# Operations guide

BroccoliDB is embedded in the host process. There is no daemon to start, but
there is still an explicit lifecycle and a durable state directory to operate.

## Lifecycle

```ts
const db = new BroccoliDatabaseKernel({
  workspaceRoot: "/var/lib/my-app/state",
  walDebounceMs: 20,
})

await db.start()
try {
  // Register tables, read state, and perform mutations.
  // Call flush() when the buffered WAL must be written before continuing.
  await db.flush()
} finally {
  await db.stop()
}
```

Rules:

1. Await `start()` before reading or writing. Table mutations stay disabled
   while checkpoints, WAL frames, and SQL schemas are being restored.
2. Keep one kernel owner per workspace root in a process.
3. Use `transaction()` only when coordinating with other kernel mutex users;
   it is not an isolated or rollback-capable database transaction.
4. Use `flush()` before reporting a durable handoff to another component.
5. Use `checkpoint()` before long imports, migrations performed by the host, or
   risky workflows.
6. Always call `stop()` during normal shutdown.

`stop()` closes the kernel's table-write gate before its final WAL drain. Await
it before handing off the workspace; writes through kernel-owned tables are
rejected while stopping and after shutdown until `start()` is called again.

`start()` and `stop()` are idempotent at the service level. If the same kernel
instance is stopped and started again, its in-memory TTL deadlines are re-armed
after recovery. TTL deadlines are process-local and are not stored in WAL frames
or checkpoints. A fresh process must use an application-owned expiration field
and reconciliation pass when deadlines must survive process termination. A
process crash can still occur between an in-memory mutation and its asynchronous
WAL append; choose an explicit flush boundary when that window matters. A SQL
UPDATE or DELETE affecting multiple rows emits per-row WAL mutations; it is not
a single crash-atomic SQL transaction.

## Workspace selection

`workspaceRoot` defaults to `process.cwd()`. For applications with multiple
projects, use an explicit absolute or application-resolved path so state does
not accidentally follow the launch directory.

```ts
const db = new BroccoliDatabaseKernel({
  workspaceRoot: path.join(appDataDir, "broccolidb"),
})
```

Do not point two independent processes at the same workspace unless the host
provides an external single-writer or lease protocol. The built-in mutex only
coordinates async work inside one Node.js process.

## On-disk layout

| Path | Purpose | Safe to edit manually? |
|---|---|---|
| `.broccolidb/wal.log` | Pending and historical mutation frames | No |
| `.broccolidb/wal.log.old` | Previous WAL after checkpoint rotation | No |
| `.broccolidb/checkpoint.db` | Latest base table snapshot | No |
| `.broccolidb/checkpoints/<id>.json` | Named checkpoint history | No |
| `.broccolidb/cas/blobs/<shard>/<hash>` | CAS payloads | No |
| `.broccolidb/cas/corrupt/` | Quarantined payloads and manifest | Preserve for investigation |

The directory is application state and should be included in the host's backup
policy. It is ignored by the package repository's `.gitignore` because it is
runtime data, not source.

JSONSQL schemas live in the reserved internal table
`__broccolidb_jsonsql_catalog_v1`, alongside ordinary table data in checkpoints
and WAL frames. Back up the complete `.broccolidb/` directory to retain both
schema and rows. Do not edit or delete catalog rows by hand. `health()` excludes
this internal table from application table and record counts.

## Backup and restore

### Consistent backup

1. Stop the owning application, or quiesce all writes.
2. Await `db.flush()` and preferably `db.checkpoint("backup-<label>")`.
3. Copy the complete `.broccolidb/` directory to the backup target.
4. Record the package version and Node.js version with the backup.
5. Restart the application.

Copying only `checkpoint.db` omits checkpoint history, WAL state, and CAS blobs.
Copying only the CAS directory omits table records and references.

Checkpointing a running single-writer kernel preserves mutations appended after
the snapshot boundary in the WAL. A multi-file backup still needs a stopped or
quiesced application so `checkpoint.db`, history, WAL, and CAS are copied as
one consistent directory state.

### Restore

1. Stop the application.
2. Preserve the current state directory for forensic comparison.
3. Restore the complete backup directory into the configured workspace root.
4. Start the same or a compatible package version.
5. Run `health()` and verify representative table and blob reads.

