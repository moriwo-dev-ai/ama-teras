import { describe, expect, it } from 'vitest';
import type { ChatMessage, CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import { compactHistory, estimateTokens, findCompactionSplit } from './compaction';

/** 要約要求には固定の要約を返すモックプロバイダ */
function summarizerProvider(summary: string): LLMProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    id: 'anthropic',
    calls,
    async *complete(req: CompletionRequest): AsyncIterable<ProviderEvent> {
      calls.push(req);
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text: summary }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

const userText = (t: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: t }] });
const asstText = (t: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

/** tool_use を含む1往復(assistant tool_use → user tool_result) */
function toolTurn(id: string): ChatMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'x'.repeat(200) }] },
  ];
}

function assertToolPairing(history: ChatMessage[]): void {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of history)
    for (const b of m.content) {
      if (b.type === 'tool_use') uses.add(b.id);
      if (b.type === 'tool_result') results.add(b.toolUseId);
    }
  for (const id of uses) expect(results.has(id), `tool_use ${id} に tool_result が無い`).toBe(true);
}

describe('estimateTokens / findCompactionSplit', () => {
  it('user テキスト境界で分割し、直近ターンを残す', () => {
    const h = [userText('t1'), asstText('a1'), userText('t2'), asstText('a2'), userText('t3'), asstText('a3')];
    // 直近2ターンを残す → split は t2 の位置(index 2)
    expect(findCompactionSplit(h, 2)).toBe(2);
  });

  it('ターン数が保持数以下なら圧縮不要(0)', () => {
    const h = [userText('t1'), asstText('a1')];
    expect(findCompactionSplit(h, 4)).toBe(0);
  });

  it('分割点は tool_use/tool_result ペアを分断しない', () => {
    // user → assistant(tool_use) → user(tool_result) → assistant → user → ...
    const h = [userText('t1'), ...toolTurn('tu1'), asstText('done1'), userText('t2'), asstText('a2')];
    const split = findCompactionSplit(h, 1); // 直近1ターン(t2)を残す
    // split の位置は t2(index 5)。手前(要約対象)に tu1 の use/result が両方含まれる
    expect(h[split]).toEqual(userText('t2'));
    assertToolPairing(h.slice(0, split));
  });
});

describe('compactHistory(M8-1)', () => {
  it('閾値超で古い履歴を要約に置換し、送信トークンが減る', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(userText(`質問${i}: ${'あ'.repeat(300)}`));
      history.push(asstText(`回答${i}: ${'い'.repeat(300)}`));
    }
    const before = estimateTokens(history);
    const provider = summarizerProvider('ユーザーは一連の質問をし、回答済み。最新の関心は質問7。');

    const compacted = await compactHistory(provider, history, { thresholdTokens: 100, keepRecentTurns: 2 });

    expect(compacted).toBe(true);
    expect(estimateTokens(history)).toBeLessThan(before); // トークンが減る
    // 要約が先頭に入り、直近2ターン(質問6,7)は生ログで残る
    expect(history[0]!.content[0]).toMatchObject({ type: 'text' });
    expect((history[0]!.content[0] as { text: string }).text).toContain('要約');
    expect(JSON.stringify(history)).toContain('質問7'); // 直近の生ログが残っている
    expect(JSON.stringify(history)).toContain('質問6');
    expect(JSON.stringify(history)).not.toContain('質問0'); // 古い生ログは要約に畳まれた
  });

  it('閾値未満なら何もしない', async () => {
    const history = [userText('短い'), asstText('短い返答')];
    const provider = summarizerProvider('要約');
    const compacted = await compactHistory(provider, history, { thresholdTokens: 100_000 });
    expect(compacted).toBe(false);
    expect(history).toHaveLength(2);
    expect(provider.calls).toHaveLength(0); // 要約LLM呼び出しも発生しない
  });

  it('圧縮後も tool_use/tool_result 整合が保たれる', async () => {
    const history: ChatMessage[] = [userText('start')];
    for (let i = 0; i < 6; i++) {
      history.push(...toolTurn(`tu${i}`));
      history.push(asstText(`step${i} ${'x'.repeat(200)}`));
      history.push(userText(`next${i} ${'y'.repeat(200)}`));
    }
    const provider = summarizerProvider('要約テキスト');
    await compactHistory(provider, history, { thresholdTokens: 100, keepRecentTurns: 2 });
    assertToolPairing(history);
  });

  it('要約が空文字なら圧縮しない(生ログ保持)', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(userText(`q${i} ${'あ'.repeat(300)}`), asstText(`a${i} ${'い'.repeat(300)}`));
    }
    const len = history.length;
    const provider = summarizerProvider('   '); // 空要約
    const compacted = await compactHistory(provider, history, { thresholdTokens: 100, keepRecentTurns: 2 });
    expect(compacted).toBe(false);
    expect(history).toHaveLength(len);
  });
});
