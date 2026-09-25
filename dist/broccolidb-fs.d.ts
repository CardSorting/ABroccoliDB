// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/** Persist directory entries on platforms that support syncing directories. */
export declare function syncDirectory(directory: string): Promise<void>;
/** Create a directory tree and sync each newly created directory entry. */
export declare function ensureDirectoryDurably(directory: string): Promise<void>;
/** Atomically replace a file only after its complete contents have been synced. */
export declare function writeFileAtomically(filePath: string, data: string | Uint8Array): Promise<void>;
//# sourceMappingURL=broccolidb-fs.d.ts.map