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
function checksumForFrame(frame, previousFrameHash) {
    const contentForHash = `${frame.frameId}:${frame.timestamp}:${frame.op}:${frame.table}:${frame.recordId}:${JSON.stringify(frame.payload ?? {})}:${previousFrameHash}`;
    return crypto.createHash("sha256").update(contentForHash).digest("hex");
}
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
    writeBuffer = [];
    flushTimer = null;
    nextFrameId = 1;
    lastFrameHash = ZERO_FRAME_HASH;
    totalFramesLogged = 0;
    lastSyncTimestamp = 0;
    lastError = null;
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
        await fs.mkdir(this.walDir, { recursive: true });
        this.isStarted = true;
    }
    async stop() {
        await this.flush();
        this.isStarted = false;
    }
    /**
     * Appends an operation frame to the Write-Ahead Log.
     */
    async appendFrame(op, table, recordId, payload, synchronous = false) {
        const frameId = this.nextFrameId;
        const timestamp = Date.now();
        const previousFrameHash = this.lastFrameHash;
        let checksum;
        try {
            checksum = checksumForFrame({ frameId, timestamp, op, table, recordId, payload }, previousFrameHash);
        }
        catch (error) {
            this.lastError = error;
            throw error;
        }
        this.nextFrameId = frameId + 1;
        this.lastFrameHash = checksum;
        const frame = {
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
        }
        else {
            this.scheduleFlush();
        }
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
     * Flushes all buffered frames to disk in a single sequential append.
     */
    async flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.mutex.runLocked(async () => {
            if (this.writeBuffer.length === 0)
                return;
            const batch = this.writeBuffer;
            this.writeBuffer = [];
            let fileHandle;
            let initialSize = 0;
            let initialSizeKnown = false;
            try {
                const serializedLines = batch.map((f) => JSON.stringify(f)).join("\n") + "\n";
                await fs.mkdir(path.dirname(this.walPath), { recursive: true });
                try {
                    initialSize = (await fs.stat(this.walPath)).size;
                    initialSizeKnown = true;
                }
                catch (error) {
                    const fileError = error;
                    if (fileError.code !== "ENOENT")
                        throw error;
                    initialSizeKnown = true;
                }
                fileHandle = await fs.open(this.walPath, "a");
                await fileHandle.appendFile(serializedLines, "utf-8");
                await fileHandle.sync();
                await fileHandle.close();
                fileHandle = undefined;
                this.lastError = null;
                this.lastSyncTimestamp = Date.now();
            }
            catch (error) {
                if (fileHandle) {
                    await fileHandle.close().catch(() => { });
                }
                // A failed append can leave a partial tail on some filesystems. Roll
                // it back before retrying instead of appending the same batch again.
                if (initialSizeKnown && fileHandle) {
                    await fs.truncate(this.walPath, initialSize).catch(() => { });
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
        const lines = rawContent.split("\n").filter((l) => l.trim().length > 0);
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
        return frames;
    }
    /**
     * Rotates the WAL log after checkpoint persistence.
     */
    async truncate() {
        await this.flush();
        await this.mutex.runLocked(async () => {
            try {
                const backupPath = `${this.walPath}.old`;
                try {
                    await fs.rename(this.walPath, backupPath);
                }
                catch (error) {
                    const fileError = error;
                    if (fileError.code !== "ENOENT")
                        throw error;
                }
                await fs.writeFile(this.walPath, "", "utf-8");
                this.lastError = null;
            }
            catch (error) {
                this.lastError = error;
                throw error;
            }
            this.lastFrameHash = ZERO_FRAME_HASH;
        });
    }
    getMetrics() {
        return {
            totalFramesLogged: this.totalFramesLogged,
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