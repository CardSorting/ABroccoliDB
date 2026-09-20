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
/**
 * BroccoliDB implementation of GALXAI's deterministic prompt compression
 * strategy. It is deliberately lossless at the semantic level: only line
 * endings, repeated whitespace, and empty-line runs are normalized. Structured
 * provider blocks remain structured so tool calls, images, and signatures are
 * never serialized into plain text by the optimization pass.
 */
export declare class TokenCompressionService {
    private static instance;
    private static readonly MAX_L1_ENTRIES;
    private readonly l1Cache;
    private constructor();
    static getInstance(): TokenCompressionService;
    /**
     * Estimates tokens with the same fast four-characters-per-token heuristic as
     * the source strategy. This is a budget signal, not provider billing data.
     */
    static estimateTokens(text: string): number;
    /**
     * Compacts a prompt at the request boundary and reuses exact L1 results by
     * SHA-256 of the unmodified prompt payload.
     */
    compactPrompt<T extends TokenCompressionMessage>(input: TokenCompressionRequest<T>): TokenCompressionResult<T>;
    /** Clears the process-local cache. Intended for lifecycle cleanup and tests. */
    clear(): void;
    private estimatePromptTokens;
    private serializeContent;
    private normalizeContent;
    private normalizeText;
    private copyMessages;
}
export declare const tokenCompressionService: TokenCompressionService;
//# sourceMappingURL=TokenCompressionService.d.ts.map