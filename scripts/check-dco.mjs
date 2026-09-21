#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import fs from "node:fs"

const input = fs.readFileSync(0, "utf8")
const parts = input.split("\0")
const commits = []

for (let index = 0; index + 1 < parts.length; index += 2) {
	const hash = parts[index].trim()
	const message = parts[index + 1]
	if (hash) commits.push({ hash, message })
}

assert.ok(commits.length > 0, "DCO check received no commits")

const signOffPattern = /^[ \t]*Signed-off-by:[ \t]+\S(?:.*\S)?[ \t]+<[^<>\r\n]+>[ \t]*$/im
for (const commit of commits) {
	assert.match(commit.message, signOffPattern, `commit ${commit.hash} is missing a DCO Signed-off-by line`)
}

console.log(`dco:check OK — ${commits.length} commit${commits.length === 1 ? "" : "s"} signed off`)
