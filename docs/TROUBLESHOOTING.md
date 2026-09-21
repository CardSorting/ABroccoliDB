# Troubleshooting

Use the symptom → likely cause → action flow below. Preserve `.broccolidb/`
before destructive recovery work.

## Startup and recovery

### `start()` throws `WalIntegrityError`

**Likely causes:** a truncated JSONL write, hand-edited WAL, filesystem
corruption, or a package/version mismatch that changed frame serialization.

**Action:** stop all writers, copy the entire `.broccolidb/` directory, inspect
the failing line and checksum message, and restore the last known-good backup if
the WAL cannot be repaired. Do not delete the WAL as a first response.

### `start()` throws `CheckpointIntegrityError`

**Likely causes:** the base checkpoint is unreadable, malformed JSON, has a
table value that is not a record array, or has a snapshot hash that no longer
matches its content. A missing checkpoint is the only base checkpoint condition
treated as a fresh database.

**Action:** preserve the entire `.broccolidb/` directory, inspect the checkpoint
and backup, and restore a known-good state directory before retrying. Do not
replace a damaged checkpoint with an empty file as a recovery shortcut.

### Data is missing after a process crash

**Likely cause:** a mutation changed memory but its asynchronous WAL append had
not been flushed before termination.

**Action:** use `transaction()`, `flush()`, or `checkpoint()` at the host's
durability boundary. BroccoliDB cannot recover a frame that never reached the
WAL.

### Startup is slow

**Likely causes:** a large WAL tail, a large checkpoint, or too many records
being rebuilt into indexes.

**Action:** measure startup with the same workload, inspect WAL metrics, quiesce
writes, and create a checkpoint. Keep tables bounded or partition application
state when a single in-memory table becomes too large.

## Tables and queries

### A query is correct but slower than expected

**Likely cause:** no matching index exists or the predicate cannot use the
available index shape.

**Action:** call `select().where(...).explain()`, inspect `scanStrategy`, and add
an equality, sorted, composite, or prefix index that matches the hot predicate.
Do not assume an index changes semantics; it changes candidate selection.

### An index appears stale

**Likely causes:** records were restored with a custom snapshot, a host kept a
second table reference, or application code mutated an object after passing it
to the table.

**Action:** treat records as immutable application values, use table mutation
methods, and rebuild the table/indexes through a controlled restore if needed.

### TTL behavior is surprising

**Likely cause:** TTL timers are process-local and depend on the process staying
alive; an expired record is not a durable scheduler job.

**Action:** use TTL for local cache-like expiration. For business deadlines,
persist an explicit expiration field and run a host-owned reconciliation pass.

## Checkpoints and rollback

### `rollback(id)` returns `false`

**Likely causes:** the ID is unknown, history was not copied with the backup, or
the checkpoint file is unreadable.

**Action:** call `listCheckpoints()`, verify
`.broccolidb/checkpoints/<id>.json`, and restore the complete state directory if
the file is missing.

### Rollback did not remove a table created later

**Likely cause:** rollback rebuilds tables represented by the checkpoint; it is
not a schema registry that automatically deletes every table absent from a
historical snapshot.

**Action:** explicitly clear or recreate application tables as part of the
rollback procedure, then checkpoint the resulting state.

## CAS

### `readBlob(hash)` returns `null`

**Likely cause:** the hash is absent from the configured workspace or the host
opened a different `workspaceRoot`.

**Action:** log the resolved root, compare `cas.getBaseDir()`, and restore the
CAS directory from the matching backup.

### `StorageIntegrityError` is raised

**Likely cause:** the identifier is not a 64-character hexadecimal SHA-256 hash,
or a payload failed Brotli decompression or SHA-256 verification.

**Action:** preserve `cas/corrupt/manifest.jsonl`, inspect the quarantined blob,
and restore a known-good backup. Do not overwrite the quarantine entry before
capturing it.

### `gc()` deleted data needed by the application

**Likely cause:** the reference was not stored in a currently loaded table as a
`CAS:<hash>` string.

**Action:** restore from backup and make references explicit before rerunning GC.
`gc()` is conservative only with respect to the references it can see.

## Locking and concurrency

### `DeadlockTimeoutError`

**Likely causes:** a callback awaited a long-running operation while holding the
lock, nested operations are waiting on another resource, or two application
components use locks in inconsistent order.

**Action:** keep transaction callbacks short, avoid external network calls while
holding the kernel lock, and review lock ordering. The mutex is re-entrant for
the same async context, but it is not a general deadlock solver.

### Two processes see divergent state

**Likely cause:** both processes wrote the same `.broccolidb/` directory. The
package does not provide cross-process fencing.

**Action:** assign one writer, put an external lease around the workspace, or
choose a database designed for multi-process coordination.

## Packaging and imports

### `ERR_MODULE_NOT_FOUND` for internal imports

**Likely cause:** the package was copied without building `dist/`, or a consumer
is bypassing the package export and importing source files incorrectly.

**Action:** run `npm run build`, import from `@noorm/broccolidb`, and inspect the
`files` list with `npm pack --dry-run`.

### A native SQLite package appears in the dependency tree

**Likely cause:** the host application installed an unrelated database package
or a stale lockfile was copied into the package.

**Action:** run `npm ls --omit=dev --depth=0`, inspect the host's dependency
graph, and keep BroccoliDB's runtime `dependencies` object empty.
