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
| `start()` | `Promise<void>` | Creates storage directories, loads checkpoint, and replays WAL. Idempotent. |
| `stop()` | `Promise<void>` | Flushes WAL and stops WAL/CAS services. |
| `flush()` | `Promise<void>` | Writes buffered WAL frames. |
| `getTable<T>(name)` | `IDbTable<T>` | Returns or creates a typed in-memory table. |
| `transaction(fn)` | `Promise<R>` | Concrete kernel method; runs an async callback under the re-entrant mutex and flushes afterward. |
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
| `put(id, record, options?)` | Insert or replace a record; `ttlMs` schedules expiration. `idempotencyKey` is accepted by the contract but is not currently used for deduplication. |
| `putMany(entries)` | Apply multiple puts. |
| `compareAndSwap(id, predicate, updater, options?)` | Apply an update only when the predicate accepts the current record. |
| `delete(id)` | Delete one record and return whether it existed. |
| `deleteWhere(where)` | Delete matching records and return the count. |
| `updateWhere(where, updater)` | Update matching records and return the count. |
| `query(options?)` | Filter, order, paginate, and return readonly records. |
| `aggregate(query)` | Group and calculate statistical metrics. |
| `select()` | Start a fluent query builder. |
| `subscribe(callback, filter?)` | Subscribe to change events; call `.unsubscribe()` to remove it. |
| `count()` | Return current record count. |
| `clear()` | Remove all records and emit a clear event. |
| `createSnapshot()` / `restoreSnapshot()` | Capture or replace the table's in-memory map. |

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
`sortOrder` accept one field or parallel readonly arrays.

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
specialized adapters, diagnostics, and tests.

## Errors

| Error | Raised when |
|---|---|
| `WalIntegrityError` | A WAL line is invalid JSON, has invalid sequencing/link metadata, or its checksum does not match. |
| `StorageIntegrityError` | A CAS identifier is invalid, or a blob cannot be decompressed, is not a regular file, or its content hash mismatches. |
| `CheckpointIntegrityError` | A base checkpoint cannot be read, parsed, shape-validated, or snapshot-hash-validated during startup. |
| `DatabaseLockError` | Base mutex coordination fails. |
| `DeadlockTimeoutError` | A mutex waiter exceeds its configured timeout. |

## Prompt compression

`TokenCompressionService.getInstance().compactPrompt()` normalizes whitespace
without flattening structured message blocks. Signed thinking blocks are left
unchanged. Results include a SHA-256 prompt key, estimated token counts,
compression ratio, requested-model echo, and an L1 cache flag.

The estimate is `ceil(characters / 4)` and is not provider usage data.