Do not delete an invalid WAL before preserving it. A checksum failure is useful
evidence about an interrupted write, manual mutation, or storage problem.
Only a missing base checkpoint is fresh state. A base-checkpoint read,
JSON-parse, record-shape, or snapshot-hash failure raises
`CheckpointIntegrityError`; preserve the directory before retrying and do not
mistake a failed startup for recovery.

## Checkpoints and rollback

Use checkpoints as application-level restore points:

```ts
const beforeUpgrade = await db.checkpoint("before-upgrade")

try {
  await runHostUpgrade(db)
} catch (error) {
  const restored = await db.rollback(beforeUpgrade.checkpointId)
  if (!restored) throw new Error("Upgrade failed and rollback was unavailable", { cause: error })
}
```

`listCheckpoints()` reports records loaded or created in the current process.
After a restart, history files are available to `rollback(id)` when the ID is
known. Keep checkpoint IDs with the host's operation record if they are needed
for later recovery. A successful rollback writes replayable table-reset frames
and a rollback marker before it returns, so the restored state survives a clean
restart; tables created after the checkpoint remain unless the application
removes them explicitly.

## Health and observability

```ts
const report = await db.health()

if (report.status !== "HEALTHY") {
  console.warn(report.actionableRecommendations)
}
```

The report covers:

- state-directory writability and estimated CAS disk usage;
- CAS blob counts, quarantine counts, and raw/stored-byte compression accounting
  (a storage metric, not a performance benchmark);
- WAL frame totals, buffered frame count, last sync time, and the last WAL
  write error, when present;
- table count, record count, and an explicitly unverified index-parity field.

The table-consistency `indexParity` field is `null` because this lightweight
probe does not independently rebuild and compare every index.

The report is a lightweight operational probe. It does not replay the WAL, scrub every
CAS payload, independently verify table/index parity, replace a backup restore
test, or provide cross-process coordination.

## WAL maintenance

The default WAL debounce is 20 ms. Increase it only when the host accepts a
larger durability window; decrease it when write visibility matters more than
batching. `checkpoint()` flushes before rotation, retains a named history
snapshot and leaves a checkpoint marker in the WAL. `compact()` flushes and
rotates through a hashed base snapshot without retaining named history. It
returns `false` and leaves the WAL intact if newer frames cross the captured
boundary while the snapshot is written. Neither operation removes WAL frames
that arrive after a successful snapshot boundary.

Large flushes are split into append calls targeting 1 MiB each, followed by one
file sync for the batch. A single serialized frame larger than that target is
kept intact and may use a larger append call. If an append fails after writing
begins, BroccoliDB durably truncates back to the prior file boundary before it
allows a retry. If it cannot confirm that rollback, the WAL fails closed; stop
the owner, preserve the state directory, and reopen the WAL to replay/recover
instead of retrying in the same instance.

If WAL growth is persistent:

1. Confirm the process is calling `flush()` or `stop()`.
2. Inspect `health().pillars.walJournal`.
3. Use `compact()` to rotate the WAL when a restore point is not needed; use a
   named checkpoint after quiescing writes when history is needed.
4. Preserve `wal.log` and `wal.log.old` before manual intervention.

## CAS maintenance

Store a blob by retaining its returned hash in a record, conventionally as a
string such as `CAS:<hash>`:

```ts
const hash = await db.storeBlob(Buffer.from(payload))
table.put("document-1", { id: "document-1", blob: `CAS:${hash}` })
const bytes = await db.readBlob(hash)
```

`gc()` scans current table values for `CAS:` references and performs one sweep
removing other blob files. Only call it when all durable references are
represented in the currently loaded tables. External manifests, pending
imports, and backups are not discovered automatically.

CAS reads require the returned 64-character hexadecimal hash. Path-like or
malformed identifiers are rejected before filesystem access; `exists()` returns
`false` for an invalid identifier.

When CAS verification fails, the payload is moved under `cas/corrupt/` and an
entry is appended to `manifest.jsonl`. Preserve the quarantine directory before
attempting a restore.

## Security and data handling

- Choose a state directory with permissions appropriate for the records stored.
- Do not put secrets in natural-language queries, error messages, or checkpoint
  labels; labels are persisted in checkpoint history.
- Treat WAL, checkpoint, CAS, and quarantine files as sensitive application data.
- Validate record content before persistence; BroccoliDB does not encrypt files.
- Use an external lock/lease when more than one process can write the same root.
