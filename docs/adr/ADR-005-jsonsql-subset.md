# ADR-005: Bounded JSONSQL subset over JSON tables

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** BroccoliDB maintainers
- **Scope:** public query API, table schemas, and SQL-shaped execution semantics

## Context

BroccoliDB already provides in-memory tables, a WAL, and JSON checkpoints. A
typed table API is useful for direct access, but some common operations are
clearer when expressed with familiar table schemas, `SELECT` clauses, and bound
values. The package must retain its zero-runtime-dependency and no-server
boundaries. Reintroducing SQLite/PostgreSQL compatibility or a native driver
would contradict ADR-001's portability goal.

## Decision

Expose `db.sql.prepare(sql)` as an optional, synchronous, embedded SQL-shaped
surface over the same BroccoliDB tables. The supported statements are:

- `CREATE TABLE [IF NOT EXISTS]` with strict JSON column types, literal defaults,
  an explicit `TEXT` or `INTEGER` primary key, and unique constraints;
- one-table `SELECT` with projections, aliases, predicates, ordering, and
  pagination;
- one-row `INSERT`, `UPDATE`, and `DELETE`;
- positional `?` bindings and common boolean, comparison, null, membership,
  range, and `LIKE` predicates.

JSON arrays and objects use structural equality for equality predicates; ordered
comparisons involving them remain unknown. Sparse JavaScript arrays are
normalized using JSON serialization semantics, with missing elements becoming
`null`. Because `LIKE` matching is synchronous and uses dynamic programming,
each SELECT, UPDATE, or DELETE has a fixed 10,000,000-cell work budget and fails
with `ERR_JSONSQL_RESOURCE_LIMIT` when the budget is exceeded.

The schema catalog is stored as a reserved internal table, so schemas share the
existing WAL, checkpoints, startup validation, and backup boundary. SQL table
constraints also validate writes made through the typed table API. Table and
column identifiers are normalized to lowercase; column values are checked
strictly without SQL affinity or coercion.

This is a bounded SQLite-inspired API. It is not a SQL server or wire protocol,
and it does not promise SQLite, PostgreSQL, Kysely, or native-driver
compatibility. It has no joins, subqueries, aggregate expressions, SQL indexes,
`ALTER TABLE`, `DROP TABLE`, migrations, upserts, or SQL transactions. SQL reads
scan and materialize their source table rather than using table indexes.

## Alternatives considered

### Keep only typed queries

Rejected as the sole interface because a compact SQL-shaped option improves
approachability for common schema and single-table CRUD work without changing
the storage engine or requiring an external package.

### Add a full SQLite/PostgreSQL parser or driver

Rejected. Full dialect support would require a much broader semantic contract,
planner, migrations, and stronger durability/concurrency guarantees. A native
driver would also add installation and ABI coupling.

### Implement relational transactions and joins now

Deferred. The current WAL stores per-row mutation frames and the kernel mutex
does not isolate direct table writes. These facilities need a separate design
and stronger WAL semantics before they can be promised.

## Consequences

### Positive

- Consumers can use familiar prepared-statement, schema, predicate, ordering,
  and pagination patterns without runtime dependencies.
- Both query styles see the same table data and constraints.
- JSONSQL inserts and batch updates use the table layer's maintained unique
  indexes rather than rescanning the whole table for each statement.
- Schema definitions are restored and validated with existing state recovery.
- Unsupported statements fail during preparation rather than being silently
  accepted as no-ops.

### Trade-offs

- The grammar is intentionally small and will reject common SQL features outside
  the supported list.
- SELECT is a table scan and allocates normalized rows and projections.
- Strict typing differs from SQLite affinity behavior.
- Multi-row `UPDATE` and `DELETE` apply after in-memory validation but produce
  per-row WAL frames; process termination can leave only part of that mutation
  replayed. The kernel's `transaction()` is a process-local coordination and
  flush boundary, not a rollback-capable or isolated SQL transaction.
- Schema changes beyond table creation require application-owned migration work.

## Compatibility impact

This adds public exports and `IBroccoliDatabaseKernel.sql`, a persisted internal
catalog record shape, and runtime validation for SQL-created tables. The
catalog's record version is `1`. Grammar or semantic expansions, catalog format
changes, or stronger transaction claims require tests, API/operations updates,
and a new ADR or an explicit update to this decision.

## Reference inspiration

SQLite's documentation provides a useful usability pattern: keep a central
language reference that states which constructs are supported, and keep bound
values separate from statement text. These references inform discoverability
and ergonomics only; they do not imply dialect compatibility:

- [SQLite SQL language reference](https://sqlite.org/lang.html)
- [SQLite parameter binding](https://www.sqlite.org/c3ref/bind_blob.html)
