// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB statistical aggregation and group-by engine.
 * Groups records in one traversal and supports SUM, AVG, MIN, MAX, COUNT,
 * STDDEV, and HAVING predicate filters.
 */
import type { DbAggregateQuery, DbAggregateResult } from "./broccolidb.contracts.js";
export declare class BroccoliAggregateEngine {
    /**
     * Executes an aggregation query across candidate records.
     */
    static execute<T extends Record<string, unknown>>(tableName: string, records: readonly T[], query: DbAggregateQuery): DbAggregateResult;
    private static finalizeMetric;
}
//# sourceMappingURL=broccolidb-aggregation.d.ts.map