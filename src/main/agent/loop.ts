import type { AgentEvent, AgentStatus } from '../../shared/types';
import type { ChatMessage, ContentBlock, LLMProvider, ToolDefinition } from '../providers/types';
import type { ToolContext, ToolPlugin, ToolResult } from '../tools/types';

export interface AgentLoopDeps {
  provider: LLMProvider;
  /** ToolRegistry を構造的に満たす(テストではモック可能) */
  tools: { list(): ToolPlugin[] };
  /** 承認フロー込みのツール実行(tools/executor.ts の executeToolWithApproval を束ねたもの) */
  executeTool: (name: string, input: unknown, ctx: ToolContext) => Promise<ToolResult>;
  emit: (event: AgentEvent) => void;
  systemPrompt: string;
  cwd: string;
  maxTurns?: number;
  maxTokens?: number;
}

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_TOKENS = 32_000;

function toToolDefinitions(plugins: ToolPlugin[]): ToolDefinition[] {
  return plugins.map((p) => ({ name: p.name, description: p.description, inputSchema: p.inputSchema }));
}

function preview(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}

/**
 * エージェントループ本体: 応答 → tool_use → 承認+実行 → tool_result → ループ。
 * history は呼び出し側が保持し、この関数が assistant / tool_result メッセージを追記する。
 * 戻り値は終了ステータス(emit済みのものと同じ)。
 */
export async function runAgentLoop(
  deps: AgentLoopDeps,
  sessionId: string,
  history: ChatMessage[],
  signal: AbortSignal,
): Promise<AgentStatus> {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const finish = (status: AgentStatus): AgentStatus => {
    deps.emit({ kind: 'status', sessionId, status });
    return status;
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal.aborted) return finish('cancelled');
    deps.emit({ kind: 'status', sessionId, status: 'calling_llm' });

    let finalMessage: ChatMessage | null = null;
    let stopReason = 'other';

    try {
      for await (const ev of deps.provider.complete({
        system: deps.systemPrompt,
        messages: history,
        tools: toToolDefinitions(deps.tools.list()),
        maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal,
      })) {
        switch (ev.type) {
          case 'text_delta':
            deps.emit({ kind: 'text_delta', sessionId, text: ev.text });
            break;
          case 'message_done':
            finalMessage = ev.message;
            stopReason = ev.stopReason;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (signal.aborted) return finish('cancelled');
      deps.emit({
        kind: 'error',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
      return finish('error');
    }

    if (signal.aborted) return finish('cancelled');
    if (!finalMessage || finalMessage.content.length === 0) {
      deps.emit({
        kind: 'error',
        sessionId,
        message: stopReason === 'refusal' ? 'モデルが応答を拒否した' : 'モデル応答が空だった',
      });
      return finish('error');
    }

    history.push(finalMessage);
    deps.emit({ kind: 'message_done', sessionId });

    if (stopReason !== 'tool_use') {
      if (stopReason === 'max_tokens') {
        deps.emit({ kind: 'error', sessionId, message: '出力トークン上限に達した(応答は途中で切れている)' });
      }
      return finish('done');
    }

    // tool_use ブロックを順に実行し、結果を1つの user メッセージにまとめて返す
    const toolUses = finalMessage.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      if (signal.aborted) return finish('cancelled');
      deps.emit({
        kind: 'tool_start',
        sessionId,
        toolUseId: tu.id,
        name: tu.name,
        inputPreview: preview(tu.input),
      });
      deps.emit({ kind: 'status', sessionId, status: 'executing_tool' });
      const result = await deps.executeTool(tu.name, tu.input, {
        cwd: deps.cwd,
        signal,
        log: () => {},
      });
      deps.emit({
        kind: 'tool_result',
        sessionId,
        toolUseId: tu.id,
        name: tu.name,
        content: result.content.length > 2000 ? `${result.content.slice(0, 2000)}…` : result.content,
        isError: result.isError === true,
      });
      results.push({
        type: 'tool_result',
        toolUseId: tu.id,
        content: result.content,
        isError: result.isError,
      });
    }
    history.push({ role: 'user', content: results });
  }

  return finish('max_turns_reached');
}
