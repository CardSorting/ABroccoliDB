# Release notes

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
- checksum-linked micro-batched WAL and restart replay;
- atomic JSON checkpoints, named history, and rollback;
- SHA-256 CAS storage with optional Brotli compression and corruption quarantine;
- re-entrant async mutex and kernel transaction boundary;
- dependency-free runtime package for Node.js `>=18`.

### Compatibility policy

The standalone package is the supported implementation. The removed SQLite
implementation is not a supported compatibility target, and this package does
not promise SQL, Kysely, or `better-sqlite3` API compatibility.

Changes to exported contracts or durable file formats require a release-note
entry and an architecture decision record.
