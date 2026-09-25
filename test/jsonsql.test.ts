// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { BroccoliDatabaseKernel, JsonSqlError } from "../src/index.js";

const CREATE_USERS = `
  CREATE TABLE users (
    id TEXT,
    name TEXT NOT NULL,
    age INTEGER NOT NULL,
    team TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    email TEXT UNIQUE DEFAULT 'unknown@example.com',
    profile JSON,
    PRIMARY KEY (id),
    UNIQUE (team, name)
  )
`;

async function createWorkspace() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "broccolidb-jsonsql-"));
  const db = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 });
  await db.start();
  return { db, workspaceRoot };
}

test("JSONSQL prepares typed tables and uses bound values with SQL boolean precedence", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  try {
    assert.deepEqual(db.sql.prepare(CREATE_USERS).run(), { changes: 1 });
    assert.deepEqual(db.sql.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)").run(), { changes: 0 });

    const insert = db.sql.prepare("INSERT INTO users (id, name, age, team, email, profile) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("ada", "Ada", 37, "platform", "ada@example.com", { editor: "vim", tags: ["db", "node"] });
    insert.run("grace", "Grace", 42, "platform", "grace@example.com", { editor: "vim" });
    insert.run("linus", "Linus", 33, "systems", null, null);

    const query = db.sql.prepare(`
      SELECT id, name AS display_name
      FROM users
      WHERE (team = ? AND active = TRUE) OR age >= ?
      ORDER BY age DESC, name ASC
      LIMIT ? OFFSET ?
    `);
    assert.deepEqual(query.all("platform", 40, 10, 0), [
      { id: "grace", display_name: "Grace" },
      { id: "ada", display_name: "Ada" },
    ]);
    assert.equal(query.get("platform", 40, 1, 0)?.display_name, "Grace");
    assert.equal(db.sql.prepare("SELECT id FROM users WHERE email IS NULL").all().length, 1);
    assert.equal(db.sql.prepare("SELECT id FROM users WHERE email = ?").all(null).length, 0);
    assert.deepEqual(db.sql.prepare("SELECT id FROM users WHERE name LIKE ?").all("A%"), [{ id: "ada" }]);
    db.getTable("users").put("ada-line", {
      id: "ada-line", name: "Ada\n", age: 38, team: "test", email: null,
    });
    assert.deepEqual(db.sql.prepare("SELECT id FROM users WHERE name LIKE ?").all("Ada"), [{ id: "ada" }]);
    assert.deepEqual(db.sql.prepare("SELECT id FROM users WHERE name LIKE ?").all("A_a"), [{ id: "ada" }]);

    const stored = db.sql.prepare("SELECT * FROM users WHERE id = ?").get("ada");
    assert.deepEqual(stored, {
      id: "ada", name: "Ada", age: 37, team: "platform", active: true,
      email: "ada@example.com", profile: { editor: "vim", tags: ["db", "node"] },
    });
  } finally {
    await db.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("JSONSQL compares JSON values structurally and normalizes sparse arrays", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  try {
    db.sql.prepare("CREATE TABLE documents (id TEXT PRIMARY KEY, value JSON NOT NULL)").run();
    const sparse: unknown[] = new Array(2);
    sparse[1] = "kept";
    const insert = db.sql.prepare("INSERT INTO documents (id, value) VALUES (?, ?)");
    insert.run("object", { b: 2, a: 1 });
    insert.run("other", { a: 2 });
    insert.run("sparse", sparse);

    assert.deepEqual(
      db.sql.prepare("SELECT id FROM documents WHERE value = ?").all({ a: 1, b: 2 }),
      [{ id: "object" }],
    );
    assert.deepEqual(
      db.sql.prepare("SELECT id FROM documents WHERE value != ? ORDER BY id").all({ a: 1, b: 2 }),
      [{ id: "other" }, { id: "sparse" }],
    );
    assert.deepEqual(
      db.sql.prepare("SELECT id FROM documents WHERE NOT (value = ?) ORDER BY id").all({ a: 1, b: 2 }),
      [{ id: "other" }, { id: "sparse" }],
    );
    assert.deepEqual(db.sql.prepare("SELECT value FROM documents WHERE id = ?").get("sparse"), {
      value: [null, "kept"],
    });
  } finally {
    await db.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("JSONSQL bounds synchronous LIKE work per query", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  try {
    db.sql.prepare("CREATE TABLE texts (id TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
    db.sql.prepare("INSERT INTO texts (id, value) VALUES (?, ?)").run("large", "x".repeat(4_000));

    assert.throws(
      () => db.sql.prepare("SELECT id FROM texts WHERE value LIKE ?").all("%_".repeat(1_250)),
      (error: unknown) => error instanceof JsonSqlError && error.code === "ERR_JSONSQL_RESOURCE_LIMIT",
    );
  } finally {
    await db.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("JSONSQL DML validates constraints before changing rows", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  try {
    db.sql.prepare(CREATE_USERS).run();
    db.sql.prepare("INSERT INTO users (id, name, age, team, email) VALUES (?, ?, ?, ?, ?)")
      .run("ada", "Ada", 37, "platform", "ada@example.com");
    db.sql.prepare("INSERT INTO users (id, name, age, team, email) VALUES (?, ?, ?, ?, ?)")
      .run("grace", "Grace", 42, "platform", "grace@example.com");

    assert.throws(
      () => db.sql.prepare("INSERT INTO users (id, name, age, team, email) VALUES (?, ?, ?, ?, ?)")
        .run("other", "Other", 25, "platform", "ada@example.com"),
      (error: unknown) => error instanceof JsonSqlError && error.code === "ERR_JSONSQL_CONSTRAINT",
    );
    assert.throws(
      () => db.sql.prepare("UPDATE users SET name = ? WHERE id = ?").run(null, "ada"),
      (error: unknown) => error instanceof JsonSqlError && error.code === "ERR_JSONSQL_CONSTRAINT",
    );
    const users = db.getTable("users");
    users.put("manual-a", { id: "manual-a", name: "Manual A", age: 21, team: "ops" });
    assert.throws(
      () => users.put("manual-b", { id: "manual-b", name: "Manual B", age: 22, team: "ops" }),
      (error: unknown) => error instanceof JsonSqlError && error.code === "ERR_JSONSQL_CONSTRAINT",
    );
    assert.throws(
      () => users.putMany([
        { id: "bulk-a", record: { id: "bulk-a", name: "Bulk A", age: 23, team: "ops", email: "shared@example.com" } },
        { id: "bulk-b", record: { id: "bulk-b", name: "Bulk B", age: 24, team: "ops", email: "shared@example.com" } },
      ]),
      (error: unknown) => error instanceof JsonSqlError && error.code === "ERR_JSONSQL_CONSTRAINT",
    );
    assert.equal(users.get("bulk-a"), undefined);
    assert.throws(() => users.transaction((tx) => {
      tx.put("tx-a", { id: "tx-a", name: "Tx A", age: 25, team: "ops", email: "tx@example.com" });
      tx.put("tx-b", { id: "tx-b", name: "Tx B", age: 26, team: "ops", email: "tx@example.com" });
    }), /UNIQUE constraint failed/);
    assert.equal(users.get("tx-a"), undefined);
    assert.equal(db.sql.prepare("SELECT name FROM users WHERE id = ?").get("ada")?.name, "Ada");

    assert.throws(
      () => db.sql.prepare("UPDATE users SET email = ? WHERE team = ?").run("shared@example.com", "platform"),
      (error: unknown) => error instanceof JsonSqlError && error.code === "ERR_JSONSQL_CONSTRAINT",
    );
    assert.equal(db.sql.prepare("SELECT email FROM users WHERE id = ?").get("ada")?.email, "ada@example.com");
    assert.equal(db.sql.prepare("SELECT email FROM users WHERE id = ?").get("grace")?.email, "grace@example.com");
    assert.deepEqual(db.sql.prepare("UPDATE users SET age = ? WHERE id = ?").run(38, "ada"), { changes: 1 });
    assert.deepEqual(db.sql.prepare("DELETE FROM users WHERE age > ? AND active = FALSE").run(40), { changes: 0 });
    assert.deepEqual(db.sql.prepare("DELETE FROM users WHERE team = ?").run("platform"), { changes: 2 });
    assert.deepEqual(db.sql.prepare("DELETE FROM users WHERE id = ?").run("manual-a"), { changes: 1 });
    assert.deepEqual(db.sql.prepare("SELECT id FROM users").all(), []);
  } finally {
    await db.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("unique indexes stay correct across swaps, replacements, and key reuse", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  try {
    db.sql.prepare("CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE)").run();
    const accounts = db.getTable("accounts");
    accounts.putMany([
      { id: "a", record: { id: "a", email: "a@example.test" } },
      { id: "b", record: { id: "b", email: "b@example.test" } },
    ]);

    // A batch can exchange unique values because constraints apply to the
    // resulting state, and index maintenance must remove all old keys first.
    accounts.putMany([
      { id: "a", record: { id: "a", email: "b@example.test" } },
      { id: "b", record: { id: "b", email: "a@example.test" } },
    ]);
    assert.deepEqual(accounts.get("a"), { id: "a", email: "b@example.test" });
    assert.deepEqual(accounts.get("b"), { id: "b", email: "a@example.test" });

    assert.equal(accounts.delete("b"), true);
    accounts.put("c", { id: "c", email: "a@example.test" });
    assert.throws(() => accounts.put("d", { id: "d", email: "b@example.test" }), /UNIQUE constraint failed/);
    assert.equal(accounts.get("d"), undefined);
  } finally {
    await db.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("JSONSQL rejects malformed statements, unsafe bindings, and multiple statements", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  try {
    db.sql.prepare(CREATE_USERS).run();
    const insert = db.sql.prepare("INSERT INTO users (id, name, age, team) VALUES (?, ?, ?, ?)");
    assert.throws(() => insert.run("one", "One", 1), /Expected 4 SQL bindings/);
    assert.throws(() => insert.run("one", "One", "1", "x"), /must be INTEGER/);
    assert.throws(() => db.sql.prepare("SELECT * FROM users; DELETE FROM users"), /Only one SQL statement/);
    assert.throws(() => db.sql.prepare("SELECT * FROM users WHERE missing IS NULL").all(), /Unknown column users.missing/);
    assert.throws(() => db.sql.prepare("UPDATE users SET name = ? WHERE missing = ?").run("x", "y"), /Unknown column users.missing/);
    assert.throws(() => db.sql.prepare("INSERT users (id) VALUES (?)"), /Expected INTO/);
    assert.throws(() => db.sql.prepare("SELECT id, name AS id FROM users"), /output names must be unique/);
    assert.throws(() => db.sql.prepare("CREATE TABLE bad (id TEXT PRIMARY KEY, payload JSON UNIQUE)"), /scalar columns/);
    assert.throws(() => db.sql.prepare("CREATE TABLE bad (id TEXT PRIMARY KEY, name TEXT NOT NULL NULL)"), /nullability more than once/);
    assert.throws(() => db.sql.prepare("CREATE TABLE bad (id TEXT PRIMARY KEY, count INTEGER DEFAULT 'many')"), /DEFAULT.*declared INTEGER type/);
    assert.throws(() => db.sql.prepare("SELECT * FROM users WHERE name = ?").all("x", "extra"), /Expected 1 SQL binding/);
    assert.throws(() => db.sql.prepare("INSERT INTO users (id, name, age, team) VALUES (?, ?, ?, ?)")
      .run("bad", "Bad", Number.NaN, "x"), /finite numbers/);

    const safeInsert = db.sql.prepare("INSERT INTO users (id, name, age, team) VALUES (?, ?, ?, ?)");
    safeInsert.run("safe", "x' OR TRUE --", 7, "x");
    assert.deepEqual(db.sql.prepare("SELECT id FROM users WHERE name = ?").all("x' OR TRUE --"), [{ id: "safe" }]);
  } finally {
    await db.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("JSONSQL schemas and rows survive WAL recovery without appearing as application tables", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  try {
    db.sql.prepare(CREATE_USERS).run();
    db.sql.prepare("INSERT INTO users (id, name, age, team) VALUES (?, ?, ?, ?)")
      .run("ada", "Ada", 37, "platform");
    await db.flush();
    await db.stop();

    const reopened = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 });
    await reopened.start();
    try {
      assert.deepEqual(reopened.sql.prepare("SELECT id, active FROM users WHERE id = ?").get("ada"), {
        id: "ada", active: true,
      });
      assert.equal((await reopened.health()).pillars.tableConsistency.tableCount, 1);
    } finally {
      await reopened.stop();
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rollback refreshes the JSONSQL catalog while retaining post-checkpoint tables", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  let activeDb = db;
  try {
    const checkpoint = await db.checkpoint("before-sql-table");
    db.sql.prepare("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)").run();
    db.sql.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run("n1", "temporary");

    assert.equal(await db.rollback(checkpoint.checkpointId), true);
    assert.deepEqual(db.sql.prepare("SELECT * FROM notes").all(), [{ id: "n1", body: "temporary" }]);
    // The kernel retains post-checkpoint tables and their JSONSQL schemas.
    assert.equal(db.getTable("notes").get("n1")?.body, "temporary");
    await db.flush();
    await db.stop();

    activeDb = new BroccoliDatabaseKernel({ workspaceRoot, walDebounceMs: 0 });
    await activeDb.start();
    assert.deepEqual(activeDb.sql.prepare("SELECT * FROM notes").all(), [{ id: "n1", body: "temporary" }]);
  } finally {
    await activeDb.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rollback removes newer constraints before restoring checkpointed legacy rows", async () => {
  const { db, workspaceRoot } = await createWorkspace();
  try {
    db.getTable("legacy_notes").put("n1", { id: "n1", body: "legacy" });
    const checkpoint = await db.checkpoint("before-schema");
    db.sql.prepare("CREATE TABLE legacy_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();

    assert.equal(await db.rollback(checkpoint.checkpointId), true);
    assert.throws(
      () => db.sql.prepare("SELECT * FROM legacy_notes").all(),
      (error: unknown) => error instanceof JsonSqlError && error.code === "ERR_JSONSQL_SCHEMA",
    );
    db.getTable("legacy_notes").put("n2", { id: "n2" });
    assert.equal(db.getTable("legacy_notes").count(), 2);
  } finally {
    await db.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
