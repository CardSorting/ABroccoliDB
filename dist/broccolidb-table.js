// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB generic reactive in-memory table.
 * Maintains secondary indexes, operator filters, aggregation, change
 * subscriptions, and TTL expiration for records held in process memory.
 */
import { BroccoliAggregateEngine } from "./broccolidb-aggregation.js";
export class BroccoliDbTable {
    name;
    records = new Map();
    walHook;
    // Index Stores
    equalityIndices = new Map();
    sortedIndices = new Map();
    compositeIndices = new Map();
    prefixIndices = new Map();
    // Subscriptions & Timers
    subscriptions = new Map();
    subscriptionSeq = 0;
    ttlTimers = new Map();
    constructor(name, walHook) {
        this.name = name;
        this.walHook = walHook;
    }
    createIndex(field) {
        if (this.equalityIndices.has(field))
            return;
        const indexMap = new Map();
        this.equalityIndices.set(field, indexMap);
        for (const [id, record] of this.records.entries()) {
            const val = this.resolveFieldValue(record, field);
            if (val !== undefined) {
                let idSet = indexMap.get(val);
                if (!idSet) {
                    idSet = new Set();
                    indexMap.set(val, idSet);
                }
                idSet.add(id);
            }
        }
    }
    createSortedIndex(field) {
        if (this.sortedIndices.has(field))
            return;
        const sortedList = [];
        this.sortedIndices.set(field, sortedList);
        for (const [id, record] of this.records.entries()) {
            const rawVal = this.resolveFieldValue(record, field);
            const val = this.normalizeSortableValue(rawVal);
            if (val !== undefined) {
                this.insertSortedIndexEntry(sortedList, val, id);
            }
        }
    }
    createCompositeIndex(fields) {
        const compName = fields.join("__");
        if (this.compositeIndices.has(compName))
            return;
        const compIndex = {
            fields,
            map: new Map(),
        };
        this.compositeIndices.set(compName, compIndex);
        for (const [id, record] of this.records.entries()) {
            const key = this.buildCompositeKey(fields, record);
            let idSet = compIndex.map.get(key);
            if (!idSet) {
                idSet = new Set();
                compIndex.map.set(key, idSet);
            }
            idSet.add(id);
        }
    }
    createPrefixIndex(field) {
        if (this.prefixIndices.has(field))
            return;
        const prefixMap = new Map();
        this.prefixIndices.set(field, prefixMap);
        for (const [id, record] of this.records.entries()) {
            const val = this.resolveFieldValue(record, field);
            if (typeof val === "string") {
                this.insertPrefixIndex(prefixMap, val, id);
            }
        }
    }
    get(id) {
        const record = this.records.get(id);
        return record ? { ...record } : undefined;
    }
    getAll() {
        return Array.from(this.records.values()).map((r) => ({ ...r }));
    }
    /** Returns cloned records together with their application keys. */
    getAllEntries() {
        return Array.from(this.records.entries()).map(([id, record]) => ({ id, record: { ...record } }));
    }
    put(id, record, options) {
        const existing = this.records.get(id);
        const isUpdate = existing !== undefined;
        const beforeClone = existing ? { ...existing } : undefined;
        this.putInternal(id, record);
        if (options?.ttlMs && options.ttlMs > 0) {
            const existingTimer = this.ttlTimers.get(id);
            if (existingTimer)
                clearTimeout(existingTimer);
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
        const stored = this.records.get(id);
        const clonedReturn = { ...stored };
        this.emitChangeEvent(isUpdate ? "UPDATE" : "INSERT", id, beforeClone, clonedReturn);
        if (this.walHook) {
            this.walHook(isUpdate ? "UPDATE" : "INSERT", this.name, id, clonedReturn);
        }
        return clonedReturn;
    }
    putMany(entries) {
        const results = [];
        for (const entry of entries) {
            results.push(this.put(entry.id, entry.record, entry.options));
        }
        return results;
    }
    compareAndSwap(id, predicate, updater, options) {
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
    delete(id) {
        const existing = this.records.get(id);
        if (!existing)
            return false;
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
    deleteWhere(where) {
        const matching = Array.from(this.records.entries())
            .filter(([, record]) => this.evaluateWhere(record, where))
            .map(([id]) => id);
        let deletedCount = 0;
        for (const id of matching) {
            if (this.delete(id)) {
                deletedCount++;
            }
        }
        return deletedCount;
    }
    updateWhere(where, updater) {
        const matching = Array.from(this.records.entries())
            .filter(([, record]) => this.evaluateWhere(record, where))
            .map(([id, record]) => [id, { ...record }]);
        let updatedCount = 0;
        for (const [id, record] of matching) {
            const updated = updater(record);
            this.put(id, updated);
            updatedCount++;
        }
        return updatedCount;
    }
    count() {
        return this.records.size;
    }
    clear() {
        this.records.clear();
        for (const m of this.equalityIndices.values())
            m.clear();
        for (const arr of this.sortedIndices.values())
            arr.length = 0;
        for (const comp of this.compositeIndices.values())
            comp.map.clear();
        for (const m of this.prefixIndices.values())
            m.clear();
        for (const t of this.ttlTimers.values())
            clearTimeout(t);
        this.ttlTimers.clear();
        this.emitChangeEvent("CLEAR", "*", undefined, undefined);
        if (this.walHook) {
            this.walHook("CLEAR", this.name, "*");
        }
    }
    query(options = {}) {
        const plan = this.planQuery(options);
        let candidates = plan.candidates;
        if (options.where) {
            candidates = candidates.filter((rec) => this.evaluateWhere(rec, options.where));
        }
        if (options.and && options.and.length > 0) {
            candidates = candidates.filter((rec) => options.and.every((clause) => this.evaluateWhere(rec, clause)));
        }
        if (options.or && options.or.length > 0) {
            candidates = candidates.filter((rec) => options.or.some((clause) => this.evaluateWhere(rec, clause)));
        }
        if (options.not) {
            candidates = candidates.filter((rec) => !this.evaluateWhere(rec, options.not));
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
                    if (valA === valB)
                        continue;
                    if (valA === undefined || valA === null)
                        return 1;
                    if (valB === undefined || valB === null)
                        return -1;
                    return valA > valB ? order : -order;
                }
                return 0;
            });
        }
        const offset = options.offset ?? 0;
        const limit = options.limit !== undefined ? options.limit : candidates.length;
        return candidates.slice(offset, offset + limit).map((r) => ({ ...r }));
    }
    aggregate(query) {
        const candidateRecords = query.where ? this.query({ where: query.where }) : this.getAll();
        return BroccoliAggregateEngine.execute(this.name, candidateRecords, query);
    }
    subscribe(callback, filter) {
        const id = `sub_${++this.subscriptionSeq}_${Date.now()}`;
        this.subscriptions.set(id, { callback, filter });
        return {
            subscriptionId: id,
            unsubscribe: () => {
                this.subscriptions.delete(id);
            },
        };
    }
    transaction(fn) {
        const snapshot = this.createSnapshot();
        const stagedMutations = [];
        const tx = {
            get: (id) => this.get(id),
            put: (id, record, options) => {
                stagedMutations.push({ op: "PUT", id, record });
                this.putInternal(id, record);
                return { ...record };
            },
            delete: (id) => {
                stagedMutations.push({ op: "DELETE", id });
                return this.deleteInternal(id);
            },
            query: (options) => this.query(options),
        };
        try {
            const result = fn(tx);
            if (this.walHook) {
                for (const mut of stagedMutations) {
                    if (mut.op === "PUT" && mut.record) {
                        this.walHook("INSERT", this.name, mut.id, mut.record);
                    }
                    else if (mut.op === "DELETE") {
                        this.walHook("DELETE", this.name, mut.id);
                    }
                }
            }
            return result;
        }
        catch (err) {
            this.restoreSnapshot(snapshot);
            throw err;
        }
    }
    select() {
        const table = this;
        const whereObj = {};
        let sortByField;
        let sortDirection = "asc";
        let limitVal;
        let offsetVal;
        const createPredicate = (field) => ({
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
        const builder = {
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
    explain(options = {}) {
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
    createSnapshot() {
        const snap = new Map();
        for (const [k, v] of this.records.entries()) {
            snap.set(k, { ...v });
        }
        return snap;
    }
    restoreSnapshot(snapshot) {
        this.records.clear();
        for (const m of this.equalityIndices.values())
            m.clear();
        for (const arr of this.sortedIndices.values())
            arr.length = 0;
        for (const comp of this.compositeIndices.values())
            comp.map.clear();
        for (const m of this.prefixIndices.values())
            m.clear();
        for (const timer of this.ttlTimers.values())
            clearTimeout(timer);
        this.ttlTimers.clear();
        for (const [k, v] of snapshot.entries()) {
            this.putInternal(k, v);
        }
    }
    // Internal Helpers
    putInternal(id, record) {
        const existing = this.records.get(id);
        if (existing) {
            this.removeIndicesForRecord(id, existing);
        }
        this.records.set(id, { ...record });
        this.addIndicesForRecord(id, record);
    }
    deleteInternal(id) {
        const existing = this.records.get(id);
        if (!existing)
            return false;
        this.removeIndicesForRecord(id, existing);
        this.records.delete(id);
        return true;
    }
    planQuery(options) {
        if (!options.where) {
            // Check if sortBy matches a sorted index and reuse its value order.
            if (options.sortBy && typeof options.sortBy === "string" && this.sortedIndices.has(options.sortBy)) {
                const sortedList = this.sortedIndices.get(options.sortBy);
                const candidates = [];
                const isDesc = options.sortOrder === "desc";
                if (isDesc) {
                    for (let i = sortedList.length - 1; i >= 0; i--) {
                        for (const id of sortedList[i].ids) {
                            const r = this.records.get(id);
                            if (r)
                                candidates.push(r);
                        }
                    }
                }
                else {
                    for (let i = 0; i < sortedList.length; i++) {
                        for (const id of sortedList[i].ids) {
                            const r = this.records.get(id);
                            if (r)
                                candidates.push(r);
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
                const val = options.where[f];
                return val !== undefined && (typeof val !== "object" || val === null || val.$eq !== undefined);
            });
            if (allFieldsPresent) {
                const keyParts = compIndex.fields.map((f) => {
                    const val = options.where[f];
                    if (typeof val === "object" && val !== null && val.$eq !== undefined) {
                        return String(val.$eq);
                    }
                    return String(val ?? "");
                });
                const compKey = keyParts.join("::");
                const idSet = compIndex.map.get(compKey);
                const candidates = [];
                if (idSet) {
                    for (const id of idSet) {
                        const r = this.records.get(id);
                        if (r)
                            candidates.push(r);
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
        const matchingEqualitySets = [];
        for (const field of whereKeys) {
            if (this.equalityIndices.has(field)) {
                const rawVal = options.where[field];
                let targetVal = rawVal;
                let isEquality = false;
                if (typeof rawVal !== "object" || rawVal === null) {
                    targetVal = rawVal;
                    isEquality = true;
                }
                else if (rawVal.$eq !== undefined) {
                    targetVal = rawVal.$eq;
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
            const candidates = [];
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
                    if (r)
                        candidates.push(r);
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
            const candidates = [];
            for (const id of match.set) {
                const r = this.records.get(id);
                if (r)
                    candidates.push(r);
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
                    const f = filter;
                    if (f.$between || f.$gt !== undefined || f.$gte !== undefined || f.$lt !== undefined || f.$lte !== undefined) {
                        const sortedList = this.sortedIndices.get(field);
                        const candidates = [];
                        for (const entry of sortedList) {
                            const val = entry.value;
                            let match = true;
                            if (f.$between && (val < f.$between[0] || val > f.$between[1]))
                                match = false;
                            if (f.$gt !== undefined && val <= f.$gt)
                                match = false;
                            if (f.$gte !== undefined && val < f.$gte)
                                match = false;
                            if (f.$lt !== undefined && val >= f.$lt)
                                match = false;
                            if (f.$lte !== undefined && val > f.$lte)
                                match = false;
                            if (match) {
                                for (const id of entry.ids) {
                                    const r = this.records.get(id);
                                    if (r)
                                        candidates.push(r);
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
                if (typeof filter === "object" && filter !== null && filter.$startsWith) {
                    const prefix = filter.$startsWith.toLowerCase();
                    const prefixMap = this.prefixIndices.get(field);
                    const idSet = prefixMap.get(prefix);
                    const candidates = [];
                    if (idSet) {
                        for (const id of idSet) {
                            const r = this.records.get(id);
                            if (r)
                                candidates.push(r);
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
    evaluateWhere(record, where) {
        for (const [field, expected] of Object.entries(where)) {
            const actualVal = this.resolveFieldValue(record, field);
            if (expected === null || typeof expected !== "object") {
                if (actualVal !== expected)
                    return false;
                continue;
            }
            if (expected instanceof RegExp) {
                expected.lastIndex = 0;
                if (typeof actualVal !== "string" || !expected.test(actualVal))
                    return false;
                continue;
            }
            const filter = expected;
            if (filter.$eq !== undefined && actualVal !== filter.$eq)
                return false;
            if (filter.$ne !== undefined && actualVal === filter.$ne)
                return false;
            if (filter.$exists !== undefined) {
                const exists = actualVal !== undefined;
                if (exists !== filter.$exists)
                    return false;
            }
            if (filter.$gt !== undefined) {
                if (actualVal === undefined || actualVal === null || actualVal <= filter.$gt)
                    return false;
            }
            if (filter.$gte !== undefined) {
                if (actualVal === undefined || actualVal === null || actualVal < filter.$gte)
                    return false;
            }
            if (filter.$lt !== undefined) {
                if (actualVal === undefined || actualVal === null || actualVal >= filter.$lt)
                    return false;
            }
            if (filter.$lte !== undefined) {
                if (actualVal === undefined || actualVal === null || actualVal > filter.$lte)
                    return false;
            }
            if (filter.$in !== undefined && (!Array.isArray(filter.$in) || !filter.$in.includes(actualVal))) {
                return false;
            }
            if (filter.$nin !== undefined && Array.isArray(filter.$nin) && filter.$nin.includes(actualVal)) {
                return false;
            }
            if (filter.$between !== undefined) {
                const [min, max] = filter.$between;
                if (actualVal === undefined || actualVal === null || actualVal < min || actualVal > max) {
                    return false;
                }
            }
            if (filter.$startsWith !== undefined) {
                if (typeof actualVal !== "string" || !actualVal.startsWith(filter.$startsWith))
                    return false;
            }
            if (filter.$endsWith !== undefined) {
                if (typeof actualVal !== "string" || !actualVal.endsWith(filter.$endsWith))
                    return false;
            }
            if (filter.$contains !== undefined) {
                if (typeof actualVal !== "string" || !actualVal.includes(filter.$contains))
                    return false;
            }
            if (filter.$regex !== undefined) {
                const re = typeof filter.$regex === "string" ? new RegExp(filter.$regex, "i") : filter.$regex;
                re.lastIndex = 0;
                if (typeof actualVal !== "string" || !re.test(actualVal))
                    return false;
            }
        }
        return true;
    }
    resolveFieldValue(record, field) {
        return record[field];
    }
    normalizeSortableValue(val) {
        if (typeof val === "number" || typeof val === "string")
            return val;
        if (val instanceof Date)
            return val.getTime();
        return undefined;
    }
    insertSortedIndexEntry(list, val, id) {
        let low = 0;
        let high = list.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (list[mid].value < val)
                low = mid + 1;
            else
                high = mid;
        }
        if (low < list.length && list[low].value === val) {
            list[low].ids.add(id);
        }
        else {
            list.splice(low, 0, { value: val, ids: new Set([id]) });
        }
    }
    buildCompositeKey(fields, record) {
        return fields.map((f) => String(record[f] ?? "")).join("::");
    }
    insertPrefixIndex(prefixMap, text, id) {
        const normalized = text.toLowerCase();
        for (let len = 1; len <= Math.min(20, normalized.length); len++) {
            const prefix = normalized.slice(0, len);
            let set = prefixMap.get(prefix);
            if (!set) {
                set = new Set();
                prefixMap.set(prefix, set);
            }
            set.add(id);
        }
    }
    addIndicesForRecord(id, record) {
        for (const [field, indexMap] of this.equalityIndices.entries()) {
            const val = this.resolveFieldValue(record, field);
            if (val !== undefined) {
                let idSet = indexMap.get(val);
                if (!idSet) {
                    idSet = new Set();
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
                idSet = new Set();
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
    removeIndicesForRecord(id, record) {
        for (const [field, indexMap] of this.equalityIndices.entries()) {
            const val = this.resolveFieldValue(record, field);
            if (val !== undefined) {
                const idSet = indexMap.get(val);
                if (idSet) {
                    idSet.delete(id);
                    if (idSet.size === 0)
                        indexMap.delete(val);
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
                if (idSet.size === 0)
                    compIndex.map.delete(key);
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
                        if (set.size === 0)
                            prefixMap.delete(prefix);
                    }
                }
            }
        }
    }
    emitChangeEvent(operation, recordId, before, after) {
        if (this.subscriptions.size === 0)
            return;
        let diff;
        if (before && after) {
            diff = {};
            const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
            for (const k of allKeys) {
                if (before[k] !== after[k]) {
                    diff[k] = { old: before[k], new: after[k] };
                }
            }
        }
        const event = {
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
                    if (target && !filter(target))
                        continue;
                }
                callback(event);
            }
            catch {
                // Isolate subscriber exceptions
            }
        }
    }
}
//# sourceMappingURL=broccolidb-table.js.map