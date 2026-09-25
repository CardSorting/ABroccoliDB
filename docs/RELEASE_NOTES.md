# Release notes

## Unreleased

- Add `db.sql.prepare()` with a dependency-free SQLite-inspired JSONSQL subset
  for typed tables, bound values, single-table reads, and basic mutations.
- Persist JSONSQL schemas in the internal catalog table and restore constraints
  after checkpoint loading and WAL replay.
- Fix fluent-query OR branches, repeated predicates, stable multi-field sort,
  non-mutating `first()`, and pagination-independent `count()`.
- Add `IDbTable.deleteMany()` for grouped in-memory deletion.
- Document that the kernel mutex callback is not an isolated or rollback-capable
  SQL transaction; multi-row SQL mutations are not crash-atomic WAL units.
- Keep table writes closed until startup recovery and JSONSQL schema validation
  finish; replay uses internal table operations without emitting duplicate WAL
  frames or exposing partial restores through mutation callbacks.
- Remove timed-out mutex waiters from the queue, and re-arm process-local TTL
  deadlines when the same kernel instance is started again.
- Use maintained unique indexes for JSONSQL inserts and batch updates instead
  of rescanning the full table; compare JSON values structurally and normalize
  sparse arrays to JSON `null` entries.
- Bound synchronous JSONSQL `LIKE` evaluation to 10,000,000 work cells per
  query and report limit failures as `ERR_JSONSQL_RESOURCE_LIMIT`.

## 3.0.0 — Apache-2.0 and defensive IP controls

This major release keeps existing table behavior and WAL frame shapes while
adding keyed table snapshots, changing the license boundary, and hardening the
checkpoint persistence format for the future release line:

- `3.0.0+` is licensed under the Apache License, Version 2.0.
- `NOTICE` records copyright, attribution, dependency, and naming information.
- The defensive patent/IP policy, trademark policy, DCO 1.1, SPDX headers, and
  automated license checks are now part of the repository and release process.
- `docs/ip/` records the technical evidence and date discipline for defensive
  prior-art preservation.
- The claim register and evidence-bounded wording audit distinguish tested
  behavior, implementation limits, measurements, and counsel-only conclusions.
- `health().pillars.tableConsistency.indexParity` is now `null` when no
  independent parity scan was performed instead of implying that one ran.

The `2.0.x` releases remain MIT-licensed. This release does not retroactively
revoke permissions already granted for a published `2.0.x` package.

The 3.0.0 line also hardens recovery behavior: the base checkpoint now uses a
versioned envelope that preserves application keys while retaining a legacy-read
path, validates the current base snapshot hash, rejects unsafe rollback path
components, malformed checkpoint data fails closed, WAL replay validates
declared links and frame sequencing, `CLEAR` and rollback reset frames replay
correctly, and CAS identifiers are constrained to SHA-256-shaped filenames
before filesystem access.

## 2.0.1 — first npm publication

This patch release publishes the standalone package under a new version because
the previously unused `2.0.0` version had already been unpublished on npm and
cannot be reused by the registry.

The package contents and supported API are unchanged from the standalone
release described below.

## 2.0.0 — standalone portable package

This release is the supported standalone BroccoliDB package.

### Included

- in-memory typed tables with equality, sorted, composite, and prefix indexes;
- operator filters, boolean query clauses, fluent queries, aggregation, CDC,
  TTL expiration, and deterministic natural-language parsing;
- micro-batched WAL with checksum metadata and restart replay;
- temp+rename JSON base checkpoints, separate named history, and rollback;
- SHA-256 CAS storage with optional Brotli compression and corruption quarantine;
- re-entrant async mutex and kernel transaction boundary;
- dependency-free runtime package for Node.js `>=18`.

### Compatibility policy

The standalone package is the supported implementation. The removed SQLite
implementation is not a supported compatibility target. The current bounded
JSONSQL subset does not promise SQLite, PostgreSQL, Kysely, or `better-sqlite3`
API compatibility.

Changes to exported contracts or durable file formats require a release-note
entry and an architecture decision record.
