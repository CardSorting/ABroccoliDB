/**
 * BroccoliDB statistical aggregation and group-by engine.
 * Groups records in one traversal and supports SUM, AVG, MIN, MAX, COUNT,
 * STDDEV, and HAVING predicate filters.
 */

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import type {
  DbAggregateMetric,
  DbAggregateQuery,
  DbAggregateResult,
  DbGroupResult,
} from "./broccolidb.contracts.js";

interface AccumulatorGroup {
  keys: Record<string, unknown>;
  count: number;
  metricData: Record<
    string,
    {
      metric: DbAggregateMetric;
      field?: string;
      sum: number;
      min: number;
      max: number;
      values: number[];
    }
  >;
}

export class BroccoliAggregateEngine {
  /**
   * Executes an aggregation query across candidate records.
   */
  static execute<T extends Record<string, unknown>>(
    tableName: string,
    records: readonly T[],
    query: DbAggregateQuery
  ): DbAggregateResult {
    const startTime = performance.now();
    const groupMap = new Map<string, AccumulatorGroup>();
    const grandTotalsAccumulator: Record<
      string,
      { metric: DbAggregateMetric; field?: string; sum: number; min: number; max: number; values: number[] }
    > = {};

    for (const [metricKey, metricDef] of Object.entries(query.metrics)) {
      grandTotalsAccumulator[metricKey] = {
        metric: metricDef.metric,
        field: metricDef.field,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        values: [],
      };
    }

    for (const record of records) {
      const groupKeyObj: Record<string, unknown> = {};
      let compositeKey = "";

      if (query.groupBy && query.groupBy.length > 0) {
        for (const f of query.groupBy) {
          const v = record[f];
          groupKeyObj[f] = v;
          compositeKey += `${f}:${JSON.stringify(v)}|`;
        }
      } else {
        compositeKey = "__root__";
      }

      let group = groupMap.get(compositeKey);
      if (!group) {
        group = {
          keys: groupKeyObj,
          count: 0,
          metricData: {},
        };
        for (const [metricKey, metricDef] of Object.entries(query.metrics)) {
          group.metricData[metricKey] = {
            metric: metricDef.metric,
            field: metricDef.field,
            sum: 0,
            min: Number.POSITIVE_INFINITY,
            max: Number.NEGATIVE_INFINITY,
            values: [],
          };
        }
        groupMap.set(compositeKey, group);
      }

      group.count++;

      for (const [metricKey, metricDef] of Object.entries(query.metrics)) {
        const acc = group.metricData[metricKey];
        const grandAcc = grandTotalsAccumulator[metricKey];
        const val = metricDef.field ? Number(record[metricDef.field]) : 1;
        const isValidNum = typeof val === "number" && !Number.isNaN(val);

        if (isValidNum) {
          acc.sum += val;
          grandAcc.sum += val;

          if (val < acc.min) acc.min = val;
          if (val > acc.max) acc.max = val;
          if (val < grandAcc.min) grandAcc.min = val;
          if (val > grandAcc.max) grandAcc.max = val;

          if (metricDef.metric === "stddev") {
            acc.values.push(val);
            grandAcc.values.push(val);
          }
        }
      }
    }

    let groups: DbGroupResult[] = [];

    for (const group of groupMap.values()) {
      const finalizedMetrics: Record<string, number> = {};

      for (const [metricKey, acc] of Object.entries(group.metricData)) {
        finalizedMetrics[metricKey] = this.finalizeMetric(acc.metric, acc.sum, acc.min, acc.max, acc.values, group.count);
      }

      groups.push({
        keys: group.keys,
        metrics: finalizedMetrics,
        recordCount: group.count,
      });
    }

    if (query.having) {
      groups = groups.filter((g) => {
        for (const [k, expected] of Object.entries(query.having!)) {
          const val = k === "count" || k === "_count" ? g.recordCount : g.metrics[k];
          if (expected !== null && typeof expected === "object") {
            const expObj = expected as Record<string, number>;
            if (expObj.$gt !== undefined && (val === undefined || val <= expObj.$gt)) return false;
            if (expObj.$gte !== undefined && (val === undefined || val < expObj.$gte)) return false;
            if (expObj.$lt !== undefined && (val === undefined || val >= expObj.$lt)) return false;
            if (expObj.$lte !== undefined && (val === undefined || val > expObj.$lte)) return false;
            if (expObj.$eq !== undefined && val !== expObj.$eq) return false;
            if (expObj.$ne !== undefined && val === expObj.$ne) return false;
          } else if (val !== expected) {
            return false;
          }
        }
        return true;
      });
    }

    if (query.limit !== undefined && query.limit > 0) {
      groups = groups.slice(0, query.limit);
    }

    const grandTotals: Record<string, number> = {};
    for (const [metricKey, acc] of Object.entries(grandTotalsAccumulator)) {
      grandTotals[metricKey] = this.finalizeMetric(
        acc.metric,
        acc.sum,
        acc.min,
        acc.max,
        acc.values,
        records.length
      );
    }

    const executionTimeMicros = Math.round((performance.now() - startTime) * 1000);

    return {
      table: tableName,
      totalRecordsEvaluated: records.length,
      groups,
      grandTotals,
      executionTimeMicros,
    };
  }

  private static finalizeMetric(
    metric: DbAggregateMetric,
    sum: number,
    min: number,
    max: number,
    values: number[],
    count: number
  ): number {
    switch (metric) {
      case "count":
        return count;
      case "sum":
        return sum;
      case "avg":
        return count > 0 ? Math.round((sum / count) * 10000) / 10000 : 0;
      case "min":
        return min !== Number.POSITIVE_INFINITY ? min : 0;
      case "max":
        return max !== Number.NEGATIVE_INFINITY ? max : 0;
      case "stddev": {
        if (values.length <= 1) return 0;
        const mean = sum / values.length;
        const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
        return Math.round(Math.sqrt(variance) * 10000) / 10000;
      }
      default:
        return sum;
    }
  }
}
