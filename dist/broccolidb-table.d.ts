// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB generic reactive in-memory table.
 * Maintains secondary indexes, operator filters, aggregation, change
 * subscriptions, and TTL expiration for records held in process memory.
 */
import type { DbAggregateQuery, DbAggregateResult, DbPutOptions, DbQueryOptions, DbWhereValue, IDbTable, IFluentQueryBuilder, ITableTransaction, QueryExecutionPlan, TableChangeCallback, TableChangeSubscription, WalOperationType } from "./broccolidb.contracts.js";
export type WalHookFn = (op: WalOperationType, table: string, recordId: string, payload?: Record<string, unknown>) => void;
export declare class BroccoliDbTable<T extends Record<string, any> = Record<string, any>> implements IDbTable<T> {
    readonly name: string;
    private readonly records;
    private readonly walHook?;
    private readonly equalityIndices;
    private readonly sortedIndices;
    private readonly compositeIndices;
    private readonly prefixIndices;
    private readonly subscriptions;
    private subscriptionSeq;
    private readonly ttlTimers;
    constructor(name: string, walHook?: WalHookFn);
    createIndex(field: keyof T & string): void;
    createSortedIndex(field: keyof T & string): void;
    createCompositeIndex(fields: readonly (keyof T & string)[]): void;
    createPrefixIndex(field: keyof T & string): void;
    get(id: string): T | undefined;
    getAll(): readonly T[];
    /** Returns cloned records together with their application keys. */
    getAllEntries(): readonly {
        id: string;
        record: T;
    }[];
    put(id: string, record: T, options?: DbPutOptions): T;
    putMany(entries: ReadonlyArray<{
        id: string;
        record: T;
        options?: DbPutOptions;
    }>): readonly T[];
    compareAndSwap(id: string, predicate: (current: T | undefined) => boolean, updater: (current: T) => T, options?: DbPutOptions): {
        success: boolean;
        record?: T;
    };
    delete(id: string): boolean;
    deleteWhere(where: Record<string, DbWhereValue>): number;
    updateWhere(where: Record<string, DbWhereValue>, updater: (record: T) => T): number;
    count(): number;
    clear(): void;
    query(options?: DbQueryOptions): readonly T[];
    aggregate(query: DbAggregateQuery): DbAggregateResult;
    subscribe(callback: TableChangeCallback<T>, filter?: (record: T) => boolean): TableChangeSubscription;
    transaction<R>(fn: (tx: ITableTransaction<T>) => R): R;
    select(): IFluentQueryBuilder<T>;
    explain(options?: DbQueryOptions): QueryExecutionPlan;
    createSnapshot(): Map<string, T>;
    restoreSnapshot(snapshot: Map<string, T>): void;
    private putInternal;
    private deleteInternal;
    private planQuery;
    private evaluateWhere;
    private resolveFieldValue;
    private normalizeSortableValue;
    private insertSortedIndexEntry;
    private buildCompositeKey;
    private insertPrefixIndex;
    private addIndicesForRecord;
    private removeIndicesForRecord;
    private emitChangeEvent;
}
//# sourceMappingURL=broccolidb-table.d.ts.map