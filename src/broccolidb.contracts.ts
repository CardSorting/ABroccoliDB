/**
 * BroccoliDB core data contracts.
 * Public types for in-memory tables, query helpers, WAL frames, CAS metadata,
 * checkpoints, and operational reports.
 */

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

export type DbDurabilityMode = "SYNCHRONOUS" | "MICRO_BATCHED" | "SPECULATIVE";

export type WalOperationType = "INSERT" | "UPDATE" | "DELETE" | "CLEAR" | "CHECKPOINT" | "ROLLBACK" | "BRANCH_MERGE";

export interface WalFrame {
  readonly frameId: number;
  readonly timestamp: number;
  readonly op: WalOperationType;
  readonly table: string;
  readonly recordId: string;
  readonly payload?: Record<string, any>;
  readonly checksum: string; // SHA-256 integrity hash
  readonly previousFrameHash?: string; // Prior-frame metadata included in checksum input
}

// -------------------------------------------------------------
// Rich Query DSL & Operator Filters
// -------------------------------------------------------------

export type DbOperator =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$in"
  | "$nin"
  | "$between"
  | "$startsWith"
  | "$endsWith"
  | "$contains"
  | "$regex"
  | "$exists";

export interface DbFieldFilter {
  readonly $eq?: unknown;
  readonly $ne?: unknown;
  readonly $gt?: number | string | Date;
  readonly $gte?: number | string | Date;
  readonly $lt?: number | string | Date;
  readonly $lte?: number | string | Date;
  readonly $in?: readonly unknown[];
  readonly $nin?: readonly unknown[];
  readonly $between?: readonly [number | string | Date, number | string | Date];
  readonly $startsWith?: string;
  readonly $endsWith?: string;
  readonly $contains?: string;
  readonly $regex?: string | RegExp;
  readonly $exists?: boolean;
}

export type DbWhereValue = unknown | DbFieldFilter;

export interface DbQueryOptions {
  readonly where?: Record<string, DbWhereValue>;
  readonly and?: readonly Record<string, DbWhereValue>[];
  readonly or?: readonly Record<string, DbWhereValue>[];
  readonly not?: Record<string, DbWhereValue>;
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: string | readonly string[];
  readonly sortOrder?: "asc" | "desc" | readonly ("asc" | "desc")[];
}

// -------------------------------------------------------------
// Index Definitions & Types
// -------------------------------------------------------------

export type IndexType = "equality" | "sorted" | "composite" | "prefix";

export interface IndexDefinition {
  readonly name: string;
  readonly type: IndexType;
  readonly fields: readonly string[];
  readonly cardinality: number;
  readonly isUnique?: boolean;
}

// -------------------------------------------------------------
// Mutation Options & TTL Expiration
// -------------------------------------------------------------

export interface DbPutOptions {
  readonly ttlMs?: number;
  readonly idempotencyKey?: string;
}

// -------------------------------------------------------------
// Multi-Dimensional Aggregation Pipeline
// -------------------------------------------------------------

export type DbAggregateMetric = "sum" | "avg" | "min" | "max" | "count" | "stddev";

export interface DbAggregateQuery {
  readonly groupBy?: readonly string[];
  readonly metrics: Record<string, { readonly metric: DbAggregateMetric; readonly field?: string }>;
  readonly where?: Record<string, DbWhereValue>;
  readonly having?: Record<string, DbWhereValue>;
  readonly limit?: number;
}

export interface DbGroupResult {
  readonly keys: Record<string, unknown>;
  readonly metrics: Record<string, number>;
  readonly recordCount: number;
}

export interface DbAggregateResult {
  readonly table: string;
  readonly totalRecordsEvaluated: number;
  readonly groups: readonly DbGroupResult[];
  readonly grandTotals: Record<string, number>;
  readonly executionTimeMicros: number;
}

// -------------------------------------------------------------
// Reactive Change Data Capture (CDC) & Observables
// -------------------------------------------------------------

export type TableChangeOperation = "INSERT" | "UPDATE" | "DELETE" | "CLEAR" | "EXPIRE";

export interface TableChangeEvent<T extends Record<string, any> = Record<string, any>> {
  readonly operation: TableChangeOperation;
  readonly table: string;
  readonly recordId: string;
  readonly before?: T;
  readonly after?: T;
  readonly diff?: Record<string, { readonly old?: unknown; readonly new?: unknown }>;
  readonly timestamp: number;
}

export type TableChangeCallback<T extends Record<string, any> = Record<string, any>> = (
  event: TableChangeEvent<T>
) => void;

export interface TableChangeSubscription {
  readonly subscriptionId: string;
  unsubscribe(): void;
}

// -------------------------------------------------------------
// Natural Query Expression & Parsed AST
// -------------------------------------------------------------

export interface NaturalQueryParsed {
  readonly rawText: string;
  readonly targetTable: string;
  readonly queryOptions: DbQueryOptions;
  readonly confidence: number;
  readonly tokensMatched: readonly string[];
}

// -------------------------------------------------------------
// Fluent Query Builder Contract
// -------------------------------------------------------------

export interface ITableTransaction<T extends Record<string, any> = Record<string, any>> {
  get(id: string): T | undefined;
  put(id: string, record: T, options?: DbPutOptions): T;
  delete(id: string): boolean;
  query(options?: DbQueryOptions): readonly T[];
}

