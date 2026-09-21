/**
 * BroccoliDB constrained natural-language query parser.
 * Converts supported human-readable expressions into structured DbQueryOptions
 * without a network or model call.
 */

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import type {
  DbFieldFilter,
  DbQueryOptions,
  DbWhereValue,
  NaturalQueryParsed,
} from "./broccolidb.contracts.js";

export class BroccoliNaturalQueryParser {
  /**
   * Parses a natural language query string into structured DbQueryOptions and table metadata.
   */
  static parse(rawText: string, defaultTable = "default"): NaturalQueryParsed {
    const text = rawText.trim();
    const where: Record<string, DbWhereValue> = {};
    const tokensMatched: string[] = [];
    let sortBy: string | undefined;
    let sortOrder: "asc" | "desc" = "asc";
    let limit: number | undefined;
    let offset: number | undefined;
    let targetTable = defaultTable;

    // 1. Table Detection (e.g., "in audits table", "from shards", "table:sessions")
    const tableMatch = text.match(/(?:in|from|table:)\s+([a-zA-Z0-9_\-]+)(?:\s+table)?/i);
    if (tableMatch) {
      targetTable = tableMatch[1].toLowerCase();
      tokensMatched.push(tableMatch[0]);
    }

    // 2. Limit & Offset (e.g. "limit 10", "top 5", "first 20", "offset 5", "skip 10")
    const limitMatch = text.match(/(?:limit|top|first|max)\s+(\d+)/i);
    if (limitMatch) {
      limit = parseInt(limitMatch[1], 10);
      tokensMatched.push(limitMatch[0]);
    }

    const offsetMatch = text.match(/(?:offset|skip)\s+(\d+)/i);
    if (offsetMatch) {
      offset = parseInt(offsetMatch[1], 10);
      tokensMatched.push(offsetMatch[0]);
    }

    // 3. Sorting (e.g. "sorted by timestamp desc", "order by priority", "latest first", "oldest first")
    if (/latest(?:\s+first)?/i.test(text)) {
      sortBy = "createdAt";
      sortOrder = "desc";
      tokensMatched.push("latest");
    } else if (/oldest(?:\s+first)?/i.test(text)) {
      sortBy = "createdAt";
      sortOrder = "asc";
      tokensMatched.push("oldest");
    } else {
      const sortMatch = text.match(/(?:sort|sorted|order|ordered)\s+by\s+([a-zA-Z0-9_\-]+)(?:\s+(asc|desc|ascending|descending))?/i);
      if (sortMatch) {
        sortBy = sortMatch[1];
        if (sortMatch[2]) {
          sortOrder = sortMatch[2].toLowerCase().startsWith("desc") ? "desc" : "asc";
        }
        tokensMatched.push(sortMatch[0]);
      }
    }

    // 4. Comparison Operators & Between (e.g. "score between 10 and 20", "tokens > 3000", "latency <= 100")
    const betweenRegex = /([a-zA-Z0-9_\-]+)\s+between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)/gi;
    let bMatch: RegExpExecArray | null;
    while ((bMatch = betweenRegex.exec(text)) !== null) {
      const field = bMatch[1];
      const min = parseFloat(bMatch[2]);
      const max = parseFloat(bMatch[3]);
      where[field] = { $between: [min, max] };
      tokensMatched.push(bMatch[0]);
    }

