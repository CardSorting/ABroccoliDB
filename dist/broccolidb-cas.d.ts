/**
 * GALXAI: BroccoliDB Content-Addressable Storage (CAS) Vault (Zenith Tier)
 * 256-Way Sharded CAS Vault with Adaptive Brotli Compression,
 * Cryptographic Read-Verification, and Automatic Corruption Quarantine.
 */
export declare class StorageIntegrityError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BroccoliCASStorageService {
    private readonly baseDir;
    private readonly blobsDir;
    private readonly corruptDir;
    private readonly verifiedCache;
    private corruptCount;
    private isStarted;
    constructor(workspaceRoot?: string);
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Computes normalized SHA-256 hash of content.
     */
    static computeSha256(content: Buffer | string): string;
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
     * Runs 2-Phase Mark-Sweep Garbage Collection.
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