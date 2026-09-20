/**
 * GALXAI: BroccoliDB Statistical Aggregation & Group-By Engine (Zenith Tier)
 * Single-pass streaming grouping, statistical accumulators (SUM, AVG, MIN, MAX, COUNT, STDDEV),
 * and HAVING predicate filters over BroccoliDbTable records.
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