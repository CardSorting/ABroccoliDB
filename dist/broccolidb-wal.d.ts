/**
 * GALXAI: BroccoliDB Write-Ahead Log (WAL) Engine (Zenith Tier)
 * Append-Only Write-Ahead Log with Micro-Batched Coalescing,
 * Cryptographic Frame Chaining, and Crash-Safe Replay.
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
    private lastSyncTimestamp;
    private isStarted;
    private readonly debounceMs;
    constructor(workspaceRoot?: string, debounceMs?: number);
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Appends an operation frame to the Write-Ahead Log.
     */
    appendFrame(op: WalOperationType, table: string, recordId: string, payload?: Record<string, unknown>, synchronous?: boolean): Promise<WalFrame>;
    private scheduleFlush;
    /**
     * Flushes all buffered frames to disk in a single sequential append.
     */
    flush(): Promise<void>;
    /**
     * Replays all frames from the WAL file.
     */
    replay(): Promise<readonly WalFrame[]>;
    /**
     * Safely truncates/rotates the WAL log after an atomic checkpoint has been persisted.
     */
    truncate(): Promise<void>;
    getMetrics(): {
        totalFramesLogged: number;
        uncommittedFrames: number;
        lastSyncTimestamp: number;
        walPath: string;
    };
}
//# sourceMappingURL=broccolidb-wal.d.ts.map