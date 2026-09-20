/**
 * Local, dependency-free BroccoliDB surface.
 *
 * BroccoliDB is table-first and keeps its hot path in memory. The kernel's
 * optional WAL/CAS/checkpoint layers use ordinary files and Node built-ins;
 * no native database driver is part of this surface.
 */
export * from "./broccolidb.contracts.js";
export * from "./broccolidb-aggregation.js";
export * from "./broccolidb-mutex.js";
export * from "./broccolidb-natural-query.js";
export * from "./broccolidb-wal.js";
export * from "./broccolidb-cas.js";
export * from "./broccolidb-table.js";
export * from "./broccolidb-kernel.js";
export * from "./TokenCompressionService.js";
//# sourceMappingURL=index.d.ts.map