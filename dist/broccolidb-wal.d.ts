// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB Write-Ahead Log (WAL) engine.
 * Append-only JSONL frames with micro-batched flushing, checksum metadata,
 * and replay-time per-frame integrity validation.
 */
import type { WalFrame, WalOperationType } from "./broccolidb.contracts.js";
export declare class WalIntegrityError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BroccoliWriteAheadLog {
    private readonly walPath;
    private readonly walDir;
    private readonly mutex;
    private writeBuffer;
    private flushTimer;
    private nextFrameId;
    private lastFrameHash;
    private totalFramesLogged;
    private tornTailRecoveryCount;
    private tornTailRecoveredBytes;
    private repairedTerminatorCount;
    private compactionBarrier;
    private pendingAppends;
    private lastSyncTimestamp;
    private lastError;
    private isStarted;
    private readonly debounceMs;
    constructor(workspaceRoot?: string, debounceMs?: number);
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Appends an operation frame to the Write-Ahead Log.
     */
    appendFrame(op: WalOperationType, table: string, recordId: string, payload?: Record<string, unknown>, synchronous?: boolean): Promise<WalFrame>;
    private createFrame;
    private scheduleFlush;
    /**
     * Flushes all buffered frames to disk in a single sequential append.
     */
    flush(): Promise<void>;
    /**
     * Replays all frames from the WAL file.
     *
     * Each frame checksum covers the serialized previous-frame metadata when it
     * is present. Replay validates the checksum, the declared link when present,
     * and the frame sequence. Legacy frames without link metadata are accepted
     * using the expected prior checksum as their checksum input.
     */
    replay(): Promise<readonly WalFrame[]>;
    /** Returns the last frame ID assigned or restored by WAL replay. */
    getCurrentFrameId(): number;
    /**
     * Rotates the WAL only through the frame included in a durable checkpoint.
     * Mutations appended while the checkpoint files are written stay in the log.
     */
    truncateThrough(frameId: number): Promise<boolean>;
    truncate(): Promise<void>;
    getMetrics(): {
        totalFramesLogged: number;
        tornTailRecoveryCount: number;
        tornTailRecoveredBytes: number;
        repairedTerminatorCount: number;
        uncommittedFrames: number;
        lastSyncTimestamp: number;
        walPath: string;
        lastError: string | null;
    };
}
//# sourceMappingURL=broccolidb-wal.d.ts.map