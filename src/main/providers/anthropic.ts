import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatMessage,
  CompletionRequest,
  ContentBlock,
  LLMProvider,
  ProviderEvent,
  StopReason,
} from './types';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 共通形式 → Anthropic Messages API パラメータ。
 * prompt caching必須(CLAUDE.md): system・ツール定義末尾・会話履歴末尾に cache_control を置き、
 * ループ間でプレフィックスキャッシュを効かせる(最大4ブレークポイントのうち3を使用)。
 */
export function buildAnthropicParams(
  req: CompletionRequest,
  model: string,
): Anthropic.MessageCreateParamsStreaming {
  const tools: Anthropic.Tool[] = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({
    role: m.role,
    content: m.content.map((b): Anthropic.ContentBlockParam => {
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text };
        case 'tool_use':
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content,
            is_error: b.isError === true,
          };
      }
    }),
  }));

  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    const lastBlock = lastMessage.content[lastMessage.content.length - 1];
    if (lastBlock && typeof lastBlock !== 'string') {
      (lastBlock as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = {
        type: 'ephemeral',
      };
    }
  }

  return {
    model,
    max_tokens: req.maxTokens,
    stream: true,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
  };
}

function mapStopReason(raw: unknown): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
      return raw;
    default:
      return 'other';
  }
}

/**
 * Anthropicの生ストリームイベント列を ProviderEvent に正規化する。
 * SDK非依存の構造判定にしてあり、テストでは素のオブジェクト列を流せる。
 */
export async function* normalizeAnthropicStream(
  events: AsyncIterable<unknown>,
): AsyncIterable<ProviderEvent> {
  const blocks: ContentBlock[] = [];
  const jsonAcc = new Map<number, string>();
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let stopReason: StopReason = 'other';

  for await (const raw of events) {
    if (!isRecord(raw)) continue;
    switch (raw['type']) {
      case 'message_start': {
        const msg = raw['message'];
        if (isRecord(msg) && isRecord(msg['usage'])) {
          const u = msg['usage'];
          if (typeof u['input_tokens'] === 'number') usage.inputTokens = u['input_tokens'];
          if (typeof u['cache_read_input_tokens'] === 'number') {
            usage.cacheReadTokens = u['cache_read_input_tokens'];
          }
        }
        break;
      }
      case 'content_block_start': {
        const index = raw['index'];
        const block = raw['content_block'];
        if (typeof index !== 'number' || !isRecord(block)) break;
        if (block['type'] === 'text') {
          blocks[index] = { type: 'text', text: '' };
        } else if (
          block['type'] === 'tool_use' &&
          typeof block['id'] === 'string' &&
          typeof block['name'] === 'string'
        ) {
          blocks[index] = { type: 'tool_use', id: block['id'], name: block['name'], input: {} };
          jsonAcc.set(index, '');
          yield { type: 'tool_use_start', id: block['id'], name: block['name'] };
        }
        break;
      }
      case 'content_block_delta': {
        const index = raw['index'];
        const delta = raw['delta'];
        if (typeof index !== 'number' || !isRecord(delta)) break;
        const block = blocks[index];
        if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
          if (block?.type === 'text') block.text += delta['text'];
          yield { type: 'text_delta', text: delta['text'] };
        } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
          jsonAcc.set(index, (jsonAcc.get(index) ?? '') + delta['partial_json']);
          if (block?.type === 'tool_use') {
            yield { type: 'tool_input_delta', id: block.id, partialJson: delta['partial_json'] };
          }
        }
        break;
      }
      case 'content_block_stop': {
        const index = raw['index'];
        if (typeof index !== 'number') break;
        const block = blocks[index];
        if (block?.type === 'tool_use') {
          const json = jsonAcc.get(index) ?? '';
          try {
            block.input = json.trim() === '' ? {} : JSON.parse(json);
          } catch {
            block.input = {};
          }
        }
        break;
      }
      case 'message_delta': {
        const delta = raw['delta'];
        if (isRecord(delta)) stopReason = mapStopReason(delta['stop_reason']);
        const u = raw['usage'];
        if (isRecord(u) && typeof u['output_tokens'] === 'number') {
          usage.outputTokens = u['output_tokens'];
        }
        break;
      }
      case 'message_stop': {
        yield {
          type: 'message_done',
          message: { role: 'assistant', content: blocks.filter((b) => b !== undefined) },
          stopReason,
          usage,
        };
        break;
      }
    }
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string = DEFAULT_ANTHROPIC_MODEL,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async *complete(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    const stream = this.client.messages.stream(buildAnthropicParams(req, this.model), {
      signal: req.signal,
    });
    yield* normalizeAnthropicStream(stream);
  }
}
