import OpenAI from 'openai';
import { parseToolArguments } from './toolArgs';
import type {
  ChatMessage,
  CompletionRequest,
  ContentBlock,
  LLMProvider,
  ProviderEvent,
  StopReason,
} from './types';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.1';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 共通形式(Anthropic寄りのブロック構造)→ OpenAI Chat Completions形式。
 * - assistantの tool_use ブロック → tool_calls
 * - userの tool_result ブロック → role:'tool' メッセージ(1ブロック=1メッセージ)
 */
export function buildOpenAIParams(
  req: CompletionRequest,
  model: string,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
  ];

  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      messages.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const b of m.content) {
        if (b.type === 'text') {
          messages.push({ role: 'user', content: b.text });
        } else if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
        }
      }
    }
  }

  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: req.maxTokens,
    messages,
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema as unknown as Record<string, unknown>,
            },
          })),
        }
      : {}),
  };
}

function mapFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/**
 * OpenAIストリームチャンク列を ProviderEvent に正規化する。
 * SDK非依存の構造判定にしてあり、テストでは素のオブジェクト列を流せる。
 */
export async function* normalizeOpenAIStream(
  chunks: AsyncIterable<unknown>,
): AsyncIterable<ProviderEvent> {
  let text = '';
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let stopReason: StopReason = 'other';

  for await (const raw of chunks) {
    if (!isRecord(raw)) continue;

    const u = raw['usage'];
    if (isRecord(u)) {
      if (typeof u['prompt_tokens'] === 'number') usage.inputTokens = u['prompt_tokens'];
      if (typeof u['completion_tokens'] === 'number') usage.outputTokens = u['completion_tokens'];
      const details = u['prompt_tokens_details'];
      if (isRecord(details) && typeof details['cached_tokens'] === 'number') {
        usage.cacheReadTokens = details['cached_tokens'];
      }
    }

    const choices = raw['choices'];
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice: unknown = choices[0];
    if (!isRecord(choice)) continue;

    const finish = choice['finish_reason'];
    if (typeof finish === 'string') stopReason = mapFinishReason(finish);

    const delta = choice['delta'];
    if (!isRecord(delta)) continue;

    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      text += delta['content'];
      yield { type: 'text_delta', text: delta['content'] };
    }

    const rawCalls = delta['tool_calls'];
    if (Array.isArray(rawCalls)) {
      for (const rc of rawCalls) {
        if (!isRecord(rc) || typeof rc['index'] !== 'number') continue;
        const index = rc['index'];
        const fn = isRecord(rc['function']) ? rc['function'] : {};
        let entry = toolCalls.get(index);
        if (!entry) {
          entry = {
            id: typeof rc['id'] === 'string' ? rc['id'] : `call_${index}`,
            name: typeof fn['name'] === 'string' ? fn['name'] : '',
            args: '',
          };
          toolCalls.set(index, entry);
          yield { type: 'tool_use_start', id: entry.id, name: entry.name };
        }
        if (typeof fn['name'] === 'string' && entry.name === '') entry.name = fn['name'];
        if (typeof fn['arguments'] === 'string' && fn['arguments'] !== '') {
          entry.args += fn['arguments'];
          yield { type: 'tool_input_delta', id: entry.id, partialJson: fn['arguments'] };
        }
      }
    }
  }

  const content: ContentBlock[] = [];
  if (text !== '') content.push({ type: 'text', text });
  for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    const { input, error } = parseToolArguments(tc.args);
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input, ...(error ? { inputError: error } : {}) });
  }

  const message: ChatMessage = { role: 'assistant', content };
  yield { type: 'message_done', message, stopReason, usage };
}

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string = DEFAULT_OPENAI_MODEL,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async *complete(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    const stream = await this.client.chat.completions.create(
      buildOpenAIParams(req, this.model),
      { signal: req.signal },
    );
    yield* normalizeOpenAIStream(stream);
  }
}
