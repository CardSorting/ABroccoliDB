/**
 * BroccoliDB generic reactive in-memory table.
 * Maintains secondary indexes, operator filters, aggregation, change
 * subscriptions, and TTL expiration for records held in process memory.
 */

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import type {
  DbAggregateQuery,
  DbAggregateResult,
  DbFieldFilter,
  DbPutOptions,
  DbQueryOptions,
  DbWhereValue,
  IDbTable,
  IFluentFieldPredicate,
  IFluentQueryBuilder,
  IndexType,
  ITableTransaction,
  QueryExecutionPlan,
  TableChangeCallback,
  TableChangeEvent,
  TableChangeOperation,
  TableChangeSubscription,
  WalOperationType,
} from "./broccolidb.contracts.js";
import { BroccoliAggregateEngine } from "./broccolidb-aggregation.js";

export type WalHookFn = (
  op: WalOperationType,
  table: string,
  recordId: string,
  payload?: Record<string, unknown>
) => void;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface SortedEntry {
  value: number | string;
  ids: Set<string>;
}

interface CompositeIndexInternal {
  fields: readonly string[];
  map: Map<string, Set<string>>;
}

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

type TableMutation<T extends Record<string, any>> =
  | { readonly operation: "put"; readonly id: string; readonly record: T }
  | { readonly operation: "delete"; readonly id: string };

