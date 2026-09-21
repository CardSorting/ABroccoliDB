#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

function read(relativePath) {
	return fs.readFileSync(path.join(repoRoot, relativePath), "utf8")
}

function assertFile(relativePath) {
	assert.ok(fs.existsSync(path.join(repoRoot, relativePath)), `required IP/licensing file missing: ${relativePath}`)
}

const requiredFiles = [
	"LICENSE",
	"NOTICE",
	"CONTRIBUTING.md",
	"DCO",
	"PATENT-NON-AGGRESSION-PLEDGE.md",
	"TRADEMARKS.md",
	"SECURITY.md",
	"docs/LEGAL-STRATEGY.md",
	"docs/ip/README.md",
	"docs/ip/INVENTION-DISCLOSURE-AND-PRIOR-ART.md",
	"docs/ip/DEFENSIVE-PRIOR-ART-CLAIMS.md",
	"docs/ip/CLAIM-REGISTER.md",
	"docs/adr/ADR-003-evidence-bounded-technical-claims.md",
	".github/workflows/repository-protection.yml",
	".github/CODEOWNERS",
	"scripts/check-dco.mjs",
]

for (const relativePath of requiredFiles) assertFile(relativePath)

const packageJson = JSON.parse(read("package.json"))
const packageLock = JSON.parse(read("package-lock.json"))
const license = read("LICENSE")
const notice = read("NOTICE")
const rootReadme = read("README.md")
const docsMap = read("docs/README.md")
const releaseNotes = read("docs/RELEASE_NOTES.md")
const protectionWorkflow = read(".github/workflows/repository-protection.yml")
const codeowners = read(".github/CODEOWNERS")

assert.equal(packageJson.license, "Apache-2.0", "package.json must declare Apache-2.0")
assert.equal(packageLock.version, packageJson.version, "lockfile top-level version must match package.json")
assert.equal(packageLock.packages?.[""].license, "Apache-2.0", "package-lock root must declare Apache-2.0")
assert.equal(packageJson.version, packageLock.packages?.[""].version, "package and lockfile versions must match")
assert.ok(Number.parseInt(packageJson.version, 10) >= 3, "the Apache-licensed line must be version 3 or later")

for (const publishedFile of [
	"LICENSE",
	"NOTICE",
	"CONTRIBUTING.md",
	"PATENT-NON-AGGRESSION-PLEDGE.md",
	"TRADEMARKS.md",
	"SECURITY.md",
	"docs",
	"DCO",
]) {
	assert.ok(packageJson.files?.includes(publishedFile), `package files must publish ${publishedFile}`)
}

assert.match(license, /^\s*Apache License\s*\n\s*Version 2\.0/m, "LICENSE must be Apache License 2.0 text")
for (const requiredClause of [
	"3. Grant of Patent License.",
	"4. Redistribution.",
	"6. Trademarks.",
	"END OF TERMS AND CONDITIONS",
]) {
	assert.ok(license.includes(requiredClause), `LICENSE is missing the Apache clause: ${requiredClause}`)
}
assert.doesNotMatch(license, /MIT License/i, "LICENSE must not retain the historical MIT text")

for (const requiredNotice of [
	"BroccoliDB / @noorm/broccolidb",
	"William Andrew Cruz",
	"Apache License, Version 2.0",
	"NOTICE records attribution information only",
]) {
	assert.ok(notice.includes(requiredNotice), `NOTICE is missing: ${requiredNotice}`)
}

for (const requiredText of [
	"Apache-2.0",
	"2.0.x",
	"PATENT-NON-AGGRESSION-PLEDGE.md",
	"docs/ip/",
	"permits commercial use",
	"source-available or dual-licensing",
]) {
	assert.ok(rootReadme.includes(requiredText), `README.md is missing licensing text: ${requiredText}`)
}
assert.doesNotMatch(rootReadme, /license-MIT/i, "README must not retain an MIT license badge")
assert.match(docsMap, /Apache-2\.0 for 3\.0\.0\+/, "docs map must state the current license boundary")
assert.match(releaseNotes, /3\.0\.0 — Apache-2\.0/, "release notes must document the license transition")
assert.match(protectionWorkflow, /SPDX-License-Identifier:\s*Apache-2\.0/, "repository protection workflow needs an Apache-2.0 SPDX header")
assert.match(protectionWorkflow, /npm run check/, "repository protection workflow must run the release checks")
assert.match(protectionWorkflow, /uses: actions\/checkout@[0-9a-f]{40}/, "checkout action must be pinned to a commit")
assert.match(protectionWorkflow, /uses: actions\/setup-node@[0-9a-f]{40}/, "setup-node action must be pinned to a commit")
assert.match(codeowners, /@CardSorting/, "CODEOWNERS must name the maintainer review owner")

function walk(relativeDirectory, result = []) {
	const absoluteDirectory = path.join(repoRoot, relativeDirectory)
	for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
		const relativePath = path.join(relativeDirectory, entry.name)
		if (entry.isDirectory()) walk(relativePath, result)
		else result.push(relativePath)
	}
	return result
}

const sourceFiles = [...walk("src"), ...walk("test"), ...walk("scripts")].filter((file) =>
	/\.(?:ts|mjs)$/.test(file),
)
for (const relativePath of sourceFiles) {
	const content = read(relativePath)
	assert.match(content, /SPDX-FileCopyrightText:\s*2026 William Andrew Cruz/, `${relativePath} needs a copyright SPDX header`)
	assert.match(content, /SPDX-License-Identifier:\s*Apache-2\.0/, `${relativePath} needs an Apache-2.0 SPDX header`)
}

const generatedFiles = walk("dist").filter((file) => /\.(?:js|d\.ts)$/.test(file))
for (const relativePath of generatedFiles) {
	const content = read(relativePath)
	assert.match(content, /SPDX-License-Identifier:\s*Apache-2\.0/, `${relativePath} needs an Apache-2.0 SPDX header`)
}

console.log(`license:check OK — Apache-2.0 package boundary, ${sourceFiles.length} source/test/script files, ${generatedFiles.length} generated files, and ${requiredFiles.length} licensing/protection artifacts verified`)
