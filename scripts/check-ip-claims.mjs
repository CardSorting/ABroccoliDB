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
	assert.ok(fs.existsSync(path.join(repoRoot, relativePath)), `claim-audit evidence file missing: ${relativePath}`)
}

const requiredFiles = [
	"docs/ip/CLAIM-REGISTER.md",
	"docs/ip/INVENTION-DISCLOSURE-AND-PRIOR-ART.md",
	"docs/ip/DEFENSIVE-PRIOR-ART-CLAIMS.md",
	"docs/LEGAL-STRATEGY.md",
	"docs/adr/ADR-003-evidence-bounded-technical-claims.md",
	"docs/adr/ADR-004-recovery-and-integrity-boundaries.md",
]
for (const relativePath of requiredFiles) assertFile(relativePath)

const claimRegister = read("docs/ip/CLAIM-REGISTER.md")
const inventionRecord = read("docs/ip/INVENTION-DISCLOSURE-AND-PRIOR-ART.md")
const legalStrategy = read("docs/LEGAL-STRATEGY.md")
const packageJson = JSON.parse(read("package.json"))

for (const requiredText of [
	"SOURCE-VERIFIED",
	"TEST-BACKED",
	"QUALIFIED",
	"MEASUREMENT-REQUIRED",
	"LEGAL-REVIEW-REQUIRED",
	"C-002",
	"C-003",
	"C-005",
	"C-009",
	"C-012",
	"C-013",
	"C-014",
	"public-disclosure date",
	"not, by itself, a verified public-disclosure date",
]) {
	assert.ok(claimRegister.includes(requiredText), `claim register is missing: ${requiredText}`)
}

for (const requiredPattern of [
	/does not\s+assert\s+inventorship, novelty, patentability, priority, or freedom to operate/i,
	/validates a\s+declared `previousFrameHash`\s+against the\s+immediately preceding checksum/i,
	/compressionSavingsPct` remains a storage\s+metric, not a performance benchmark/i,
	/only a missing base checkpoint is treated as fresh state/i,
]) {
	assert.match(inventionRecord, requiredPattern, `invention record is missing limitation: ${requiredPattern}`)
}

assert.match(legalStrategy, /MPEP|public accessibility|publicly available/i, "legal strategy must preserve public-accessibility date discipline")
assert.match(packageJson.scripts?.check ?? "", /npm run ip:check/, "release check must run the IP claim audit")

const publicClaimSurfaces = [
	"README.md",
	"docs/ARCHITECTURE.md",
	"docs/BRIEF.md",
	"docs/API.md",
	"docs/OPERATIONS.md",
	"docs/GLOSSARY.md",
	"docs/PHILOSOPHY.md",
	"docs/RELEASE_NOTES.md",
	"docs/adr/ADR-001-portable-inmemory-kernel.md",
	"docs/adr/ADR-002-apache-licensing-and-ip-protection.md",
	"docs/adr/ADR-004-recovery-and-integrity-boundaries.md",
]

function walk(relativeDirectory, result = []) {
	const absoluteDirectory = path.join(repoRoot, relativeDirectory)
	for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
		const relativePath = path.join(relativeDirectory, entry.name)
		if (entry.isDirectory()) walk(relativePath, result)
		else result.push(relativePath)
	}
	return result
}

const sourceSurfaces = fs.readdirSync(path.join(repoRoot, "src"), { withFileTypes: true })
	.filter((entry) => entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name))
	.map((entry) => path.join("src", entry.name))

const generatedClaimSurfaces = walk("dist").filter((file) => /\.(?:js|d\.ts|map)$/.test(file))

const forbiddenClaimPatterns = [
	/\bchecksum-linked\b/i,
	/cryptographic frame chaining/i,
	/\b(?:2[- ]phase|two[- ]phase) mark[- ]sweep\b/i,
	/\bmark-sweep\b/i,
	/\bdouble-buffered\b/i,
	/\bframe-perfect\b/i,
	/forensic diagnostic/i,
	/\bsub-microsecond\b/i,
	/<\s*0\.5\s*[µu]s/i,
	/<\s*0\.1\s*ms/i,
	/production-grade/i,
	/adaptive jittered backoff/i,
	/offline AST parsing/i,
	/\bZenith Tier\b/i,
	/atomic JSON checkpoints?/i,
]

for (const relativePath of [...publicClaimSurfaces, ...sourceSurfaces, ...generatedClaimSurfaces]) {
	const content = read(relativePath)
	for (const pattern of forbiddenClaimPatterns) {
		assert.doesNotMatch(content, pattern, `${relativePath} contains unsupported claim wording: ${pattern}`)
	}
}

for (const evidencePath of [
	"src/broccolidb-table.ts",
	"src/broccolidb-wal.ts",
	"src/broccolidb-kernel.ts",
	"src/broccolidb-cas.ts",
	"src/broccolidb-mutex.ts",
	"src/broccolidb-natural-query.ts",
	"test/broccolidb.test.ts",
	"docs/TROUBLESHOOTING.md",
	"NOTICE",
	"DCO",
]) assertFile(evidencePath)

console.log(`ip:check OK — ${claimRegister.match(/^\| C-\d+/gm)?.length ?? 0} bounded claims, ${publicClaimSurfaces.length} public documentation surfaces, ${generatedClaimSurfaces.length} generated surfaces, and ${sourceSurfaces.length} source headers audited`)
