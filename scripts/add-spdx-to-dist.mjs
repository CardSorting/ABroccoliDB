#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const distRoot = path.join(repoRoot, "dist")
const header = [
	"// SPDX-FileCopyrightText: 2026 William Andrew Cruz",
	"// SPDX-License-Identifier: Apache-2.0",
	"",
].join("\n")

function walk(directory, result = []) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name)
		if (entry.isDirectory()) walk(fullPath, result)
		else result.push(fullPath)
	}
	return result
}

if (!fs.existsSync(distRoot)) throw new Error("dist directory does not exist; run TypeScript compilation first")

const generatedFiles = walk(distRoot).filter((file) => /\.(?:js|d\.ts)$/.test(file))
for (const file of generatedFiles) {
	const content = fs.readFileSync(file, "utf8")
	if (!content.includes("SPDX-License-Identifier: Apache-2.0")) {
		fs.writeFileSync(file, `${header}${content}`, "utf8")
	}
}

console.log(`dist:spdx OK — ${generatedFiles.length} generated JavaScript/declaration files checked`)
