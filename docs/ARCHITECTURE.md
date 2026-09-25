# Architecture

BroccoliDB is a four-layer embedded kernel with a process-local coordination
boundary. The layers are deliberately composable: tables can be used directly,
while the kernel adds WAL, checkpoints, CAS, and lifecycle management.

## Layer map

```mermaid
flowchart TB
    K[BroccoliDatabaseKernel]
    Q[JSONSQL subset parser\nprepared statements · table constraints]
    T[Reactive in-memory tables\nCRUD · indexes · filters · CDC · TTL]
    W[Write-ahead log\nJSONL · checksum frames · micro-batching]
    C[Checkpoints\ntemp+rename base snapshot · timeline history]
    S[CAS vault\nSHA-256 read check · Brotli · quarantine · sweep]
    M[ReentrantAsyncMutex\nprocess-local async coordination]

    K --> T
    K --> Q
    Q --> T
    K --> W
    K --> C
    K --> S
    K --> M
    T --> W
    T --> C
    T -. CAS:hash references .-> S
```

| Layer | Responsibility | Implementation |
|---|---|---|
| **JSONSQL** | Prepared, single-table SQL-shaped statements and schemas over the table layer | `src/broccolidb-jsonsql.ts` |
| **L1 tables** | In-memory records, indexes, filtering, aggregation, fluent queries, TTL, CDC | `src/broccolidb-table.ts` |
| **L2 WAL** | Append mutation frames, micro-batched flush, per-frame checksum validation, replay, rotation | `src/broccolidb-wal.ts` |
| **L3 CAS** | Content-addressed blobs, conditional Brotli encoding, read hash verification, quarantine, reference-set sweep | `src/broccolidb-cas.ts` |
| **L4 snapshots** | Temp+rename base-file replacement, WAL compaction, separate named checkpoint history and rollback metadata | `src/broccolidb-kernel.ts` |
| **Coordination** | Re-entrant async lock for kernel callbacks and serialized compaction/checkpoint/rollback operations | `src/broccolidb-mutex.ts` |
| **Contracts** | Public types and behavior vocabulary | `src/broccolidb.contracts.ts` |

## Startup and recovery

`start()` is idempotent. The kernel performs the following sequence:

1. Create `.broccolidb/` and its checkpoint directory.
2. Start the CAS service and WAL service.
3. Load `.broccolidb/checkpoint.db` if it exists. Current checkpoint envelopes
   preserve table application keys and verify their snapshot hash; legacy
   value-array snapshots remain readable.
4. Replay frames remaining in `.broccolidb/wal.log`.
5. Restore the JSONSQL schema catalog and reattach type/unique constraints after
   table data has been rebuilt.
6. Mark the kernel started.

The table-write gate stays closed until the entire recovery sequence completes.
Checkpoint and WAL restoration use internal table operations that do not emit
normal mutation events or append duplicate WAL frames. This prevents retained
table references from changing data while recovery is in progress.

Checkpoint data is loaded into tables before WAL replay. A missing base snapshot
is treated as a fresh database. A base-file read, JSON-parse, record-shape, or
snapshot-hash failure raises `CheckpointIntegrityError`; it is not silently
converted into an empty database. A malformed, checksum-invalid,
sequence-invalid, or discontinuously linked WAL frame is a `WalIntegrityError`
and should be investigated rather than silently discarded. An invalid,
unterminated final JSONL tail is repairable: replay validates the complete
prefix, truncates the tail, and reports recovered bytes through
`health().pillars.walJournal`.

JSONSQL schemas are ordinary rows in the reserved internal table
`__broccolidb_jsonsql_catalog_v1`. They are included in checkpoint data and WAL
replay; `health()` and checkpoint summary counts exclude this metadata table.
After recovery, the kernel validates catalog records and existing rows before
enabling their typed-table constraints. A malformed schema or data row fails
startup with `JsonSqlError` rather than silently disabling those checks.

## Mutation flow

```mermaid
sequenceDiagram
    participant App
    participant Table
    participant Kernel
    participant WAL

    App->>Kernel: getTable("users")
    Kernel-->>App: IDbTable<User>
    App->>Table: put(id, record)
    Table->>Table: update record and indexes
    Table-->>App: record
    Table->>Kernel: WAL hook (async append)
    Kernel->>WAL: append frame
    WAL-->>WAL: debounce / batch
    App->>Kernel: flush or transaction
    Kernel->>WAL: write JSONL frames
```

The table mutation is synchronous from the caller's perspective. The table's
WAL hook schedules an asynchronous frame append, so callers that need a durable
boundary must await `flush()`, a successful `transaction()` callback,
`compact()`, `checkpoint()`, or `stop()`. `transaction()` holds the process-local
mutex but does not isolate direct table writes or provide rollback.

## Checkpoint flow

`checkpoint(label)` runs under the kernel mutex:

1. Flush pending WAL frames.
2. Serialize every currently registered table with its application key in the
   versioned checkpoint envelope and capture the WAL frame boundary represented
   by that snapshot.
3. Compute a SHA-256 snapshot hash.
4. Write and sync a temporary base file, rename it to `checkpoint.db`, then sync
   its parent directory where supported.
5. Write and sync a named history file under `checkpoints/<checkpointId>.json`.
6. Cache the timeline record and in-memory snapshots.
7. Rotate the WAL through the captured frame boundary and synchronously append
   the checkpoint marker. Frames added after the snapshot boundary remain in
   the WAL; new frame assignment waits briefly while the atomic rotation runs.

