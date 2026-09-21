# BroccoliDB brief

## Problem

Applications often need a small, local state substrate with indexed records,
durability, recovery, and predictable behavior. A native SQLite binding can be
excellent, but it introduces platform-specific binaries, rebuilds, ABI coupling,
and dependency installation failure modes that are disproportionate for an
embedded table workload.

## Solution

BroccoliDB keeps the hot path in ordinary JavaScript/TypeScript memory and adds
explicit filesystem layers only where durability needs them:

1. **Reactive tables** hold typed records and maintain secondary indexes.
2. **WAL** appends mutation frames and replays them after a restart.
3. **Checkpoints** write a versioned JSON base snapshot that preserves
   application keys and rotate the WAL.
4. **CAS** stores large or reusable byte payloads by SHA-256 content address.
5. **Mutex and transactions** serialize related async mutations in one process.

## Guarantees

- The package has no production dependencies or native database driver.
- Reads and index lookups use in-memory table state.
- `flush()` writes buffered WAL frames; `stop()` flushes before returning.
- `start()` loads a checkpoint and replays WAL frames; invalid checkpoint data
  or its snapshot hash raises `CheckpointIntegrityError`, while invalid WAL
  JSON, checksums, links, or frame sequences raise `WalIntegrityError`.
- The versioned base checkpoint preserves application keys and is written
  through a temporary file and rename; its snapshot hash is checked on startup;
  history and WAL rotation are separate operations.
- CAS reads verify the content hash and quarantine corrupted payloads.
- Query, aggregation, natural-query, and prompt-compression helpers are
  deterministic and offline.

These guarantees are deliberately narrower than a replicated database. The
health report is a lightweight operational probe, and the CAS statistics field
named `compressionSavingsPct` is storage accounting, not a performance
benchmark. See
[Operations](OPERATIONS.md) for durability boundaries and process limitations.

A missing checkpoint is fresh state; a base-checkpoint read, JSON-parse,
record-shape, or snapshot-hash failure raises `CheckpointIntegrityError`.
Preserve the state directory before retrying or restoring.

## Good fit

- Extension or CLI-local state
- Agent/session tables
- Durable caches and indexes scoped to one workspace
- Embedded tools that need rollback checkpoints
- Portable test fixtures and hermetic local storage

## Not a fit

- Multiple writers across independent processes without external coordination
- Cross-machine replication or consensus
- SQL dialect compatibility or migrations from arbitrary relational schemas
- Provider billing/token accounting
- Large analytical datasets that do not fit comfortably in memory

## Decision in one sentence

Use a small, inspectable, dependency-free table kernel when portability and
application-owned durability matter more than SQL compatibility or distributed
database features.
