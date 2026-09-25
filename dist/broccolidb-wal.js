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
import { ensureDirectoryDurably, syncDirectory } from "./broccolidb-fs.js";
import { ReentrantAsyncMutex } from "./broccolidb-mutex.js";
const ZERO_FRAME_HASH = "0".repeat(64);
const WAL_OPERATIONS = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "CLEAR",
    "CHECKPOINT",
    "ROLLBACK",
    "BRANCH_MERGE",
];
function checksumForFrame(frame, previousFrameHash, serializedPayload = JSON.stringify(frame.payload ?? {})) {
    const contentForHash = `${frame.frameId}:${frame.timestamp}:${frame.op}:${frame.table}:${frame.recordId}:${serializedPayload}:${previousFrameHash}`;
    return crypto.createHash("sha256").update(contentForHash).digest("hex");
}
// Target size for each append call. A single WAL frame stays intact and may
// exceed this target; rejecting large application records would be surprising.
const WAL_APPEND_CHUNK_TARGET_BYTES = 1024 * 1024;
export class WalIntegrityError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "WalIntegrityError";
    }
}
export class BroccoliWriteAheadLog {
    walPath;
    walDir;
    mutex = new ReentrantAsyncMutex("broccolidb-wal-mutex");
    // Keep immutable serialized frames in the queue. In addition to avoiding
    // another full JSON serialization during flush, this snapshots payloads at
    // append time so caller mutation cannot invalidate their checksums.
    writeBuffer = [];
    flushTimer = null;
    nextFrameId = 1;
    lastFrameHash = ZERO_FRAME_HASH;
    totalFramesLogged = 0;
    tornTailRecoveryCount = 0;
    tornTailRecoveredBytes = 0;
    repairedTerminatorCount = 0;
    compactionBarrier;
    pendingAppends = new Set();
    lastSyncTimestamp = 0;
    lastError = null;
    poisonedError = null;
    directorySyncPending = false;
    acceptsFrames = false;
    isStarted = false;
    debounceMs;
    constructor(workspaceRoot = process.cwd(), debounceMs = 20) {
        this.debounceMs = debounceMs;
        this.walDir = path.resolve(workspaceRoot, ".broccolidb");
        this.walPath = path.join(this.walDir, "wal.log");
    }
    async start() {
        if (this.isStarted)
            return;
        if (this.poisonedError)
            throw this.poisonedError;
        await ensureDirectoryDurably(this.walDir);
        this.acceptsFrames = true;
        this.isStarted = true;
    }
    async stop() {
        this.acceptsFrames = false;
        try {
            await this.flush();
        }
        finally {
            if (this.flushTimer) {
                clearTimeout(this.flushTimer);
                this.flushTimer = null;
            }
            this.isStarted = false;
        }
    }
    /**
     * Appends an operation frame to the Write-Ahead Log.
     */
    async appendFrame(op, table, recordId, payload, synchronous = false) {
        if (!this.acceptsFrames)
            throw new Error("WAL is stopping or stopped; call start() before appending frames.");
        if (this.poisonedError)
            throw this.poisonedError;
        let frame;
        if (this.compactionBarrier) {
            const pending = this.compactionBarrier.then(() => this.createFrame(op, table, recordId, payload));
            this.pendingAppends.add(pending);
            try {
                frame = await pending;
            }
            finally {
                this.pendingAppends.delete(pending);
            }
        }
        else {
            frame = this.createFrame(op, table, recordId, payload);
        }
        if (synchronous) {
            await this.flush();
        }
        else {
            this.scheduleFlush();
        }
        return frame;
    }
    createFrame(op, table, recordId, payload) {
        if (this.poisonedError)
            throw this.poisonedError;
        const frameId = this.nextFrameId;
        if (!Number.isSafeInteger(frameId))
            throw new RangeError("WAL frame ID space is exhausted");
        if (!WAL_OPERATIONS.includes(op))
            throw new TypeError("Invalid WAL operation");
        if (typeof table !== "string" || typeof recordId !== "string") {
            throw new TypeError("WAL table and record IDs must be strings");
        }
        const timestamp = Date.now();
        const previousFrameHash = this.lastFrameHash;
        let serializedPayload;
        let checksum;
        try {
            if (payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload))) {
                throw new TypeError("WAL payload must be a JSON object");
            }
            const encodedPayload = JSON.stringify(payload ?? {});
            if (typeof encodedPayload !== "string" || encodedPayload[0] !== "{") {
                throw new TypeError("WAL payload must serialize to a JSON object");
            }
            serializedPayload = encodedPayload;
            checksum = checksumForFrame({ frameId, timestamp, op, table, recordId, payload }, previousFrameHash, serializedPayload);
        }
        catch (error) {
            this.lastError = error;
            throw error;
        }
        const serializedFrame = [
            `"frameId":${frameId}`,
            `"timestamp":${timestamp}`,
            `"op":${JSON.stringify(op)}`,
            `"table":${JSON.stringify(table)}`,
            `"recordId":${JSON.stringify(recordId)}`,
            ...(payload === undefined ? [] : [`"payload":${serializedPayload}`]),
            `"checksum":${JSON.stringify(checksum)}`,
            `"previousFrameHash":${JSON.stringify(previousFrameHash)}`,
        ].join(",");
        const capturedPayload = payload === undefined
            ? undefined
            : JSON.parse(serializedPayload);
        const frame = {
            frameId,
            timestamp,
            op,
            table,
            recordId,
            payload: capturedPayload,
            checksum,
            previousFrameHash,
        };
        this.writeBuffer.push(`{${serializedFrame}}`);
        this.nextFrameId = frameId + 1;
        this.lastFrameHash = checksum;
        this.totalFramesLogged += 1;
        return frame;
    }
    scheduleFlush() {
        if (this.flushTimer)
            return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush().catch((error) => {
                this.lastError = error;
            });
        }, this.debounceMs);
    }
    /**
     * Flushes buffered frames with sequential append calls and one batch sync.
     */
    async flush() {
        if (this.poisonedError)
            throw this.poisonedError;
        while (this.compactionBarrier)
            await this.compactionBarrier;
        while (this.pendingAppends.size > 0)
            await Promise.all([...this.pendingAppends]);
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.mutex.runLocked(async () => {
            if (this.poisonedError)
                throw this.poisonedError;
            if (this.writeBuffer.length === 0) {
                if (this.directorySyncPending) {
                    try {
                        await syncDirectory(this.walDir);
                        this.directorySyncPending = false;
                        this.lastError = null;
                        this.lastSyncTimestamp = Date.now();
                    }
                    catch (error) {
                        this.lastError = error;
                        throw error;
                    }
                }
                if (this.lastError !== null)
                    throw this.lastError;
                return;
            }
            const batch = this.writeBuffer;
            this.writeBuffer = [];
            let fileHandle;
            let initialSize = 0;
            let initialSizeKnown = false;
            let appendStarted = false;
            try {
                await ensureDirectoryDurably(path.dirname(this.walPath));
                try {
                    initialSize = (await fs.stat(this.walPath)).size;
                    initialSizeKnown = true;
                }
                catch (error) {
                    const fileError = error;
                    if (fileError.code !== "ENOENT")
                        throw error;
                    initialSizeKnown = true;
                    this.directorySyncPending = true;
                }
                fileHandle = await fs.open(this.walPath, "a");
                let chunk = [];
                let chunkBytes = 0;
                for (const line of batch) {
                    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
                    if (chunk.length > 0 && chunkBytes + lineBytes > WAL_APPEND_CHUNK_TARGET_BYTES) {
                        appendStarted = true;
                        await fileHandle.appendFile(`${chunk.join("\n")}\n`, "utf-8");
                        chunk = [];
                        chunkBytes = 0;
                    }
                    chunk.push(line);
                    chunkBytes += lineBytes;
                }
                if (chunk.length > 0) {
                    appendStarted = true;
                    await fileHandle.appendFile(`${chunk.join("\n")}\n`, "utf-8");
                }
                await fileHandle.sync();
                await fileHandle.close();
                fileHandle = undefined;
                if (this.directorySyncPending) {
                    await syncDirectory(this.walDir);
                    this.directorySyncPending = false;
                }
                this.lastError = null;
                this.lastSyncTimestamp = Date.now();
            }
            catch (error) {
                let rollbackError;
                if (appendStarted) {
                    try {
                        if (!initialSizeKnown)
                            throw new Error("Original WAL size is unknown");
                        if (fileHandle) {
                            await fileHandle.truncate(initialSize);
                            await fileHandle.sync();
                            const stat = await fileHandle.stat();
                            if (stat.size !== initialSize)
                                throw new Error("WAL size did not return to its pre-append boundary");
                        }
                        else {
                            const rollbackHandle = await fs.open(this.walPath, "r+");
                            try {
                                await rollbackHandle.truncate(initialSize);
                                await rollbackHandle.sync();
                                const stat = await rollbackHandle.stat();
                                if (stat.size !== initialSize)
                                    throw new Error("WAL size did not return to its pre-append boundary");
                            }
                            finally {
                                await rollbackHandle.close();
                            }
                        }
                    }
                    catch (failure) {
                        rollbackError = failure;
                    }
                }
                if (fileHandle) {
                    await fileHandle.close().catch(() => { });
                }
                // Preserve the batch ahead of frames appended while the filesystem
                // operation was in flight. Retry only after a partial append has been
                // durably removed; otherwise a retry could duplicate frame IDs.
                this.writeBuffer = [...batch, ...this.writeBuffer];
                if (rollbackError !== undefined) {
                    const cause = new AggregateError([error, rollbackError], "WAL append and rollback failed");
                    this.poisonedError = new WalIntegrityError("WAL append rollback could not be confirmed; further writes are disabled until the log is reopened", { cause });
                    this.lastError = this.poisonedError;
                    throw this.poisonedError;
                }
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
    async replay() {
        await this.flush();
        let rawContent;
        try {
            rawContent = await fs.readFile(this.walPath, "utf-8");
        }
        catch (err) {
            const error = err;
            if (error.code === "ENOENT")
                return [];
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
                }
                catch {
                    // An unterminated, invalid final JSONL record can only be a torn
                    // append. Keep every complete frame before it and discard this
                    // tail; malformed newline-terminated records remain fatal below.
                    tornTailBytes = Buffer.byteLength(tail, "utf8");
                }
            }
        }
        const lines = rawLines.filter((l) => l.trim().length > 0);
        const frames = [];
        let expectedPrevHash = ZERO_FRAME_HASH;
        let previousFrameId;
        for (let i = 0; i < lines.length; i++) {
            let frame;
            try {
                frame = JSON.parse(lines[i]);
            }
            catch (err) {
                throw new WalIntegrityError(`Corrupted WAL frame JSON at line ${i + 1}`, { cause: err });
            }
            if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
                throw new WalIntegrityError(`WAL frame must be an object at line ${i + 1}`);
            }
            if (!Number.isSafeInteger(frame.frameId) || frame.frameId < 1) {
                throw new WalIntegrityError(`Invalid WAL frame ID at line ${i + 1}`);
            }
            if (previousFrameId !== undefined && frame.frameId !== previousFrameId + 1) {
                throw new WalIntegrityError(`WAL frame sequence gap at line ${i + 1}: expected ${previousFrameId + 1}, got ${frame.frameId}`);
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
            if (frame.payload !== undefined &&
                (frame.payload === null || typeof frame.payload !== "object" || Array.isArray(frame.payload))) {
                throw new WalIntegrityError(`Invalid WAL payload at frame ${frame.frameId} (line ${i + 1})`);
            }
            if (typeof frame.checksum !== "string") {
                throw new WalIntegrityError(`Invalid WAL checksum field at frame ${frame.frameId} (line ${i + 1})`);
            }
            if (frame.previousFrameHash !== undefined && frame.previousFrameHash !== expectedPrevHash) {
                throw new WalIntegrityError(`WAL previous-frame link mismatch at frame ${frame.frameId} (line ${i + 1}). Expected ${expectedPrevHash}, got ${frame.previousFrameHash}`);
            }
            const computedHash = checksumForFrame(frame, frame.previousFrameHash ?? expectedPrevHash);
            if (computedHash !== frame.checksum) {
                throw new WalIntegrityError(`WAL checksum mismatch at frame ${frame.frameId} (line ${i + 1}). Expected ${frame.checksum}, computed ${computedHash}`);
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
            }
            finally {
                await handle.close();
            }
            this.tornTailRecoveryCount += 1;
            this.tornTailRecoveredBytes += tornTailBytes;
        }
        else if (repairFinalNewline) {
            const handle = await fs.open(this.walPath, "a");
            try {
                await handle.appendFile("\n", "utf8");
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            this.repairedTerminatorCount += 1;
        }
        return frames;
    }
    /** Returns the last frame ID assigned or restored by WAL replay. */
    getCurrentFrameId() {
        return this.nextFrameId - 1;
    }
    /**
     * Rotates the WAL only through the frame included in a durable checkpoint.
     * Mutations appended while the checkpoint files are written stay in the log.
     */
    async truncateThrough(frameId) {
        if (!Number.isSafeInteger(frameId) || frameId < 0)
            throw new RangeError("frameId must be a non-negative safe integer");
        await this.flush();
        return await this.mutex.runLocked(async () => {
            if (this.getCurrentFrameId() > frameId)
                return false;
            let releaseBarrier;
            this.compactionBarrier = new Promise((resolve) => { releaseBarrier = resolve; });
            const temporaryPath = `${this.walPath}.tmp.${crypto.randomUUID()}`;
            let handle;
            let replaced = false;
            try {
                handle = await fs.open(temporaryPath, "wx");
                await handle.sync();
                await handle.close();
                handle = undefined;
                await fs.rename(temporaryPath, this.walPath);
                replaced = true;
                this.directorySyncPending = true;
                this.lastFrameHash = ZERO_FRAME_HASH;
                await syncDirectory(this.walDir);
                this.directorySyncPending = false;
                this.lastError = null;
                return true;
            }
            catch (error) {
                if (handle)
                    await handle.close().catch(() => { });
                await fs.unlink(temporaryPath).catch(() => { });
                this.lastError = error;
                if (replaced)
                    this.lastFrameHash = ZERO_FRAME_HASH;
                throw error;
            }
            finally {
                this.compactionBarrier = undefined;
                releaseBarrier();
            }
        });
    }
    async truncate() {
        await this.truncateThrough(this.getCurrentFrameId());
    }
    getMetrics() {
        return {
            totalFramesLogged: this.totalFramesLogged,
            tornTailRecoveryCount: this.tornTailRecoveryCount,
            tornTailRecoveredBytes: this.tornTailRecoveredBytes,
            repairedTerminatorCount: this.repairedTerminatorCount,
            uncommittedFrames: this.writeBuffer.length,
            lastSyncTimestamp: this.lastSyncTimestamp,
            walPath: this.walPath,
            lastError: this.lastError === null
                ? null
                : this.lastError instanceof Error
                    ? this.lastError.message
                    : String(this.lastError),
        };
    }
}
//# sourceMappingURL=broccolidb-wal.js.map