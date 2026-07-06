import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import { runAgentLoop, type AgentLoopDeps } from './loop';

/** M21-4: ツール実行中の ctx.log が tool_progress イベントとしてUIへ流れることを固定 */

function mockProvider(responses: ProviderEvent[][]): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(_req: CompletionRequest) {
      const next = responses.shift();
      if (!next) throw new Error('モック応答が尽きた');
      yield* next;
    },
  };
}

describe('runAgentLoop M21-4(tool_progress)', () => {
  it('executeTool内の ctx.log が toolUseId/name 付きの tool_progress として emit される', async () => {
    const provider = mockProvider([
      [
        {
          type: 'message_done',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'bash', input: {} }] },
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        },
      ],
      [
        {
          type: 'message_done',
          message: { role: 'assistant', content: [{ type: 'text', text: '完了' }] },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        },
      ],
    ]);
    const events: AgentEvent[] = [];
    const deps: AgentLoopDeps = {
      provider,
      tools: { list: () => [] },
      executeTool: async (_name, _input, ctx) => {
        ctx.log('building...\nstep 2/5');
        return { content: 'ok' };
      },
      emit: (e) => events.push(e),
      systemPrompt: 'test',
      cwd: process.cwd(),
    };
    const history = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'ビルドして' }] }];
    const status = await runAgentLoop(deps, 's1', history, new AbortController().signal);
    expect(status).toBe('done');
    const progress = events.find((e) => e.kind === 'tool_progress');
    expect(progress).toEqual({
      kind: 'tool_progress',
      sessionId: 's1',
      toolUseId: 'tu9',
      name: 'bash',
      outputTail: 'building...\nstep 2/5',
    });
  });
});
