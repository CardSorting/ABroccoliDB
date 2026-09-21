# Defensive prior-art index

This is a structured technical index, not a patent claim set and not a
statement that any element is novel or legally sufficient prior art. It is
intended to make the project’s source evidence and search vocabulary easier to
preserve and review.

## Element families

### A. Indexed in-memory table kernel

- typed record map keyed by application identifiers;
- equality, sorted/range, composite, and prefix indexes;
- predicate filtering, ordering, pagination, aggregation, TTL, and CDC;
- direct evidence in `src/broccolidb-table.ts` and the public contracts.

**Search vocabulary:** `BroccoliDbTable`, table-first embedded database,
in-memory secondary index, deterministic CDC, TTL record expiration.

### B. Per-frame checksum WAL with prior-frame metadata

- JSONL mutation frames with operation, table, record, and checksum metadata;
- prior-frame hash metadata included in each newly generated frame's checksum
  input, with replay validation when the metadata is present;
- micro-batched append and explicit flush boundaries;
- startup replay and per-frame checksum failure classification;
- frame-sequence and declared-link validation during replay, with legacy missing
  link metadata tolerated;
- direct evidence in `src/broccolidb-wal.ts` and `src/broccolidb-kernel.ts`.

**Search vocabulary:** per-frame checksum JSONL WAL, prior-frame metadata,
micro-batched embedded WAL, crash replay table kernel, explicit flush durability
boundary.

### C. Rename-based base replacement and named rollback substrate

- complete base snapshots and named checkpoint history;
- temporary-file write followed by rename-based replacement of the base snapshot;
- separate history-file write, WAL rotation, and checkpoint marker;
- explicit rollback of records represented by a snapshot;
- replayable reset frames for a successful rollback;
- no cross-file transaction and no automatic removal of post-checkpoint tables;
- direct evidence in `src/broccolidb-kernel.ts` and `docs/OPERATIONS.md`.

**Search vocabulary:** rename-based JSON checkpoint embedded table, named
rollback history, WAL rotation checkpoint recovery.

### D. SHA-256/Brotli CAS integrity vault

- digest-addressed sharded blob paths;
- optional Brotli payload encoding;
- digest verification on reads, quarantine records, and reference-set sweep;
- direct evidence in `src/broccolidb-cas.ts`.

**Search vocabulary:** sharded SHA-256 content-addressable blob quarantine,
Brotli CAS read verification, embedded database reference-set blob sweep.

### E. Re-entrant async transaction coordination

- async ownership context propagation;
- nested/re-entrant lock acquisition;
- queued contention and timeout errors;
- direct evidence in `src/broccolidb-mutex.ts`.

**Search vocabulary:** AsyncLocalStorage re-entrant mutex, process-local async
transaction lock, deadlock timeout embedded kernel.

### F. Offline deterministic language and token helpers

- constrained natural-language query parsing into typed options;
- whitespace and structured-message prompt compression;
- no network or provider call in the helper path;
- direct evidence in `src/broccolidb-natural-query.ts` and
  `src/TokenCompressionService.ts`.

**Search vocabulary:** offline natural query parser TypeScript table,
structured prompt token compression deterministic helper.

## Preservation notes

The index is useful only when the referenced source and release artifact remain
available with a verifiable date and digest. Preserve the original repository
history; do not claim that this index alone invalidates a patent or creates a
priority date. Patent counsel should decide whether any element, combination,
or publication is relevant in a particular jurisdiction.
