/**
 * BroccoliDB content-addressable storage (CAS) service.
 * 256-way sharded blobs with conditional Brotli encoding, SHA-256 read
 * verification, and corruption quarantine.
 */

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

const compressBrotli = promisify(zlib.brotliCompress);
const decompressBrotli = promisify(zlib.brotliDecompress);

const BROTLI_MINIMUM_BYTES = 1024;
const BROTLI_MINIMUM_SAVINGS_RATIO = 0.9;
const BROTLI_STATS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAGIC_RAW = Buffer.from("BR_RAW\0");
const MAGIC_BROTLI = Buffer.from("BR_BRZ\0");
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

export class StorageIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageIntegrityError";
  }
}

export class BroccoliCASStorageService {
  private readonly baseDir: string;
  private readonly blobsDir: string;
  private readonly corruptDir: string;
  private corruptCount = 0;
  private isStarted = false;

  constructor(workspaceRoot: string = process.cwd()) {
    this.baseDir = path.resolve(workspaceRoot, ".broccolidb", "cas");
    this.blobsDir = path.join(this.baseDir, "blobs");
    this.corruptDir = path.join(this.baseDir, "corrupt");
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    await fs.mkdir(this.blobsDir, { recursive: true });
    await fs.mkdir(this.corruptDir, { recursive: true });
    for (const directory of [this.baseDir, this.blobsDir, this.corruptDir]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory()) {
        throw new StorageIntegrityError(`CAS path is not a regular directory: ${directory}`);
      }
    }
    this.isStarted = true;
  }

  async stop(): Promise<void> {
    this.isStarted = false;
  }

  /**
   * Computes normalized SHA-256 hash of content.
   */
  static computeSha256(content: Buffer | string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private static normalizeHash(hash: string): string {
    if (!SHA256_HEX_PATTERN.test(hash)) {
      throw new StorageIntegrityError(`Invalid CAS hash identifier: ${String(hash)}`);
    }
    return hash.toLowerCase();
  }

  private static isBlobFileName(file: string, shard: string): boolean {
    return SHA256_HEX_PATTERN.test(file) && file.slice(0, 2).toLowerCase() === shard.toLowerCase();
  }

  /**
   * Stores a content buffer or string into the CAS vault.
   */
  async store(content: Buffer | string): Promise<string> {
    const rawBuffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const hash = BroccoliCASStorageService.computeSha256(rawBuffer);

    const shard = hash.slice(0, 2);
    const shardDir = path.join(this.blobsDir, shard);
    const filePath = path.join(shardDir, hash);

    try {
      const existing = await this.read(hash);
      if (existing !== null) return hash;
    } catch (error) {
      if (!(error instanceof StorageIntegrityError)) throw error;
      // A damaged existing object was quarantined; rebuild it below.
    }

    let payload: Buffer;
    if (rawBuffer.length >= BROTLI_MINIMUM_BYTES) {
      try {
        const compressed = await compressBrotli(rawBuffer, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          },
        });
        if (compressed.length / rawBuffer.length <= BROTLI_MINIMUM_SAVINGS_RATIO) {
          payload = Buffer.concat([MAGIC_BROTLI, compressed]);
        } else {
          payload = Buffer.concat([MAGIC_RAW, rawBuffer]);
        }
      } catch {
        payload = Buffer.concat([MAGIC_RAW, rawBuffer]);
      }
    } else {
      payload = Buffer.concat([MAGIC_RAW, rawBuffer]);
    }

    await fs.mkdir(shardDir, { recursive: true });
    const shardStat = await fs.lstat(shardDir);
    if (!shardStat.isDirectory()) {
      throw new StorageIntegrityError(`CAS shard is not a regular directory: ${shard}`);
    }
    const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
    await fs.writeFile(tmpPath, payload);
    await fs.rename(tmpPath, filePath);
    return hash;
  }

  /**
   * Reads raw decompressed content from CAS.
   */
  async read(hash: string): Promise<Buffer | null> {
    const normalizedHash = BroccoliCASStorageService.normalizeHash(hash);
    const shard = normalizedHash.slice(0, 2);
    const filePath = path.join(this.blobsDir, shard, normalizedHash);

    let storedBuffer: Buffer;
    try {
      const shardStat = await fs.lstat(path.join(this.blobsDir, shard));
      if (!shardStat.isDirectory()) {
        throw new StorageIntegrityError(`CAS shard is not a regular directory: ${shard}`);
      }
      const fileStat = await fs.lstat(filePath);
      if (!fileStat.isFile()) {
        throw new StorageIntegrityError(`CAS object is not a regular file: ${normalizedHash}`);
      }
      storedBuffer = await fs.readFile(filePath);
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "ENOENT") return null;
      throw err;
    }

    let rawBuffer: Buffer;
    if (storedBuffer.subarray(0, MAGIC_BROTLI.length).equals(MAGIC_BROTLI)) {
      const compressed = storedBuffer.subarray(MAGIC_BROTLI.length);
      try {
        rawBuffer = await decompressBrotli(compressed);
      } catch (err) {
        await this.quarantineBlob(normalizedHash, filePath, "brotli_decompression_failure");
        throw new StorageIntegrityError(`Corrupted Brotli payload in blob ${normalizedHash}`, { cause: err });
      }
    } else if (storedBuffer.subarray(0, MAGIC_RAW.length).equals(MAGIC_RAW)) {
      rawBuffer = storedBuffer.subarray(MAGIC_RAW.length);
    } else {
      rawBuffer = storedBuffer;
    }

    const actualHash = BroccoliCASStorageService.computeSha256(rawBuffer);
    if (actualHash !== normalizedHash) {
      await this.quarantineBlob(normalizedHash, filePath, `sha256_mismatch: expected ${normalizedHash} got ${actualHash}`);
      throw new StorageIntegrityError(
        `CAS cryptographic integrity failure for blob ${normalizedHash} (actual hash: ${actualHash}). Quarantined.`
      );
    }

    return rawBuffer;
  }

  /**
   * Checks whether a blob exists in CAS.
   */
  async exists(hash: string): Promise<boolean> {
    let normalizedHash: string;
    try {
      normalizedHash = BroccoliCASStorageService.normalizeHash(hash);
    } catch {
      return false;
    }

    const shard = normalizedHash.slice(0, 2);
    const filePath = path.join(this.blobsDir, shard, normalizedHash);
    try {
      const shardStat = await fs.lstat(path.join(this.blobsDir, shard));
      if (!shardStat.isDirectory()) return false;
      const fileStat = await fs.lstat(filePath);
      if (!fileStat.isFile()) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Quarantines a corrupted blob to the corrupt directory with an audit manifest entry.
   */
  private async quarantineBlob(expectedHash: string, originalPath: string, reason: string): Promise<void> {
    await fs.mkdir(this.corruptDir, { recursive: true });
    const timestamp = Date.now();
    const quarantinedPath = path.join(this.corruptDir, `${expectedHash}.${timestamp}-${crypto.randomUUID()}.corrupt`);

    try {
      await fs.rename(originalPath, quarantinedPath);
    } catch {
      // File may already be moved
    }

    this.corruptCount += 1;

    const manifestEntry = {
      timestamp: new Date(timestamp).toISOString(),
      expectedHash,
      reason,
      originalPath,
      quarantinedPath,
    };

    const manifestPath = path.join(this.corruptDir, "manifest.jsonl");
    await fs.appendFile(manifestPath, `${JSON.stringify(manifestEntry)}\n`, "utf-8");
  }

  /**
   * Removes blob files whose names are absent from the supplied reference set.
   * This is a single filesystem sweep; callers are responsible for constructing
   * a complete reference set before invoking it.
   */
  async pruneUnreferenced(referencedHashes: Set<string>): Promise<number> {
    let prunedCount = 0;
    const protectedHashes = new Set<string>();
    for (const hash of referencedHashes) {
      if (typeof hash === "string" && SHA256_HEX_PATTERN.test(hash)) {
        protectedHashes.add(hash.toLowerCase());
      }
    }

    let shards: string[];

    try {
      shards = await fs.readdir(this.blobsDir);
    } catch {
      return 0;
    }

    for (const shard of shards) {
      if (shard.length !== 2 || !/^[a-f0-9]{2}$/i.test(shard)) continue;
      const shardDir = path.join(this.blobsDir, shard);
      let stats;
      try {
        stats = await fs.lstat(shardDir);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) continue;

      let files: string[];
      try {
        files = await fs.readdir(shardDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!BroccoliCASStorageService.isBlobFileName(file, shard)) continue;
        if (!protectedHashes.has(file.toLowerCase())) {
          try {
            const fileStat = await fs.lstat(path.join(shardDir, file));
            if (!fileStat.isFile()) continue;
            await fs.unlink(path.join(shardDir, file));
            prunedCount += 1;
          } catch {
            // Ignored
          }
        }
      }
    }

    return prunedCount;
  }

  /**
   * Computes comprehensive CAS vault statistics.
   */
  async getStats(): Promise<{
    totalBlobs: number;
    totalRawBytes: number;
    totalStoredBytes: number;
    compressionSavingsPct: number;
    corruptCount: number;
    quarantinedBlobs: readonly string[];
  }> {
    let totalBlobs = 0;
    let totalStoredBytes = 0;
    let totalRawBytes = 0;

    let shards: string[] = [];
    try {
      shards = await fs.readdir(this.blobsDir);
    } catch {
      shards = [];
    }

    for (const shard of shards) {
      if (shard.length !== 2 || !/^[a-f0-9]{2}$/i.test(shard)) continue;
      const shardDir = path.join(this.blobsDir, shard);
      let files: string[] = [];
      try {
        files = await fs.readdir(shardDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!BroccoliCASStorageService.isBlobFileName(file, shard)) continue;
        const filePath = path.join(shardDir, file);
        try {
          const stat = await fs.lstat(filePath);
          if (!stat.isFile()) continue;
          totalBlobs += 1;
          totalStoredBytes += stat.size;

          // Decode the small on-disk format so the reported raw total is an
          // accounting value rather than a duplicate of stored bytes. A
          // damaged payload is left for the explicit read/quarantine path.
          try {
            const storedBuffer = await fs.readFile(filePath);
            if (storedBuffer.subarray(0, MAGIC_BROTLI.length).equals(MAGIC_BROTLI)) {
              const rawBuffer = await decompressBrotli(storedBuffer.subarray(MAGIC_BROTLI.length), {
                maxOutputLength: BROTLI_STATS_MAX_OUTPUT_BYTES,
              });
              totalRawBytes += rawBuffer.length;
            } else if (storedBuffer.subarray(0, MAGIC_RAW.length).equals(MAGIC_RAW)) {
              totalRawBytes += Math.max(0, storedBuffer.length - MAGIC_RAW.length);
            } else {
              totalRawBytes += storedBuffer.length;
            }
          } catch {
            totalRawBytes += stat.size;
          }
        } catch {}
      }
    }

    let quarantinedBlobs: string[] = [];
    try {
      quarantinedBlobs = (await fs.readdir(this.corruptDir)).filter((f) => f.endsWith(".corrupt"));
    } catch {
      quarantinedBlobs = [];
    }

    const savingsPct = totalRawBytes > 0 && totalStoredBytes < totalRawBytes
      ? Math.round(((totalRawBytes - totalStoredBytes) / totalRawBytes) * 100)
      : 0;

    return {
      totalBlobs,
      totalRawBytes,
      totalStoredBytes,
      compressionSavingsPct: savingsPct,
      corruptCount: Math.max(this.corruptCount, quarantinedBlobs.length),
      quarantinedBlobs,
    };
  }

  getBaseDir(): string {
    return this.baseDir;
  }
}
