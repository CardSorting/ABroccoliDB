/**
 * BroccoliDB Write-Ahead Log (WAL) engine.
 * Append-only JSONL frames with micro-batched flushing, checksum metadata,
 * and replay-time per-frame integrity validation.
 */

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WalFrame, WalOperationType } from "./broccolidb.contracts.js";
import { ensureDirectoryDurably, syncDirectory } from "./broccolidb-fs.js";
import { ReentrantAsyncMutex } from "./broccolidb-mutex.js";

const ZERO_FRAME_HASH = "0".repeat(64);
const WAL_OPERATIONS: readonly WalOperationType[] = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "CLEAR",
  "CHECKPOINT",
  "ROLLBACK",
  "BRANCH_MERGE",
];

function checksumForFrame(frame: Pick<WalFrame, "frameId" | "timestamp" | "op" | "table" | "recordId" | "payload">, previousFrameHash: string): string {
  const contentForHash = `${frame.frameId}:${frame.timestamp}:${frame.op}:${frame.table}:${frame.recordId}:${JSON.stringify(frame.payload ?? {})}:${previousFrameHash}`;
  return crypto.createHash("sha256").update(contentForHash).digest("hex");
}

export class WalIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WalIntegrityError";
  }
}

export class BroccoliWriteAheadLog {
  private readonly walPath: string;
  private readonly walDir: string;
  private readonly mutex = new ReentrantAsyncMutex("broccolidb-wal-mutex");
  private writeBuffer: WalFrame[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private nextFrameId = 1;
  private lastFrameHash = ZERO_FRAME_HASH;
  private totalFramesLogged = 0;
  private tornTailRecoveryCount = 0;
  private tornTailRecoveredBytes = 0;
  private repairedTerminatorCount = 0;
  private compactionBarrier: Promise<void> | undefined;
  private pendingAppends = new Set<Promise<WalFrame>>();
  private lastSyncTimestamp = 0;
  private lastError: unknown = null;
  private isStarted = false;

  private readonly debounceMs: number;

  constructor(workspaceRoot: string = process.cwd(), debounceMs: number = 20) {
    this.debounceMs = debounceMs;
    this.walDir = path.resolve(workspaceRoot, ".broccolidb");
    this.walPath = path.join(this.walDir, "wal.log");
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    await ensureDirectoryDurably(this.walDir);
    this.isStarted = true;
  }

  async stop(): Promise<void> {
    await this.flush();
    this.isStarted = false;
  }

  /**
   * Appends an operation frame to the Write-Ahead Log.
   */
  async appendFrame(
    op: WalOperationType,
    table: string,
    recordId: string,
    payload?: Record<string, unknown>,
    synchronous: boolean = false
  ): Promise<WalFrame> {
    let frame: WalFrame;
    if (this.compactionBarrier) {
      const pending = this.compactionBarrier.then(() => this.createFrame(op, table, recordId, payload));
      this.pendingAppends.add(pending);
      try {
        frame = await pending;
      } finally {
        this.pendingAppends.delete(pending);
      }
    } else {
      frame = this.createFrame(op, table, recordId, payload);
    }

    if (synchronous) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }

    return frame;
  }

