/**
 * GALXAI: BroccoliDB Write-Ahead Log (WAL) Engine (Zenith Tier)
 * Append-Only Write-Ahead Log with Micro-Batched Coalescing,
 * Cryptographic Frame Chaining, and Crash-Safe Replay.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WalFrame, WalOperationType } from "./broccolidb.contracts.js";
import { ReentrantAsyncMutex } from "./broccolidb-mutex.js";

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
  private lastFrameHash = "0000000000000000000000000000000000000000000000000000000000000000";
  private totalFramesLogged = 0;
  private lastSyncTimestamp = 0;
  private isStarted = false;

  private readonly debounceMs: number;

  constructor(workspaceRoot: string = process.cwd(), debounceMs: number = 20) {
    this.debounceMs = debounceMs;
    this.walDir = path.resolve(workspaceRoot, ".broccolidb");
    this.walPath = path.join(this.walDir, "wal.log");
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    await fs.mkdir(this.walDir, { recursive: true });
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
    const frameId = this.nextFrameId++;
    const timestamp = Date.now();
    const previousFrameHash = this.lastFrameHash;

    const contentForHash = `${frameId}:${timestamp}:${op}:${table}:${recordId}:${JSON.stringify(payload ?? {})}:${previousFrameHash}`;
    const checksum = crypto.createHash("sha256").update(contentForHash).digest("hex");
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

    if (synchronous) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }

    return frame;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /**
   * Flushes all buffered frames to disk in a single sequential append.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.writeBuffer.length === 0) return;

    await this.mutex.runLocked(async () => {
      if (this.writeBuffer.length === 0) return;
      const batch = this.writeBuffer;
      this.writeBuffer = [];

      const serializedLines = batch.map((f) => JSON.stringify(f)).join("\n") + "\n";
      await fs.mkdir(path.dirname(this.walPath), { recursive: true });
      await fs.appendFile(this.walPath, serializedLines, "utf-8");
      this.lastSyncTimestamp = Date.now();
    });
  }

  /**
   * Replays all frames from the WAL file.
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

    const lines = rawContent.split("\n").filter((l) => l.trim().length > 0);
    const frames: WalFrame[] = [];
    let expectedPrevHash = "0000000000000000000000000000000000000000000000000000000000000000";

    for (let i = 0; i < lines.length; i++) {
      let frame: WalFrame;
      try {
        frame = JSON.parse(lines[i]) as WalFrame;
      } catch (err) {
        throw new WalIntegrityError(`Corrupted WAL frame JSON at line ${i + 1}`, { cause: err });
      }

      const contentForHash = `${frame.frameId}:${frame.timestamp}:${frame.op}:${frame.table}:${frame.recordId}:${JSON.stringify(frame.payload ?? {})}:${frame.previousFrameHash ?? expectedPrevHash}`;
      const computedHash = crypto.createHash("sha256").update(contentForHash).digest("hex");

      if (computedHash !== frame.checksum) {
        throw new WalIntegrityError(
          `WAL checksum mismatch at frame ${frame.frameId} (line ${i + 1}). Expected ${frame.checksum}, computed ${computedHash}`
        );
      }

      expectedPrevHash = frame.checksum;
      frames.push(frame);
      if (frame.frameId >= this.nextFrameId) {
        this.nextFrameId = frame.frameId + 1;
      }
      this.lastFrameHash = frame.checksum;
    }

    return frames;
  }

  /**
   * Safely truncates/rotates the WAL log after an atomic checkpoint has been persisted.
   */
  async truncate(): Promise<void> {
    await this.flush();
    await this.mutex.runLocked(async () => {
      try {
        const backupPath = `${this.walPath}.old`;
        await fs.rename(this.walPath, backupPath).catch(() => {});
        await fs.writeFile(this.walPath, "", "utf-8");
      } catch {
        // Ignored if file doesn't exist
      }
      this.lastFrameHash = "0000000000000000000000000000000000000000000000000000000000000000";
    });
  }

  getMetrics(): {
    totalFramesLogged: number;
    uncommittedFrames: number;
    lastSyncTimestamp: number;
    walPath: string;
  } {
    return {
      totalFramesLogged: this.totalFramesLogged,
      uncommittedFrames: this.writeBuffer.length,
      lastSyncTimestamp: this.lastSyncTimestamp,
      walPath: this.walPath,
    };
  }
}
