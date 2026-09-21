# Design philosophy

BroccoliDB is intentionally smaller than a general-purpose database. Its design
optimizes for an embeddable application boundary where the owner can see the
tables, choose the workspace path, decide when to flush, and recover from
ordinary files.

## Principles

### 1. Memory is the hot path; durability is explicit

Table reads and indexes stay in memory. The WAL, checkpoint, and CAS layers are
explicit durability mechanisms rather than hidden database behavior. Callers
should know which boundary they have crossed:

| Boundary | Meaning |
|---|---|
| `put()`/`delete()` returned | The in-memory table changed; the WAL append was scheduled |
| `await db.flush()` | Buffered WAL frames were written |
| `await db.transaction(fn)` returned | The callback completed and the kernel flushed its WAL buffer |
| `await db.checkpoint()` returned | A base snapshot and checkpoint history were written, the WAL was rotated, and the checkpoint marker was flushed |
| `await db.stop()` returned | Kernel subsystems were flushed and stopped |

### 2. Files should be boring

The durable format uses JSON, JSONL, SHA-256, temporary files, and rename. This
makes state inspectable and transferable without a native reader. The trade-off
is that applications should not expect SQL joins, page-level indexes, or a
server-grade transaction log.

### 3. Integrity belongs at the boundary

WAL frames carry checksums and previous-frame metadata; replay checks declared
links and frame sequencing when present. CAS payloads are verified against their
requested SHA-256 address on read. Checkpoint snapshots include a hash. Corrupt
data should fail visibly or be quarantined; it should not silently be treated as
valid state. A missing base checkpoint is fresh state, while a read, parse,
record-shape, or snapshot-hash failure raises `CheckpointIntegrityError`.

### 4. Contracts are more stable than implementation details

Consumers program against `IDbTable`, `IBroccoliDatabaseKernel`, query types,
aggregate types, and change events. Internal index maps and file helpers may
change, but public signatures and documented lifecycle semantics require review.

### 5. Portability beats incidental compatibility

BroccoliDB does not preserve the removed SQLite package's SQL or driver API. The
supported path is the standalone `@noorm/broccolidb` package. Adapters should
translate application queries into the typed table/query contracts instead of
reintroducing a private compatibility layer.

### 6. Operational behavior must be legible

Health reports, checkpoint records, WAL metrics, CAS stats, and explicit error
types are preferable to opaque magic. The health report is a diagnostic probe,
not a substitute for an application-specific audit or backup test.

## Rejected alternatives

### Native SQLite binding as the package core

Rejected for this package because it adds native installation and ABI concerns.
Applications that need SQL should choose a dedicated SQL database; BroccoliDB is
the portable table substrate.

### A remote database service

Rejected because the package is designed for local, offline, process-owned state
and should not introduce networking, credentials, or service discovery.

### Implicit persistence on every mutation

Rejected because it couples latency and correctness decisions to an invisible
policy. Micro-batching plus explicit `flush()`, `transaction()`, and
`checkpoint()` calls make the boundary visible to the caller.

### Treating token estimates as billing truth

Rejected in `TokenCompressionService`. The four-characters-per-token estimate is
a rough budget signal; provider usage accounting remains the provider's concern.

## Boundaries

- The async mutex is process-local and re-entrant through async context.
- The kernel does not coordinate independent Node processes writing the same
  workspace.
- WAL replay validates frame checksums and reconstructs table mutations; it is
  not a general migration engine.
- CAS garbage collection is only safe when the referenced-hash set accurately
  reflects application records.
- Health probes report the implementation's current checks; they are not a
  full filesystem scrub or cross-process consistency protocol.
