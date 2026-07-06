import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolContext } from '../tools/types';
import { runAgentLoop, type AgentLoopDeps } from './loop';

/** M21-1: 実行中の追加指示(drainInstructions)の注入位置と履歴整合性を固定する */

function textResponse(text: string): ProviderEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'message_done',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    },
  ];
}

function toolUseResponse(id: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { type: 'tool_use_start', id, name },
    {
      type: 'message_done',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    },
  ];
}

function mockProvider(responses: ProviderEvent[][]): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id: 'anthropic',
    requests,
    async *complete(req: CompletionRequest) {
      requests.push({
        ...req,
        messages: req.messages.map((m) => ({ ...m, content: [...m.content] })),
      });
      const next = responses.shift();
      if (!next) throw new Error('モック応答が尽きた');
      yield* next;
    },
  };
}

const userMsg = (text: string): { role: 'user'; content: [{ type: 'text'; text: string }] } => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

function assertToolPairing(history: { role: string; content: unknown[] }[]): void {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const msg of history) {
    for (const b of msg.content as { type?: string; id?: string; toolUseId?: string }[]) {
      if (b.type === 'tool_use' && typeof b.id === 'string') toolUseIds.add(b.id);
      if (b.type === 'tool_result' && typeof b.toolUseId === 'string') toolResultIds.add(b.toolUseId);
    }
  }
  for (const id of toolUseIds) {
    expect(toolResultIds.has(id), `tool_use ${id} に対応する tool_result が無い`).toBe(true);
  }
}

function makeDeps(
  provider: LLMProvider,
  queue: { text: string }[],
): { deps: AgentLoopDeps; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const deps: AgentLoopDeps = {
    provider,
    tools: { list: () => [] },
    executeTool: async (_n: string, _i: unknown, _c: ToolContext) => ({ content: 'ok' }),
    emit: (e) => events.push(e),
    systemPrompt: 'test',
    cwd: process.cwd(),
    drainInstructions: () => queue.splice(0),
  };
  return { deps, events };
}

describe('runAgentLoop M21-1(実行中の追加指示)', () => {
  it('ターン境界で tool_result 群の後ろに text として注入され、LLM呼び出しに載る', async () => {
    const provider = mockProvider([
      toolUseResponse('tu1', 'read_file', { path: 'a.txt' }),
      textResponse('了解、追加指示も反映した'),
    ]);
    const queue: { text: string }[] = [];
    const { deps } = makeDeps(provider, queue);
    const history = [userMsg('a.txtを読んで')];

    // 1ターン目の応答(tool_use)を受けた後にユーザーが追加指示を送った状況を再現:
    // executeTool の中でキューへ積む(ツール実行中=まだ次のLLM呼び出し前)
    deps.executeTool = async () => {
      queue.push({ text: 'ついでにREADMEも直して' });
      return { content: 'ファイル内容' };
    };

    const status = await runAgentLoop(deps, 's1', history, new AbortController().signal);
    expect(status).toBe('done');

    // 2回目のLLM呼び出しの最後のuserメッセージ: tool_result が先、追加指示 text が後
    const second = provider.requests[1]!;
    const lastUser = second.messages[second.messages.length - 1]!;
    expect(lastUser.role).toBe('user');
    const types = lastUser.content.map((b) => b.type);
    expect(types).toEqual(['tool_result', 'text']);
    const textBlock = lastUser.content.find((b) => b.type === 'text');
    expect(textBlock && 'text' in textBlock ? textBlock.text : '').toBe('ついでにREADMEも直して');
    assertToolPairing(history);
  });

  it('モデルが応答を完了しても、キューに指示が残っていればループを継続する', async () => {
    const provider = mockProvider([
      textResponse('できた'),
      textResponse('追加分もやった'),
    ]);
    const queue: { text: string }[] = [];
    const { deps } = makeDeps(provider, queue);
    // 1回目の complete 中に追加指示が届いた状況(text_delta ストリーミング中の送信)
    const origComplete = provider.complete.bind(provider);
    let first = true;
    provider.complete = async function* (req) {
      if (first) {
        first = false;
        queue.push({ text: 'テストも書いて' });
      }
      yield* origComplete(req);
    };

    const history = [userMsg('作って')];
    const status = await runAgentLoop(deps, 's1', history, new AbortController().signal);
    expect(status).toBe('done');
    // user → assistant(できた) → user(追加指示) → assistant(追加分もやった)
    expect(history).toHaveLength(4);
    expect(history[2]!.role).toBe('user');
    const block = history[2]!.content[0]!;
    expect(block.type === 'text' ? block.text : '').toBe('テストも書いて');
    expect(provider.requests).toHaveLength(2);
  });

  it('キューが空なら挙動は従来と同一(余計なメッセージを積まない)', async () => {
    const provider = mockProvider([textResponse('こんにちは')]);
    const { deps } = makeDeps(provider, []);
    const history = [userMsg('hi')];
    const status = await runAgentLoop(deps, 's1', history, new AbortController().signal);
    expect(status).toBe('done');
    expect(history).toHaveLength(2);
    expect(provider.requests).toHaveLength(1);
  });
});
