#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const docsRoot = path.join(repoRoot, "docs")

const requiredFiles = [
	"README.md",
	"LICENSE",
	"NOTICE",
	"CONTRIBUTING.md",
	"DCO",
	"PATENT-NON-AGGRESSION-PLEDGE.md",
	"TRADEMARKS.md",
	"SECURITY.md",
	"docs/README.md",
	"docs/LEGAL-STRATEGY.md",
	"docs/ip/README.md",
	"docs/ip/INVENTION-DISCLOSURE-AND-PRIOR-ART.md",
	"docs/ip/DEFENSIVE-PRIOR-ART-CLAIMS.md",
	"docs/ip/CLAIM-REGISTER.md",
	"docs/BRIEF.md",
	"docs/PHILOSOPHY.md",
	"docs/GLOSSARY.md",
	"docs/ARCHITECTURE.md",
	"docs/API.md",
	"docs/OPERATIONS.md",
	"docs/TROUBLESHOOTING.md",
	"docs/CONTRIBUTING.md",
	"docs/RELEASE_NOTES.md",
	"docs/adr/README.md",
	"docs/adr/ADR-001-portable-inmemory-kernel.md",
	"docs/adr/ADR-002-apache-licensing-and-ip-protection.md",
	"docs/adr/ADR-003-evidence-bounded-technical-claims.md",
	"docs/adr/ADR-004-recovery-and-integrity-boundaries.md",
	"docs/adr/TEMPLATE.md",
]

for (const relativePath of requiredFiles) {
	assert.ok(fs.existsSync(path.join(repoRoot, relativePath)), `required documentation missing: ${relativePath}`)
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), [], "BroccoliDB runtime dependencies must remain empty")

const rootReadme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8")
const docsMap = fs.readFileSync(path.join(docsRoot, "README.md"), "utf8")
for (const requiredLink of ["docs/README.md", "docs/API.md", "docs/OPERATIONS.md", "docs/CONTRIBUTING.md", "docs/LEGAL-STRATEGY.md", "docs/ip/README.md"]) {
	assert.ok(rootReadme.includes(requiredLink), `README.md must link ${requiredLink}`)
}
for (const requiredSection of ["## Reading paths by role", "## Document catalog", "## Documentation conventions", "## Source-of-truth matrix"]) {
	assert.ok(docsMap.includes(requiredSection), `docs/README.md must include ${requiredSection}`)
}

function walkMarkdown(dir, result = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) walkMarkdown(fullPath, result)
		else if (entry.name.endsWith(".md")) result.push(fullPath)
	}
	return result
}

const markdownFiles = [
	path.join(repoRoot, "README.md"),
	path.join(repoRoot, "CONTRIBUTING.md"),
	path.join(repoRoot, "PATENT-NON-AGGRESSION-PLEDGE.md"),
	path.join(repoRoot, "TRADEMARKS.md"),
	...walkMarkdown(docsRoot),
]
const markdownLink = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const brokenLinks = []

for (const markdownFile of markdownFiles) {
	const content = fs.readFileSync(markdownFile, "utf8")
	let match
	while ((match = markdownLink.exec(content)) !== null) {
		const target = match[1]
		if (!target || target.startsWith("#") || /^(?:https?:|mailto:)/i.test(target)) continue
		const cleanTarget = target.split("#", 1)[0]
		if (!cleanTarget) continue
		const resolved = path.resolve(path.dirname(markdownFile), cleanTarget)
		if (!fs.existsSync(resolved)) brokenLinks.push(`${path.relative(repoRoot, markdownFile)} → ${target}`)
	}
}

assert.deepEqual(brokenLinks, [], `broken documentation links:\n${brokenLinks.join("\n")}`)
assert.doesNotMatch(rootReadme, /(?<!\.)broccolidb\//, "README must not reference the removed in-repository broccolidb/ tree")
assert.doesNotMatch(docsMap, /(?<!\.)broccolidb\//, "docs map must not reference the removed in-repository broccolidb/ tree")

console.log(`docs:check OK — ${markdownFiles.length} Markdown files, ${requiredFiles.length} required artifacts`)
