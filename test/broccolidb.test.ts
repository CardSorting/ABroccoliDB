// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import test from "node:test"
import os from "node:os"
import path from "node:path"
import {
	BroccoliCASStorageService,
	BroccoliDatabaseKernel,
	BroccoliWriteAheadLog,
	CheckpointIntegrityError,
	StorageIntegrityError,
	WalIntegrityError,
} from "../src/index.js"

test("tables, indexes, WAL replay, and checkpoints survive a restart", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-package-"))
	try {
		const first = new BroccoliDatabaseKernel({ workspaceRoot })
		await first.start()
		const users = first.getTable<{ id: string; name: string; score: number }>("users")
		users.createIndex("name")
		users.put("user-1", { id: "user-1", name: "Ada", score: 10 })
		assert.deepEqual(users.query({ where: { name: "Ada" } }), [{ id: "user-1", name: "Ada", score: 10 }])
		await first.flush()
		await first.stop()

		const second = new BroccoliDatabaseKernel({ workspaceRoot })
		await second.start()
		assert.deepEqual(second.getTable("users").get("user-1"), { id: "user-1", name: "Ada", score: 10 })
		const checkpoint = await second.checkpoint("portable-package-test")
		assert.equal(checkpoint.totalRecords, 1)
		const later = second.getTable<{ id: string; name: string }>("created-later")
		later.put("later-1", { id: "later-1", name: "still-present" })
		assert.equal(await second.rollback(checkpoint.checkpointId), true)
		assert.deepEqual(later.get("later-1"), { id: "later-1", name: "still-present" })
		await second.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("kernel shutdown closes table writes before the final WAL drain", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-stop-write-gate-"))
	try {
		const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await db.start()
		const users = db.getTable<{ id: string }>("users")
		users.put("saved", { id: "saved" })

		const stopping = db.stop()
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.throws(() => users.put("late", { id: "late" }), /stopping or stopped/)
		await stopping

		const reopened = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await reopened.start()
		assert.deepEqual(reopened.getTable("users").getAll(), [{ id: "saved" }])
		await reopened.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("compaction rotates the WAL without creating named checkpoint history", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-compact-"))
	try {
		const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await db.start()
		const items = db.getTable<{ id: string; value: number }>("items")
		items.put("before", { id: "before", value: 1 })
		await db.flush()

		assert.equal(await db.compact(), true)
		assert.deepEqual(db.listCheckpoints(), [])
		assert.deepEqual(await readdir(path.join(workspaceRoot, ".broccolidb", "checkpoints")), [])
		items.put("after", { id: "after", value: 2 })
		await db.stop()

		const reopened = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await reopened.start()
		assert.deepEqual(reopened.getTable("items").get("before"), { id: "before", value: 1 })
		assert.deepEqual(reopened.getTable("items").get("after"), { id: "after", value: 2 })
		assert.deepEqual(reopened.listCheckpoints(), [])
		await reopened.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("table writes stay closed before start finishes recovery", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-start-write-gate-"))
	try {
		const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		const items = db.getTable<{ id: string }>("items")
		assert.throws(() => items.put("early", { id: "early" }), /stopping or stopped/)
		await db.start()
		assert.deepEqual(items.put("ready", { id: "ready" }), { id: "ready" })
		await db.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("TTL expiration is retried after the same kernel starts again", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-ttl-restart-"))
	try {
		const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await db.start()
		const items = db.getTable<{ id: string }>("items")
		items.put("temporary", { id: "temporary" }, { ttlMs: 15 })
		await db.stop()

		await new Promise<void>((resolve) => setTimeout(resolve, 30))
		await db.start()
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
		assert.equal(items.get("temporary"), undefined)
		await db.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL rejects appends until it has started", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-lifecycle-"))
	try {
		const wal = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await assert.rejects(wal.appendFrame("INSERT", "items", "early", { id: "early" }), /stopping or stopped/)
		await wal.start()
		await wal.appendFrame("INSERT", "items", "ready", { id: "ready" }, true)
		await wal.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("fluent queries keep repeated predicates, OR groups, ordering, and pagination independent", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-fluent-query-"))
	try {
		const db = new BroccoliDatabaseKernel({ workspaceRoot })
		await db.start()
		const items = db.getTable<{ id: string; name: string; score: number; tag: string }>("items")
		items.putMany([
			{ id: "a", record: { id: "a", name: "Alpha", score: 10, tag: "x" } },
			{ id: "b", record: { id: "b", name: "Beta", score: 20, tag: "y" } },
			{ id: "c", record: { id: "c", name: "Beta", score: 30, tag: "x" } },
			{ id: "d", record: { id: "d", name: "Alpha", score: 40, tag: "z" } },
		])

		assert.deepEqual(
			items.select().where("score").greaterThanOrEqual(10).and("score").lessThan(30)
				.orderBy("name").orderBy("score", "desc").execute().map((row) => row.id),
			["a", "b"],
		)
		assert.deepEqual(
			items.select().where("score").lessThan(20)
				.or((branch) => branch.where("tag").equals("x").and("score").greaterThanOrEqual(30))
				.execute().map((row) => row.id),
			["a", "c"],
		)
		assert.deepEqual(
			items.select().where("name").equals("Alpha")
				.or((branch) => branch.where("tag").equals("z").or((nested) => nested.where("score").equals(30)))
				.execute().map((row) => row.id).sort(),
			["a", "c", "d"],
		)

		const paged = items.select().orderBy("score").limit(3)
		assert.equal(paged.first()?.id, "a")
		assert.deepEqual(paged.execute().map((row) => row.id), ["a", "b", "c"])
		assert.equal(items.select().where("tag").equals("x").limit(1).offset(1).count(), 2)
		assert.throws(() => items.select().limit(-1), RangeError)
		await db.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("checkpoints preserve application keys even when records omit an id field", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-checkpoint-keys-"))
	try {
		const first = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await first.start()
		first.getTable("settings").put("application-key", { enabled: true })
		first.getTable("__proto__").put("prototype-key", { safe: true })
		await first.checkpoint("preserve-application-key")
		await first.stop()

		const second = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await second.start()
		assert.deepEqual(second.getTable("settings").get("application-key"), { enabled: true })
		assert.equal(second.getTable("settings").count(), 1)
		assert.deepEqual(second.getTable("__proto__").get("prototype-key"), { safe: true })
		await second.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("startup remains compatible with legacy value-array checkpoints", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-legacy-checkpoint-"))
	try {
		await mkdir(path.join(workspaceRoot, ".broccolidb"), { recursive: true })
		await writeFile(
			path.join(workspaceRoot, ".broccolidb", "checkpoint.db"),
			JSON.stringify({ settings: [{ id: "legacy-key", enabled: true }] }),
			"utf8",
		)

		const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await db.start()
		assert.deepEqual(db.getTable("settings").get("legacy-key"), { id: "legacy-key", enabled: true })
		await db.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("where mutations use the application key when a record omits an id field", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-keyed-mutations-"))
	try {
		const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await db.start()
		const settings = db.getTable<{ enabled: boolean }>("settings")
		settings.put("application-key", { enabled: true })
		assert.equal(settings.updateWhere({ enabled: true }, () => ({ enabled: false })), 1)
		assert.deepEqual(settings.get("application-key"), { enabled: false })
		assert.equal(settings.deleteWhere({ enabled: false }), 1)
		assert.equal(settings.count(), 0)
		await db.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("startup rejects a valid-shaped base checkpoint whose content hash changed", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-checkpoint-hash-"))
	try {
		const first = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await first.start()
		first.getTable("settings").put("application-key", { enabled: true })
		await first.checkpoint("hash-verified")
		await first.stop()

		const checkpointPath = path.join(workspaceRoot, ".broccolidb", "checkpoint.db")
		const tampered = JSON.parse(await readFile(checkpointPath, "utf8")) as {
			tables: { settings: Array<{ id: string; record: Record<string, unknown> }> }
		}
		tampered.tables.settings[0].record.enabled = false
		await writeFile(checkpointPath, JSON.stringify(tampered, null, 2), "utf8")

		const second = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await assert.rejects(second.start(), CheckpointIntegrityError)
		await second.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL replay rejects a frame whose checksum no longer matches its fields", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-integrity-"))
	try {
		const writer = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await writer.start()
		await writer.appendFrame("INSERT", "users", "user-1", { id: "user-1" }, true)
		await writer.stop()

		const walPath = path.join(workspaceRoot, ".broccolidb", "wal.log")
		const frame = JSON.parse(await readFile(walPath, "utf8")) as Record<string, unknown>
		frame.recordId = "tampered-id"
		await writeFile(walPath, `${JSON.stringify(frame)}\n`, "utf8")

		const reader = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await reader.start()
		await assert.rejects(reader.replay(), WalIntegrityError)
		await reader.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL replay rejects a recomputed frame with a discontinuous previous link", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-chain-"))
	try {
		const writer = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await writer.start()
		await writer.appendFrame("INSERT", "users", "user-1", { id: "user-1" }, true)
		await writer.appendFrame("INSERT", "users", "user-2", { id: "user-2" }, true)
		await writer.stop()

		const walPath = path.join(workspaceRoot, ".broccolidb", "wal.log")
		const lines = (await readFile(walPath, "utf8")).trim().split("\n")
		const second = JSON.parse(lines[1]) as Record<string, any>
		second.previousFrameHash = "0".repeat(64)
		const contentForHash = `${second.frameId}:${second.timestamp}:${second.op}:${second.table}:${second.recordId}:${JSON.stringify(second.payload ?? {})}:${second.previousFrameHash}`
		second.checksum = createHash("sha256").update(contentForHash).digest("hex")
		lines[1] = JSON.stringify(second)
		await writeFile(walPath, `${lines.join("\n")}\n`, "utf8")

		const reader = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await reader.start()
		await assert.rejects(reader.replay(), /previous-frame link mismatch/)
		await reader.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL replay discards only an unterminated torn tail and can append after recovery", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-torn-tail-"))
	try {
		const writer = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await writer.start()
		await writer.appendFrame("INSERT", "users", "user-1", { id: "user-1" }, true)
		await writer.appendFrame("INSERT", "users", "user-2", { id: "user-2" }, true)
		await writer.stop()

		const walPath = path.join(workspaceRoot, ".broccolidb", "wal.log")
		const completePrefix = await readFile(walPath, "utf8")
		const tornTail = '{"frameId":3,"timestamp":'
		await writeFile(walPath, `${completePrefix}${tornTail}`, "utf8")

		const reader = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await reader.start()
		assert.equal((await reader.replay()).length, 2)
		assert.equal(await readFile(walPath, "utf8"), completePrefix)
		assert.deepEqual(
			{
				recoveryCount: reader.getMetrics().tornTailRecoveryCount,
				recoveredBytes: reader.getMetrics().tornTailRecoveredBytes,
			},
			{ recoveryCount: 1, recoveredBytes: Buffer.byteLength(tornTail) },
		)
		await reader.appendFrame("INSERT", "users", "user-3", { id: "user-3" }, true)
		await reader.stop()

		const restarted = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await restarted.start()
		assert.equal((await restarted.replay()).length, 3)
		await restarted.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("BroccoliDB health reports recovered WAL tail metrics", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-health-wal-recovery-"))
	try {
		const writer = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await writer.start()
		await writer.appendFrame("INSERT", "users", "user-1", { id: "user-1" }, true)
		await writer.stop()

		const walPath = path.join(workspaceRoot, ".broccolidb", "wal.log")
		const validPrefix = await readFile(walPath, "utf8")
		const tornTail = "{\"frameId\":"
		await writeFile(walPath, `${validPrefix}${tornTail}`, "utf8")

		const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await db.start()
		const report = await db.health()
		assert.equal(report.pillars.walJournal.tornTailRecoveryCount, 1)
		assert.equal(report.pillars.walJournal.tornTailRecoveredBytes, Buffer.byteLength(tornTail))
		await db.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("checkpoint WAL rotation preserves frames newer than its snapshot boundary", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-checkpoint-boundary-"))
	try {
		const wal = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await wal.start()
		await wal.appendFrame("INSERT", "users", "user-1", { id: "user-1" }, true)
		const snapshotFrameId = wal.getCurrentFrameId()
		await wal.appendFrame("INSERT", "users", "user-2", { id: "user-2" }, true)

		assert.equal(await wal.truncateThrough(snapshotFrameId), false)
		await wal.stop()

		const reader = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await reader.start()
		assert.equal((await reader.replay()).length, 2)
		await reader.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL replay repairs a missing final newline only after validating the frame", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-terminator-"))
	try {
		const writer = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await writer.start()
		await writer.appendFrame("INSERT", "users", "user-1", { id: "user-1" }, true)
		await writer.stop()

		const walPath = path.join(workspaceRoot, ".broccolidb", "wal.log")
		const completeFrame = (await readFile(walPath, "utf8")).trimEnd()
		await writeFile(walPath, completeFrame, "utf8")

		const reader = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await reader.start()
		assert.equal((await reader.replay()).length, 1)
		assert.equal(await readFile(walPath, "utf8"), `${completeFrame}\n`)
		assert.equal(reader.getMetrics().repairedTerminatorCount, 1)
		await reader.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL replay does not salvage an unterminated frame with a checksum failure", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-invalid-tail-"))
	try {
		const writer = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await writer.start()
		await writer.appendFrame("INSERT", "users", "user-1", { id: "user-1" }, true)
		await writer.stop()

		const walPath = path.join(workspaceRoot, ".broccolidb", "wal.log")
		const frame = JSON.parse(await readFile(walPath, "utf8")) as Record<string, unknown>
		frame.recordId = "tampered-id"
		const invalidFrame = JSON.stringify(frame)
		await writeFile(walPath, invalidFrame, "utf8")

		const reader = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await reader.start()
		await assert.rejects(reader.replay(), WalIntegrityError)
		assert.equal(await readFile(walPath, "utf8"), invalidFrame)
		await reader.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL flush failures remain retryable and visible in metrics", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-error-"))
	try {
		const wal = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await wal.start()
		const walPath = path.join(workspaceRoot, ".broccolidb", "wal.log")
		await mkdir(walPath, { recursive: true })
		await wal.appendFrame("INSERT", "users", "user-1", { id: "user-1" })
		await assert.rejects(wal.flush())
		assert.match(wal.getMetrics().lastError ?? "", /EISDIR|directory/i)

		await rm(walPath, { recursive: true, force: true })
		await wal.flush()
		assert.equal(wal.getMetrics().lastError, null)
		await wal.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL checksum serialization failures do not consume frame IDs", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-frame-id-"))
	try {
		const wal = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await wal.start()
		await assert.rejects(wal.appendFrame("INSERT", "users", "invalid", { value: BigInt(1) }), TypeError)
		await assert.rejects(wal.flush(), TypeError)
		await wal.appendFrame("INSERT", "users", "user-1", { id: "user-1" }, true)

		const frame = JSON.parse(
			await readFile(path.join(workspaceRoot, ".broccolidb", "wal.log"), "utf8"),
		) as { frameId: number }
		assert.equal(frame.frameId, 1)
		await wal.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL captures payload contents at append time", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-payload-snapshot-"))
	try {
		const wal = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await wal.start()
		const payload = { nested: { value: "before" } }
		const appended = await wal.appendFrame("INSERT", "users", "user-1", payload)
		payload.nested.value = "after"

		assert.deepEqual(appended.payload, { nested: { value: "before" } })
		const frames = await wal.replay()
		assert.deepEqual(frames[0].payload, { nested: { value: "before" } })
		await wal.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("kernel flush surfaces a rejected table payload with no queued WAL frame", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-invalid-table-record-"))
	try {
		const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await db.start()
		const table = db.getTable<{ id: string; value: bigint }>("items")
		table.put("invalid", { id: "invalid", value: BigInt(1) })
		await assert.rejects(db.flush(), TypeError)

		table.delete("invalid")
		await db.flush()
		await db.stop()

		const reopened = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await reopened.start()
		assert.equal(reopened.getTable("items").get("invalid"), undefined)
		await reopened.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("WAL uses bounded chunk targets and preserves an oversized frame", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-wal-chunks-"))
	try {
		const wal = new BroccoliWriteAheadLog(workspaceRoot, 0)
		await wal.start()
		const payload = { value: "x".repeat(2048) }
		for (let index = 0; index < 600; index++) {
			await wal.appendFrame("INSERT", "items", `item-${index}`, payload)
		}
		const oversizedValue = "y".repeat(1024 * 1024 + 16)
		await wal.appendFrame("INSERT", "items", "large-item", { value: oversizedValue })
		await wal.flush()
		const frames = await wal.replay()
		assert.equal(frames.length, 601)
		assert.equal(frames[600].payload?.value, oversizedValue)
		await wal.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("startup restore does not append replayed records back into the WAL", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-replay-quiet-"))
	try {
		const first = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await first.start()
		first.getTable("users").put("user-1", { id: "user-1", name: "Ada" })
		await first.flush()
		await first.stop()

		const second = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await second.start()
		await second.flush()
		const walPath = path.join(workspaceRoot, ".broccolidb", "wal.log")
		assert.equal((await readFile(walPath, "utf8")).trim().split("\n").length, 1)
		assert.deepEqual(second.getTable("users").get("user-1"), { id: "user-1", name: "Ada" })
		await second.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("CLEAR WAL frames are applied during restart replay", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-clear-replay-"))
	try {
		const first = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await first.start()
		const users = first.getTable("users")
		users.put("user-1", { id: "user-1" })
		users.put("user-2", { id: "user-2" })
		users.clear()
		await first.flush()
		await first.stop()

		const second = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await second.start()
		assert.equal(second.getTable("users").count(), 0)
		await second.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("an in-memory rollback remains restored after a restart", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-rollback-durable-"))
	try {
		const first = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await first.start()
		const users = first.getTable("users")
		users.put("user-1", { id: "user-1", state: "checkpointed" })
		const checkpoint = await first.checkpoint("rollback-durability")
		users.put("user-1", { id: "user-1", state: "changed" })
		assert.equal(await first.rollback(checkpoint.checkpointId), true)
		assert.deepEqual(users.get("user-1"), { id: "user-1", state: "checkpointed" })
		await first.stop()

		const second = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await second.start()
		assert.deepEqual(second.getTable("users").get("user-1"), { id: "user-1", state: "checkpointed" })
		await second.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("an on-disk rollback validates its snapshot hash and remains restored", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-disk-rollback-"))
	try {
		const first = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await first.start()
		const users = first.getTable("users")
		users.put("user-1", { id: "user-1", state: "checkpointed" })
		const checkpoint = await first.checkpoint("disk-rollback")
		const historyPath = path.join(workspaceRoot, ".broccolidb", "checkpoints", `${checkpoint.checkpointId}.json`)
		const originalHistory = await readFile(historyPath, "utf8")
		users.put("user-1", { id: "user-1", state: "changed" })
		await first.flush()
		await first.stop()

		const second = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await second.start()
		assert.deepEqual(second.getTable("users").get("user-1"), { id: "user-1", state: "changed" })
		assert.equal(await second.rollback("../package.json"), false)
		const tamperedHistory = JSON.parse(originalHistory) as {
			data: { formatVersion: number; tables: { users: Array<{ id: string; record: Record<string, unknown> }> } }
		}
		tamperedHistory.data.tables.users[0].record.state = "tampered"
		await writeFile(historyPath, JSON.stringify(tamperedHistory, null, 2), "utf8")
		assert.equal(await second.rollback(checkpoint.checkpointId), false)
		assert.deepEqual(second.getTable("users").get("user-1"), { id: "user-1", state: "changed" })
		await writeFile(historyPath, originalHistory, "utf8")
		assert.equal(await second.rollback(checkpoint.checkpointId), true)
		assert.deepEqual(second.getTable("users").get("user-1"), { id: "user-1", state: "checkpointed" })
		await second.stop()

		const third = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 })
		await third.start()
		assert.deepEqual(third.getTable("users").get("user-1"), { id: "user-1", state: "checkpointed" })
		await third.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("startup fails closed on a malformed base checkpoint", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-checkpoint-integrity-"))
	try {
		const first = new BroccoliDatabaseKernel({ workspaceRoot })
		await first.start()
		await first.stop()
		await writeFile(path.join(workspaceRoot, ".broccolidb", "checkpoint.db"), "{not-json", "utf8")

		const second = new BroccoliDatabaseKernel({ workspaceRoot })
		await assert.rejects(second.start(), CheckpointIntegrityError)
		await second.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("CAS read verification quarantines a damaged blob", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-cas-integrity-"))
	try {
		const cas = new BroccoliCASStorageService(workspaceRoot)
		await cas.start()
		const hash = await cas.store(Buffer.from("x".repeat(4096), "utf8"))
		const blobPath = path.join(cas.getBaseDir(), "blobs", hash.slice(0, 2), hash)
		const stored = await readFile(blobPath)
		stored[stored.length - 1] ^= 0xff
		await writeFile(blobPath, stored)

		await assert.rejects(cas.read(hash), StorageIntegrityError)
		const quarantined = await readdir(path.join(cas.getBaseDir(), "corrupt"))
		assert.ok(quarantined.some((entry) => entry.startsWith(`${hash}.`) && entry.endsWith(".corrupt")))
		await cas.store(Buffer.from("x".repeat(4096), "utf8"))
		assert.deepEqual(await cas.read(hash), Buffer.from("x".repeat(4096), "utf8"))
		assert.equal((await cas.getStats()).corruptCount, 1)
		await cas.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})

test("CAS rejects path-like identifiers and only sweeps valid blob files", async () => {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-cas-boundary-"))
	try {
		const cas = new BroccoliCASStorageService(workspaceRoot)
		await cas.start()
		const retainedHash = await cas.store(Buffer.from("retained", "utf8"))
		const orphanHash = await cas.store(Buffer.from("orphan", "utf8"))
		const shardDir = path.join(cas.getBaseDir(), "blobs", retainedHash.slice(0, 2))
		const temporaryPath = path.join(shardDir, `${retainedHash}.tmp.123`)
		await mkdir(shardDir, { recursive: true })
		await writeFile(temporaryPath, "unfinished", "utf8")

		await assert.rejects(cas.read("../package.json"), StorageIntegrityError)
		assert.equal(await cas.exists("../package.json"), false)
		assert.equal(await cas.pruneUnreferenced(new Set([retainedHash, "../package.json"])), 1)
		assert.equal(await cas.exists(retainedHash), true)
		assert.equal(await cas.exists(orphanHash), false)
		assert.equal((await readdir(shardDir)).includes(`${retainedHash}.tmp.123`), true)
		await cas.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})
