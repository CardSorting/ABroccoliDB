/**
 * BroccoliDB in-memory table kernel.
 * Coordinates tables, a micro-batched WAL, sharded CAS storage, checkpoint
 * files, and process-local async locking.
 */
// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureDirectoryDurably, writeFileAtomically } from "./broccolidb-fs.js";
import { BroccoliCASStorageService } from "./broccolidb-cas.js";
import { ReentrantAsyncMutex } from "./broccolidb-mutex.js";
import { BroccoliDbTable } from "./broccolidb-table.js";
import { BroccoliWriteAheadLog } from "./broccolidb-wal.js";
export class CheckpointIntegrityError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "CheckpointIntegrityError";
    }
}
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const SAFE_CHECKPOINT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
function isSafeCheckpointId(value) {
    return typeof value === "string" && SAFE_CHECKPOINT_ID_PATTERN.test(value);
}
function isRecordObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseCheckpointTables(value, formatVersion) {
    if (!isRecordObject(value)) {
        throw new CheckpointIntegrityError("Checkpoint tables must be an object");
    }
    const tables = Object.create(null);
    for (const [tableName, rows] of Object.entries(value)) {
        if (!Array.isArray(rows)) {
            throw new CheckpointIntegrityError(`Checkpoint table ${tableName} must contain an array`);
        }
        tables[tableName] = rows.map((row, rowIndex) => {
            if (!isRecordObject(row)) {
                throw new CheckpointIntegrityError(`Checkpoint table ${tableName} row ${rowIndex} is not an object`);
            }
            if (formatVersion === 1) {
                if (typeof row.id !== "string" || !isRecordObject(row.record)) {
                    throw new CheckpointIntegrityError(`Checkpoint table ${tableName} row ${rowIndex} has invalid identity data`);
                }
                return { id: row.id, record: row.record };
            }
            if (row.id !== undefined && typeof row.id !== "string") {
                throw new CheckpointIntegrityError(`Legacy checkpoint table ${tableName} row ${rowIndex} has a non-string id`);
            }
            return { id: typeof row.id === "string" ? row.id : crypto.randomUUID(), record: row };
        });
    }
    return tables;
}
function hashCheckpointData(data) {
    const serialized = JSON.stringify(data, null, 2);
    if (typeof serialized !== "string") {
        throw new CheckpointIntegrityError("Checkpoint data cannot be serialized");
    }
    return crypto.createHash("sha256").update(serialized).digest("hex");
}
export class BroccoliDatabaseKernel {
    workspaceRoot;
    dbDir;
    checkpointsDir;
    baseDbPath;
    tables = new Map();
    checkpoints = new Map();
    memorySnapshots = new Map();
    wal;
    cas;
    mutex = new ReentrantAsyncMutex("broccolidb-kernel-mutex");
    isStarted = false;
    isRestoring = false;
    frameIndex = 0;
    constructor(options = {}) {
        this.workspaceRoot = options.workspaceRoot ?? process.cwd();
        this.dbDir = path.resolve(this.workspaceRoot, ".broccolidb");
        this.checkpointsDir = path.join(this.dbDir, "checkpoints");
        this.baseDbPath = path.join(this.dbDir, "checkpoint.db");
        this.wal = new BroccoliWriteAheadLog(this.workspaceRoot, options.walDebounceMs ?? 20);
        this.cas = new BroccoliCASStorageService(this.workspaceRoot);
    }
    /**
     * Initializes the kernel, mounts CAS, and replays the WAL on startup.
     */
    async start() {
        await this.mutex.runLocked(async () => {
            if (this.isStarted)
                return;
            await ensureDirectoryDurably(this.checkpointsDir);
            try {
                await this.cas.start();
                await this.wal.start();
                this.isRestoring = true;
                try {
                    // 1. Load Base State Checkpoint if present
                    await this.loadBaseCheckpoint();
                    // 2. Replay trailing WAL frames
                    await this.replayWal();
                    this.isStarted = true;
                }
                finally {
                    this.isRestoring = false;
                }
            }
            catch (error) {
                // A failed startup must not leave timers, services, or a half-mounted
                // kernel behind if the host elects to inspect the error and retry.
                await Promise.allSettled([this.wal.stop(), this.cas.stop()]);
                throw error;
            }
        });
    }
    /**
     * Gracefully flushes WAL and stops kernel subsystems.
     */
    async stop() {
        await this.mutex.runLocked(async () => {
            await this.wal.flush();
            await this.wal.stop();
            await this.cas.stop();
            this.isStarted = false;
        });
    }
    /**
     * Flushes WAL write buffers to disk.
     */
    async flush() {
        await this.wal.flush();
    }
    /**
     * Returns a typed in-memory reactive table, creating it if it does not exist.
     */
    getTable(name) {
        let table = this.tables.get(name);
        if (!table) {
            table = new BroccoliDbTable(name, (op, tbl, id, payload) => {
                if (this.isRestoring)
                    return;
                this.frameIndex += 1;
                void this.wal.appendFrame(op, tbl, id, payload).catch(() => {
                    // The WAL exposes the failure through health() and a later flush().
                });
            });
            this.tables.set(name, table);
        }
        return table;
    }
    /**
     * Executes an async operation in an isolated transaction protected by re-entrant mutex.
     */
    async transaction(fn) {
        return this.mutex.runLocked(async () => {
            const result = await fn();
            await this.wal.flush();
            return result;
        });
    }
    /**
     * Writes a temporary-file/rename base snapshot, named history, and WAL marker.
     * The history-file write and WAL rotation are separate filesystem operations.
     */
    async checkpoint(label = "manual_checkpoint") {
        return this.mutex.runLocked(async () => {
            await this.wal.flush();
            const timestamp = Date.now();
            const checkpointId = `chk_${timestamp}_${crypto.randomUUID()}`;
            const allTableData = Object.create(null);
            let totalRecords = 0;
            const memorySnapshot = new Map();
            for (const [tableName, table] of this.tables.entries()) {
                const records = table.getAllEntries();
                allTableData[tableName] = records.map(({ id, record }) => ({ id, record }));
                totalRecords += records.length;
                memorySnapshot.set(tableName, table.createSnapshot());
            }
            const checkpointData = { formatVersion: 1, tables: allTableData };
            const snapshotHash = hashCheckpointData(checkpointData);
            const checkpointFrameId = this.wal.getCurrentFrameId();
            const record = {
                checkpointId,
                timestamp,
                frameIndex: this.frameIndex,
                label,
                tableCount: this.tables.size,
                totalRecords,
                snapshotHash,
            };
            await writeFileAtomically(this.baseDbPath, JSON.stringify({ ...checkpointData, snapshotHash }, null, 2));
            const historyFile = path.join(this.checkpointsDir, `${checkpointId}.json`);
            const timelinePayload = { record, data: checkpointData };
            await writeFileAtomically(historyFile, JSON.stringify(timelinePayload, null, 2));
            this.checkpoints.set(checkpointId, record);
            this.memorySnapshots.set(checkpointId, memorySnapshot);
            await this.wal.truncateThrough(checkpointFrameId);
            await this.wal.appendFrame("CHECKPOINT", "system", checkpointId, { label, snapshotHash }, true);
            return record;
        });
    }
    /**
     * Restores the records represented by a prior timeline checkpoint.
     * Tables created after the checkpoint are not removed automatically.
     */
    async rollback(checkpointId) {
        return this.mutex.runLocked(async () => {
            if (!isSafeCheckpointId(checkpointId))
                return false;
            const inMemory = this.memorySnapshots.get(checkpointId);
            if (inMemory) {
                for (const [tableName, tableSnapshot] of inMemory.entries()) {
                    const table = this.tables.get(tableName);
                    if (table) {
                        table.restoreSnapshot(tableSnapshot);
                        await this.wal.appendFrame("CLEAR", tableName, "*");
                        for (const [recordId, record] of tableSnapshot.entries()) {
                            await this.wal.appendFrame("INSERT", tableName, recordId, record);
                        }
                    }
                }
                await this.wal.appendFrame("ROLLBACK", "system", checkpointId, { source: "memory_cache" }, true);
                return true;
            }
            const historyFile = path.join(this.checkpointsDir, `${checkpointId}.json`);
            let parsed;
            try {
                const rawContent = await fs.readFile(historyFile, "utf-8");
                parsed = JSON.parse(rawContent);
            }
            catch {
                return false;
            }
            if (!isRecordObject(parsed) || !isRecordObject(parsed.record) || !isRecordObject(parsed.data)) {
                return false;
            }
            if (typeof parsed.record.snapshotHash !== "string" ||
                !SHA256_HEX_PATTERN.test(parsed.record.snapshotHash)) {
                return false;
            }
            let tableData = parsed.data;
            let formatVersion;
            if (isRecordObject(parsed.data) && "formatVersion" in parsed.data) {
                if (parsed.data.formatVersion !== 1 || !isRecordObject(parsed.data.tables))
                    return false;
                formatVersion = 1;
                tableData = parsed.data.tables;
            }
            let tables;
            try {
                tables = parseCheckpointTables(tableData, formatVersion);
            }
            catch {
                return false;
            }
            const snapshotHash = hashCheckpointData(parsed.data);
            if (snapshotHash !== parsed.record.snapshotHash)
                return false;
            for (const [tableName, entries] of Object.entries(tables)) {
                const table = this.getTable(tableName);
                table.clear();
                for (const entry of entries) {
                    table.put(entry.id, entry.record);
                }
            }
            await this.wal.appendFrame("ROLLBACK", "system", checkpointId, { source: "disk_snapshot" }, true);
            return true;
        });
    }
    listCheckpoints() {
        return Array.from(this.checkpoints.values()).sort((a, b) => b.timestamp - a.timestamp);
    }
    async storeBlob(content) {
        return this.cas.store(content);
    }
    async readBlob(hash) {
        return this.cas.read(hash);
    }
    async gc() {
        const referencedHashes = new Set();
        for (const table of this.tables.values()) {
            for (const record of table.getAll()) {
                for (const value of Object.values(record)) {
                    if (typeof value === "string" && value.startsWith("CAS:")) {
                        referencedHashes.add(value.substring(4));
                    }
                }
            }
        }
        return this.cas.pruneUnreferenced(referencedHashes);
    }
    /**
     * Returns a lightweight operational report, not a full WAL replay, CAS scrub,
     * table-index parity scan, or cross-process consistency check.
     */
    async health() {
        const casStats = await this.cas.getStats();
        const walMetrics = this.wal.getMetrics();
        let diskUsageBytes = casStats.totalStoredBytes;
        let writeable = true;
        try {
            const testFile = path.join(this.dbDir, `.health_probe_${crypto.randomUUID()}`);
            await fs.writeFile(testFile, "OK", { encoding: "utf-8", flag: "wx" });
            await fs.unlink(testFile);
        }
        catch {
            writeable = false;
        }
        let totalRecords = 0;
        for (const table of this.tables.values()) {
            totalRecords += table.count();
        }
        const diskInvariantsValid = writeable;
        const casIntegrityHealthy = casStats.corruptCount === 0;
        const walJournalHealthy = walMetrics.lastError === null;
        const tableConsistencyHealthy = true;
        const overallHealthy = diskInvariantsValid && casIntegrityHealthy && walJournalHealthy && tableConsistencyHealthy;
        const status = overallHealthy
            ? "HEALTHY"
            : casStats.corruptCount > 0 && walMetrics.lastError === null
                ? "DEGRADED"
                : "CORRUPTED";
        const recommendations = [];
        if (!writeable)
            recommendations.push("CRITICAL: Database directory is not writeable. Check disk permissions.");
        if (casStats.corruptCount > 0)
            recommendations.push(`WARNING: ${casStats.corruptCount} corrupted CAS blobs quarantined.`);
        if (walMetrics.lastError)
            recommendations.push(`CRITICAL: WAL write failed: ${walMetrics.lastError}`);
        if (walMetrics.uncommittedFrames > 500)
            recommendations.push("ADVISORY: WAL write buffer is high. Trigger db_checkpoint_wal.");
        return {
            status,
            timestamp: Date.now(),
            pillars: {
                diskInvariants: {
                    valid: diskInvariantsValid,
                    baseDir: this.dbDir,
                    diskUsageBytes,
                    writeable,
                },
                casIntegrity: {
                    totalBlobs: casStats.totalBlobs,
                    corruptCount: casStats.corruptCount,
                    compressionSavingsPct: casStats.compressionSavingsPct,
                    healthy: casIntegrityHealthy,
                },
                walJournal: {
                    totalFrames: walMetrics.totalFramesLogged,
                    uncommittedFrames: walMetrics.uncommittedFrames,
                    lastSyncTimestamp: walMetrics.lastSyncTimestamp,
                    lastError: walMetrics.lastError,
                    tornTailRecoveryCount: walMetrics.tornTailRecoveryCount,
                    tornTailRecoveredBytes: walMetrics.tornTailRecoveredBytes,
                    repairedTerminatorCount: walMetrics.repairedTerminatorCount,
                    healthy: walJournalHealthy,
                },
                tableConsistency: {
                    tableCount: this.tables.size,
                    totalRecords,
                    indexParity: null,
                    healthy: tableConsistencyHealthy,
                },
            },
            actionableRecommendations: recommendations,
        };
    }
    async loadBaseCheckpoint() {
        let raw;
        try {
            raw = await fs.readFile(this.baseDbPath, "utf-8");
        }
        catch (error) {
            const fileError = error;
            if (fileError.code === "ENOENT")
                return;
            throw new CheckpointIntegrityError(`Unable to read base checkpoint at ${this.baseDbPath}`, { cause: error });
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (error) {
            throw new CheckpointIntegrityError(`Base checkpoint is not valid JSON: ${this.baseDbPath}`, { cause: error });
        }
        let tableData = parsed;
        let formatVersion;
        if (isRecordObject(parsed) && "formatVersion" in parsed) {
            const allowedKeys = new Set(["formatVersion", "tables", "snapshotHash"]);
            if (Object.keys(parsed).some((key) => !allowedKeys.has(key)) ||
                parsed.formatVersion !== 1 ||
                !isRecordObject(parsed.tables) ||
                typeof parsed.snapshotHash !== "string" ||
                !SHA256_HEX_PATTERN.test(parsed.snapshotHash)) {
                throw new CheckpointIntegrityError(`Unsupported base checkpoint format: ${this.baseDbPath}`);
            }
            const expectedHash = hashCheckpointData({ formatVersion: 1, tables: parsed.tables });
            if (expectedHash !== parsed.snapshotHash) {
                throw new CheckpointIntegrityError(`Base checkpoint hash mismatch: ${this.baseDbPath}`);
            }
            formatVersion = 1;
            tableData = parsed.tables;
        }
        const tables = parseCheckpointTables(tableData, formatVersion);
        for (const [tableName, entries] of Object.entries(tables)) {
            const table = this.getTable(tableName);
            table.clear();
            for (const entry of entries) {
                table.put(entry.id, entry.record);
            }
        }
    }
    async replayWal() {
        const frames = await this.wal.replay();
        for (const frame of frames) {
            if (frame.op === "INSERT" || frame.op === "UPDATE") {
                if (frame.payload && frame.table) {
                    const table = this.getTable(frame.table);
                    table.put(frame.recordId, frame.payload);
                }
            }
            else if (frame.op === "DELETE") {
                if (frame.table) {
                    const table = this.getTable(frame.table);
                    table.delete(frame.recordId);
                }
            }
            else if (frame.op === "CLEAR") {
                if (frame.table) {
                    const table = this.getTable(frame.table);
                    table.clear();
                }
            }
            this.frameIndex = Math.max(this.frameIndex, frame.frameId);
        }
    }
}
export const broccolidb = new BroccoliDatabaseKernel();
//# sourceMappingURL=broccolidb-kernel.js.map