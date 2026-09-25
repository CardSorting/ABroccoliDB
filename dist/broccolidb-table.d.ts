// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB generic reactive in-memory table.
 * Maintains secondary indexes, operator filters, aggregation, change
 * subscriptions, and TTL expiration for records held in process memory.
 */
import type { DbAggregateQuery, DbAggregateResult, DbPutOptions, DbQueryOptions, DbWhereValue, IDbTable, IFluentQueryBuilder, ITableTransaction, QueryExecutionPlan, TableChangeCallback, TableChangeSubscription, WalOperationType } from "./broccolidb.contracts.js";
export type WalHookFn = (op: WalOperationType, table: string, recordId: string, payload?: Record<string, unknown>) => void;
export interface DbTableUniqueConstraint {
    readonly name: string;
    readonly fields: readonly string[];
    readonly key?: (id: string, record: Record<string, unknown>) => string | undefined;
}
export interface DbTableConstraints<T extends Record<string, any> = Record<string, any>> {
    readonly unique: readonly DbTableUniqueConstraint[];
    validateRecord(id: string, record: T): void;
    conflict(constraint: DbTableUniqueConstraint): Error;
}
export declare class BroccoliDbTable<T extends Record<string, any> = Record<string, any>> implements IDbTable<T> {
    readonly name: string;
    private readonly records;
    private readonly walHook?;
    private readonly assertWritable?;
    private readonly equalityIndices;
    private readonly sortedIndices;
    private readonly compositeIndices;
    private readonly prefixIndices;
    private constraints;
    private readonly uniqueIndices;
    private isDeferringMutationEvents;
    private deferredMutationEvents;
    private readonly subscriptions;
    private subscriptionSeq;
    private readonly ttlTimers;
    private readonly ttlDeadlines;
    constructor(name: string, walHook?: WalHookFn, assertWritable?: () => void);
    /** Installs runtime schema checks and unique indexes for JSONSQL tables. */
    setConstraints(constraints: DbTableConstraints<T> | undefined): void;
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
    /** Deletes all currently present keys as one in-memory mutation batch. */
    deleteMany(ids: readonly string[]): number;
    deleteWhere(where: Record<string, DbWhereValue>): number;
    updateWhere(where: Record<string, DbWhereValue>, updater: (record: T) => T): number;
    count(): number;
    clear(): void;
    query(options?: DbQueryOptions): readonly T[];
    queryEntries(options?: DbQueryOptions): readonly {
        id: string;
        record: T;
    }[];
    private executeQueryRecords;
    aggregate(query: DbAggregateQuery): DbAggregateResult;
    subscribe(callback: TableChangeCallback<T>, filter?: (record: T) => boolean): TableChangeSubscription;
    transaction<R>(fn: (tx: ITableTransaction<T>) => R): R;
    select(): IFluentQueryBuilder<T>;
    explain(options?: DbQueryOptions): QueryExecutionPlan;
    createSnapshot(): Map<string, T>;
    restoreSnapshot(snapshot: Map<string, T>): void;
    /** @internal Replaces table contents during checkpoint recovery without opening the write gate. */
    restoreRecoveryEntries(entries: readonly {
        id: string;
        record: T;
    }[]): void;
    /** @internal Applies one already-validated WAL mutation during startup replay. */
    applyRecoveryMutation(op: WalOperationType, id: string, payload?: Record<string, unknown>): void;
    /** @internal Re-arms process-local TTLs after kernel recovery or restart. */
    resumeExpirations(): void;
    private putOne;
    private deleteOne;
    private runMutationBatch;
    private deferMutationEvent;
    private validateTtl;
    private clearExpiration;
    private scheduleExpiration;
    private resetRecordsAndIndexes;
    private uniqueKey;
    private rebuildUniqueIndices;
    private buildUniqueIndices;
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