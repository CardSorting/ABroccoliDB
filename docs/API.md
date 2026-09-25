# API reference

This reference documents the supported public entry point:

```ts
import { ... } from "@noorm/broccolidb"
```

The complete type-level contract is in [`src/broccolidb.contracts.ts`](../src/broccolidb.contracts.ts)
and the export list is in [`src/index.ts`](../src/index.ts).

## Kernel

```ts
interface DatabaseKernelOptions {
  workspaceRoot?: string
  walDebounceMs?: number
}

const db = new BroccoliDatabaseKernel(options)
```

| Method | Returns | Notes |
|---|---|---|
| `start()` | `Promise<void>` | Creates storage directories, loads checkpoint, replays WAL, restores schemas, then enables table writes. Idempotent. |
| `stop()` | `Promise<void>` | Closes table writes, flushes WAL, and stops WAL/CAS services; call `start()` before reusing the kernel. |
| `flush()` | `Promise<void>` | Writes buffered WAL frames. |
| `getTable<T>(name)` | `IDbTable<T>` | Returns or creates a typed in-memory table. |
| `transaction(fn)` | `Promise<R>` | Runs an async callback under the process-local mutex and flushes after success; it does not isolate or roll back table writes. |
| `compact()` | `Promise<boolean>` | Writes a hashed base snapshot and rotates the WAL without creating named checkpoint history; returns `false` if newer frames prevent safe rotation. |
| `checkpoint(label?)` | `Promise<TimelineCheckpointRecord>` | Writes a synced hashed base snapshot and history record, then rotates the WAL through the captured frame boundary so newer writes remain replayable. |
| `rollback(id)` | `Promise<boolean>` | Restores a cached or hash-validated on-disk checkpoint and writes replayable rollback frames; unsafe IDs return `false`. |
| `listCheckpoints()` | `readonly TimelineCheckpointRecord[]` | Lists checkpoint records known to the current process. |
| `health()` | `Promise<DbHealthReport>` | Reports writeability, CAS metrics, WAL metrics including flush errors and torn-tail recovery counters, and table counts; `indexParity` is `null` unless independently checked; it is not a full integrity scrub. |
| `storeBlob(content)` | `Promise<string>` | Stores bytes/string in CAS and returns the SHA-256 address. |
| `readBlob(hash)` | `Promise<Buffer \| null>` | Returns verified content or `null` when the blob is absent. |
| `gc()` | `Promise<number>` | Performs one sweep removing CAS files not referenced by current table string values prefixed `CAS:`. |

The package also exports `broccolidb`, a singleton constructed with the default
workspace root. Prefer an explicitly constructed kernel when an application has
more than one workspace, test isolation, or lifecycle owner.

## Tables

```ts
type User = { id: string; name: string; score: number; active: boolean }
const users = db.getTable<User>("users")
```

| Method | Description |
|---|---|
| `get(id)` | Read one record or return `undefined`. |
| `getAll()` | Return a readonly snapshot of current records. |
| `getAllEntries()` | Return cloned records together with their application keys. |
| `put(id, record, options?)` | Insert or replace a record; `ttlMs` schedules process-local expiration (re-armed on same-kernel restart, not persisted across process termination). `idempotencyKey` is accepted by the contract but is not currently used for deduplication. |
| `putMany(entries)` | Apply multiple puts as one in-memory batch. Prefer it for imports and bulk writes; constraint checks and unique-index updates cover only affected records, while WAL persistence still records each row. |
| `compareAndSwap(id, predicate, updater, options?)` | Apply an update only when the predicate accepts the current record. |
| `delete(id)` | Delete one record and return whether it existed. |
| `deleteMany(ids)` | Delete the currently present keys as one in-memory mutation batch and return the count. |
| `deleteWhere(where)` | Delete matching records and return the count. |
| `updateWhere(where, updater)` | Update matching records and return the count. |
| `query(options?)` | Filter, order, paginate, and return readonly records. |
| `aggregate(query)` | Group and calculate statistical metrics. |
| `select()` | Start a fluent query builder. |
| `subscribe(callback, filter?)` | Subscribe to change events; call `.unsubscribe()` to remove it. |
| `count()` | Return current record count. |
| `clear()` | Remove all records and emit a clear event. |
| `createSnapshot()` / `restoreSnapshot()` | Capture or replace the table's in-memory map. |

For a durable bulk-write boundary, write a batch with `putMany()` and then
await `db.flush()`. This groups WAL filesystem work through the configured
micro-batch window; it does not turn the row frames into one crash-atomic
transaction. For very large imports, use bounded batches so application work
can yield between them.

## Indexes

```ts
users.createIndex("active")
users.createSortedIndex("score")
users.createCompositeIndex(["active", "name"])
users.createPrefixIndex("name")
```

