#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "broccolidb-npm-cache-"))
let result
try {
	result = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--cache", cacheDirectory], {
		cwd: repoRoot,
		encoding: "utf8",
	})
} finally {
	fs.rmSync(cacheDirectory, { recursive: true, force: true })
}

assert.equal(result.status, 0, `npm pack dry-run failed:\n${result.stderr}`)

let report
try {
	report = JSON.parse(result.stdout)
} catch (error) {
	throw new Error(`npm pack dry-run did not return JSON: ${result.stdout}`, { cause: error })
}

assert.equal(report.length, 1, "npm pack dry-run must describe exactly one package")
assert.equal(report[0].name, packageJson.name, "packed package name must match package.json")
assert.equal(report[0].version, packageJson.version, "packed package version must match package.json")

const files = new Set(report[0].files.map((entry) => entry.path))
for (const requiredPath of [
	"README.md",
	"LICENSE",
	"NOTICE",
	"DCO",
	"PATENT-NON-AGGRESSION-PLEDGE.md",
	"TRADEMARKS.md",
	"SECURITY.md",
	"CONTRIBUTING.md",
	"dist/index.js",
	"dist/index.d.ts",
	"docs/ip/CLAIM-REGISTER.md",
]) {
	assert.ok(files.has(requiredPath), `published package is missing ${requiredPath}`)
}

for (const forbiddenPrefix of [".git/", ".github/", "node_modules/", "scripts/", "src/", "test/"]) {
	assert.ok(
		![...files].some((file) => file.startsWith(forbiddenPrefix)),
		`published package must not include ${forbiddenPrefix}`,
	)
}

assert.ok(!files.has("package-lock.json"), "published package must not include package-lock.json")
assert.ok(![...files].some((file) => file.startsWith(".broccolidb/")), "published package must not include runtime state")

console.log(`package:check OK — ${files.size} published files; Apache/IP artifacts present and development surfaces excluded`)
