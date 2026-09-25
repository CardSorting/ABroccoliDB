// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Persist directory entries on platforms that support syncing directories. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (["EINVAL", "ENOTSUP", "ENOSYS"].includes(fileError.code ?? "")) return;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

/** Create a directory tree and sync each newly created directory entry. */
export async function ensureDirectoryDurably(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);
    return;
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== "ENOENT") throw error;
  }

  const parent = path.dirname(resolved);
  await ensureDirectoryDurably(parent);
  try {
    await fs.mkdir(resolved);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== "EEXIST") throw error;
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw error;
    return;
  }
  await syncDirectory(parent);
  await syncDirectory(resolved);
}

/** Atomically replace a file only after its complete contents have been synced. */
export async function writeFileAtomically(filePath: string, data: string | Uint8Array): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDirectoryDurably(directory);
  const temporaryPath = `${filePath}.tmp.${crypto.randomUUID()}`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
