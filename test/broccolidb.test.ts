import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import test from "node:test"
import os from "node:os"
import path from "node:path"
import { BroccoliDatabaseKernel } from "../src/index.js"

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
		await second.stop()
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true })
	}
})