Index creation is explicit and does not change query semantics. Available index
types are `equality`, `sorted`, `composite`, and `prefix`. The fluent builder's
`explain()` method returns the selected strategy and candidate counts.

## Query options

```ts
const result = users.query({
  where: {
    active: true,
    score: { $gte: 80, $lt: 100 },
  },
  sortBy: "score",
  sortOrder: "desc",
  limit: 20,
  offset: 0,
})
```

Supported field operators:

| Operator | Meaning |
|---|---|
| `$eq`, `$ne` | Equality or inequality |
| `$gt`, `$gte`, `$lt`, `$lte` | Ordered comparison |
| `$in`, `$nin` | Membership or non-membership |
| `$between` | Inclusive two-value range |
| `$startsWith`, `$endsWith` | String prefix/suffix |
| `$contains` | String containment |
| `$regex` | Regular expression match |
| `$exists` | Field presence check |

Boolean clauses are available through `and`, `or`, and `not`. `sortBy` and
`sortOrder` accept one field or parallel readonly arrays. `orGroups` expresses
an OR of AND groups; each inner array is one AND group. Disjunctions currently
use a full table scan.

## Fluent queries

```ts
const topUsers = users
  .select()
  .where("active").equals(true)
  .and("score").greaterThanOrEqual(80)
  .orderBy("score", "desc")
  .limit(10)

console.log(topUsers.explain())
console.log(topUsers.execute())
console.log(topUsers.first())
console.log(topUsers.count())
```

Predicates include `equals`, `notEquals`, `greaterThan`,
`greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`, `in`, `notIn`, `between`,
`startsWith`, `contains`, and `matches`.

Each call to `.where()` or `.and()` adds another AND predicate, including when
the same field is used more than once. `.or(callback)` creates a separately
grouped OR branch. Repeated `.orderBy()` calls add stable sort keys. `first()`
does not change the builder, and `count()` ignores its limit and offset.

## JSONSQL

`db.sql` is an embedded, dependency-free SQL-shaped API over the same tables.
It is a bounded SQLite-inspired dialect, not SQLite/PostgreSQL compatibility,
a network server, or a driver API.

```ts
const db = new BroccoliDatabaseKernel({ workspaceRoot: "./state" })
await db.start()

db.sql.prepare(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    team TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (team, name)
  )
`).run()

const insert = db.sql.prepare("INSERT INTO users (id, name, team) VALUES (?, ?, ?)")
insert.run("user-1", "Ada", "platform")

const find = db.sql.prepare(`
  SELECT id, name AS display_name
  FROM users
  WHERE team = ? AND active = TRUE
  ORDER BY name ASC
  LIMIT ?
`)
console.log(find.all("platform", 20))

await db.flush()
await db.stop()
```

`prepare(sql)` accepts exactly one statement. Its `?` placeholders bind JSON
values by position; every placeholder must have one binding, and table or column
names cannot be parameters. `statement.all(...values)` and `.get(...values)` are
for `SELECT`. `statement.run(...values)` is for table creation and mutations and
returns `{ changes, lastInsertRowid? }`. Binding values must be JSON-compatible
and numbers must be finite.

Supported statements and clauses:

- `CREATE TABLE [IF NOT EXISTS]` with `TEXT`, `INTEGER`, `REAL`, `BOOLEAN`,
  `JSON`, or `ANY` columns; scalar literal `DEFAULT`; `NOT NULL`; one explicit
  `TEXT` or `INTEGER` primary key; and single/composite `UNIQUE` constraints.
- `SELECT` one table with `*` or named columns, optional `AS` aliases, `WHERE`,
  `ORDER BY`, `LIMIT`, and `OFFSET`.
- One-row `INSERT`, `UPDATE SET` with literal or bound values, and `DELETE`.
- Parenthesized `AND`/`OR`/`NOT`, comparisons, `IS [NOT] NULL`, `[NOT] IN`,
  `[NOT] BETWEEN`, and `[NOT] LIKE` predicates.

Identifiers are case-folded to lowercase and limited to simple alphanumeric
names with underscores. Primary keys must be supplied explicitly; there is no
auto-increment. Column values are checked strictly (`INTEGER` means a safe
integer; `REAL` means a finite number); SQL type affinity and coercion are not
implemented. `NULL` comparisons follow three-valued filtering behavior. Unique
constraints allow multiple `NULL` values. `LIKE` treats `%` as any-length text,
`_` as one Unicode code point, and compares ASCII letters without case; there is
no `ESCAPE` clause. JSON objects and arrays compare structurally for `=` and
`!=`; ordered comparisons involving them evaluate as unknown. Each SELECT,
UPDATE, or DELETE has a 10,000,000-cell synchronous `LIKE` work budget and throws
`JsonSqlError` with code `ERR_JSONSQL_RESOURCE_LIMIT` when exceeded. `LIMIT` and
`OFFSET` require safe integer values; a negative LIMIT means no upper bound, and
a negative OFFSET is treated as zero.

The schema catalog is stored in the same `.broccolidb/` table snapshot and WAL.
Startup restores schemas after checkpoint loading and WAL replay. SQL-created
constraints also validate writes made through the typed table API. There is no
`ALTER TABLE`, `DROP TABLE`, migration system, SQL transaction, join, subquery,
aggregate expression, SQL index, or conflict/upsert clause. A SQL `SELECT` scans
and materializes the table in memory; table indexes are not used by this SQL
subset. Use typed queries for index-aware execution.

Typed table writes to a SQL-managed table are validated against its schema, but
they are not rewritten to materialize defaults. SQL reads apply declared
defaults when a stored record omits a column; a direct typed `get()` returns the
record shape that was written. A multi-row UPDATE or DELETE applies as one
validated in-memory batch but emits per-row WAL frames, so process termination
can leave only part of that statement replayed.

`db.transaction(fn)` is a kernel coordination and flush boundary, not an SQL
transaction: it does not roll back callback mutations or prevent direct table
writes from running outside the callback.

## Aggregation

```ts
const summary = users.aggregate({
  groupBy: ["active"],
  metrics: {
    users: { metric: "count" },
    averageScore: { metric: "avg", field: "score" },
    scoreSpread: { metric: "stddev", field: "score" },
  },
  having: { users: { $gte: 2 } },
})
```

Metrics are `sum`, `avg`, `min`, `max`, `count`, and `stddev`. Results include
groups, grand totals, records evaluated, and elapsed microseconds.

## Change events and TTL

```ts
const subscription = users.subscribe((event) => {
  console.log(event.operation, event.recordId, event.before, event.after)
})

