import type { JsonSchema } from '../tools/types';

/** プロバイダ非依存の共通メッセージ形式。Anthropicのブロック構造に寄せ、OpenAI側(M6)で変換する */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; inputError?: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  signal: AbortSignal;
}

/** ストリーミングイベント。プロバイダ実装は各SDKのイベントをこれに正規化する */
export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'message_done'; message: ChatMessage; stopReason: StopReason; usage: CompletionUsage };

export interface LLMProvider {
  readonly id: 'anthropic' | 'openai';
  /** ストリーミング補完。最後に必ず message_done を yield する */
  complete(req: CompletionRequest): AsyncIterable<ProviderEvent>;
}
