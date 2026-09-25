// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0
/**
 * Dependency-free, SQLite-inspired SQL surface over BroccoliDB JSON tables.
 * This is a deliberately bounded embedded dialect, not a SQL server.
 */
import { BroccoliDbTable } from "./broccolidb-table.js";
const CATALOG_TABLE = "__broccolidb_jsonsql_catalog_v1";
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_LIKE_COMPARISON_CELLS_PER_QUERY = 10_000_000;
export class JsonSqlError extends Error {
    code;
    constructor(message, code = "ERR_JSONSQL_SYNTAX", options) {
        super(message, options);
        this.name = "JsonSqlError";
        this.code = code;
    }
}
function canonicalIdentifier(value, offset) {
    if (!IDENTIFIER.test(value) ||
        ["__proto__", "prototype", "constructor"].includes(value.toLowerCase()) ||
        value.toLowerCase().startsWith("__broccolidb_")) {
        throw new JsonSqlError(`Invalid or reserved SQL identifier at character ${offset + 1}`);
    }
    return value.toLowerCase();
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function cloneJsonValue(value, ancestors = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new JsonSqlError("JSONSQL values must use finite numbers", "ERR_JSONSQL_BINDINGS");
        return value;
    }
    if (Array.isArray(value)) {
        if (ancestors.has(value))
            throw new JsonSqlError("JSONSQL values cannot contain cycles", "ERR_JSONSQL_BINDINGS");
        ancestors.add(value);
        // JSON.stringify persists array holes as null. Materialize the same value
        // here so in-memory comparisons and the durable representation agree.
        const clone = Array.from({ length: value.length }, (_, index) => Object.prototype.hasOwnProperty.call(value, index) ? cloneJsonValue(value[index], ancestors) : null);
        ancestors.delete(value);
        return clone;
    }
    if (isPlainObject(value)) {
        if (ancestors.has(value))
            throw new JsonSqlError("JSONSQL values cannot contain cycles", "ERR_JSONSQL_BINDINGS");
        ancestors.add(value);
        const clone = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined)
                throw new JsonSqlError(`JSONSQL value at ${key} is undefined`, "ERR_JSONSQL_BINDINGS");
            Object.defineProperty(clone, key, {
                value: cloneJsonValue(item, ancestors), enumerable: true, configurable: true, writable: true,
            });
        }
        ancestors.delete(value);
        return clone;
    }
    throw new JsonSqlError("JSONSQL values must be JSON-compatible", "ERR_JSONSQL_BINDINGS");
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
class SqlLexer {
    source;
    index = 0;
    tokens = [];
    constructor(source) {
        this.source = source;
    }
    tokenize() {
        while (this.index < this.source.length) {
            const char = this.source[this.index];
            if (/\s/.test(char)) {
                this.index++;
                continue;
            }
            if (char === "-" && this.source[this.index + 1] === "-") {
                this.skipLineComment();
                continue;
            }
            if (char === "/" && this.source[this.index + 1] === "*") {
                this.skipBlockComment();
                continue;
            }
            if (char === "'") {
                this.readString();
                continue;
            }
            if (char === '"' || char === "`" || char === "[") {
                this.readQuotedIdentifier();
                continue;
            }
            if (char === "?") {
                this.tokens.push({ kind: "parameter", text: char, offset: this.index });
                this.index++;
                continue;
            }
            if (/[a-zA-Z_]/.test(char)) {
                this.readWord();
                continue;
            }
            if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(this.source[this.index + 1] ?? ""))) {
                this.readNumber();
                continue;
            }
            const two = this.source.slice(this.index, this.index + 2);
            if (["<=", ">=", "<>", "!=", "=="].includes(two)) {
                this.tokens.push({ kind: "symbol", text: two, offset: this.index });
                this.index += 2;
                continue;
            }
            if ("(),;*=<>+-".includes(char)) {
                this.tokens.push({ kind: "symbol", text: char, offset: this.index });
                this.index++;
                continue;
            }
            throw new JsonSqlError(`Unexpected character at position ${this.index + 1}`);
        }
        this.tokens.push({ kind: "eof", text: "", offset: this.index });
        return this.tokens;
    }
    readString() {
        const start = this.index++;
        let value = "";
        while (this.index < this.source.length) {
            const char = this.source[this.index++];
            if (char === "'") {
                if (this.source[this.index] === "'") {
                    value += "'";
                    this.index++;
                    continue;
                }
                this.tokens.push({ kind: "string", text: this.source.slice(start, this.index), value, offset: start });
                return;
            }
            value += char;
        }
        throw new JsonSqlError(`Unterminated string at position ${start + 1}`);
    }
    readQuotedIdentifier() {
        const start = this.index;
        const open = this.source[this.index++];
        const close = open === "[" ? "]" : open;
        let value = "";
        while (this.index < this.source.length) {
            const char = this.source[this.index++];
            if (char === close) {
                if (open !== "[" && this.source[this.index] === close) {
                    value += close;
                    this.index++;
                    continue;
                }
                this.tokens.push({ kind: "identifier", text: this.source.slice(start, this.index), value, offset: start });
                return;
            }
            value += char;
        }
        throw new JsonSqlError(`Unterminated quoted identifier at position ${start + 1}`);
    }
    readWord() {
        const start = this.index++;
        while (this.index < this.source.length && /[a-zA-Z0-9_$]/.test(this.source[this.index]))
            this.index++;
        const text = this.source.slice(start, this.index);
        this.tokens.push({ kind: "word", text, value: text, offset: start });
    }
    readNumber() {
        const start = this.index;
        const match = this.source.slice(start).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
        if (!match)
            throw new JsonSqlError(`Invalid number at position ${start + 1}`);
        const value = Number(match[0]);
        if (!Number.isFinite(value))
            throw new JsonSqlError(`Number is out of range at position ${start + 1}`);
        this.index += match[0].length;
        this.tokens.push({ kind: "number", text: match[0], value, offset: start });
    }
    skipLineComment() {
        this.index += 2;
        while (this.index < this.source.length && this.source[this.index] !== "\n")
            this.index++;
    }
    skipBlockComment() {
        const start = this.index;
        this.index += 2;
        const end = this.source.indexOf("*/", this.index);
        if (end < 0)
            throw new JsonSqlError(`Unterminated comment at position ${start + 1}`);
        this.index = end + 2;
    }
}
class SqlParser {
    source;
    index = 0;
    parameterCount = 0;
    tokens;
    constructor(source) {
        this.source = source;
        this.tokens = new SqlLexer(source).tokenize();
    }
    parse() {
        let command;
        if (this.takeWord("CREATE"))
            command = this.parseCreateTable();
        else if (this.takeWord("SELECT"))
            command = this.parseSelect();
        else if (this.takeWord("INSERT"))
            command = this.parseInsert();
        else if (this.takeWord("UPDATE"))
            command = this.parseUpdate();
        else if (this.takeWord("DELETE"))
            command = this.parseDelete();
        else
            throw new JsonSqlError("Supported statements are CREATE TABLE, SELECT, INSERT, UPDATE, and DELETE");
        this.takeSymbol(";");
        if (!this.atEnd())
            throw this.syntax("Only one SQL statement is allowed per prepared statement");
        return { command, parameterCount: this.parameterCount };
    }
    parseCreateTable() {
        this.expectWord("TABLE");
        const ifNotExists = this.takeWord("IF") ? (this.expectWord("NOT"), this.expectWord("EXISTS"), true) : false;
        const name = this.readIdentifier();
        this.expectSymbol("(");
        const columns = [];
        const uniqueGroups = [];
        let primaryKey;
        do {
            if (this.takeWord("PRIMARY")) {
                this.expectWord("KEY");
                this.expectSymbol("(");
                const key = this.readIdentifier();
                this.expectSymbol(")");
                if (primaryKey)
                    throw this.syntax("A table can have only one primary key");
                primaryKey = key;
            }
            else if (this.takeWord("UNIQUE")) {
                this.expectSymbol("(");
                uniqueGroups.push(this.readIdentifierList());
                this.expectSymbol(")");
            }
            else {
                const columnName = this.readIdentifier();
                const typeToken = this.expectIdentifier();
                const declaredType = String(typeToken.value).toUpperCase();
                const type = normalizeColumnType(declaredType, typeToken.offset);
                let notNull = false;
                let columnPrimaryKey = false;
                let unique = false;
                let hasDefault = false;
                let nullabilitySpecified = false;
                let defaultValue;
                while (this.isWord("NOT") || this.isWord("NULL") || this.isWord("PRIMARY") || this.isWord("UNIQUE") || this.isWord("DEFAULT")) {
                    if (this.takeWord("NOT")) {
                        this.expectWord("NULL");
                        if (nullabilitySpecified)
                            throw this.syntax(`Column ${columnName} declares nullability more than once`);
                        nullabilitySpecified = true;
                        notNull = true;
                    }
                    else if (this.takeWord("NULL")) {
                        if (nullabilitySpecified)
                            throw this.syntax(`Column ${columnName} declares nullability more than once`);
                        nullabilitySpecified = true;
                        notNull = false;
                    }
                    else if (this.takeWord("PRIMARY")) {
                        this.expectWord("KEY");
                        if (columnPrimaryKey)
                            throw this.syntax(`Column ${columnName} declares PRIMARY KEY more than once`);
                        columnPrimaryKey = true;
                        notNull = true;
                    }
                    else if (this.takeWord("UNIQUE")) {
                        if (unique)
                            throw this.syntax(`Column ${columnName} declares UNIQUE more than once`);
                        unique = true;
                    }
                    else {
                        this.expectWord("DEFAULT");
                        if (hasDefault)
                            throw this.syntax(`Column ${columnName} declares DEFAULT more than once`);
                        defaultValue = this.readStaticValue();
                        hasDefault = true;
                    }
                }
                if (columnPrimaryKey) {
                    if (primaryKey)
                        throw this.syntax("A table can have only one primary key");
                    primaryKey = columnName;
                }
                columns.push({ name: columnName, type, notNull, primaryKey: columnPrimaryKey, unique, hasDefault, defaultValue });
                if (unique)
                    uniqueGroups.push([columnName]);
            }
        } while (this.takeSymbol(","));
        this.expectSymbol(")");
        if (columns.length === 0)
            throw this.syntax("CREATE TABLE requires at least one column");
        if (!primaryKey)
            throw this.syntax("CREATE TABLE requires one PRIMARY KEY column");
        const columnNames = new Set();
        for (const column of columns) {
            if (columnNames.has(column.name))
                throw this.syntax(`Column ${column.name} is declared more than once`);
            columnNames.add(column.name);
        }
        if (!columnNames.has(primaryKey))
            throw this.syntax(`Primary key column ${primaryKey} is not declared`);
        for (const column of columns) {
            if (column.primaryKey && column.name !== primaryKey)
                throw this.syntax("Primary key declarations do not match");
            if (column.hasDefault && column.defaultValue !== null && !valueHasType(column.defaultValue, column.type)) {
                throw this.syntax(`DEFAULT for ${column.name} must use the declared ${column.type} type`);
            }
        }
        if (uniqueGroups.some((group) => group.some((field) => !columnNames.has(field)))) {
            throw this.syntax("UNIQUE constraints must refer to declared columns");
        }
        const declaredColumns = new Map(columns.map((column) => [column.name, column]));
        if (uniqueGroups.some((group) => group.some((field) => {
            const type = declaredColumns.get(field).type;
            return type === "JSON" || type === "ANY";
        }))) {
            throw this.syntax("UNIQUE constraints support scalar columns only");
        }
        const keyColumn = columns.find((column) => column.name === primaryKey);
        if (keyColumn.type !== "TEXT" && keyColumn.type !== "INTEGER") {
            throw this.syntax("The primary key must use TEXT or INTEGER");
        }
        if (keyColumn.hasDefault)
            throw this.syntax("Primary keys must be supplied explicitly; automatic IDs are not supported");
        const schemaColumns = columns.map((column) => column.name === primaryKey
            ? { ...column, primaryKey: true, notNull: true }
            : column);
        const groups = [];
        const seenGroups = new Set();
        for (const group of [[primaryKey], ...uniqueGroups]) {
            const key = [...group].sort().join("\u0000");
            if (seenGroups.has(key))
                continue;
            seenGroups.add(key);
            groups.push(group);
        }
        return {
            kind: "create-table",
            ifNotExists,
            schema: { version: 1, name, primaryKey, columns: schemaColumns, uniqueGroups: groups },
        };
    }
    parseSelect() {
        const columns = [];
        if (this.takeSymbol("*"))
            columns.push({ kind: "star" });
        else {
            do {
                const name = this.readIdentifier();
                const alias = this.takeWord("AS") ? this.readIdentifier() : undefined;
                columns.push(alias ? { kind: "column", name, alias } : { kind: "column", name });
            } while (this.takeSymbol(","));
        }
        const outputNames = columns.flatMap((column) => column.kind === "column" ? [column.alias ?? column.name] : []);
        if (new Set(outputNames).size !== outputNames.length) {
            throw this.syntax("SELECT output names must be unique; use distinct aliases");
        }
        this.expectWord("FROM");
        const table = this.readIdentifier();
        const where = this.takeWord("WHERE") ? this.parseOr() : undefined;
        const orderBy = [];
        if (this.takeWord("ORDER")) {
            this.expectWord("BY");
            do {
                const field = this.readIdentifier();
                const direction = this.takeWord("DESC") ? "desc" : (this.takeWord("ASC"), "asc");
                orderBy.push({ field, direction });
            } while (this.takeSymbol(","));
        }
        const limit = this.takeWord("LIMIT") ? this.readValueExpression() : undefined;
        const offset = this.takeWord("OFFSET") ? this.readValueExpression() : undefined;
        return { kind: "select", table, columns, where, orderBy, limit, offset };
    }
    parseInsert() {
        this.expectWord("INTO");
        const table = this.readIdentifier();
        this.expectSymbol("(");
        const columns = this.readIdentifierList();
        this.expectSymbol(")");
        this.expectWord("VALUES");
        this.expectSymbol("(");
        const values = [];
        do
            values.push(this.readValueExpression());
        while (this.takeSymbol(","));
        this.expectSymbol(")");
        if (columns.length !== values.length)
            throw this.syntax("INSERT column and value counts must match");
        return { kind: "insert", table, columns, values };
    }
    parseUpdate() {
        const table = this.readIdentifier();
        this.expectWord("SET");
        const assignments = [];
        do {
            const column = this.readIdentifier();
            this.expectSymbol("=");
            assignments.push({ column, value: this.readValueExpression() });
        } while (this.takeSymbol(","));
        const names = assignments.map((assignment) => assignment.column);
        if (new Set(names).size !== names.length)
            throw this.syntax("UPDATE cannot assign a column more than once");
        const where = this.takeWord("WHERE") ? this.parseOr() : undefined;
        return { kind: "update", table, assignments, where };
    }
    parseDelete() {
        this.expectWord("FROM");
        const table = this.readIdentifier();
        const where = this.takeWord("WHERE") ? this.parseOr() : undefined;
        return { kind: "delete", table, where };
    }
    parseOr() {
        let expression = this.parseAnd();
        while (this.takeWord("OR"))
            expression = { kind: "or", left: expression, right: this.parseAnd() };
        return expression;
    }
    parseAnd() {
        let expression = this.parseNot();
        while (this.takeWord("AND"))
            expression = { kind: "and", left: expression, right: this.parseNot() };
        return expression;
    }
    parseNot() {
        if (this.takeWord("NOT"))
            return { kind: "not", expression: this.parseNot() };
        return this.parsePredicate();
    }
    parsePredicate() {
        if (this.takeSymbol("(")) {
            const expression = this.parseOr();
            this.expectSymbol(")");
            return expression;
        }
        const field = this.readIdentifier();
        if (this.takeWord("IS")) {
            const negated = this.takeWord("NOT");
            this.expectWord("NULL");
            return { kind: "null-check", field, negated };
        }
        const negated = this.takeWord("NOT");
        if (this.takeWord("IN")) {
            this.expectSymbol("(");
            const values = [];
            do
                values.push(this.readValueExpression());
            while (this.takeSymbol(","));
            this.expectSymbol(")");
            return { kind: "in", field, values, negated };
        }
        if (this.takeWord("BETWEEN")) {
            const lower = this.readValueExpression();
            this.expectWord("AND");
            const upper = this.readValueExpression();
            return { kind: "between", field, lower, upper, negated };
        }
        if (this.takeWord("LIKE"))
            return { kind: "like", field, pattern: this.readValueExpression(), negated };
        if (negated)
            throw this.syntax("NOT must be followed by IN, BETWEEN, or LIKE");
        const operator = this.expectComparisonOperator();
        return { kind: "compare", field, operator, value: this.readValueExpression() };
    }
    readValueExpression() {
        if (this.peek().kind === "parameter") {
            this.index++;
            return { kind: "parameter", index: this.parameterCount++ };
        }
        return { kind: "literal", value: this.readStaticValue() };
    }
    readStaticValue() {
        if (this.takeSymbol("-")) {
            const token = this.peek();
            if (token.kind !== "number")
                throw this.syntax("A minus sign must precede a numeric literal");
            this.index++;
            return -token.value;
        }
        const token = this.peek();
        if (token.kind === "string" || token.kind === "number") {
            this.index++;
            return token.value;
        }
        if (this.takeWord("NULL"))
            return null;
        if (this.takeWord("TRUE"))
            return true;
        if (this.takeWord("FALSE"))
            return false;
        throw this.syntax("Expected a string, number, TRUE, FALSE, or NULL value");
    }
    readIdentifier() {
        const token = this.expectIdentifier();
        return canonicalIdentifier(String(token.value), token.offset);
    }
    readIdentifierList() {
        const identifiers = [this.readIdentifier()];
        while (this.takeSymbol(","))
            identifiers.push(this.readIdentifier());
        if (new Set(identifiers).size !== identifiers.length)
            throw this.syntax("Identifier lists cannot contain duplicates");
        return identifiers;
    }
    expectIdentifier() {
        const token = this.peek();
        if (token.kind !== "identifier" && token.kind !== "word")
            throw this.syntax("Expected an identifier");
        this.index++;
        return token;
    }
    expectComparisonOperator() {
        const token = this.peek();
        const operator = token.text === "==" ? "=" : token.text;
        if (!["=", "!=", "<>", ">", ">=", "<", "<="].includes(operator)) {
            throw this.syntax("Expected a comparison operator");
        }
        this.index++;
        return operator;
    }
    previous() { return this.tokens[this.index - 1]; }
    peek() { return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]; }
    atEnd() { return this.peek().kind === "eof"; }
    isWord(word) { return this.peek().kind === "word" && this.peek().text.toUpperCase() === word; }
    takeWord(word) { if (!this.isWord(word))
        return false; this.index++; return true; }
    expectWord(word) { if (!this.takeWord(word))
        throw this.syntax(`Expected ${word}`); }
    takeSymbol(symbol) { if (this.peek().kind !== "symbol" || this.peek().text !== symbol)
        return false; this.index++; return true; }
    expectSymbol(symbol) { if (!this.takeSymbol(symbol))
        throw this.syntax(`Expected '${symbol}'`); }
    syntax(message) { return new JsonSqlError(`${message} at character ${this.peek().offset + 1}`); }
}
function normalizeColumnType(type, offset) {
    switch (type) {
        case "TEXT":
        case "VARCHAR":
        case "CHAR": return "TEXT";
        case "INTEGER":
        case "INT":
        case "BIGINT": return "INTEGER";
        case "REAL":
        case "FLOAT":
        case "DOUBLE": return "REAL";
        case "BOOLEAN":
        case "BOOL": return "BOOLEAN";
        case "JSON":
        case "JSONB": return "JSON";
        case "ANY": return "ANY";
        default: throw new JsonSqlError(`Unsupported JSONSQL column type '${type}' at character ${offset + 1}`);
    }
}
function valueFor(expression, bindings) {
    return expression.kind === "literal" ? expression.value : bindings[expression.index];
}
function compareSqlValues(left, right) {
    if (left === undefined || left === null || right === null)
        return null;
    if (typeof left !== typeof right)
        return null;
    if (typeof left === "string" && typeof right === "string")
        return left < right ? -1 : left > right ? 1 : 0;
    if (typeof left === "number" && typeof right === "number")
        return left < right ? -1 : left > right ? 1 : 0;
    if (typeof left === "boolean" && typeof right === "boolean")
        return left === right ? 0 : left ? 1 : -1;
    if ((typeof left === "object" && left !== null) && (typeof right === "object" && right !== null)) {
        return stableJson(left) === stableJson(right) ? 0 : null;
    }
    return null;
}
function sqlValuesEqual(left, right) {
    if (left === undefined || left === null || right === null)
        return null;
    const leftStructured = typeof left === "object";
    const rightStructured = typeof right === "object";
    if (leftStructured && rightStructured)
        return stableJson(left) === stableJson(right);
    const comparison = compareSqlValues(left, right);
    return comparison === null ? null : comparison === 0;
}
function truthNot(value) { return value === null ? null : !value; }
function truthAnd(left, right) {
    if (left === false || right === false)
        return false;
    if (left === null || right === null)
        return null;
    return true;
}
function truthOr(left, right) {
    if (left === true || right === true)
        return true;
    if (left === null || right === null)
        return null;
    return false;
}
function foldAsciiCase(char) {
    const code = char.charCodeAt(0);
    return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char;
}
function likeMatches(value, sourcePattern, budget) {
    const work = (value.length + 1) * (sourcePattern.length + 1);
    if (!Number.isSafeInteger(work) || work > budget.likeComparisonCells) {
        throw new JsonSqlError(`LIKE evaluation exceeded the ${String(MAX_LIKE_COMPARISON_CELLS_PER_QUERY)}-cell per-query limit`, "ERR_JSONSQL_RESOURCE_LIMIT");
    }
    budget.likeComparisonCells -= work;
    const input = Array.from(value, foldAsciiCase);
    const pattern = [];
    for (const char of Array.from(sourcePattern, foldAsciiCase)) {
        if (char !== "%" || pattern.at(-1) !== "%")
            pattern.push(char);
    }
    // Dynamic programming avoids generating a regular expression from user input.
    let previous = new Uint8Array(pattern.length + 1);
    previous[0] = 1;
    for (let column = 1; column <= pattern.length && pattern[column - 1] === "%"; column++) {
        previous[column] = 1;
    }
    for (const char of input) {
        const current = new Uint8Array(pattern.length + 1);
        for (let column = 1; column <= pattern.length; column++) {
            const token = pattern[column - 1];
            if (token === "%")
                current[column] = current[column - 1] || previous[column] ? 1 : 0;
            else if (token === "_" || token === char)
                current[column] = previous[column - 1];
        }
        previous = current;
    }
    return previous[pattern.length] === 1;
}
function evaluateExpression(expression, row, bindings, budget) {
    if (!expression)
        return true;
    switch (expression.kind) {
        case "and": {
            const left = evaluateExpression(expression.left, row, bindings, budget);
            return left === false ? false : truthAnd(left, evaluateExpression(expression.right, row, bindings, budget));
        }
        case "or": {
            const left = evaluateExpression(expression.left, row, bindings, budget);
            return left === true ? true : truthOr(left, evaluateExpression(expression.right, row, bindings, budget));
        }
        case "not": return truthNot(evaluateExpression(expression.expression, row, bindings, budget));
        case "null-check": return expression.negated ? row[expression.field] !== null : row[expression.field] === null;
        case "compare": {
            if (expression.operator === "=" || expression.operator === "!=" || expression.operator === "<>") {
                const equal = sqlValuesEqual(row[expression.field], valueFor(expression.value, bindings));
                if (equal === null)
                    return null;
                return expression.operator === "=" ? equal : !equal;
            }
            const comparison = compareSqlValues(row[expression.field], valueFor(expression.value, bindings));
            if (comparison === null)
                return null;
            switch (expression.operator) {
                case ">": return comparison > 0;
                case ">=": return comparison >= 0;
                case "<": return comparison < 0;
                case "<=": return comparison <= 0;
            }
        }
        case "in": {
            const value = row[expression.field];
            if (value === null || value === undefined)
                return null;
            let foundNull = false;
            let found = false;
            for (const item of expression.values) {
                const candidate = valueFor(item, bindings);
                if (candidate === null)
                    foundNull = true;
                else if (typeof value === "object" && typeof candidate === "object") {
                    if (stableJson(value) === stableJson(candidate)) {
                        found = true;
                        break;
                    }
                }
                else if (compareSqlValues(value, candidate) === 0) {
                    found = true;
                    break;
                }
            }
            const result = found ? true : foundNull ? null : false;
            return expression.negated ? truthNot(result) : result;
        }
        case "between": {
            const value = row[expression.field];
            const lower = valueFor(expression.lower, bindings);
            const upper = valueFor(expression.upper, bindings);
            const low = compareSqlValues(value, lower);
            const high = compareSqlValues(value, upper);
            const result = low === null || high === null ? null : low >= 0 && high <= 0;
            return expression.negated ? truthNot(result) : result;
        }
        case "like": {
            const value = row[expression.field];
            const pattern = valueFor(expression.pattern, bindings);
            if (typeof value !== "string" || typeof pattern !== "string")
                return null;
            const result = likeMatches(value, pattern, budget);
            return expression.negated ? !result : result;
        }
    }
}
function compareSqlSortValues(left, right) {
    const rank = (value) => {
        if (value === null)
            return 0;
        if (typeof value === "number")
            return 1;
        if (typeof value === "boolean")
            return 2;
        if (typeof value === "string")
            return 3;
        return 4;
    };
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank !== rightRank)
        return leftRank - rightRank;
    return compareSqlValues(left, right) ?? 0;
}
function valueHasType(value, type) {
    switch (type) {
        case "TEXT": return typeof value === "string";
        case "INTEGER": return typeof value === "number" && Number.isSafeInteger(value);
        case "REAL": return typeof value === "number" && Number.isFinite(value);
        case "BOOLEAN": return typeof value === "boolean";
        case "JSON":
        case "ANY": return true;
    }
}
function tableKey(value) {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) {
        throw new JsonSqlError("Primary keys must be non-null TEXT or safe INTEGER values", "ERR_JSONSQL_CONSTRAINT");
    }
    return String(value);
}
export class JsonSqlStatement {
    connection;
    command;
    parameterCount;
    sql;
    constructor(connection, command, parameterCount, sql) {
        this.connection = connection;
        this.command = command;
        this.parameterCount = parameterCount;
        this.sql = sql;
    }
    get kind() { return this.command.kind; }
    all(...parameters) {
        if (this.command.kind !== "select")
            throw new JsonSqlError("all() is only available for SELECT statements");
        return this.connection.executeSelect(this.command, this.bind(parameters));
    }
    get(...parameters) {
        return this.all(...parameters)[0];
    }
    run(...parameters) {
        const bindings = this.bind(parameters);
        if (this.command.kind === "select")
            throw new JsonSqlError("run() cannot execute a SELECT statement");
        return this.connection.executeMutation(this.command, bindings);
    }
    bind(parameters) {
        if (parameters.length !== this.parameterCount) {
            throw new JsonSqlError(`Expected ${this.parameterCount} SQL binding${this.parameterCount === 1 ? "" : "s"}, received ${parameters.length}`, "ERR_JSONSQL_BINDINGS");
        }
        return parameters.map((value) => cloneJsonValue(value));
    }
}
/**
 * SQL subset backed by the same in-memory tables and WAL as the kernel.
 * It supports one table per statement, typed CREATE TABLE schemas, and bound
 * positional parameters. It intentionally does not expose a network protocol.
 */
