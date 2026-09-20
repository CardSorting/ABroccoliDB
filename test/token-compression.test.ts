import assert from "node:assert/strict"
import test from "node:test"
import { TokenCompressionService } from "../src/TokenCompressionService.js"

test("compresses prompt whitespace while preserving structured blocks", () => {
	const service = TokenCompressionService.getInstance()
	service.clear()

	const messages = [
		{ role: "user", content: "  keep   this\r\n\r\n\r\n  compact  " },
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "call-1", name: "search", input: { q: "portable" } },
				{ type: "text", text: "  structured   text  " },
				{ type: "thinking", thinking: "  private   reasoning  ", signature: "sig-1" },
				{ type: "thinking", thinking: "  unsigned   reasoning  " },
			],
		},
	]

	const result = service.compactPrompt({
		systemPrompt: "  system   prompt  ",
		messages,
		requestedModel: "model-x",
	})
	const compactedBlocks = result.compactedMessages[1]?.content as Array<Record<string, unknown>>

	assert.equal(result.compactedSystemPrompt, "system prompt")
	assert.equal(result.compactedMessages[0]?.content, "keep this\n\n compact")
	assert.deepEqual(compactedBlocks[0], messages[1]?.content[0])
	assert.equal(compactedBlocks[1]?.text, "structured text")
	assert.deepEqual(compactedBlocks[2], messages[1]?.content[2])
	assert.equal(compactedBlocks[3]?.thinking, "unsigned reasoning")
	assert.equal(result.recommendedModel, "model-x")
	assert.ok(result.tokensSaved > 0)
	assert.equal(result.promptSha256.length, 64)

	const cached = service.compactPrompt({ systemPrompt: "  system   prompt  ", messages, requestedModel: "model-x" })
	assert.equal(cached.cachedL1, true)
	assert.deepEqual(cached.compactedMessages, result.compactedMessages)
})

test("uses the four-characters-per-token estimate", () => {
	assert.equal(TokenCompressionService.estimateTokens(""), 0)
	assert.equal(TokenCompressionService.estimateTokens("12345"), 2)
})
