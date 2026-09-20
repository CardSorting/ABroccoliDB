/**
 * GALXAI: BroccoliDB Master Deterministic Hybrid In-Memory + Handrolled Kernel (Zenith Tier)
 * Unifies L1 Hot In-Memory Reactive Tables, L2 Micro-Batched Write-Ahead Log (WAL),
 * L3 Sharded Content-Addressable Storage (CAS), L4 Double-Buffered Atomic Checkpointing,
 * and the 4-Pillar Forensic Diagnostic Probe.
 */
import type { DbHealthReport, IBroccoliDatabaseKernel, IDbTable, TimelineCheckpointRecord } from "./broccolidb.contracts.js";
export interface DatabaseKernelOptions {
    readonly workspaceRoot?: string;
    readonly walDebounceMs?: number;
}
export declare class BroccoliDatabaseKernel implements IBroccoliDatabaseKernel {
    readonly workspaceRoot: string;
    private readonly dbDir;
    private readonly checkpointsDir;
    private readonly baseDbPath;
    private readonly tables;
    private readonly checkpoints;
    private readonly memorySnapshots;
    private readonly wal;
    private readonly cas;
    private readonly mutex;
    private isStarted;
    private frameIndex;
    constructor(options?: DatabaseKernelOptions);
    /**
     * Initializes the kernel, mounts CAS, and executes cold-start crash replay.
     */
    start(): Promise<void>;
    /**
     * Gracefully flushes WAL and stops kernel subsystems.
     */
    stop(): Promise<void>;
    /**
     * Flushes WAL write buffers to disk.
     */
    flush(): Promise<void>;
    /**
     * Returns a typed in-memory reactive table, creating it if it does not exist.
     */
    getTable<T extends Record<string, unknown> = Record<string, unknown>>(name: string): IDbTable<T>;
    /**
     * Executes an async operation in an isolated transaction protected by re-entrant mutex.
     */
    transaction<R>(fn: () => Promise<R>): Promise<R>;
    /**
     * Creates an atomic double-buffered state checkpoint and rotates the WAL journal.
     */
    checkpoint(label?: string): Promise<TimelineCheckpointRecord>;
    /**
     * Restores state to a prior timeline checkpoint with frame-perfect precision.
     */
    rollback(checkpointId: string): Promise<boolean>;
    listCheckpoints(): readonly TimelineCheckpointRecord[];
    storeBlob(content: Buffer | string): Promise<string>;
    readBlob(hash: string): Promise<Buffer | null>;
    gc(): Promise<number>;
    health(): Promise<DbHealthReport>;
    private loadBaseCheckpoint;
    private replayWal;
}
export declare const broccolidb: BroccoliDatabaseKernel;
//# sourceMappingURL=broccolidb-kernel.d.ts.map