export class BroccoliDbTable<T extends Record<string, any> = Record<string, any>>
  implements IDbTable<T>
{
  readonly name: string;
  private readonly records = new Map<string, T>();
  private readonly walHook?: WalHookFn;
  private readonly assertWritable?: () => void;

  // Index Stores
  private readonly equalityIndices = new Map<string, Map<unknown, Set<string>>>();
  private readonly sortedIndices = new Map<string, SortedEntry[]>();
  private readonly compositeIndices = new Map<string, CompositeIndexInternal>();
  private readonly prefixIndices = new Map<string, Map<string, Set<string>>>();
  private constraints: DbTableConstraints<T> | undefined;
  private readonly uniqueIndices = new Map<string, Map<string, string>>();
  private isDeferringMutationEvents = false;
  private deferredMutationEvents: Array<() => void> = [];

  // Subscriptions & Timers
  private readonly subscriptions = new Map<
    string,
    { callback: TableChangeCallback<T>; filter?: (record: T) => boolean }
  >();
  private subscriptionSeq = 0;
  private readonly ttlTimers = new Map<string, NodeJS.Timeout>();
  private readonly ttlDeadlines = new Map<string, number>();

  constructor(name: string, walHook?: WalHookFn, assertWritable?: () => void) {
    this.name = name;
    this.walHook = walHook;
    this.assertWritable = assertWritable;
  }

  /** Installs runtime schema checks and unique indexes for JSONSQL tables. */
  setConstraints(constraints: DbTableConstraints<T> | undefined): void {
    const previous = this.constraints;
    this.constraints = constraints;
    try {
      this.rebuildUniqueIndices();
    } catch (error) {
      this.constraints = previous;
      this.rebuildUniqueIndices();
      throw error;
    }
  }

  createIndex(field: keyof T & string): void {
    if (this.equalityIndices.has(field)) return;
    const indexMap = new Map<unknown, Set<string>>();
    this.equalityIndices.set(field, indexMap);

    for (const [id, record] of this.records.entries()) {
      const val = this.resolveFieldValue(record, field);
      if (val !== undefined) {
        let idSet = indexMap.get(val);
        if (!idSet) {
          idSet = new Set<string>();
          indexMap.set(val, idSet);
        }
        idSet.add(id);
      }
    }
  }

  createSortedIndex(field: keyof T & string): void {
    if (this.sortedIndices.has(field)) return;
    const sortedList: SortedEntry[] = [];
    this.sortedIndices.set(field, sortedList);

    for (const [id, record] of this.records.entries()) {
      const rawVal = this.resolveFieldValue(record, field);
      const val = this.normalizeSortableValue(rawVal);
      if (val !== undefined) {
        this.insertSortedIndexEntry(sortedList, val, id);
      }
    }
  }

  createCompositeIndex(fields: readonly (keyof T & string)[]): void {
    const compName = fields.join("__");
    if (this.compositeIndices.has(compName)) return;

    const compIndex: CompositeIndexInternal = {
      fields,
      map: new Map<string, Set<string>>(),
    };
    this.compositeIndices.set(compName, compIndex);

    for (const [id, record] of this.records.entries()) {
      const key = this.buildCompositeKey(fields, record);
      let idSet = compIndex.map.get(key);
      if (!idSet) {
        idSet = new Set<string>();
        compIndex.map.set(key, idSet);
      }
      idSet.add(id);
    }
  }

  createPrefixIndex(field: keyof T & string): void {
    if (this.prefixIndices.has(field)) return;
    const prefixMap = new Map<string, Set<string>>();
    this.prefixIndices.set(field, prefixMap);

    for (const [id, record] of this.records.entries()) {
      const val = this.resolveFieldValue(record, field);
      if (typeof val === "string") {
        this.insertPrefixIndex(prefixMap, val, id);
      }
    }
  }

  get(id: string): T | undefined {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  getAll(): readonly T[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  /** Returns cloned records together with their application keys. */
  getAllEntries(): readonly { id: string; record: T }[] {
    return Array.from(this.records.entries()).map(([id, record]) => ({ id, record: { ...record } }));
  }

  put(id: string, record: T, options?: DbPutOptions): T {
    this.assertWritable?.();
    this.validateTtl(options?.ttlMs);
    let result!: T;
    this.runMutationBatch([{ operation: "put", id, record }], () => {
      result = this.putOne(id, record, options);
    });
    return result;
  }

  putMany(entries: ReadonlyArray<{ id: string; record: T; options?: DbPutOptions }>): readonly T[] {
    this.assertWritable?.();
    for (const entry of entries) this.validateTtl(entry.options?.ttlMs);
    const results: T[] = [];
    this.runMutationBatch(entries.map(({ id, record }) => ({ operation: "put" as const, id, record })), () => {
      for (const entry of entries) results.push(this.putOne(entry.id, entry.record, entry.options));
    });
    return results;
  }

  compareAndSwap(
    id: string,
    predicate: (current: T | undefined) => boolean,
    updater: (current: T) => T,
    options?: DbPutOptions
  ): { success: boolean; record?: T } {
    this.assertWritable?.();
    const current = this.get(id);
    if (!predicate(current)) {
      return { success: false, record: current };
    }
    if (!current) {
      return { success: false };
    }
    const updated = updater({ ...current });
    const saved = this.put(id, updated, options);
    return { success: true, record: saved };
  }

  delete(id: string): boolean {
    this.assertWritable?.();
    const existing = this.records.get(id);
    if (!existing) return false;
    this.runMutationBatch([{ operation: "delete", id }], () => this.deleteOne(id));
    return true;
  }

  /** Deletes all currently present keys as one in-memory mutation batch. */
  deleteMany(ids: readonly string[]): number {
    this.assertWritable?.();
    const existing = [...new Set(ids)].filter((id) => this.records.has(id));
    this.runMutationBatch(existing.map((id) => ({ operation: "delete" as const, id })), () => {
      for (const id of existing) this.deleteOne(id);
    });
    return existing.length;
  }

  deleteWhere(where: Record<string, DbWhereValue>): number {
    this.assertWritable?.();
    const matching = Array.from(this.records.entries())
      .filter(([, record]) => this.evaluateWhere(record, where))
      .map(([id]) => id);
    return this.deleteMany(matching);
  }

  updateWhere(where: Record<string, DbWhereValue>, updater: (record: T) => T): number {
    this.assertWritable?.();
    const matching = Array.from(this.records.entries())
      .filter(([, record]) => this.evaluateWhere(record, where))
      .map(([id, record]) => [id, { ...record }] as const);
    const updates = matching.map(([id, record]) => ({ id, record: updater(record) }));
    this.runMutationBatch(updates.map(({ id, record }) => ({ operation: "put" as const, id, record })), () => {
      for (const { id, record } of updates) this.putOne(id, record);
    });
    return updates.length;
  }

  count(): number {
    return this.records.size;
  }

  clear(): void {
    this.assertWritable?.();
    const ids = [...this.records.keys()];
    this.runMutationBatch(ids.map((id) => ({ operation: "delete" as const, id })), () => {
      this.records.clear();
      for (const m of this.equalityIndices.values()) m.clear();
      for (const arr of this.sortedIndices.values()) arr.length = 0;
      for (const comp of this.compositeIndices.values()) comp.map.clear();
      for (const m of this.prefixIndices.values()) m.clear();
      for (const t of this.ttlTimers.values()) clearTimeout(t);
      this.ttlTimers.clear();
      this.ttlDeadlines.clear();

      this.deferMutationEvent(() => this.emitChangeEvent("CLEAR", "*", undefined, undefined));
      if (this.walHook) this.deferMutationEvent(() => this.walHook!("CLEAR", this.name, "*"));
    });
  }

  query(options: DbQueryOptions = {}): readonly T[] {
    return this.executeQueryRecords(options).map((record) => ({ ...record }));
  }

  queryEntries(options: DbQueryOptions = {}): readonly { id: string; record: T }[] {
    const selected = this.executeQueryRecords(options);
    const wanted = new Set(selected);
    const idByRecord = new Map<T, string>();
    for (const [id, record] of this.records.entries()) {
      if (wanted.has(record)) idByRecord.set(record, id);
    }
    return selected.map((record) => ({ id: idByRecord.get(record)!, record: { ...record } }));
  }

  private executeQueryRecords(options: DbQueryOptions): readonly T[] {
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
      throw new RangeError("limit must be a non-negative safe integer");
    }
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) {
      throw new RangeError("offset must be a non-negative safe integer");
    }
    const plan = this.planQuery(options);
    let candidates = plan.candidates;
    const hasBase = options.where !== undefined || (options.and?.length ?? 0) > 0;
    const alternatives = [
      ...(options.or ?? []).map((clause) => [clause]),
      ...(options.orGroups ?? []),
    ];
    candidates = candidates.filter((record) => {
      const matchesBase = hasBase &&
        (!options.where || this.evaluateWhere(record, options.where)) &&
        (options.and ?? []).every((clause) => this.evaluateWhere(record, clause));
      const matchesOr = alternatives.some((group) =>
        group.every((clause) => this.evaluateWhere(record, clause))
      );
      const matches = alternatives.length > 0
        ? (hasBase && matchesBase) || matchesOr
        : hasBase ? matchesBase : true;
      return matches && (!options.not || !this.evaluateWhere(record, options.not));
    });

    if (options.sortBy) {
      const sortFields = Array.isArray(options.sortBy) ? options.sortBy : [options.sortBy];
      const sortOrders = Array.isArray(options.sortOrder)
        ? options.sortOrder
        : [options.sortOrder ?? "asc"];

      candidates = [...candidates].sort((a, b) => {
        for (let i = 0; i < sortFields.length; i++) {
          const field = sortFields[i];
          const order = (sortOrders[i] ?? sortOrders[0]) === "desc" ? -1 : 1;
          const valA = this.resolveFieldValue(a, field);
          const valB = this.resolveFieldValue(b, field);

          if (valA === valB) continue;
          if (valA === undefined || valA === null) return 1;
          if (valB === undefined || valB === null) return -1;
          return (valA as any) > (valB as any) ? order : -order;
        }
        return 0;
      });
    }

    const offset = options.offset ?? 0;
    const limit = options.limit !== undefined ? options.limit : candidates.length;
    return candidates.slice(offset, offset + limit);
  }

  aggregate(query: DbAggregateQuery): DbAggregateResult {
    const candidateRecords = query.where ? this.query({ where: query.where }) : this.getAll();
    return BroccoliAggregateEngine.execute(this.name, candidateRecords, query);
  }

  subscribe(
    callback: TableChangeCallback<T>,
    filter?: (record: T) => boolean
  ): TableChangeSubscription {
    const id = `sub_${++this.subscriptionSeq}_${Date.now()}`;
    this.subscriptions.set(id, { callback, filter });

    return {
      subscriptionId: id,
      unsubscribe: () => {
        this.subscriptions.delete(id);
      },
    };
  }

  transaction<R>(fn: (tx: ITableTransaction<T>) => R): R {
    this.assertWritable?.();
    const snapshot = this.createSnapshot();
    const stagedMutations: Array<{ op: "PUT" | "DELETE"; id: string; record?: T }> = [];

    const tx: ITableTransaction<T> = {
      get: (id: string) => this.get(id),
      put: (id: string, record: T, options?: DbPutOptions) => {
        this.assertWritable?.();
        stagedMutations.push({ op: "PUT", id, record });
        this.putInternal(id, record);
        return { ...record };
      },
      delete: (id: string) => {
        this.assertWritable?.();
        stagedMutations.push({ op: "DELETE", id });
        return this.deleteInternal(id);
      },
      query: (options?: DbQueryOptions) => this.query(options),
    };

    try {
      const result = fn(tx);
      this.rebuildUniqueIndices();
      if (this.walHook) {
        for (const mut of stagedMutations) {
          if (mut.op === "PUT" && mut.record) {
            this.walHook("INSERT", this.name, mut.id, mut.record);
          } else if (mut.op === "DELETE") {
            this.walHook("DELETE", this.name, mut.id);
          }
        }
      }
      return result;
    } catch (err) {
      this.restoreSnapshot(snapshot);
      throw err;
    }
  }

  select(): IFluentQueryBuilder<T> {
    interface QueryState {
      base: Record<string, DbWhereValue>[];
      alternatives: Record<string, DbWhereValue>[][];
      sortFields: string[];
      sortDirections: ("asc" | "desc")[];
      limit?: number;
      offset?: number;
    }

    const makeBuilder = (): { builder: IFluentQueryBuilder<T>; state: QueryState } => {
      const state: QueryState = {
        base: [],
        alternatives: [],
        sortFields: [],
        sortDirections: [],
      };
      const addPredicate = (field: string, filter: DbFieldFilter): IFluentQueryBuilder<T> => {
        state.base.push({ [field]: filter });
        return builder;
      };
      const makeOptions = (pagination = true): DbQueryOptions => {
        const [where, ...and] = state.base;
        return {
          where,
          and: and.length > 0 ? and : undefined,
          orGroups: state.alternatives.length > 0 ? state.alternatives : undefined,
          sortBy: state.sortFields.length === 0
            ? undefined
            : state.sortFields.length === 1 ? state.sortFields[0] : state.sortFields,
          sortOrder: state.sortDirections.length === 0
            ? undefined
            : state.sortDirections.length === 1 ? state.sortDirections[0] : state.sortDirections,
          limit: pagination ? state.limit : undefined,
          offset: pagination ? state.offset : undefined,
        };
      };
      const createPredicate = (field: string): IFluentFieldPredicate<T> => ({
        equals: (val) => addPredicate(field, { $eq: val }),
        notEquals: (val) => addPredicate(field, { $ne: val }),
        greaterThan: (val) => addPredicate(field, { $gt: val }),
        greaterThanOrEqual: (val) => addPredicate(field, { $gte: val }),
        lessThan: (val) => addPredicate(field, { $lt: val }),
        lessThanOrEqual: (val) => addPredicate(field, { $lte: val }),
        in: (values) => addPredicate(field, { $in: values }),
        notIn: (values) => addPredicate(field, { $nin: values }),
        between: (min, max) => addPredicate(field, { $between: [min, max] }),
        startsWith: (prefix) => addPredicate(field, { $startsWith: prefix }),
        contains: (sub) => addPredicate(field, { $contains: sub }),
        matches: (regex) => addPredicate(field, { $regex: regex }),
      });

      const builder: IFluentQueryBuilder<T> = {
        where: (field) => createPredicate(field),
        and: (field) => createPredicate(field),
        or: (clause) => {
          const nested = makeBuilder();
          clause(nested.builder);
          if (nested.state.base.length > 0) state.alternatives.push(nested.state.base);
          state.alternatives.push(...nested.state.alternatives);
          return builder;
        },
        orderBy: (field, direction = "asc") => {
          state.sortFields.push(field);
          state.sortDirections.push(direction);
          return builder;
        },
        limit: (count) => {
          if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("limit must be a non-negative safe integer");
          state.limit = count;
          return builder;
        },
        offset: (count) => {
          if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("offset must be a non-negative safe integer");
          state.offset = count;
          return builder;
        },
        execute: () => this.query(makeOptions()),
        explain: () => this.explain(makeOptions()),
        first: () => this.query({ ...makeOptions(), limit: 1 })[0],
        count: () => this.query(makeOptions(false)).length,
      };
      return { builder, state };
    };

    return makeBuilder().builder;
  }

  explain(options: DbQueryOptions = {}): QueryExecutionPlan {
    const startTime = performance.now();
    const plan = this.planQuery(options);
    const results = this.query(options);
    const durationMicros = Math.round((performance.now() - startTime) * 1000);

    return {
      table: this.name,
      matchedIndex: plan.indexName,
      indexType: plan.indexType,
      scanStrategy: plan.scanStrategy,
      candidatesScanned: plan.candidates.length,
      recordsMatched: results.length,
      executionTimeMicros: durationMicros,
      query: options,
    };
  }

  createSnapshot(): Map<string, T> {
    const snap = new Map<string, T>();
    for (const [k, v] of this.records.entries()) {
      snap.set(k, { ...v });
    }
    return snap;
  }

  restoreSnapshot(snapshot: Map<string, T>): void {
    this.assertWritable?.();
    const entries = Array.from(snapshot.entries()).map(([id, record]) => ({ id, record }));
    const restoredUniqueIndices = this.buildUniqueIndices(entries);
    this.records.clear();
    for (const m of this.equalityIndices.values()) m.clear();
    for (const arr of this.sortedIndices.values()) arr.length = 0;
    for (const comp of this.compositeIndices.values()) comp.map.clear();
    for (const m of this.prefixIndices.values()) m.clear();
    for (const timer of this.ttlTimers.values()) clearTimeout(timer);
    this.ttlTimers.clear();
    this.ttlDeadlines.clear();

    for (const [k, v] of snapshot.entries()) {
      this.putInternal(k, v);
    }
    this.uniqueIndices.clear();
    for (const [name, index] of restoredUniqueIndices) this.uniqueIndices.set(name, index);
  }

  /** @internal Replaces table contents during checkpoint recovery without opening the write gate. */
  restoreRecoveryEntries(entries: readonly { id: string; record: T }[]): void {
    for (const timer of this.ttlTimers.values()) clearTimeout(timer);
    this.ttlTimers.clear();
    this.constraints = undefined;
    this.uniqueIndices.clear();
    this.resetRecordsAndIndexes();
    for (const { id, record } of entries) this.putInternal(id, record);
  }

  /** @internal Applies one already-validated WAL mutation during startup replay. */
  applyRecoveryMutation(op: WalOperationType, id: string, payload?: Record<string, unknown>): void {
    switch (op) {
      case "INSERT":
      case "UPDATE":
        if (!payload) throw new TypeError(`WAL ${op} frame is missing its record payload`);
        this.putInternal(id, payload as T);
        return;
      case "DELETE":
        this.deleteInternal(id);
        return;
      case "CLEAR":
        this.resetRecordsAndIndexes();
        return;
      default:
        return;
    }
  }

  /** @internal Re-arms process-local TTLs after kernel recovery or restart. */
  resumeExpirations(): void {
    for (const id of this.ttlDeadlines.keys()) {
      if (!this.records.has(id)) this.clearExpiration(id);
    }
    for (const id of this.ttlDeadlines.keys()) this.scheduleExpiration(id);
  }

  // Internal Helpers
  private putOne(id: string, record: T, options?: DbPutOptions): T {
    const existing = this.records.get(id);
    const isUpdate = existing !== undefined;
    const beforeClone = existing ? { ...existing } : undefined;
    this.clearExpiration(id);

    this.putInternal(id, record);

    if (options?.ttlMs !== undefined && options.ttlMs > 0) {
      this.ttlDeadlines.set(id, Date.now() + options.ttlMs);
      this.scheduleExpiration(id);
    }

    const clonedReturn = { ...this.records.get(id)! };
    this.deferMutationEvent(() => this.emitChangeEvent(
      isUpdate ? "UPDATE" : "INSERT",
      id,
      beforeClone,
      clonedReturn,
    ));
    if (this.walHook) {
      this.deferMutationEvent(() => this.walHook!(isUpdate ? "UPDATE" : "INSERT", this.name, id, clonedReturn));
    }
    return clonedReturn;
  }

  private deleteOne(id: string): boolean {
    const existing = this.records.get(id);
    if (!existing) return false;
    const beforeClone = { ...existing };
    this.deleteInternal(id);
    this.clearExpiration(id);
    this.deferMutationEvent(() => this.emitChangeEvent("DELETE", id, beforeClone, undefined));
    if (this.walHook) this.deferMutationEvent(() => this.walHook!("DELETE", this.name, id));
    return true;
  }

  private runMutationBatch<R>(mutations: readonly TableMutation<T>[], apply: () => R): R {
    if (!this.constraints || this.isDeferringMutationEvents) return apply();

    const finalMutations = new Map<string, TableMutation<T>>();
    for (const mutation of mutations) finalMutations.set(mutation.id, mutation);
    const affectedIds = new Set(finalMutations.keys());
    for (const mutation of finalMutations.values()) {
      if (mutation.operation === "put") this.constraints.validateRecord(mutation.id, mutation.record);
    }

    // Stage only the index entries touched by this batch. Rebuilding every
    // unique index from every record after each put made inserting N rows
    // quadratic even though each mutation affects only a handful of keys.
    const stagedIndexes: Array<{
      name: string;
      index: Map<string, string>;
      removals: Array<{ key: string; id: string }>;
      additions: Array<{ key: string; id: string }>;
    }> = [];
    for (const constraint of this.constraints.unique) {
      const proposed = new Map<string, string>();
      const index = this.uniqueIndices.get(constraint.name) ?? new Map<string, string>();
      const removals: Array<{ key: string; id: string }> = [];
      const additions: Array<{ key: string; id: string }> = [];

      for (const id of affectedIds) {
        const current = this.records.get(id);
        if (current === undefined) continue;
        const key = this.uniqueKey(id, current, constraint);
        if (key !== undefined) removals.push({ key, id });
      }

      for (const mutation of finalMutations.values()) {
        if (mutation.operation !== "put") continue;
        const key = this.uniqueKey(mutation.id, mutation.record, constraint);
        if (key === undefined) continue;
        const currentOwner = index.get(key);
        if (currentOwner !== undefined && currentOwner !== mutation.id && !affectedIds.has(currentOwner)) {
          throw this.constraints.conflict(constraint);
        }
        const proposedOwner = proposed.get(key);
        if (proposedOwner !== undefined && proposedOwner !== mutation.id) {
          throw this.constraints.conflict(constraint);
        }
        proposed.set(key, mutation.id);
        additions.push({ key, id: mutation.id });
      }
      stagedIndexes.push({ name: constraint.name, index, removals, additions });
    }

    this.isDeferringMutationEvents = true;
    this.deferredMutationEvents = [];
    let result: R;
    try {
      result = apply();
      for (const staged of stagedIndexes) {
        for (const { key, id } of staged.removals) {
          if (staged.index.get(key) === id) staged.index.delete(key);
        }
        for (const { key, id } of staged.additions) staged.index.set(key, id);
        this.uniqueIndices.set(staged.name, staged.index);
      }
    } catch (error) {
      // An unexpected failure in the underlying mutation can leave a partial
      // batch behind. Rebuild in this exceptional path to keep indexes aligned
      // with the records that were actually applied.
      try { this.rebuildUniqueIndices(); } catch { /* Keep the original mutation error. */ }
      this.deferredMutationEvents = [];
      this.isDeferringMutationEvents = false;
      throw error;
    }
    const deferred = this.deferredMutationEvents;
    this.deferredMutationEvents = [];
    this.isDeferringMutationEvents = false;
    for (const effect of deferred) effect();
    return result;
  }

  private deferMutationEvent(effect: () => void): void {
    if (this.isDeferringMutationEvents) this.deferredMutationEvents.push(effect);
    else effect();
  }

  private validateTtl(ttlMs: number | undefined): void {
    if (ttlMs === undefined) return;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || !Number.isSafeInteger(Date.now() + ttlMs)) {
      throw new RangeError("ttlMs must be a non-negative safe integer that fits in a timestamp");
    }
  }

  private clearExpiration(id: string): void {
    const timer = this.ttlTimers.get(id);
    if (timer) clearTimeout(timer);
    this.ttlTimers.delete(id);
    this.ttlDeadlines.delete(id);
  }

  private scheduleExpiration(id: string): void {
    const deadline = this.ttlDeadlines.get(id);
    if (deadline === undefined || !this.records.has(id)) return;
    const previous = this.ttlTimers.get(id);
    if (previous) clearTimeout(previous);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - Date.now()));
    const timer = setTimeout(() => {
      this.ttlTimers.delete(id);
      if (Date.now() < deadline) {
        this.scheduleExpiration(id);
        return;
      }
      try {
        this.assertWritable?.();
      } catch {
        // Keep the deadline. resumeExpirations() will retry after start().
        return;
      }
      const current = this.records.get(id);
      if (!current) {
        this.ttlDeadlines.delete(id);
        return;
      }
      this.runMutationBatch([{ operation: "delete", id }], () => {
        const expired = this.records.get(id);
        if (!expired) return;
        this.deleteInternal(id);
        this.ttlDeadlines.delete(id);
        this.deferMutationEvent(() => this.emitChangeEvent("EXPIRE", id, expired, undefined));
        if (this.walHook) this.deferMutationEvent(() => this.walHook!("DELETE", this.name, id));
      });
    }, delay);
    timer.unref?.();
    this.ttlTimers.set(id, timer);
  }

  private resetRecordsAndIndexes(): void {
    this.records.clear();
    for (const index of this.equalityIndices.values()) index.clear();
    for (const entries of this.sortedIndices.values()) entries.length = 0;
    for (const index of this.compositeIndices.values()) index.map.clear();
    for (const index of this.prefixIndices.values()) index.clear();
  }

  private uniqueKey(id: string, record: T, constraint: DbTableUniqueConstraint): string | undefined {
    if (constraint.key) return constraint.key(id, record);
    const values = constraint.fields.map((field) => record[field]);
    if (values.some((value) => value === null || value === undefined)) return undefined;
    return JSON.stringify(values);
  }

  private rebuildUniqueIndices(): void {
    const next = this.buildUniqueIndices(this.getAllEntries());
    this.uniqueIndices.clear();
    for (const [name, index] of next) this.uniqueIndices.set(name, index);
  }

  private buildUniqueIndices(entries: readonly { id: string; record: T }[]): Map<string, Map<string, string>> {
    const next = new Map<string, Map<string, string>>();
    if (!this.constraints) return next;
    for (const constraint of this.constraints.unique) next.set(constraint.name, new Map());
    for (const { id, record } of entries) {
      this.constraints.validateRecord(id, record);
      for (const constraint of this.constraints.unique) {
        const key = this.uniqueKey(id, record, constraint);
        if (key === undefined) continue;
        const index = next.get(constraint.name)!;
        if (index.has(key) && index.get(key) !== id) throw this.constraints.conflict(constraint);
        index.set(key, id);
      }
    }
    return next;
  }

  private putInternal(id: string, record: T): void {
    const existing = this.records.get(id);
    if (existing) {
      this.removeIndicesForRecord(id, existing);
    }

    this.records.set(id, { ...record });
    this.addIndicesForRecord(id, record);
  }

  private deleteInternal(id: string): boolean {
    const existing = this.records.get(id);
    if (!existing) return false;

    this.removeIndicesForRecord(id, existing);
    this.records.delete(id);
    return true;
  }

  private planQuery(options: DbQueryOptions): {
    candidates: T[];
    indexName?: string;
    indexType?: IndexType;
    scanStrategy: "INDEX_LOOKUP" | "INDEX_RANGE_SCAN" | "COMPOSITE_INDEX_LOOKUP" | "PREFIX_SCAN" | "MULTI_INDEX_INTERSECTION" | "FULL_TABLE_SCAN";
  } {
    if ((options.or?.length ?? 0) > 0 || (options.orGroups?.length ?? 0) > 0) {
      return { candidates: Array.from(this.records.values()), scanStrategy: "FULL_TABLE_SCAN" };
    }
    if (!options.where) {
      // Check if sortBy matches a sorted index and reuse its value order.
      if (options.sortBy && typeof options.sortBy === "string" && this.sortedIndices.has(options.sortBy)) {
        const sortedList = this.sortedIndices.get(options.sortBy)!;
        const candidates: T[] = [];
        const isDesc = options.sortOrder === "desc";
        if (isDesc) {
          for (let i = sortedList.length - 1; i >= 0; i--) {
            for (const id of sortedList[i].ids) {
              const r = this.records.get(id);
              if (r) candidates.push(r);
            }
          }
        } else {
          for (let i = 0; i < sortedList.length; i++) {
            for (const id of sortedList[i].ids) {
              const r = this.records.get(id);
              if (r) candidates.push(r);
            }
          }
        }
        return {
          candidates,
          indexName: options.sortBy,
          indexType: "sorted",
          scanStrategy: "INDEX_RANGE_SCAN",
        };
      }

      return {
        candidates: Array.from(this.records.values()),
        scanStrategy: "FULL_TABLE_SCAN",
      };
    }

    const whereKeys = Object.keys(options.where);

    // 1. Check Composite Indices (Multi-Field Exact Match)
    for (const [compName, compIndex] of this.compositeIndices.entries()) {
      const allFieldsPresent = compIndex.fields.every((f) => {
        const val = options.where![f];
        return val !== undefined && (typeof val !== "object" || val === null || (val as any).$eq !== undefined);
      });

      if (allFieldsPresent) {
        const keyParts = compIndex.fields.map((f) => {
          const val = options.where![f];
          if (typeof val === "object" && val !== null && (val as any).$eq !== undefined) {
            return String((val as any).$eq);
          }
          return String(val ?? "");
        });
        const compKey = keyParts.join("::");
        const idSet = compIndex.map.get(compKey);
        const candidates: T[] = [];
        if (idSet) {
          for (const id of idSet) {
            const r = this.records.get(id);
            if (r) candidates.push(r);
          }
        }
        return {
          candidates,
          indexName: compName,
          indexType: "composite",
          scanStrategy: "COMPOSITE_INDEX_LOOKUP",
        };
      }
    }

    // 2. Check Equality Indices & Multi-Index Intersection
    const matchingEqualitySets: Array<{ field: string; set: Set<string> }> = [];

    for (const field of whereKeys) {
      if (this.equalityIndices.has(field)) {
        const rawVal = options.where[field];
        let targetVal: unknown = rawVal;
        let isEquality = false;

        if (typeof rawVal !== "object" || rawVal === null) {
          targetVal = rawVal;
          isEquality = true;
        } else if ((rawVal as any).$eq !== undefined) {
          targetVal = (rawVal as any).$eq;
          isEquality = true;
        }

        if (isEquality) {
          const idSet = this.equalityIndices.get(field)?.get(targetVal);
          matchingEqualitySets.push({ field, set: idSet || new Set() });
        }
      }
    }

    if (matchingEqualitySets.length > 1) {
      // Sort sets by size ascending to reduce intersection work.
      matchingEqualitySets.sort((a, b) => a.set.size - b.set.size);
      const primarySet = matchingEqualitySets[0].set;
      const candidates: T[] = [];

      for (const id of primarySet) {
        let inAll = true;
        for (let i = 1; i < matchingEqualitySets.length; i++) {
          if (!matchingEqualitySets[i].set.has(id)) {
            inAll = false;
            break;
          }
        }
        if (inAll) {
          const r = this.records.get(id);
          if (r) candidates.push(r);
        }
      }

      return {
        candidates,
        indexName: matchingEqualitySets.map((m) => m.field).join("+"),
        indexType: "equality",
        scanStrategy: "MULTI_INDEX_INTERSECTION",
      };
    }

    if (matchingEqualitySets.length === 1) {
      const match = matchingEqualitySets[0];
      const candidates: T[] = [];
      for (const id of match.set) {
        const r = this.records.get(id);
        if (r) candidates.push(r);
      }
      return {
        candidates,
        indexName: match.field,
        indexType: "equality",
        scanStrategy: "INDEX_LOOKUP",
      };
    }

    // 3. Check Sorted Indices for Range Queries ($gt, $gte, $lt, $lte, $between)
    for (const field of whereKeys) {
      if (this.sortedIndices.has(field)) {
        const filter = options.where[field];
        if (typeof filter === "object" && filter !== null) {
          const f = filter as DbFieldFilter;
          if (f.$between || f.$gt !== undefined || f.$gte !== undefined || f.$lt !== undefined || f.$lte !== undefined) {
            const sortedList = this.sortedIndices.get(field)!;
            const candidates: T[] = [];

            for (const entry of sortedList) {
              const val = entry.value;
              let match = true;

              if (f.$between && (val < f.$between[0] || val > f.$between[1])) match = false;
              if (f.$gt !== undefined && val <= (f.$gt as any)) match = false;
              if (f.$gte !== undefined && val < (f.$gte as any)) match = false;
              if (f.$lt !== undefined && val >= (f.$lt as any)) match = false;
              if (f.$lte !== undefined && val > (f.$lte as any)) match = false;

              if (match) {
                for (const id of entry.ids) {
                  const r = this.records.get(id);
                  if (r) candidates.push(r);
                }
              }
            }

            return {
              candidates,
              indexName: field,
              indexType: "sorted",
              scanStrategy: "INDEX_RANGE_SCAN",
            };
          }
        }
      }
    }

    // 4. Check Prefix Indices ($startsWith)
    for (const field of whereKeys) {
      if (this.prefixIndices.has(field)) {
        const filter = options.where[field];
        if (typeof filter === "object" && filter !== null && (filter as DbFieldFilter).$startsWith) {
          const prefix = (filter as DbFieldFilter).$startsWith!.toLowerCase();
          const prefixMap = this.prefixIndices.get(field)!;
          const idSet = prefixMap.get(prefix);
          const candidates: T[] = [];
          if (idSet) {
            for (const id of idSet) {
              const r = this.records.get(id);
              if (r) candidates.push(r);
            }
          }
          return {
            candidates,
            indexName: field,
            indexType: "prefix",
            scanStrategy: "PREFIX_SCAN",
          };
        }
      }
    }

    return {
      candidates: Array.from(this.records.values()),
      scanStrategy: "FULL_TABLE_SCAN",
    };
  }

  private evaluateWhere(record: T, where: Record<string, DbWhereValue>): boolean {
    for (const [field, expected] of Object.entries(where)) {
      const actualVal = this.resolveFieldValue(record, field);

      if (expected === null || typeof expected !== "object") {
        if (actualVal !== expected) return false;
        continue;
      }

      if (expected instanceof RegExp) {
        expected.lastIndex = 0;
        if (typeof actualVal !== "string" || !expected.test(actualVal)) return false;
        continue;
      }

      const filter = expected as DbFieldFilter;

      if (filter.$eq !== undefined && actualVal !== filter.$eq) return false;
      if (filter.$ne !== undefined && actualVal === filter.$ne) return false;
      if (filter.$exists !== undefined) {
        const exists = actualVal !== undefined;
        if (exists !== filter.$exists) return false;
      }

      if (filter.$gt !== undefined) {
        if (actualVal === undefined || actualVal === null || (actualVal as any) <= filter.$gt) return false;
      }
      if (filter.$gte !== undefined) {
        if (actualVal === undefined || actualVal === null || (actualVal as any) < filter.$gte) return false;
      }
      if (filter.$lt !== undefined) {
        if (actualVal === undefined || actualVal === null || (actualVal as any) >= filter.$lt) return false;
      }
      if (filter.$lte !== undefined) {
        if (actualVal === undefined || actualVal === null || (actualVal as any) > filter.$lte) return false;
      }
      if (filter.$in !== undefined && (!Array.isArray(filter.$in) || !filter.$in.includes(actualVal))) {
        return false;
      }
      if (filter.$nin !== undefined && Array.isArray(filter.$nin) && filter.$nin.includes(actualVal)) {
        return false;
      }
      if (filter.$between !== undefined) {
        const [min, max] = filter.$between;
        if (actualVal === undefined || actualVal === null || (actualVal as any) < min || (actualVal as any) > max) {
          return false;
        }
      }
      if (filter.$startsWith !== undefined) {
        if (typeof actualVal !== "string" || !actualVal.startsWith(filter.$startsWith)) return false;
      }
      if (filter.$endsWith !== undefined) {
        if (typeof actualVal !== "string" || !actualVal.endsWith(filter.$endsWith)) return false;
      }
      if (filter.$contains !== undefined) {
        if (typeof actualVal !== "string" || !actualVal.includes(filter.$contains)) return false;
      }
      if (filter.$regex !== undefined) {
        const re = typeof filter.$regex === "string" ? new RegExp(filter.$regex, "i") : filter.$regex;
        re.lastIndex = 0;
        if (typeof actualVal !== "string" || !re.test(actualVal)) return false;
      }
    }
    return true;
  }

  private resolveFieldValue(record: T, field: string): unknown {
    return record[field];
  }

  private normalizeSortableValue(val: unknown): number | string | undefined {
    if (typeof val === "number" || typeof val === "string") return val;
    if (val instanceof Date) return val.getTime();
    return undefined;
  }

  private insertSortedIndexEntry(list: SortedEntry[], val: number | string, id: string): void {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (list[mid].value < val) low = mid + 1;
      else high = mid;
    }
    if (low < list.length && list[low].value === val) {
      list[low].ids.add(id);
    } else {
      list.splice(low, 0, { value: val, ids: new Set([id]) });
    }
  }

  private buildCompositeKey(fields: readonly string[], record: Record<string, unknown>): string {
    return fields.map((f) => String(record[f] ?? "")).join("::");
  }

  private insertPrefixIndex(prefixMap: Map<string, Set<string>>, text: string, id: string): void {
    const normalized = text.toLowerCase();
    for (let len = 1; len <= Math.min(20, normalized.length); len++) {
      const prefix = normalized.slice(0, len);
      let set = prefixMap.get(prefix);
      if (!set) {
        set = new Set<string>();
        prefixMap.set(prefix, set);
      }
      set.add(id);
    }
  }

  private addIndicesForRecord(id: string, record: T): void {
    for (const [field, indexMap] of this.equalityIndices.entries()) {
      const val = this.resolveFieldValue(record, field);
      if (val !== undefined) {
        let idSet = indexMap.get(val);
        if (!idSet) {
          idSet = new Set<string>();
          indexMap.set(val, idSet);
        }
        idSet.add(id);
      }
    }

    for (const [field, sortedList] of this.sortedIndices.entries()) {
      const rawVal = this.resolveFieldValue(record, field);
      const val = this.normalizeSortableValue(rawVal);
      if (val !== undefined) {
        this.insertSortedIndexEntry(sortedList, val, id);
      }
    }

    for (const [compName, compIndex] of this.compositeIndices.entries()) {
      const key = this.buildCompositeKey(compIndex.fields, record);
      let idSet = compIndex.map.get(key);
      if (!idSet) {
        idSet = new Set<string>();
        compIndex.map.set(key, idSet);
      }
      idSet.add(id);
    }

    for (const [field, prefixMap] of this.prefixIndices.entries()) {
      const val = this.resolveFieldValue(record, field);
      if (typeof val === "string") {
        this.insertPrefixIndex(prefixMap, val, id);
      }
    }
  }

  private removeIndicesForRecord(id: string, record: T): void {
    for (const [field, indexMap] of this.equalityIndices.entries()) {
      const val = this.resolveFieldValue(record, field);
      if (val !== undefined) {
        const idSet = indexMap.get(val);
        if (idSet) {
          idSet.delete(id);
          if (idSet.size === 0) indexMap.delete(val);
        }
      }
    }

    for (const [field, sortedList] of this.sortedIndices.entries()) {
      const rawVal = this.resolveFieldValue(record, field);
      const val = this.normalizeSortableValue(rawVal);
      if (val !== undefined) {
        for (let i = 0; i < sortedList.length; i++) {
          if (sortedList[i].value === val) {
            sortedList[i].ids.delete(id);
            if (sortedList[i].ids.size === 0) {
              sortedList.splice(i, 1);
            }
            break;
          }
        }
      }
    }

    for (const [compName, compIndex] of this.compositeIndices.entries()) {
      const key = this.buildCompositeKey(compIndex.fields, record);
      const idSet = compIndex.map.get(key);
      if (idSet) {
        idSet.delete(id);
        if (idSet.size === 0) compIndex.map.delete(key);
      }
    }

    for (const [field, prefixMap] of this.prefixIndices.entries()) {
      const val = this.resolveFieldValue(record, field);
      if (typeof val === "string") {
        const normalized = val.toLowerCase();
        for (let len = 1; len <= Math.min(20, normalized.length); len++) {
          const prefix = normalized.slice(0, len);
          const set = prefixMap.get(prefix);
          if (set) {
            set.delete(id);
            if (set.size === 0) prefixMap.delete(prefix);
          }
        }
      }
    }
  }

  private emitChangeEvent(
    operation: TableChangeOperation,
    recordId: string,
    before?: T,
    after?: T
  ): void {
    if (this.subscriptions.size === 0) return;

    let diff: Record<string, { readonly old?: unknown; readonly new?: unknown }> | undefined;
    if (before && after) {
      diff = {};
      const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const k of allKeys) {
        if (before[k] !== after[k]) {
          diff[k] = { old: before[k], new: after[k] };
        }
      }
    }

    const event: TableChangeEvent<T> = {
      operation,
      table: this.name,
      recordId,
      before,
      after,
      diff,
      timestamp: Date.now(),
    };

    for (const { callback, filter } of this.subscriptions.values()) {
      try {
        if (filter) {
          const target = after ?? before;
          if (target && !filter(target)) continue;
        }
        callback(event);
      } catch {
        // Isolate subscriber exceptions
      }
    }
  }
}
