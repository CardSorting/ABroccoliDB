// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB in-memory table kernel.
 * Coordinates tables, a micro-batched WAL, sharded CAS storage, checkpoint
 * files, and process-local async locking.
 */
import type { DbHealthReport, IBroccoliDatabaseKernel, IDbTable, TimelineCheckpointRecord } from "./broccolidb.contracts.js";
import { type JsonSqlDatabase } from "./broccolidb-jsonsql.js";
export declare class CheckpointIntegrityError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export interface DatabaseKernelOptions {
    readonly workspaceRoot?: string;
    readonly walDebounceMs?: number;
}
export declare class BroccoliDatabaseKernel implements IBroccoliDatabaseKernel {
    readonly workspaceRoot: string;
    readonly sql: JsonSqlDatabase;
    private readonly dbDir;
    private readonly checkpointsDir;
    private readonly baseDbPath;
    private readonly tables;
    private readonly checkpoints;
    private readonly memorySnapshots;
    private readonly wal;
    private readonly cas;
    private readonly mutex;
    private readonly jsonSql;
    private isStarted;
    private acceptsTableWrites;
    private frameIndex;
    constructor(options?: DatabaseKernelOptions);
    /**
     * Initializes the kernel, mounts CAS, and replays the WAL on startup.
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
     * Runs an async callback under the process-local kernel mutex and flushes the
     * WAL when it succeeds. This is not an isolated or rollback-capable database
     * transaction; direct table writes do not acquire this mutex.
     */
    transaction<R>(fn: () => Promise<R>): Promise<R>;
    /**
     * Writes a temporary-file/rename base snapshot, named history, and WAL marker.
     * The history-file write and WAL rotation are separate filesystem operations.
     */
    checkpoint(label?: string): Promise<TimelineCheckpointRecord>;
    /**
     * Writes a hashed base snapshot and rotates the WAL without retaining a
     * named timeline checkpoint. Returns false when newer WAL frames crossed the
     * captured snapshot boundary, leaving the existing WAL intact for replay.
     */
    compact(): Promise<boolean>;
    /**
     * Restores the records represented by a prior timeline checkpoint.
     * Tables created after the checkpoint are not removed automatically.
     */
    rollback(checkpointId: string): Promise<boolean>;
    listCheckpoints(): readonly TimelineCheckpointRecord[];
    storeBlob(content: Buffer | string): Promise<string>;
    readBlob(hash: string): Promise<Buffer | null>;
    gc(): Promise<number>;
    /**
     * Returns a lightweight operational report, not a full WAL replay, CAS scrub,
     * table-index parity scan, or cross-process consistency check.
     */
    health(): Promise<DbHealthReport>;
    private loadBaseCheckpoint;
    private replayWal;
}
export declare const broccolidb: BroccoliDatabaseKernel;
//# sourceMappingURL=broccolidb-kernel.d.ts.map