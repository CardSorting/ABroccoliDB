// [LAYER: CORE]
// @classification PURE

import { createHash } from 'node:crypto';

/**
 * Minimal message shape accepted by the prompt compressor.
 * The generic keeps provider-specific message metadata intact while the
 * compressor only rewrites textual content.
 */
export interface TokenCompressionMessage {
  role?: string;
  content?: unknown;
}

export interface TokenCompressionRequest<T extends TokenCompressionMessage = TokenCompressionMessage> {
  systemPrompt?: string;
  messages: readonly T[];
  requestedModel?: string;
}

export interface TokenCompressionResult<T extends TokenCompressionMessage = TokenCompressionMessage> {
  compactedSystemPrompt?: string;
  compactedMessages: T[];
  originalEstimatedTokens: number;
  compactedEstimatedTokens: number;
  tokensSaved: number;
  compressionRatioPct: number;
  promptSha256: string;
  /** The requested model is echoed without routing or model substitution. */
  recommendedModel: string;
  cachedL1: boolean;
}

type CachedCompressionResult = TokenCompressionResult<TokenCompressionMessage>;

/**
 * BroccoliDB implementation of GALXAI's deterministic prompt compression
 * strategy. It is deliberately lossless at the semantic level: only line
 * endings, repeated whitespace, and empty-line runs are normalized. Structured
 * provider blocks remain structured so tool calls, images, and signatures are
 * never serialized into plain text by the optimization pass.
 */
export class TokenCompressionService {
  private static instance: TokenCompressionService | undefined;
  private static readonly MAX_L1_ENTRIES = 1_000;

  private readonly l1Cache = new Map<string, CachedCompressionResult>();

  private constructor() {}

  public static getInstance(): TokenCompressionService {
    if (!TokenCompressionService.instance) {
      TokenCompressionService.instance = new TokenCompressionService();
    }
    return TokenCompressionService.instance;
  }

  /**
   * Estimates tokens with the same fast four-characters-per-token heuristic as
   * the source strategy. This is a budget signal, not provider billing data.
   */
  public static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  /**
   * Compacts a prompt at the request boundary and reuses exact L1 results by
   * SHA-256 of the unmodified prompt payload.
   */
  public compactPrompt<T extends TokenCompressionMessage>(
    input: TokenCompressionRequest<T>,
  ): TokenCompressionResult<T> {
    const rawPayload = JSON.stringify({
      systemPrompt: input.systemPrompt ?? null,
      messages: input.messages,
    });
    const promptSha256 = createHash('sha256').update(rawPayload ?? '').digest('hex');
    const cached = this.l1Cache.get(promptSha256);

    if (cached) {
      return {
        ...cached,
        compactedMessages: this.copyMessages(cached.compactedMessages) as T[],
        recommendedModel: input.requestedModel ?? 'unknown',
        cachedL1: true,
      };
    }

    const compactedSystemPrompt = input.systemPrompt === undefined
      ? undefined
      : this.normalizeText(input.systemPrompt, 'system');
    const compactedMessages = input.messages.map((message) => ({
      ...message,
      content: this.normalizeContent(message.content, message.role),
    })) as T[];

    const originalEstimatedTokens = this.estimatePromptTokens(input.systemPrompt, input.messages);
    const compactedEstimatedTokens = this.estimatePromptTokens(compactedSystemPrompt, compactedMessages);
    const tokensSaved = Math.max(0, originalEstimatedTokens - compactedEstimatedTokens);
    const compressionRatioPct = originalEstimatedTokens > 0
      ? Number(((tokensSaved / originalEstimatedTokens) * 100).toFixed(2))
      : 0;

    const result: TokenCompressionResult<T> = {
      compactedSystemPrompt,
      compactedMessages,
      originalEstimatedTokens,
      compactedEstimatedTokens,
      tokensSaved,
      compressionRatioPct,
      promptSha256,
      recommendedModel: input.requestedModel ?? 'unknown',
      cachedL1: false,
    };

    this.l1Cache.set(promptSha256, {
      ...result,
      compactedMessages: this.copyMessages(compactedMessages),
    });
    if (this.l1Cache.size > TokenCompressionService.MAX_L1_ENTRIES) {
      const firstKey = this.l1Cache.keys().next().value;
      if (firstKey) this.l1Cache.delete(firstKey);
    }

    return result;
  }

  /** Clears the process-local cache. Intended for lifecycle cleanup and tests. */
  public clear(): void {
    this.l1Cache.clear();
  }

  private estimatePromptTokens(
    systemPrompt: string | undefined,
    messages: readonly TokenCompressionMessage[],
  ): number {
    let total = TokenCompressionService.estimateTokens(systemPrompt ?? '');
    for (const message of messages) {
      total += TokenCompressionService.estimateTokens(this.serializeContent(message.content));
    }
    return total;
  }

  private serializeContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (content === undefined || content === null) return '';
    try {
      return JSON.stringify(content) ?? '';
    } catch {
      return String(content);
    }
  }

  private normalizeContent(content: unknown, role?: string): unknown {
    if (typeof content === 'string') {
      return this.normalizeText(content, role);
    }

    if (!Array.isArray(content)) return content;

    let changed = false;
    const normalized = content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const record = block as Record<string, unknown>;

      if (record.type === 'text' && typeof record.text === 'string') {
        const text = this.normalizeText(record.text, role);
        if (text !== record.text) changed = true;
        return text === record.text ? block : { ...record, text };
      }

      if (record.type === 'thinking' && typeof record.thinking === 'string') {
        // Provider thought signatures cover the reasoning payload. Rewriting a
        // signed block would leave the signature attached to different bytes
        // and can make the next request invalid. Unsigned blocks are safe to
        // normalize because they do not carry that provider contract.
        if (record.signature !== undefined) return block;

        const thinking = this.normalizeText(record.thinking, role);
        if (thinking !== record.thinking) changed = true;
        return thinking === record.thinking ? block : { ...record, thinking };
      }

      if (record.type === 'tool_result') {
        if (typeof record.content === 'string') {
          const text = this.normalizeText(record.content, role);
          if (text !== record.content) changed = true;
          return text === record.content ? block : { ...record, content: text };
        }

        if (Array.isArray(record.content)) {
          const nested = this.normalizeContent(record.content, role);
          if (nested !== record.content) {
            changed = true;
            return { ...record, content: nested };
          }
        }
      }

      return block;
    });

    return changed ? normalized : content;
  }

  private normalizeText(text: string, role?: string): string {
    const normalized = text.replace(/\r\n/g, '\n');
    if (role === 'system') {
      return normalized.replace(/[ \t]+/g, ' ').trim();
    }

    return normalized
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  private copyMessages(messages: readonly TokenCompressionMessage[]): TokenCompressionMessage[] {
    return messages.map((message) => {
      const content = message.content;
      if (!Array.isArray(content)) return { ...message };

      return {
        ...message,
        content: content.map((block) => (
          block && typeof block === 'object' ? { ...(block as Record<string, unknown>) } : block
        )),
      };
    });
  }
}

export const tokenCompressionService = TokenCompressionService.getInstance();