The current base payload is a versioned JSON envelope so records whose value
does not contain an `id` field still retain their table key. Legacy value-array
payloads remain readable, but a legacy record without an embedded `id` cannot
recover its original key because that older format did not store it. The
current envelope hash is verified before startup loads its records. Checkpoint
IDs are constrained to single path-safe identifiers before history paths are
constructed. The synced temporary-file-plus-rename write keeps the prior named
base path in place until replacement. Base snapshot, history, and WAL rotation
remain separate operations, not a cross-file transaction. If history or rotation
fails, the synced base snapshot and remaining WAL can still be replayed on the
next startup. Checkpoint history is ordinary JSON and is copied with the rest of
`.broccolidb/`.

## WAL compaction flow

`compact()` writes the same hashed base envelope as a checkpoint, but does not
create a timeline record, history file, or in-memory rollback snapshot. It
captures the represented WAL frame boundary before writing the base file, then
rotates only through that boundary and appends a compact marker. If newer frames
cross the boundary before rotation, the method returns `false` and leaves the
WAL intact; replaying those frames on top of the equivalent base snapshot is
safe. Use it to reclaim append-only history when a named restore point is not
needed; use `checkpoint()` when timeline rollback is required.

## Rollback flow

`rollback(checkpointId)` first checks the process-local snapshot cache. If the
checkpoint was created in the current process, it restores those maps directly.
Otherwise it loads the checkpoint history JSON and rebuilds the tables named by
the checkpoint. Both paths write replayable `CLEAR`/`INSERT` frames followed by
a rollback marker, so the restored state survives a clean restart. Tables
created after the checkpoint are not removed automatically. The method returns
`false` for an unknown, path-unsafe, unreadable, malformed, or hash-mismatched
history record.

Rollback is an application state operation, not a distributed transaction or a
schema migration. Take a backup before destructive rollback workflows.

## Table execution model

Each table owns:

- a `Map<string, T>` of records;
- equality maps for exact lookups;
- sorted entries for range/order queries;
- composite maps keyed by field tuples;
- prefix maps for string-prefix lookups;
- subscriptions and TTL timers;
- the query, aggregation, and fluent-builder helpers.

Constraint-backed tables validate a write batch before changing records, then
update only the unique-index entries touched by that batch. This keeps repeated
single-row writes proportional to the number of constraints instead of
rescanning the full table after every write. Bulk operations such as `putMany()`
and `deleteMany()` amortize validation and index maintenance across their
affected rows; WAL durability remains a separate asynchronous flush boundary.

The query planner reports the selected `scanStrategy`, matched index, candidate
count, match count, and elapsed microseconds through `explain()`. A query can
fall back to `FULL_TABLE_SCAN`; creating an index is an optimization, not a
semantic requirement.

JSONSQL parses each prepared string once and evaluates bound values over the
same table records. It currently scans and materializes rows for SELECT and
does not use the table query planner. Its subset includes explicit typed table
schemas, common predicates, ordering, pagination, and single-table CRUD. The
catalog has no `ALTER TABLE` or `DROP TABLE` path; schema evolution is an
application-owned migration, and a migration should checkpoint and validate its
data explicitly. See the [JSONSQL API contract](API.md#jsonsql) for exact syntax
and type behavior.

## CAS model

The CAS service hashes raw content before storage. Blobs are sharded by the
first two hash characters and stored with a small format marker:

- `BR_RAW\0` for uncompressed bytes;
- `BR_BRZ\0` for Brotli-compressed bytes when the compressed representation
  meets the savings threshold.

Reads decompress when needed, recompute the raw SHA-256, and quarantine a blob
when decompression or hash verification fails. Public identifiers must match a
64-character hexadecimal SHA-256 shape before a path is constructed. The stats
path best-effort accounts for raw bytes by decoding the stored marker with a
bounded 64 MiB Brotli output budget; `compressionSavingsPct` is a storage
metric, not a performance benchmark.
`BroccoliDatabaseKernel.gc()` builds a reference set from string fields beginning
with `CAS:` in current table records and passes that set to the CAS single-sweep
pruner. External manifests, pending imports, and backups are not discovered.

## Failure model

| Failure | Behavior | Caller action |
|---|---|---|
| Missing workspace directory | Created on `start()` | Normal startup |
| Missing checkpoint | Treated as fresh state | Continue or restore a backup |
| Base checkpoint read/parse/shape/hash failure | `CheckpointIntegrityError` during startup | Preserve the directory, inspect/restore, then retry |
| Invalid WAL JSON/checksum/link/sequence | `WalIntegrityError` during replay | Preserve the directory, inspect/restore, then retry |
| Unreadable CAS blob | `null` for missing blob; integrity error for corruption | Inspect quarantine manifest and restore if needed |
| Non-writable state directory | Health status is degraded/corrupted | Fix permissions or choose another root |
| Mutex wait exceeds timeout | `DeadlockTimeoutError` (a wait timeout, not proof of a deadlock) | Find long-held/nested lock or reduce contention |
| Process termination before flush | Recent buffered frames may be absent | Use explicit flush boundaries; `transaction()` flushes on success but does not provide rollback |

## Implementation map

| Concern | File |
|---|---|
| Export surface | `src/index.ts` |
| Types and public contracts | `src/broccolidb.contracts.ts` |
| Kernel lifecycle and recovery | `src/broccolidb-kernel.ts` |
| Table/index/query behavior | `src/broccolidb-table.ts` |
| Aggregation | `src/broccolidb-aggregation.ts` |
| Natural-language parser | `src/broccolidb-natural-query.ts` |
| WAL | `src/broccolidb-wal.ts` |
| CAS | `src/broccolidb-cas.ts` |
| Mutex | `src/broccolidb-mutex.ts` |
| Prompt compression | `src/TokenCompressionService.ts` |
| Contract tests | `test/` |
