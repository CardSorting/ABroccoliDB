# ADR-001: Portable in-memory kernel with explicit filesystem durability

- **Status:** Accepted
- **Date:** 2026-09-20
- **Owners:** BroccoliDB maintainers
- **Scope:** package architecture, runtime dependencies, and persistence boundary

## Context

BroccoliDB is embedded in applications that need local tables, indexes, and
recoverable state. The previous SQLite-oriented implementation introduced a
native database dependency and a portability burden for consumers that only
needed table operations and local durability.

The standalone package must work across supported Node.js environments without a
native compiler, Electron ABI rebuild, database server, or SQL-specific adapter.

## Decision

Use an in-memory table kernel as the supported implementation and compose
durability from ordinary filesystem primitives:

- typed `Map`-backed tables and secondary indexes for the hot path;
- a micro-batched JSONL WAL with per-frame checksum metadata for mutation replay;
- a temp+rename JSON base checkpoint and separate named history for restore
  points;
- SHA-256 content-addressable files with optional Brotli compression for blobs;
- a process-local re-entrant async mutex for kernel transactions;
- zero production dependencies and an ESM Node.js `>=18` package surface.

The public contract is the package export from `src/index.ts` and the interfaces
in `src/broccolidb.contracts.ts`. The removed SQLite implementation is not a
compatibility target. This ADR's original SQL parsing non-goal is narrowed by
[ADR-005](ADR-005-jsonsql-subset.md): the package now includes a bounded,
embedded JSONSQL surface while continuing to exclude native drivers and full
dialect compatibility.

## Alternatives considered

### Keep `better-sqlite3` in the package

Rejected. It creates native installation/ABI coupling and makes a small embedded
table substrate harder to transfer between environments.

### Use Kysely over a database driver

Rejected. A query builder does not remove the underlying driver and would force
the package to preserve SQL/dialect semantics it does not need.

### Use an external service

Rejected. The package is intended for offline, process-owned local state and
should not add networking, credentials, deployment, or service availability
requirements.

## Consequences

### Positive

- Consumers install and run without native database builds.
- State is inspectable and transferable as ordinary files.
- The hot path is simple and memory-resident for bounded local tables; no
  latency or throughput guarantee follows from that design.
- Recovery behavior is explicit and testable.
- The package can be vendored or published without LUMI-specific aliases.

### Trade-offs

- Tables must fit in process memory.
- There is no general SQL compatibility, migration engine, or relational join
  planner. See ADR-005 for the supported single-table JSONSQL subset.
- The built-in mutex does not coordinate independent processes.
- Durability is explicit; an unflushed process crash can lose the latest buffer.
- Applications own backup policy, schema evolution, and record validation.

## Compatibility impact

Changing the WAL frame shape, checkpoint structure, CAS encoding, export surface,
or lifecycle semantics is a compatibility change. Such changes require tests,
operations documentation, release notes, and a new or updated ADR.
