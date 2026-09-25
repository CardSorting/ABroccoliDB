/**
 * BroccoliDB re-entrant async mutex.
 * Uses AsyncLocalStorage context propagation and timeout-based contention
 * diagnostics for process-local coordination.
 */
// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
const mutexStorage = new AsyncLocalStorage();
export class DatabaseLockError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "DatabaseLockError";
    }
}
export class DeadlockTimeoutError extends DatabaseLockError {
    constructor(message, options) {
        super(message, options);
        this.name = "DeadlockTimeoutError";
    }
}
export class ReentrantAsyncMutex {
    queue = [];
    locked = false;
    currentHolderId = null;
    holdCount = 0;
    name;
    timeoutMs;
    constructor(name = "default-mutex", timeoutMs = 30_000) {
        this.name = name;
        this.timeoutMs = timeoutMs;
    }
    /**
     * Acquires the mutex or increments re-entrant hold count if caller already owns it.
     */
    async acquire() {
        const callerId = mutexStorage.getStore() || crypto.randomUUID();
        if (this.locked && this.currentHolderId === callerId) {
            this.holdCount += 1;
            return () => this.release(callerId);
        }
        if (!this.locked) {
            this.locked = true;
            this.currentHolderId = callerId;
            this.holdCount = 1;
            return () => this.release(callerId);
        }
        return new Promise((resolve, reject) => {
            let waiter;
            const timer = setTimeout(() => {
                const idx = this.queue.indexOf(waiter);
                if (idx >= 0) {
                    this.queue.splice(idx, 1);
                    const stack = new Error().stack || "";
                    reject(new DeadlockTimeoutError(`[Mutex:${this.name}] Deadlock timeout after ${this.timeoutMs}ms. Lock held by ${this.currentHolderId}. Waiter stack:\n${stack}`));
                }
            }, this.timeoutMs);
            waiter = {
                resolve: (releaseFn) => {
                    clearTimeout(timer);
                    resolve(releaseFn);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
                holderId: callerId,
                timestamp: Date.now(),
            };
            this.queue.push(waiter);
        });
    }
    release(callerId) {
        if (this.currentHolderId !== callerId) {
            return;
        }
        this.holdCount -= 1;
        if (this.holdCount > 0) {
            return;
        }
        const next = this.queue.shift();
        if (next) {
            this.currentHolderId = next.holderId;
            this.holdCount = 1;
            next.resolve(() => this.release(next.holderId));
        }
        else {
            this.locked = false;
            this.currentHolderId = null;
            this.holdCount = 0;
        }
    }
    /**
     * Executes an async callback within a protected re-entrant lock scope.
     */
    async runLocked(callback) {
        const callerId = mutexStorage.getStore() || crypto.randomUUID();
        const release = await this.acquire();
        try {
            return await mutexStorage.run(callerId, callback);
        }
        finally {
            release();
        }
    }
    /**
     * Computes a bounded randomized exponential backoff delay in milliseconds.
     */
    static calculateJitterDelay(attempt, baseMs = 10, maxMs = 500) {
        const exponential = Math.min(maxMs, baseMs * Math.pow(1.25, attempt));
        const randomJitter = Math.random() * (baseMs * 2);
        return Math.floor(exponential + randomJitter);
    }
    isLocked() {
        return this.locked;
    }
    getCurrentHolder() {
        return this.currentHolderId;
    }
    getQueueLength() {
        return this.queue.length;
    }
}
//# sourceMappingURL=broccolidb-mutex.js.map