    const compRegex = /([a-zA-Z0-9_\-]+)\s*(>=|<=|>|<|!=|=)\s*['"]?([^'"\s,]+)['"]?/g;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = compRegex.exec(text)) !== null) {
      const field = cMatch[1];
      const op = cMatch[2];
      const rawVal = cMatch[3];
      let val: any = rawVal;
      const lower = rawVal.toLowerCase();
      if (lower === 'true') {
        val = true;
      } else if (lower === 'false') {
        val = false;
      } else if (lower === 'null') {
        val = null;
      } else if (!Number.isNaN(Number(rawVal)) && rawVal.trim() !== '') {
        val = Number(rawVal);
      }

      const existingFilter: DbFieldFilter = (typeof where[field] === "object" && where[field] !== null)
        ? (where[field] as DbFieldFilter)
        : {};

      let updatedFilter: DbFieldFilter;
      switch (op) {
        case ">=":
          updatedFilter = { ...existingFilter, $gte: val as any };
          break;
        case "<=":
          updatedFilter = { ...existingFilter, $lte: val as any };
          break;
        case ">":
          updatedFilter = { ...existingFilter, $gt: val as any };
          break;
        case "<":
          updatedFilter = { ...existingFilter, $lt: val as any };
          break;
        case "!=":
          updatedFilter = { ...existingFilter, $ne: val };
          break;
        case "=":
        default:
          updatedFilter = { ...existingFilter, $eq: val };
          break;
      }
      where[field] = updatedFilter;
      tokensMatched.push(cMatch[0]);
    }

    // 5. In / Or List (e.g. "status in [healthy, paused]", "profile is hipaa or gdpr")
    const inListRegex = /([a-zA-Z0-9_\-]+)\s+(?:in\s*\[([a-zA-Z0-9_,\s\-]+)\]|(?:is|are)\s+([a-zA-Z0-9_\-]+)\s+or\s+([a-zA-Z0-9_\-]+))/gi;
    let inMatch: RegExpExecArray | null;
    while ((inMatch = inListRegex.exec(text)) !== null) {
      const field = inMatch[1];
      let items: string[];
      if (inMatch[2]) {
        items = inMatch[2].split(",").map((s) => s.trim());
      } else {
        items = [inMatch[3].trim(), inMatch[4].trim()];
      }
      where[field] = { $in: items };
      tokensMatched.push(inMatch[0]);
    }

    // 6. StartsWith / Prefix (e.g. "userId starts with user_prod", "shardId starting with gpt")
    const startRegex = /([a-zA-Z0-9_\-]+)\s+(?:starts?\s+with|starting\s+with)\s+['"]?([a-zA-Z0-9_\-]+)['"]?/gi;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = startRegex.exec(text)) !== null) {
      const field = sMatch[1];
      const prefix = sMatch[2];
      where[field] = { $startsWith: prefix };
      tokensMatched.push(sMatch[0]);
    }

    // 7. Contains / Text Search (e.g. "action contains EXFILTRATION", "metadata contains error")
    const containRegex = /([a-zA-Z0-9_\-]+)\s+(?:contains?|containing)\s+['"]?([a-zA-Z0-9_\-]+)['"]?/gi;
    let ctMatch: RegExpExecArray | null;
    while ((ctMatch = containRegex.exec(text)) !== null) {
      const field = ctMatch[1];
      const substring = ctMatch[2];
      where[field] = { $contains: substring };
      tokensMatched.push(ctMatch[0]);
    }

    // 8. Equality (e.g. "status is healthy", "with action INFERENCE", "region:us")
    const eqRegex = /(?:\bwhere\s+|\bwith\s+|\b)([a-zA-Z0-9_\-]+)\s*(?::|\s+is\s+|=)\s*['"]?([^'"\s,]+)['"]?/gi;
    let eMatch: RegExpExecArray | null;
    while ((eMatch = eqRegex.exec(text)) !== null) {
      const field = eMatch[1];
      const rawVal = eMatch[2];
      const reserved = ["table", "limit", "offset", "sort", "sorted", "order", "ordered", "by", "asc", "desc", "and", "or", "not", "where", "with", "in", "from", "select"];
      if (!reserved.includes(field.toLowerCase()) && !(field in where)) {
        let parsedVal: any = rawVal;
        const lower = rawVal.toLowerCase();
        if (lower === 'true') parsedVal = true;
        else if (lower === 'false') parsedVal = false;
        else if (lower === 'null') parsedVal = null;
        else if (!Number.isNaN(Number(rawVal)) && rawVal.trim() !== '') parsedVal = Number(rawVal);

        where[field] = { $eq: parsedVal };
        tokensMatched.push(eMatch[0]);
      }
    }

    const queryOptions: DbQueryOptions = {
      where: Object.keys(where).length > 0 ? where : undefined,
      sortBy,
      sortOrder: sortBy ? sortOrder : undefined,
      limit,
      offset,
    };

    const matchedChars = tokensMatched.reduce((acc, t) => acc + t.length, 0);
    const confidence = Math.min(1.0, Math.max(0.2, (matchedChars / Math.max(1, text.length)) * 1.2));

    return {
      rawText: text,
      targetTable,
      queryOptions,
      confidence: Math.round(confidence * 100) / 100,
      tokensMatched,
    };
  }
}
