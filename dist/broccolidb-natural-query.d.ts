/**
 * GALXAI: BroccoliDB Deterministic Natural Language Query Parser (Zenith Tier)
 * Converts conversational, human-friendly natural search expressions into structured
 * DbQueryOptions without any external LLM roundtrips (< 0.1 ms offline AST parsing).
 */
import type { NaturalQueryParsed } from "./broccolidb.contracts.js";
export declare class BroccoliNaturalQueryParser {
    /**
     * Parses a natural language query string into structured DbQueryOptions and table metadata.
     */
    static parse(rawText: string, defaultTable?: string): NaturalQueryParsed;
}
//# sourceMappingURL=broccolidb-natural-query.d.ts.map