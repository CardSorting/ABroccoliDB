// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * BroccoliDB constrained natural-language query parser.
 * Converts supported human-readable expressions into structured DbQueryOptions
 * without a network or model call.
 */
import type { NaturalQueryParsed } from "./broccolidb.contracts.js";
export declare class BroccoliNaturalQueryParser {
    /**
     * Parses a natural language query string into structured DbQueryOptions and table metadata.
     */
    static parse(rawText: string, defaultTable?: string): NaturalQueryParsed;
}
//# sourceMappingURL=broccolidb-natural-query.d.ts.map