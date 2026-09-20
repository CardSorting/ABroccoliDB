/**
 * GALXAI: BroccoliDB Generic Reactive In-Memory Table (Zenith Tier)
 * Delivers sub-microsecond (<0.5 µs) hotpath lookups, multi-modal secondary indexing,
 * rich operator filtering, aggregation pipeline, reactive CDC subscriptions, and TTL expiration.
 */

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

interface SortedEntry {
  value: number | string;
  ids: Set<string>;
}

interface CompositeIndexInternal {
  fields: readonly string[];
  map: Map<string, Set<string>>;
}

export class BroccoliDbTable<T extends Record<string, any> = Record<string, any>>
  implements IDbTable<T>
{
  readonly name: string;
  private readonly records = new Map<string, T>();
  private readonly walHook?: WalHookFn;

  // Index Stores
  private readonly equalityIndices = new Map<string, Map<unknown, Set<string>>>();
  private readonly sortedIndices = new Map<string, SortedEntry[]>();
  private readonly compositeIndices = new Map<string, CompositeIndexInternal>();
  private readonly prefixIndices = new Map<string, Map<string, Set<string>>>();

  // Subscriptions & Timers
  private readonly subscriptions = new Map<
    string,
    { callback: TableChangeCallback<T>; filter?: (record: T) => boolean }
  >();
  private subscriptionSeq = 0;
  private readonly ttlTimers = new Map<string, NodeJS.Timeout>();

  constructor(name: string, walHook?: WalHookFn) {
    this.name = name;
    this.walHook = walHook;
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

  put(id: string, record: T, options?: DbPutOptions): T {
    const existing = this.records.get(id);
    const isUpdate = existing !== undefined;
    const beforeClone = existing ? { ...existing } : undefined;

    this.putInternal(id, record);

    if (options?.ttlMs && options.ttlMs > 0) {
      const existingTimer = this.ttlTimers.get(id);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        const expiredRec = this.records.get(id);
        if (expiredRec) {
          this.deleteInternal(id);
          this.ttlTimers.delete(id);
          this.emitChangeEvent("EXPIRE", id, expiredRec, undefined);
          if (this.walHook) {
            this.walHook("DELETE", this.name, id);
          }
        }
      }, options.ttlMs);
      timer.unref?.();
      this.ttlTimers.set(id, timer);
    }

    const stored = this.records.get(id)!;
    const clonedReturn = { ...stored };

    this.emitChangeEvent(
      isUpdate ? "UPDATE" : "INSERT",
      id,
      beforeClone,
      clonedReturn
    );

    if (this.walHook) {
      this.walHook(isUpdate ? "UPDATE" : "INSERT", this.name, id, clonedReturn);
    }

    return clonedReturn;
  }

  putMany(entries: ReadonlyArray<{ id: string; record: T; options?: DbPutOptions }>): readonly T[] {
    const results: T[] = [];
    for (const entry of entries) {
      results.push(this.put(entry.id, entry.record, entry.options));
    }
    return results;
  }

  compareAndSwap(
    id: string,
    predicate: (current: T | undefined) => boolean,
    updater: (current: T) => T,
    options?: DbPutOptions
  ): { success: boolean; record?: T } {
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
    const existing = this.records.get(id);
    if (!existing) return false;

    const beforeClone = { ...existing };
    this.deleteInternal(id);

    const timer = this.ttlTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.ttlTimers.delete(id);
    }

    this.emitChangeEvent("DELETE", id, beforeClone, undefined);

    if (this.walHook) {
      this.walHook("DELETE", this.name, id);
    }

    return true;
  }

  deleteWhere(where: Record<string, DbWhereValue>): number {
    const matching = this.query({ where });
    let deletedCount = 0;
    for (const record of matching) {
      const id = (record as any).id;
      if (id && this.delete(id)) {
        deletedCount++;
      }
    }
    return deletedCount;
  }

  updateWhere(where: Record<string, DbWhereValue>, updater: (record: T) => T): number {
    const matching = this.query({ where });
    let updatedCount = 0;
    for (const record of matching) {
      const id = (record as any).id;
      if (id) {
        const updated = updater({ ...record });
        this.put(id, updated);
        updatedCount++;
      }
    }
    return updatedCount;
  }

  count(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
    for (const m of this.equalityIndices.values()) m.clear();
    for (const arr of this.sortedIndices.values()) arr.length = 0;
    for (const comp of this.compositeIndices.values()) comp.map.clear();
    for (const m of this.prefixIndices.values()) m.clear();
    for (const t of this.ttlTimers.values()) clearTimeout(t);
    this.ttlTimers.clear();

    this.emitChangeEvent("CLEAR", "*", undefined, undefined);

    if (this.walHook) {
      this.walHook("CLEAR", this.name, "*");
    }
  }

  query(options: DbQueryOptions = {}): readonly T[] {
    const plan = this.planQuery(options);
    let candidates = plan.candidates;

    if (options.where) {
      candidates = candidates.filter((rec) => this.evaluateWhere(rec, options.where!));
    }

    if (options.and && options.and.length > 0) {
      candidates = candidates.filter((rec) =>
        options.and!.every((clause) => this.evaluateWhere(rec, clause))
      );
    }

    if (options.or && options.or.length > 0) {
      candidates = candidates.filter((rec) =>
        options.or!.some((clause) => this.evaluateWhere(rec, clause))
      );
    }

    if (options.not) {
      candidates = candidates.filter((rec) => !this.evaluateWhere(rec, options.not!));
    }

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
    return candidates.slice(offset, offset + limit).map((r) => ({ ...r }));
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
    const snapshot = this.createSnapshot();
    const stagedMutations: Array<{ op: "PUT" | "DELETE"; id: string; record?: T }> = [];

    const tx: ITableTransaction<T> = {
      get: (id: string) => this.get(id),
      put: (id: string, record: T, options?: DbPutOptions) => {
        stagedMutations.push({ op: "PUT", id, record });
        this.putInternal(id, record);
        return { ...record };
      },
      delete: (id: string) => {
        stagedMutations.push({ op: "DELETE", id });
        return this.deleteInternal(id);
      },
      query: (options?: DbQueryOptions) => this.query(options),
    };

    try {
      const result = fn(tx);
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
    const table = this;
    const whereObj: Record<string, DbWhereValue> = {};
    let sortByField: string | undefined;
    let sortDirection: "asc" | "desc" = "asc";
    let limitVal: number | undefined;
    let offsetVal: number | undefined;

    const createPredicate = (field: string): IFluentFieldPredicate<T> => ({
      equals: (val) => {
        whereObj[field] = { $eq: val };
        return builder;
      },
      notEquals: (val) => {
        whereObj[field] = { $ne: val };
        return builder;
      },
      greaterThan: (val) => {
        whereObj[field] = { $gt: val };
        return builder;
      },
      greaterThanOrEqual: (val) => {
        whereObj[field] = { $gte: val };
        return builder;
      },
      lessThan: (val) => {
        whereObj[field] = { $lt: val };
        return builder;
      },
      lessThanOrEqual: (val) => {
        whereObj[field] = { $lte: val };
        return builder;
      },
      in: (values) => {
        whereObj[field] = { $in: values };
        return builder;
      },
      notIn: (values) => {
        whereObj[field] = { $nin: values };
        return builder;
      },
      between: (min, max) => {
        whereObj[field] = { $between: [min, max] };
        return builder;
      },
      startsWith: (prefix) => {
        whereObj[field] = { $startsWith: prefix };
        return builder;
      },
      contains: (sub) => {
        whereObj[field] = { $contains: sub };
        return builder;
      },
      matches: (regex) => {
        whereObj[field] = { $regex: regex };
        return builder;
      },
    });

    const builder: IFluentQueryBuilder<T> = {
      where: (field) => createPredicate(field),
      and: (field) => createPredicate(field),
      or: (clause) => {
        const subBuilder = table.select();
        clause(subBuilder);
        return builder;
      },
      orderBy: (field, direction = "asc") => {
        sortByField = field;
        sortDirection = direction;
        return builder;
      },
      limit: (count) => {
        limitVal = count;
        return builder;
      },
      offset: (count) => {
        offsetVal = count;
        return builder;
      },
      execute: () => {
        return table.query({
          where: Object.keys(whereObj).length > 0 ? whereObj : undefined,
          sortBy: sortByField,
          sortOrder: sortDirection,
          limit: limitVal,
          offset: offsetVal,
        });
      },
      explain: () => {
        return table.explain({
          where: Object.keys(whereObj).length > 0 ? whereObj : undefined,
          sortBy: sortByField,
          sortOrder: sortDirection,
          limit: limitVal,
          offset: offsetVal,
        });
      },
      first: () => {
        const res = builder.limit(1).execute();
        return res[0];
      },
      count: () => {
        return builder.execute().length;
      },
    };

    return builder;
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
    this.records.clear();
    for (const m of this.equalityIndices.values()) m.clear();
    for (const arr of this.sortedIndices.values()) arr.length = 0;
    for (const comp of this.compositeIndices.values()) comp.map.clear();
    for (const m of this.prefixIndices.values()) m.clear();

    for (const [k, v] of snapshot.entries()) {
      this.putInternal(k, v);
    }
  }

  // Internal Helpers
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
    if (!options.where) {
      // Check if sortBy matches a sorted index for zero-cost pre-sorted candidates
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
      // Sort sets by size ascending for fastest intersection
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
