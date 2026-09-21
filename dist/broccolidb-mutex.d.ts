// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB re-entrant async mutex.
 * Uses AsyncLocalStorage context propagation and timeout-based contention
 * diagnostics for process-local coordination.
 */
export declare class DatabaseLockError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare class DeadlockTimeoutError extends DatabaseLockError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class ReentrantAsyncMutex {
    private queue;
    private locked;
    private currentHolderId;
    private holdCount;
    readonly name: string;
    private readonly timeoutMs;
    constructor(name?: string, timeoutMs?: number);
    /**
     * Acquires the mutex or increments re-entrant hold count if caller already owns it.
     */
    acquire(): Promise<() => void>;
    private release;
    /**
     * Executes an async callback within a protected re-entrant lock scope.
     */
    runLocked<T>(callback: () => Promise<T>): Promise<T>;
    /**
     * Computes a bounded randomized exponential backoff delay in milliseconds.
     */
    static calculateJitterDelay(attempt: number, baseMs?: number, maxMs?: number): number;
    isLocked(): boolean;
    getCurrentHolder(): string | null;
    getQueueLength(): number;
}
//# sourceMappingURL=broccolidb-mutex.d.ts.map