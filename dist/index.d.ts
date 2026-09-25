// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * Local, dependency-free BroccoliDB surface.
 *
 * BroccoliDB is table-first and keeps its hot path in memory. The optional
 * JSONSQL subset runs over those same tables. WAL/CAS/checkpoint layers use
 * ordinary files and Node built-ins; no native database driver is required.
 */
export * from "./broccolidb.contracts.js";
export * from "./broccolidb-aggregation.js";
export * from "./broccolidb-mutex.js";
export * from "./broccolidb-natural-query.js";
export { JsonSqlError, JsonSqlStatement, type JsonSqlColumnType, type JsonSqlDatabase, type JsonSqlRunResult, type JsonSqlStatementKind, type JsonSqlValue, } from "./broccolidb-jsonsql.js";
export * from "./broccolidb-wal.js";
export * from "./broccolidb-cas.js";
export * from "./broccolidb-table.js";
export * from "./broccolidb-kernel.js";
export * from "./TokenCompressionService.js";
//# sourceMappingURL=index.d.ts.map