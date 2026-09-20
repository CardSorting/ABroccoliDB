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
  // register tables, read state, and perform mutations
  await db.transaction(async () => {
    // related writes share one process-local lock
  })
  await db.flush()
} finally {
  await db.stop()
}
```

Rules:

1. Start once before reading or writing.
2. Keep one kernel owner per workspace root in a process.
3. Use `transaction()` for related async mutations.
4. Use `flush()` before reporting a durable handoff to another component.
5. Use `checkpoint()` before long imports, migrations performed by the host, or
   risky workflows.
6. Always call `stop()` during normal shutdown.

`start()` and `stop()` are idempotent at the service level. A process crash can
still occur between an in-memory mutation and its asynchronous WAL append;
choose an explicit flush or transaction boundary when that window matters.

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

## Backup and restore

### Consistent backup

1. Stop the owning application, or quiesce all writes.
2. Await `db.flush()` and preferably `db.checkpoint("backup-<label>")`.
3. Copy the complete `.broccolidb/` directory to the backup target.
4. Record the package version and Node.js version with the backup.
5. Restart the application.

Copying only `checkpoint.db` omits checkpoint history, WAL state, and CAS blobs.
Copying only the CAS directory omits table records and references.

### Restore

1. Stop the application.
2. Preserve the current state directory for forensic comparison.
3. Restore the complete backup directory into the configured workspace root.
4. Start the same or a compatible package version.
5. Run `health()` and verify representative table and blob reads.

Do not delete an invalid WAL before preserving it. A checksum failure is useful
evidence about an interrupted write, manual mutation, or storage problem.

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
for later recovery.

## Health and observability

```ts
const report = await db.health()

if (report.status !== "HEALTHY") {
  console.warn(report.actionableRecommendations)
}
```

The report covers:

- state-directory writability and estimated CAS disk usage;
- CAS blob counts, quarantine counts, and reported compression savings;
- WAL frame totals, buffered frame count, and last sync time;
- table count, record count, and current index-parity status.

The report is a fast operational probe. It does not replace a backup restore
test, a full application invariant check, or cross-process coordination.

## WAL maintenance

The default WAL debounce is 20 ms. Increase it only when the host accepts a
larger durability window; decrease it when write visibility matters more than
batching. `checkpoint()` flushes before rotation and leaves a new checkpoint
marker in the WAL.

If WAL growth is persistent:

1. Confirm the process is calling `flush()` or `stop()`.
2. Inspect `health().pillars.walJournal`.
3. Create a checkpoint after quiescing writes.
4. Preserve `wal.log` and `wal.log.old` before manual intervention.

## CAS maintenance

Store a blob by retaining its returned hash in a record, conventionally as a
string such as `CAS:<hash>`:

```ts
const hash = await db.storeBlob(Buffer.from(payload))
table.put("document-1", { id: "document-1", blob: `CAS:${hash}` })
const bytes = await db.readBlob(hash)
```

`gc()` scans current table values for `CAS:` references and removes all other
blob files. Only call it when all durable references are represented in the
currently loaded tables. External manifests, pending imports, and backups are
not discovered automatically.

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
