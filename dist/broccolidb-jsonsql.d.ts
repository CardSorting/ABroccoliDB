// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * Dependency-free, SQLite-inspired SQL surface over BroccoliDB JSON tables.
 * This is a deliberately bounded embedded dialect, not a SQL server.
 */
import type { IDbTable } from "./broccolidb.contracts.js";
export type JsonSqlValue = null | string | number | boolean | JsonSqlValue[] | {
    [key: string]: JsonSqlValue;
};
export type JsonSqlColumnType = "TEXT" | "INTEGER" | "REAL" | "BOOLEAN" | "JSON" | "ANY";
export type JsonSqlStatementKind = "create-table" | "select" | "insert" | "update" | "delete";
export interface JsonSqlRunResult {
    readonly changes: number;
    readonly lastInsertRowid?: string | number;
}
export interface JsonSqlDatabase {
    prepare(sql: string): JsonSqlStatement;
}
export declare class JsonSqlError extends Error {
    readonly code: "ERR_JSONSQL_SYNTAX" | "ERR_JSONSQL_BINDINGS" | "ERR_JSONSQL_CONSTRAINT" | "ERR_JSONSQL_SCHEMA" | "ERR_JSONSQL_RESOURCE_LIMIT";
    constructor(message: string, code?: JsonSqlError["code"], options?: ErrorOptions);
}
interface JsonSqlColumn {
    readonly name: string;
    readonly type: JsonSqlColumnType;
    readonly notNull: boolean;
    readonly primaryKey: boolean;
    readonly unique: boolean;
    readonly hasDefault: boolean;
    readonly defaultValue?: JsonSqlValue;
}
interface JsonSqlSchema {
    readonly version: 1;
    readonly name: string;
    readonly primaryKey: string;
    readonly columns: readonly JsonSqlColumn[];
    readonly uniqueGroups: readonly (readonly string[])[];
}
interface SqlHost {
    getTable<T extends Record<string, unknown> = Record<string, unknown>>(name: string): IDbTable<T>;
}
type SqlValueExpression = {
    readonly kind: "literal";
    readonly value: JsonSqlValue;
} | {
    readonly kind: "parameter";
    readonly index: number;
};
type SqlExpression = {
    readonly kind: "compare";
    readonly field: string;
    readonly operator: "=" | "!=" | "<>" | ">" | ">=" | "<" | "<=";
    readonly value: SqlValueExpression;
} | {
    readonly kind: "null-check";
    readonly field: string;
    readonly negated: boolean;
} | {
    readonly kind: "in";
    readonly field: string;
    readonly values: readonly SqlValueExpression[];
    readonly negated: boolean;
} | {
    readonly kind: "between";
    readonly field: string;
    readonly lower: SqlValueExpression;
    readonly upper: SqlValueExpression;
    readonly negated: boolean;
} | {
    readonly kind: "like";
    readonly field: string;
    readonly pattern: SqlValueExpression;
    readonly negated: boolean;
} | {
    readonly kind: "not";
    readonly expression: SqlExpression;
} | {
    readonly kind: "and" | "or";
    readonly left: SqlExpression;
    readonly right: SqlExpression;
};
interface CreateTableCommand {
    readonly kind: "create-table";
    readonly ifNotExists: boolean;
    readonly schema: JsonSqlSchema;
}
interface SelectCommand {
    readonly kind: "select";
    readonly table: string;
    readonly columns: readonly ({
        readonly kind: "star";
    } | {
        readonly kind: "column";
        readonly name: string;
        readonly alias?: string;
    })[];
    readonly where?: SqlExpression;
    readonly orderBy: readonly {
        readonly field: string;
        readonly direction: "asc" | "desc";
    }[];
    readonly limit?: SqlValueExpression;
    readonly offset?: SqlValueExpression;
}
interface InsertCommand {
    readonly kind: "insert";
    readonly table: string;
    readonly columns: readonly string[];
    readonly values: readonly SqlValueExpression[];
}
interface UpdateCommand {
    readonly kind: "update";
    readonly table: string;
    readonly assignments: readonly {
        readonly column: string;
        readonly value: SqlValueExpression;
    }[];
    readonly where?: SqlExpression;
}
interface DeleteCommand {
    readonly kind: "delete";
    readonly table: string;
    readonly where?: SqlExpression;
}
type SqlCommand = CreateTableCommand | SelectCommand | InsertCommand | UpdateCommand | DeleteCommand;
export declare class JsonSqlStatement {
    private readonly connection;
    private readonly command;
    private readonly parameterCount;
    readonly sql: string;
    constructor(connection: JsonSqlConnection, command: SqlCommand, parameterCount: number, sql: string);
    get kind(): JsonSqlStatementKind;
    all<T extends Record<string, unknown> = Record<string, unknown>>(...parameters: readonly unknown[]): readonly T[];
    get<T extends Record<string, unknown> = Record<string, unknown>>(...parameters: readonly unknown[]): T | undefined;
    run(...parameters: readonly unknown[]): JsonSqlRunResult;
    private bind;
}
/**
 * SQL subset backed by the same in-memory tables and WAL as the kernel.
 * It supports one table per statement, typed CREATE TABLE schemas, and bound
 * positional parameters. It intentionally does not expose a network protocol.
 */
export declare class JsonSqlConnection implements JsonSqlDatabase {
    private readonly host;
    private readonly schemas;
    private catalog;
    constructor(host: SqlHost);
    prepare(sql: string): JsonSqlStatement;
    /** Rebuilds and validates table schemas after checkpoint and WAL recovery. */
    restoreSchemas(): void;
    /** Preserves schemas for tables that kernel rollback deliberately retains. */
    preserveSchemasForPostCheckpointTables(checkpointTableNames: ReadonlySet<string>): () => void;
    /** Removes newer schemas from checkpointed tables before their old rows return. */
    clearConstraintsForCheckpointedTables(checkpointTableNames: ReadonlySet<string>): void;
    executeSelect(command: SelectCommand, bindings: readonly JsonSqlValue[]): readonly Record<string, JsonSqlValue>[];
    executeMutation(command: Exclude<SqlCommand, SelectCommand>, bindings: readonly JsonSqlValue[]): JsonSqlRunResult;
    private createTable;
    private installSchema;
    private requireSchema;
    private readCatalogSchema;
    private getCatalog;
    private requireColumn;
    private validateExpression;
    private readStoredRow;
    private makeInsertedRow;
    private makeStoredRow;
    private assertUnique;
    private readLimit;
    private readNonNegativeInteger;
    private constraint;
}
export {};
//# sourceMappingURL=broccolidb-jsonsql.d.ts.map