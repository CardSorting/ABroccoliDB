/**
 * GALXAI: BroccoliDB Content-Addressable Storage (CAS) Vault (Zenith Tier)
 * 256-Way Sharded CAS Vault with Adaptive Brotli Compression,
 * Cryptographic Read-Verification, and Automatic Corruption Quarantine.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
const compressBrotli = promisify(zlib.brotliCompress);
const decompressBrotli = promisify(zlib.brotliDecompress);
const BROTLI_MINIMUM_BYTES = 1024;
const BROTLI_MINIMUM_SAVINGS_RATIO = 0.9;
const MAGIC_RAW = Buffer.from("BR_RAW\0");
const MAGIC_BROTLI = Buffer.from("BR_BRZ\0");
export class StorageIntegrityError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "StorageIntegrityError";
    }
}
export class BroccoliCASStorageService {
    baseDir;
    blobsDir;
    corruptDir;
    verifiedCache = new Set();
    corruptCount = 0;
    isStarted = false;
    constructor(workspaceRoot = process.cwd()) {
        this.baseDir = path.resolve(workspaceRoot, ".broccolidb", "cas");
        this.blobsDir = path.join(this.baseDir, "blobs");
        this.corruptDir = path.join(this.baseDir, "corrupt");
    }
    async start() {
        if (this.isStarted)
            return;
        await fs.mkdir(this.blobsDir, { recursive: true });
        await fs.mkdir(this.corruptDir, { recursive: true });
        this.isStarted = true;
    }
    async stop() {
        this.isStarted = false;
    }
    /**
     * Computes normalized SHA-256 hash of content.
     */
    static computeSha256(content) {
        return crypto.createHash("sha256").update(content).digest("hex");
    }
    /**
     * Stores a content buffer or string into the CAS vault.
     */
    async store(content) {
        const rawBuffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
        const hash = BroccoliCASStorageService.computeSha256(rawBuffer);
        if (this.verifiedCache.has(hash)) {
            return hash;
        }
        const shard = hash.slice(0, 2);
        const shardDir = path.join(this.blobsDir, shard);
        const filePath = path.join(shardDir, hash);
        try {
            await fs.access(filePath);
            this.verifiedCache.add(hash);
            return hash;
        }
        catch {
            // Blob does not exist yet
        }
        let payload;
        if (rawBuffer.length >= BROTLI_MINIMUM_BYTES) {
            try {
                const compressed = await compressBrotli(rawBuffer, {
                    params: {
                        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
                    },
                });
                if (compressed.length / rawBuffer.length <= BROTLI_MINIMUM_SAVINGS_RATIO) {
                    payload = Buffer.concat([MAGIC_BROTLI, compressed]);
                }
                else {
                    payload = Buffer.concat([MAGIC_RAW, rawBuffer]);
                }
            }
            catch {
                payload = Buffer.concat([MAGIC_RAW, rawBuffer]);
            }
        }
        else {
            payload = Buffer.concat([MAGIC_RAW, rawBuffer]);
        }
        await fs.mkdir(shardDir, { recursive: true });
        const tmpPath = `${filePath}.tmp.${Date.now()}`;
        await fs.writeFile(tmpPath, payload);
        await fs.rename(tmpPath, filePath);
        this.verifiedCache.add(hash);
        return hash;
    }
    /**
     * Reads raw decompressed content from CAS.
     */
    async read(hash) {
        const shard = hash.slice(0, 2);
        const filePath = path.join(this.blobsDir, shard, hash);
        let storedBuffer;
        try {
            storedBuffer = await fs.readFile(filePath);
        }
        catch (err) {
            const error = err;
            if (error.code === "ENOENT")
                return null;
            throw err;
        }
        let rawBuffer;
        if (storedBuffer.subarray(0, MAGIC_BROTLI.length).equals(MAGIC_BROTLI)) {
            const compressed = storedBuffer.subarray(MAGIC_BROTLI.length);
            try {
                rawBuffer = await decompressBrotli(compressed);
            }
            catch (err) {
                await this.quarantineBlob(hash, filePath, "brotli_decompression_failure");
                throw new StorageIntegrityError(`Corrupted Brotli payload in blob ${hash}`, { cause: err });
            }
        }
        else if (storedBuffer.subarray(0, MAGIC_RAW.length).equals(MAGIC_RAW)) {
            rawBuffer = storedBuffer.subarray(MAGIC_RAW.length);
        }
        else {
            rawBuffer = storedBuffer;
        }
        const actualHash = BroccoliCASStorageService.computeSha256(rawBuffer);
        if (actualHash !== hash) {
            await this.quarantineBlob(hash, filePath, `sha256_mismatch: expected ${hash} got ${actualHash}`);
            throw new StorageIntegrityError(`CAS cryptographic integrity failure for blob ${hash} (actual hash: ${actualHash}). Quarantined.`);
        }
        this.verifiedCache.add(hash);
        return rawBuffer;
    }
    /**
     * Checks whether a blob exists in CAS.
     */
    async exists(hash) {
        if (this.verifiedCache.has(hash))
            return true;
        const shard = hash.slice(0, 2);
        const filePath = path.join(this.blobsDir, shard, hash);
        try {
            await fs.access(filePath);
            this.verifiedCache.add(hash);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Quarantines a corrupted blob to the corrupt directory with an audit manifest entry.
     */
    async quarantineBlob(expectedHash, originalPath, reason) {
        await fs.mkdir(this.corruptDir, { recursive: true });
        const timestamp = Date.now();
        const quarantinedPath = path.join(this.corruptDir, `${expectedHash}.${timestamp}.corrupt`);
        try {
            await fs.rename(originalPath, quarantinedPath);
        }
        catch {
            // File may already be moved
        }
        this.verifiedCache.delete(expectedHash);
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
     * Runs 2-Phase Mark-Sweep Garbage Collection.
     */
    async pruneUnreferenced(referencedHashes) {
        let prunedCount = 0;
        let shards;
        try {
            shards = await fs.readdir(this.blobsDir);
        }
        catch {
            return 0;
        }
        for (const shard of shards) {
            const shardDir = path.join(this.blobsDir, shard);
            let stats;
            try {
                stats = await fs.stat(shardDir);
            }
            catch {
                continue;
            }
            if (!stats.isDirectory())
                continue;
            let files;
            try {
                files = await fs.readdir(shardDir);
            }
            catch {
                continue;
            }
            for (const file of files) {
                if (!referencedHashes.has(file)) {
                    try {
                        await fs.unlink(path.join(shardDir, file));
                        this.verifiedCache.delete(file);
                        prunedCount += 1;
                    }
                    catch {
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
    async getStats() {
        let totalBlobs = 0;
        let totalStoredBytes = 0;
        let totalRawBytes = 0;
        let shards = [];
        try {
            shards = await fs.readdir(this.blobsDir);
        }
        catch {
            shards = [];
        }
        for (const shard of shards) {
            const shardDir = path.join(this.blobsDir, shard);
            let files = [];
            try {
                files = await fs.readdir(shardDir);
            }
            catch {
                continue;
            }
            for (const file of files) {
                const filePath = path.join(shardDir, file);
                try {
                    const stat = await fs.stat(filePath);
                    totalBlobs += 1;
                    totalStoredBytes += stat.size;
                    totalRawBytes += stat.size;
                }
                catch { }
            }
        }
        let quarantinedBlobs = [];
        try {
            quarantinedBlobs = (await fs.readdir(this.corruptDir)).filter((f) => f.endsWith(".corrupt"));
        }
        catch {
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
            corruptCount: this.corruptCount + quarantinedBlobs.length,
            quarantinedBlobs,
        };
    }
    getBaseDir() {
        return this.baseDir;
    }
}
//# sourceMappingURL=broccolidb-cas.js.map