// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB content-addressable storage (CAS) service.
 * 256-way sharded blobs with conditional Brotli encoding, SHA-256 read
 * verification, and corruption quarantine.
 */
export declare class StorageIntegrityError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BroccoliCASStorageService {
    private readonly baseDir;
    private readonly blobsDir;
    private readonly corruptDir;
    private corruptCount;
    private isStarted;
    constructor(workspaceRoot?: string);
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Computes normalized SHA-256 hash of content.
     */
    static computeSha256(content: Buffer | string): string;
    private static normalizeHash;
    private static isBlobFileName;
    /**
     * Stores a content buffer or string into the CAS vault.
     */
    store(content: Buffer | string): Promise<string>;
    /**
     * Reads raw decompressed content from CAS.
     */
    read(hash: string): Promise<Buffer | null>;
    /**
     * Checks whether a blob exists in CAS.
     */
    exists(hash: string): Promise<boolean>;
    /**
     * Quarantines a corrupted blob to the corrupt directory with an audit manifest entry.
     */
    private quarantineBlob;
    /**
     * Removes blob files whose names are absent from the supplied reference set.
     * This is a single filesystem sweep; callers are responsible for constructing
     * a complete reference set before invoking it.
     */
    pruneUnreferenced(referencedHashes: Set<string>): Promise<number>;
    /**
     * Computes comprehensive CAS vault statistics.
     */
    getStats(): Promise<{
        totalBlobs: number;
        totalRawBytes: number;
        totalStoredBytes: number;
        compressionSavingsPct: number;
        corruptCount: number;
        quarantinedBlobs: readonly string[];
    }>;
    getBaseDir(): string;
}
//# sourceMappingURL=broccolidb-cas.d.ts.map