export class JsonSqlConnection {
    host;
    schemas = new Map();
    catalog;
    constructor(host) {
        this.host = host;
    }
    prepare(sql) {
        const parsed = new SqlParser(sql).parse();
        return new JsonSqlStatement(this, parsed.command, parsed.parameterCount, sql);
    }
    /** Rebuilds and validates table schemas after checkpoint and WAL recovery. */
    restoreSchemas() {
        this.schemas.clear();
        for (const { id, record } of this.getCatalog().getAllEntries()) {
            const schema = parseStoredSchema(record);
            if (schema.name !== id)
                throw new JsonSqlError("JSONSQL schema catalog key does not match its table name", "ERR_JSONSQL_SCHEMA");
            this.installSchema(schema, true);
        }
    }
    /** Preserves schemas for tables that kernel rollback deliberately retains. */
    preserveSchemasForPostCheckpointTables(checkpointTableNames) {
        const retained = this.getCatalog().getAllEntries()
            .filter(({ id }) => !checkpointTableNames.has(id));
        return () => {
            const catalog = this.getCatalog();
            for (const { id, record } of retained) {
                if (!catalog.get(id))
                    catalog.put(id, record);
            }
            this.restoreSchemas();
        };
    }
    /** Removes newer schemas from checkpointed tables before their old rows return. */
    clearConstraintsForCheckpointedTables(checkpointTableNames) {
        for (const name of this.schemas.keys()) {
            if (!checkpointTableNames.has(name))
                continue;
            const table = this.host.getTable(name);
            if (table instanceof BroccoliDbTable)
                table.setConstraints(undefined);
        }
    }
    executeSelect(command, bindings) {
        const schema = this.requireSchema(command.table);
        this.validateExpression(schema, command.where);
        for (const column of command.columns)
            if (column.kind === "column")
                this.requireColumn(schema, column.name);
        for (const order of command.orderBy) {
            const aliased = command.columns.some((column) => column.kind === "column" && column.alias === order.field);
            if (!aliased)
                this.requireColumn(schema, order.field);
        }
        const table = this.host.getTable(schema.name);
        let rows = table.getAllEntries().map(({ id, record }) => this.readStoredRow(schema, id, record));
        const budget = { likeComparisonCells: MAX_LIKE_COMPARISON_CELLS_PER_QUERY };
        rows = rows.filter((row) => evaluateExpression(command.where, row, bindings, budget) === true);
        if (command.orderBy.length > 0) {
            rows = rows.map((row, index) => ({ row, index })).sort((left, right) => {
                for (const order of command.orderBy) {
                    const selected = command.columns.find((column) => column.kind === "column" && column.alias === order.field);
                    const field = selected?.kind === "column" ? selected.name : order.field;
                    const a = left.row[field] ?? null;
                    const b = right.row[field] ?? null;
                    const comparison = compareSqlSortValues(a, b);
                    if (comparison !== 0)
                        return order.direction === "desc" ? -comparison : comparison;
                }
                return left.index - right.index;
            }).map(({ row }) => row);
        }
        const offset = command.offset ? this.readNonNegativeInteger(command.offset, bindings, "OFFSET") : 0;
        const limit = command.limit ? this.readLimit(command.limit, bindings) : undefined;
        rows = rows.slice(offset, limit === undefined ? undefined : offset + limit);
        if (command.columns.some((column) => column.kind === "star"))
            return rows.map((row) => cloneJsonValue(row));
        return rows.map((row) => {
            const projected = {};
            for (const column of command.columns) {
                if (column.kind !== "column")
                    continue;
                Object.defineProperty(projected, column.alias ?? column.name, {
                    value: cloneJsonValue(row[column.name]), enumerable: true, configurable: true, writable: true,
                });
            }
            return projected;
        });
    }
    executeMutation(command, bindings) {
        if (command.kind === "create-table")
            return this.createTable(command);
        const schema = this.requireSchema(command.table);
        if (command.kind !== "insert")
            this.validateExpression(schema, command.where);
        const table = this.host.getTable(schema.name);
        if (command.kind === "insert") {
            for (const column of command.columns)
                this.requireColumn(schema, column);
            const input = {};
            command.columns.forEach((column, index) => Object.defineProperty(input, column, {
                value: valueFor(command.values[index], bindings), enumerable: true, configurable: true, writable: true,
            }));
            const row = this.makeInsertedRow(schema, input);
            const id = tableKey(row[schema.primaryKey]);
            if (table.get(id) !== undefined)
                this.constraint(`Duplicate primary key value for ${schema.name}.${schema.primaryKey}`);
            // Kernel tables maintain unique indexes. Keep a scan-based fallback for
            // custom SqlHost implementations that do not provide those constraints.
            if (!(table instanceof BroccoliDbTable)) {
                const current = table.getAllEntries().map(({ id: recordId, record }) => this.readStoredRow(schema, recordId, record));
                this.assertUnique(schema, [...current, row]);
            }
            table.put(id, row);
            return { changes: 1, lastInsertRowid: row[schema.primaryKey] };
        }
        if (command.kind === "update") {
            for (const assignment of command.assignments)
                this.requireColumn(schema, assignment.column);
            const entries = table.getAllEntries();
            const normalized = entries.map(({ id, record }) => ({ id, row: this.readStoredRow(schema, id, record) }));
            const budget = { likeComparisonCells: MAX_LIKE_COMPARISON_CELLS_PER_QUERY };
            const changed = normalized.filter(({ row }) => evaluateExpression(command.where, row, bindings, budget) === true);
            const updated = new Map();
            for (const { id, row } of changed) {
                const next = { ...row };
                for (const assignment of command.assignments) {
                    Object.defineProperty(next, assignment.column, {
                        value: valueFor(assignment.value, bindings), enumerable: true, configurable: true, writable: true,
                    });
                }
                const validated = this.makeStoredRow(schema, next);
                if (tableKey(validated[schema.primaryKey]) !== id) {
                    this.constraint("UPDATE cannot change a primary key");
                }
                updated.set(id, validated);
            }
            if (!(table instanceof BroccoliDbTable)) {
                const result = normalized.map(({ id, row }) => updated.get(id) ?? row);
                this.assertUnique(schema, result);
            }
            table.putMany([...updated].map(([id, row]) => ({ id, record: row })));
            return { changes: updated.size };
        }
        const entries = table.getAllEntries();
        const budget = { likeComparisonCells: MAX_LIKE_COMPARISON_CELLS_PER_QUERY };
        const matches = entries.filter(({ id, record }) => evaluateExpression(command.where, this.readStoredRow(schema, id, record), bindings, budget) === true);
        return { changes: table.deleteMany(matches.map(({ id }) => id)) };
    }
    createTable(command) {
        const existing = this.schemas.get(command.schema.name) ?? this.readCatalogSchema(command.schema.name);
        if (existing) {
            if (command.ifNotExists)
                return { changes: 0 };
            this.constraint(`Table ${command.schema.name} already exists`);
        }
        const table = this.host.getTable(command.schema.name);
        const current = table.getAllEntries().map(({ id, record }) => this.readStoredRow(command.schema, id, record));
        this.assertUnique(command.schema, current);
        this.getCatalog().put(command.schema.name, command.schema);
        this.installSchema(command.schema, false);
        return { changes: 1 };
    }
    installSchema(schema, restoring) {
        const table = this.host.getTable(schema.name);
        const entries = table.getAllEntries().map(({ id, record }) => this.readStoredRow(schema, id, record));
        this.assertUnique(schema, entries);
        if (table instanceof BroccoliDbTable) {
            table.setConstraints({
                unique: schema.uniqueGroups.map((fields, index) => ({
                    name: `${schema.name}:unique:${index}`,
                    fields,
                    key: (id, record) => {
                        const normalized = this.readStoredRow(schema, id, record);
                        const values = fields.map((field) => normalized[field]);
                        return values.some((value) => value === null || value === undefined) ? undefined : stableJson(values);
                    },
                })),
                validateRecord: (id, record) => { this.readStoredRow(schema, id, record); },
                conflict: (constraint) => new JsonSqlError(`UNIQUE constraint failed: ${schema.name}.${constraint.fields.join(", ")}`, "ERR_JSONSQL_CONSTRAINT"),
            });
        }
        this.schemas.set(schema.name, schema);
        if (restoring && !this.catalog)
            this.catalog = this.host.getTable(CATALOG_TABLE);
    }
    requireSchema(name) {
        const schema = this.schemas.get(name) ?? this.readCatalogSchema(name);
        if (!schema)
            throw new JsonSqlError(`Table ${name} has no JSONSQL schema; create it with CREATE TABLE`, "ERR_JSONSQL_SCHEMA");
        return schema;
    }
    readCatalogSchema(name) {
        const stored = this.getCatalog().get(name);
        if (!stored)
            return undefined;
        const schema = parseStoredSchema(stored);
        if (schema.name !== name)
            throw new JsonSqlError("JSONSQL schema catalog key does not match its table name", "ERR_JSONSQL_SCHEMA");
        this.installSchema(schema, false);
        return schema;
    }
    getCatalog() {
        this.catalog ??= this.host.getTable(CATALOG_TABLE);
        return this.catalog;
    }
    requireColumn(schema, name) {
        const column = schema.columns.find((item) => item.name === name);
        if (!column)
            throw new JsonSqlError(`Unknown column ${schema.name}.${name}`, "ERR_JSONSQL_SCHEMA");
        return column;
    }
    validateExpression(schema, expression) {
        if (!expression)
            return;
        switch (expression.kind) {
            case "and":
            case "or":
                this.validateExpression(schema, expression.left);
                this.validateExpression(schema, expression.right);
                break;
            case "not":
                this.validateExpression(schema, expression.expression);
                break;
            default:
                this.requireColumn(schema, expression.field);
        }
    }
    readStoredRow(schema, id, input) {
        if (!isPlainObject(input))
            this.constraint(`Row in ${schema.name} must be a JSON object`);
        const row = {};
        const names = new Set(schema.columns.map((column) => column.name));
        for (const key of Object.keys(input))
            if (!names.has(key))
                this.constraint(`Unknown column ${schema.name}.${key}`);
        for (const column of schema.columns) {
            const exists = Object.prototype.hasOwnProperty.call(input, column.name);
            const value = exists ? cloneJsonValue(input[column.name]) : column.hasDefault ? cloneJsonValue(column.defaultValue) : null;
            if (value === null && (column.notNull || column.primaryKey))
                this.constraint(`${schema.name}.${column.name} cannot be NULL`);
            if (value !== null && !valueHasType(value, column.type))
                this.constraint(`${schema.name}.${column.name} must be ${column.type}`);
            Object.defineProperty(row, column.name, { value, enumerable: true, configurable: true, writable: true });
        }
        if (tableKey(row[schema.primaryKey]) !== id)
            this.constraint(`Stored row key does not match ${schema.name}.${schema.primaryKey}`);
        return row;
    }
    makeInsertedRow(schema, input) {
        const row = {};
        const names = new Set(schema.columns.map((column) => column.name));
        for (const key of Object.keys(input))
            if (!names.has(key))
                this.constraint(`Unknown column ${schema.name}.${key}`);
        for (const column of schema.columns) {
            const exists = Object.prototype.hasOwnProperty.call(input, column.name);
            const value = exists ? cloneJsonValue(input[column.name]) : column.hasDefault ? cloneJsonValue(column.defaultValue) : null;
            if (value === null && (column.notNull || column.primaryKey))
                this.constraint(`${schema.name}.${column.name} cannot be NULL`);
            if (value !== null && !valueHasType(value, column.type))
                this.constraint(`${schema.name}.${column.name} must be ${column.type}`);
            Object.defineProperty(row, column.name, { value, enumerable: true, configurable: true, writable: true });
        }
        tableKey(row[schema.primaryKey]);
        return row;
    }
    makeStoredRow(schema, input) {
        return this.makeInsertedRow(schema, input);
    }
    assertUnique(schema, rows) {
        for (const group of schema.uniqueGroups) {
            const seen = new Set();
            for (const row of rows) {
                const values = group.map((field) => row[field]);
                if (values.some((value) => value === null || value === undefined))
                    continue;
                const key = stableJson(values);
                if (seen.has(key))
                    this.constraint(`UNIQUE constraint failed: ${schema.name}.${group.join(", ")}`);
                seen.add(key);
            }
        }
    }
    readLimit(expression, bindings) {
        const value = valueFor(expression, bindings);
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
            throw new JsonSqlError("LIMIT must be a safe integer", "ERR_JSONSQL_BINDINGS");
        }
        return value < 0 ? undefined : value;
    }
    readNonNegativeInteger(expression, bindings, clause) {
        const value = valueFor(expression, bindings);
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
            throw new JsonSqlError(`${clause} must be a safe integer`, "ERR_JSONSQL_BINDINGS");
        }
        return Math.max(0, value);
    }
    constraint(message) { throw new JsonSqlError(message, "ERR_JSONSQL_CONSTRAINT"); }
}
function parseStoredSchema(value) {
    if (!isPlainObject(value) || value.version !== 1 || typeof value.name !== "string" || typeof value.primaryKey !== "string" || !Array.isArray(value.columns) || !Array.isArray(value.uniqueGroups)) {
        throw new JsonSqlError("Invalid JSONSQL schema record in catalog", "ERR_JSONSQL_SCHEMA");
    }
    const name = canonicalIdentifier(value.name, 0);
    const primaryKey = canonicalIdentifier(value.primaryKey, 0);
    const columns = [];
    for (const item of value.columns) {
        if (!isPlainObject(item) || typeof item.name !== "string" || typeof item.type !== "string" || typeof item.notNull !== "boolean" || typeof item.primaryKey !== "boolean" || typeof item.unique !== "boolean" || typeof item.hasDefault !== "boolean") {
            throw new JsonSqlError(`Invalid JSONSQL column definition in ${name}`, "ERR_JSONSQL_SCHEMA");
        }
        const columnName = canonicalIdentifier(item.name, 0);
        const type = normalizeColumnType(item.type, 0);
        const defaultValue = item.hasDefault ? cloneJsonValue(item.defaultValue) : undefined;
        if (item.hasDefault && defaultValue !== null && defaultValue !== undefined && !valueHasType(defaultValue, type)) {
            throw new JsonSqlError(`Invalid default value for ${name}.${columnName}`, "ERR_JSONSQL_SCHEMA");
        }
        columns.push({ name: columnName, type, notNull: item.notNull, primaryKey: item.primaryKey, unique: item.unique, hasDefault: item.hasDefault, defaultValue });
    }
    const columnNames = new Set(columns.map((column) => column.name));
    if (columnNames.size !== columns.length || !columnNames.has(primaryKey)) {
        throw new JsonSqlError(`Invalid or duplicate columns in JSONSQL schema ${name}`, "ERR_JSONSQL_SCHEMA");
    }
    const primaryColumn = columns.find((column) => column.name === primaryKey);
    if (columns.filter((column) => column.primaryKey).length !== 1 || !primaryColumn.primaryKey || !primaryColumn.notNull || (primaryColumn.type !== "TEXT" && primaryColumn.type !== "INTEGER") || primaryColumn.hasDefault) {
        throw new JsonSqlError(`Invalid primary key metadata for ${name}`, "ERR_JSONSQL_SCHEMA");
    }
    const uniqueGroups = value.uniqueGroups.map((group) => {
        if (!Array.isArray(group) || group.length === 0 || group.some((field) => typeof field !== "string")) {
            throw new JsonSqlError(`Invalid JSONSQL unique constraint in ${name}`, "ERR_JSONSQL_SCHEMA");
        }
        const fields = group.map((field) => canonicalIdentifier(field, 0));
        if (fields.some((field) => !columnNames.has(field)) || new Set(fields).size !== fields.length) {
            throw new JsonSqlError(`Invalid JSONSQL unique constraint in ${name}`, "ERR_JSONSQL_SCHEMA");
        }
        if (fields.some((field) => {
            const type = columns.find((column) => column.name === field).type;
            return type === "JSON" || type === "ANY";
        })) {
            throw new JsonSqlError(`Invalid non-scalar JSONSQL unique constraint in ${name}`, "ERR_JSONSQL_SCHEMA");
        }
        return fields;
    });
    const uniqueGroupKeys = uniqueGroups.map((group) => [...group].sort().join("\u0000"));
    if (new Set(uniqueGroupKeys).size !== uniqueGroupKeys.length) {
        throw new JsonSqlError(`Duplicate JSONSQL unique constraints in ${name}`, "ERR_JSONSQL_SCHEMA");
    }
    if (columns.some((column) => column.unique && !uniqueGroups.some((group) => group.length === 1 && group[0] === column.name))) {
        throw new JsonSqlError(`JSONSQL unique column metadata is missing in ${name}`, "ERR_JSONSQL_SCHEMA");
    }
    if (!uniqueGroups.some((group) => group.length === 1 && group[0] === primaryKey)) {
        throw new JsonSqlError(`Primary key uniqueness is missing for ${name}`, "ERR_JSONSQL_SCHEMA");
    }
    return { version: 1, name, primaryKey, columns, uniqueGroups };
}
//# sourceMappingURL=broccolidb-jsonsql.js.map