export interface IFluentQueryBuilder<T extends Record<string, any> = Record<string, any>> {
  where(field: keyof T & string): IFluentFieldPredicate<T>;
  and(field: keyof T & string): IFluentFieldPredicate<T>;
  or(clause: (builder: IFluentQueryBuilder<T>) => void): IFluentQueryBuilder<T>;
  orderBy(field: keyof T & string, direction?: "asc" | "desc"): IFluentQueryBuilder<T>;
  limit(count: number): IFluentQueryBuilder<T>;
  offset(count: number): IFluentQueryBuilder<T>;
  execute(): readonly T[];
  explain(): QueryExecutionPlan;
  first(): T | undefined;
  count(): number;
}

export interface IFluentFieldPredicate<T extends Record<string, any> = Record<string, any>> {
  equals(value: unknown): IFluentQueryBuilder<T>;
  notEquals(value: unknown): IFluentQueryBuilder<T>;
  greaterThan(value: number | string | Date): IFluentQueryBuilder<T>;
  greaterThanOrEqual(value: number | string | Date): IFluentQueryBuilder<T>;
  lessThan(value: number | string | Date): IFluentQueryBuilder<T>;
  lessThanOrEqual(value: number | string | Date): IFluentQueryBuilder<T>;
  in(values: readonly unknown[]): IFluentQueryBuilder<T>;
  notIn(values: readonly unknown[]): IFluentQueryBuilder<T>;
  between(min: number | string | Date, max: number | string | Date): IFluentQueryBuilder<T>;
  startsWith(prefix: string): IFluentQueryBuilder<T>;
  contains(substring: string): IFluentQueryBuilder<T>;
  matches(regex: string | RegExp): IFluentQueryBuilder<T>;
}

export interface QueryExecutionPlan {
  readonly table: string;
  readonly matchedIndex?: string;
  readonly indexType?: IndexType;
  readonly scanStrategy: "INDEX_LOOKUP" | "INDEX_RANGE_SCAN" | "COMPOSITE_INDEX_LOOKUP" | "PREFIX_SCAN" | "MULTI_INDEX_INTERSECTION" | "FULL_TABLE_SCAN";
  readonly candidatesScanned: number;
  readonly recordsMatched: number;
  readonly executionTimeMicros: number;
  readonly query: DbQueryOptions;
}

// -------------------------------------------------------------
// Master Table Interface
// -------------------------------------------------------------

export interface IDbTable<T extends Record<string, any> = Record<string, any>> {
  readonly name: string;
  get(id: string): T | undefined;
  getAll(): readonly T[];
  getAllEntries(): readonly { id: string; record: T }[];
  put(id: string, record: T, options?: DbPutOptions): T;
  putMany(entries: ReadonlyArray<{ id: string; record: T; options?: DbPutOptions }>): readonly T[];
  compareAndSwap(
    id: string,
    predicate: (current: T | undefined) => boolean,
    updater: (current: T) => T,
    options?: DbPutOptions
  ): { success: boolean; record?: T };
  delete(id: string): boolean;
  deleteWhere(where: Record<string, DbWhereValue>): number;
  updateWhere(where: Record<string, DbWhereValue>, updater: (record: T) => T): number;
  query(options?: DbQueryOptions): readonly T[];
  createIndex(field: keyof T & string): void;
  createSortedIndex(field: keyof T & string): void;
  createCompositeIndex(fields: readonly (keyof T & string)[]): void;
  createPrefixIndex(field: keyof T & string): void;
  aggregate(query: DbAggregateQuery): DbAggregateResult;
  select(): IFluentQueryBuilder<T>;
  subscribe(callback: TableChangeCallback<T>, filter?: (record: T) => boolean): TableChangeSubscription;
  count(): number;
  clear(): void;
  createSnapshot(): Map<string, T>;
  restoreSnapshot(snapshot: Map<string, T>): void;
}

export interface TimelineCheckpointRecord {
  readonly checkpointId: string;
  readonly timestamp: number;
  readonly frameIndex: number;
  readonly label: string;
  readonly tableCount: number;
  readonly totalRecords: number;
  readonly snapshotHash: string;
}

export interface DbHealthReport {
  readonly status: "HEALTHY" | "DEGRADED" | "CORRUPTED";
  readonly timestamp: number;
  readonly pillars: {
    readonly diskInvariants: {
      readonly valid: boolean;
      readonly baseDir: string;
      readonly diskUsageBytes: number;
      readonly writeable: boolean;
    };
    readonly casIntegrity: {
      readonly totalBlobs: number;
      readonly corruptCount: number;
      readonly compressionSavingsPct: number;
      readonly healthy: boolean;
    };
    readonly walJournal: {
      readonly totalFrames: number;
      readonly uncommittedFrames: number;
      readonly lastSyncTimestamp: number;
      readonly lastError: string | null;
      readonly tornTailRecoveryCount: number;
      readonly tornTailRecoveredBytes: number;
      readonly repairedTerminatorCount: number;
      readonly healthy: boolean;
    };
    readonly tableConsistency: {
      readonly tableCount: number;
      readonly totalRecords: number;
      /** `null` means no independent index-parity scan was performed. */
      readonly indexParity: boolean | null;
      readonly healthy: boolean;
    };
  };
  readonly actionableRecommendations: readonly string[];
}

export interface IBroccoliDatabaseKernel {
  readonly workspaceRoot: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  getTable<T extends Record<string, any> = Record<string, any>>(name: string): IDbTable<T>;
  checkpoint(label?: string): Promise<TimelineCheckpointRecord>;
  rollback(checkpointId: string): Promise<boolean>;
  listCheckpoints(): readonly TimelineCheckpointRecord[];
  health(): Promise<DbHealthReport>;
  storeBlob(content: Buffer | string): Promise<string>;
  readBlob(hash: string): Promise<Buffer | null>;
  gc(): Promise<number>;
}