  private createFrame(
    op: WalOperationType,
    table: string,
    recordId: string,
    payload?: Record<string, unknown>
  ): WalFrame {
    const frameId = this.nextFrameId;
    const timestamp = Date.now();
    const previousFrameHash = this.lastFrameHash;

    let checksum: string;
    try {
      checksum = checksumForFrame({ frameId, timestamp, op, table, recordId, payload }, previousFrameHash);
    } catch (error) {
      this.lastError = error;
      throw error;
    }
    this.nextFrameId = frameId + 1;
    this.lastFrameHash = checksum;

    const frame: WalFrame = {
      frameId,
      timestamp,
      op,
      table,
      recordId,
      payload,
      checksum,
      previousFrameHash,
    };

    this.writeBuffer.push(frame);
    this.totalFramesLogged += 1;
    return frame;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error) => {
        this.lastError = error;
      });
    }, this.debounceMs);
  }

  /**
   * Flushes all buffered frames to disk in a single sequential append.
   */
  async flush(): Promise<void> {
    while (this.compactionBarrier) await this.compactionBarrier;
    while (this.pendingAppends.size > 0) await Promise.all([...this.pendingAppends]);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.mutex.runLocked(async () => {
      if (this.writeBuffer.length === 0) return;
      const batch = this.writeBuffer;
      this.writeBuffer = [];
      let fileHandle: fs.FileHandle | undefined;
      let initialSize = 0;
      let initialSizeKnown = false;
      let initialFileMissing = false;

      try {
        const serializedLines = batch.map((f) => JSON.stringify(f)).join("\n") + "\n";
        await ensureDirectoryDurably(path.dirname(this.walPath));
        try {
          initialSize = (await fs.stat(this.walPath)).size;
          initialSizeKnown = true;
        } catch (error: unknown) {
          const fileError = error as { code?: string };
          if (fileError.code !== "ENOENT") throw error;
          initialSizeKnown = true;
          initialFileMissing = true;
        }
        fileHandle = await fs.open(this.walPath, "a");
        await fileHandle.appendFile(serializedLines, "utf-8");
        await fileHandle.sync();
        await fileHandle.close();
        fileHandle = undefined;
        if (initialFileMissing) await syncDirectory(this.walDir);
        this.lastError = null;
        this.lastSyncTimestamp = Date.now();
      } catch (error) {
        if (fileHandle) {
          await fileHandle.close().catch(() => {});
        }
        // A failed append can leave a partial tail on some filesystems. Roll
        // it back before retrying instead of appending the same batch again.
        if (initialSizeKnown) {
          await fs.truncate(this.walPath, initialSize).catch(() => {});
        }
        // Preserve the batch ahead of frames appended while the filesystem
        // operation was in flight so an explicit retry can make progress.
        this.writeBuffer = [...batch, ...this.writeBuffer];
        this.lastError = error;
        throw error;
      }
    });
  }

  /**
   * Replays all frames from the WAL file.
   *
   * Each frame checksum covers the serialized previous-frame metadata when it
   * is present. Replay validates the checksum, the declared link when present,
   * and the frame sequence. Legacy frames without link metadata are accepted
   * using the expected prior checksum as their checksum input.
   */
  async replay(): Promise<readonly WalFrame[]> {
    await this.flush();

      let rawContent: string;
      try {
        rawContent = await fs.readFile(this.walPath, "utf-8");
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error.code === "ENOENT") return [];
        throw err;
      }

      const hasFinalNewline = rawContent.endsWith("\n");
      const rawLines = rawContent.split("\n");
      let tornTailBytes = 0;
      let repairFinalNewline = false;
      if (!hasFinalNewline && rawLines.length > 0) {
        const tail = rawLines.pop() ?? "";
        if (tail.length > 0) {
          try {
            JSON.parse(tail);
            rawLines.push(tail);
            repairFinalNewline = true;
          } catch {
            // An unterminated, invalid final JSONL record can only be a torn
            // append. Keep every complete frame before it and discard this
            // tail; malformed newline-terminated records remain fatal below.
            tornTailBytes = Buffer.byteLength(tail, "utf8");
          }
        }
      }
      const lines = rawLines.filter((l) => l.trim().length > 0);
      const frames: WalFrame[] = [];
      let expectedPrevHash = ZERO_FRAME_HASH;
      let previousFrameId: number | undefined;

      for (let i = 0; i < lines.length; i++) {
        let frame: WalFrame;
        try {
          frame = JSON.parse(lines[i]) as WalFrame;
        } catch (err) {
          throw new WalIntegrityError(`Corrupted WAL frame JSON at line ${i + 1}`, { cause: err });
        }

        if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
          throw new WalIntegrityError(`WAL frame must be an object at line ${i + 1}`);
        }
        if (!Number.isSafeInteger(frame.frameId) || frame.frameId < 1) {
          throw new WalIntegrityError(`Invalid WAL frame ID at line ${i + 1}`);
        }
        if (previousFrameId !== undefined && frame.frameId !== previousFrameId + 1) {
          throw new WalIntegrityError(
            `WAL frame sequence gap at line ${i + 1}: expected ${previousFrameId + 1}, got ${frame.frameId}`
          );
        }
        if (!Number.isFinite(frame.timestamp) || typeof frame.timestamp !== "number") {
          throw new WalIntegrityError(`Invalid WAL timestamp at frame ${frame.frameId} (line ${i + 1})`);
        }
        if (!WAL_OPERATIONS.includes(frame.op)) {
          throw new WalIntegrityError(`Invalid WAL operation at frame ${frame.frameId} (line ${i + 1})`);
        }
        if (typeof frame.table !== "string" || typeof frame.recordId !== "string") {
          throw new WalIntegrityError(`Invalid WAL identity fields at frame ${frame.frameId} (line ${i + 1})`);
        }
        if (
          frame.payload !== undefined &&
          (frame.payload === null || typeof frame.payload !== "object" || Array.isArray(frame.payload))
        ) {
          throw new WalIntegrityError(`Invalid WAL payload at frame ${frame.frameId} (line ${i + 1})`);
        }
        if (typeof frame.checksum !== "string") {
          throw new WalIntegrityError(`Invalid WAL checksum field at frame ${frame.frameId} (line ${i + 1})`);
        }
        if (frame.previousFrameHash !== undefined && frame.previousFrameHash !== expectedPrevHash) {
          throw new WalIntegrityError(
            `WAL previous-frame link mismatch at frame ${frame.frameId} (line ${i + 1}). Expected ${expectedPrevHash}, got ${frame.previousFrameHash}`
          );
        }

        const computedHash = checksumForFrame(frame, frame.previousFrameHash ?? expectedPrevHash);

        if (computedHash !== frame.checksum) {
          throw new WalIntegrityError(
            `WAL checksum mismatch at frame ${frame.frameId} (line ${i + 1}). Expected ${frame.checksum}, computed ${computedHash}`
          );
        }

        expectedPrevHash = frame.checksum;
        previousFrameId = frame.frameId;
        frames.push(frame);
        if (frame.frameId >= this.nextFrameId) {
          this.nextFrameId = frame.frameId + 1;
        }
        this.lastFrameHash = frame.checksum;
      }

      this.totalFramesLogged = Math.max(this.totalFramesLogged, frames.length);

      if (tornTailBytes > 0) {
        const lastNewline = rawContent.lastIndexOf("\n");
        const validPrefix = rawContent.slice(0, lastNewline + 1);
        const validBytes = Buffer.byteLength(validPrefix, "utf8");
        const handle = await fs.open(this.walPath, "r+");
        try {
          await handle.truncate(validBytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.tornTailRecoveryCount += 1;
        this.tornTailRecoveredBytes += tornTailBytes;
      } else if (repairFinalNewline) {
        const handle = await fs.open(this.walPath, "a");
        try {
          await handle.appendFile("\n", "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.repairedTerminatorCount += 1;
      }

    return frames;
  }

  /** Returns the last frame ID assigned or restored by WAL replay. */
  getCurrentFrameId(): number {
    return this.nextFrameId - 1;
  }

  /**
   * Rotates the WAL only through the frame included in a durable checkpoint.
   * Mutations appended while the checkpoint files are written stay in the log.
   */
  async truncateThrough(frameId: number): Promise<boolean> {
    if (!Number.isSafeInteger(frameId) || frameId < 0) throw new RangeError("frameId must be a non-negative safe integer");
    await this.flush();
    return await this.mutex.runLocked(async () => {
      if (this.getCurrentFrameId() > frameId) return false;

      let releaseBarrier!: () => void;
      this.compactionBarrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      const temporaryPath = `${this.walPath}.tmp.${crypto.randomUUID()}`;
      let handle: fs.FileHandle | undefined;
      let replaced = false;
      try {
        handle = await fs.open(temporaryPath, "wx");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporaryPath, this.walPath);
        replaced = true;
        this.lastFrameHash = ZERO_FRAME_HASH;
        await syncDirectory(this.walDir);
        this.lastError = null;
        return true;
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporaryPath).catch(() => {});
        this.lastError = error;
        if (replaced) this.lastFrameHash = ZERO_FRAME_HASH;
        throw error;
      } finally {
        this.compactionBarrier = undefined;
        releaseBarrier();
      }
    });
  }

  async truncate(): Promise<void> {
    await this.truncateThrough(this.getCurrentFrameId());
  }

  getMetrics(): {
    totalFramesLogged: number;
    tornTailRecoveryCount: number;
    tornTailRecoveredBytes: number;
    repairedTerminatorCount: number;
    uncommittedFrames: number;
    lastSyncTimestamp: number;
    walPath: string;
    lastError: string | null;
  } {
    return {
      totalFramesLogged: this.totalFramesLogged,
      tornTailRecoveryCount: this.tornTailRecoveryCount,
      tornTailRecoveredBytes: this.tornTailRecoveredBytes,
      repairedTerminatorCount: this.repairedTerminatorCount,
      uncommittedFrames: this.writeBuffer.length,
      lastSyncTimestamp: this.lastSyncTimestamp,
      walPath: this.walPath,
      lastError:
        this.lastError === null
          ? null
          : this.lastError instanceof Error
            ? this.lastError.message
            : String(this.lastError),
    };
  }
}