users.put("temporary", { id: "temporary", name: "Temp", score: 0, active: true }, { ttlMs: 5_000 })
subscription.unsubscribe()
```

Change operations are `INSERT`, `UPDATE`, `DELETE`, `CLEAR`, and `EXPIRE`.
Events may include `before`, `after`, and a field-level `diff`.

## Natural-language parsing

`BroccoliNaturalQueryParser` is a deterministic offline parser, not an LLM:

```ts
const parsed = BroccoliNaturalQueryParser.parse(
  "from users where score >= 80 sorted by score desc limit 10",
)

const rows = db.getTable<User>(parsed.targetTable).query(parsed.queryOptions)
```

It recognizes table selection, limit/offset, sorting, comparisons, ranges,
membership, prefixes, contains, and equality phrases. The returned `confidence`
is a parsing coverage heuristic; applications should validate user-facing input.

## WAL and CAS classes

Advanced consumers can use the lower-level services directly:

- `BroccoliWriteAheadLog` supports `start`, `appendFrame`, `flush`, `replay`,
  `truncate`, `truncateThrough`, `getCurrentFrameId`, and `getMetrics`.
- `BroccoliCASStorageService` supports `start`, `store`, `read`, `exists`,
  `pruneUnreferenced`, `getStats`, and `getBaseDir`.
- `ReentrantAsyncMutex` supports `acquire`, `runLocked`, `isLocked`,
  `getCurrentHolder`, and `getQueueLength`.

Prefer the kernel for normal application use. Direct services are useful for
specialized adapters, diagnostics, and tests. Call `BroccoliWriteAheadLog.start()`
before appending frames; appends are rejected after stop until it is started
again.

## Errors

| Error | Raised when |
|---|---|
| `WalIntegrityError` | A WAL line is invalid JSON, has invalid sequencing/link metadata, or its checksum does not match. |
| `StorageIntegrityError` | A CAS identifier is invalid, or a blob cannot be decompressed, is not a regular file, or its content hash mismatches. |
| `CheckpointIntegrityError` | A base checkpoint cannot be read, parsed, shape-validated, or snapshot-hash-validated during startup. |
| `DatabaseLockError` | Base mutex coordination fails. |
| `DeadlockTimeoutError` | A mutex waiter exceeds its configured timeout; prolonged contention is reported but a deadlock is not proven. |
| `JsonSqlError` | JSONSQL syntax, binding, schema, constraint, or synchronous resource limit fails. `code` distinguishes the category. |

## Prompt compression

`TokenCompressionService.getInstance().compactPrompt()` normalizes whitespace
without flattening structured message blocks. Signed thinking blocks are left
unchanged. Results include a SHA-256 prompt key, estimated token counts,
compression ratio, requested-model echo, and an L1 cache flag.

The estimate is `ceil(characters / 4)` and is not provider usage data.
