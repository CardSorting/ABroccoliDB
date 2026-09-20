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
3. **Checkpoints** write a complete JSON base snapshot and rotate the WAL.
4. **CAS** stores large or reusable byte payloads by SHA-256 content address.
5. **Mutex and transactions** serialize related async mutations in one process.

## Guarantees

- The package has no production dependencies or native database driver.
- Reads and index lookups use in-memory table state.
- `flush()` writes buffered WAL frames; `stop()` flushes before returning.
- `start()` loads a checkpoint and replays readable WAL frames.
- Checkpoint files are written through a temporary file and rename.
- CAS reads verify the content hash and quarantine corrupted payloads.
- Query, aggregation, natural-query, and prompt-compression helpers are
  deterministic and offline.

These guarantees are deliberately narrower than a replicated database. See
[Operations](OPERATIONS.md) for durability boundaries and process limitations.

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
