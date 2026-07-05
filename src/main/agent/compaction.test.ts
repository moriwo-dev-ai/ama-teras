import { describe, expect, it } from 'vitest';
import type { ChatMessage, CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import {
  compactHistory,
  estimateTokens,
  findCompactionSplit,
  splitMemoryEscape,
  SUMMARY_SECTIONS,
  TRUNCATE_IF_LONGER_THAN,
  truncateOldToolResults,
} from './compaction';

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

describe('M13-1: 実測トークントリガー', () => {
  it('measuredTokens が閾値超なら履歴の推定が小さくても発火する', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) history.push(userText(`q${i}`), asstText(`a${i}`));
    const provider = summarizerProvider('要約');
    const compacted = await compactHistory(provider, history, {
      thresholdTokens: 1000,
      keepRecentTurns: 2,
      measuredTokens: 5000, // 実測が超過(推定は数十トークンしかない)
    });
    expect(compacted).toBe(true);
  });

  it('measuredTokens が閾値未満なら推定が大きくても発火しない(実測を優先)', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(userText(`q${i} ${'あ'.repeat(3000)}`), asstText(`a${i} ${'い'.repeat(3000)}`));
    }
    const provider = summarizerProvider('要約');
    const compacted = await compactHistory(provider, history, {
      thresholdTokens: 1000,
      measuredTokens: 10,
    });
    expect(compacted).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('M13-1: 第1段圧縮(tool_result 切り詰め)', () => {
  function longToolTurn(id: string): ChatMessage[] {
    return [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'z'.repeat(TRUNCATE_IF_LONGER_THAN + 1000) }] },
    ];
  }

  it('古いターンの長い tool_result だけ切り詰め、ブロック数・ID・並びは不変(API 400回帰防止)', () => {
    const history: ChatMessage[] = [
      userText('t1'),
      ...longToolTurn('old1'),
      asstText('done1'),
      userText('t2'),
      ...longToolTurn('recent1'),
      asstText('done2'),
    ];
    const structureBefore = history.map((m) => ({
      role: m.role,
      blocks: m.content.map((b) => (b.type === 'tool_result' ? `r:${b.toolUseId}` : b.type === 'tool_use' ? `u:${b.id}` : 't')),
    }));

    const n = truncateOldToolResults(history, 1); // 直近1ターン(t2以降)は保持
    expect(n).toBe(1);

    // 古い方は切り詰め済み・新しい方は原文のまま
    const oldResult = history[2]!.content[0]!;
    expect(oldResult.type === 'tool_result' && oldResult.content).toContain('切り詰め済み');
    expect(oldResult.type === 'tool_result' && oldResult.content.length).toBeLessThan(2000);
    const recentResult = history[6]!.content[0]!;
    expect(recentResult.type === 'tool_result' && recentResult.content.length).toBeGreaterThan(TRUNCATE_IF_LONGER_THAN);

    // 構造(role・ブロック種別・ID・並び)は完全に不変
    const structureAfter = history.map((m) => ({
      role: m.role,
      blocks: m.content.map((b) => (b.type === 'tool_result' ? `r:${b.toolUseId}` : b.type === 'tool_use' ? `u:${b.id}` : 't')),
    }));
    expect(structureAfter).toEqual(structureBefore);
  });

  it('切り詰めだけで閾値を下回れば要約(LLM呼び出し)まで行かない', async () => {
    const history: ChatMessage[] = [
      userText('t1'),
      ...longToolTurn('old1'),
      asstText('done1'),
      userText('t2'),
      asstText('a2'),
    ];
    const provider = summarizerProvider('未使用のはず');
    const compacted = await compactHistory(provider, history, {
      thresholdTokens: 1200, // 切り詰め後の推定(数百トークン)なら下回る値
      keepRecentTurns: 1,
      measuredTokens: 5000,
    });
    expect(compacted).toBe(true);
    expect(provider.calls).toHaveLength(0); // 第1段だけで完了
    expect(history.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('要約')))).toBe(false);
  });
});

describe('M13-1: 構造化要約と記憶退避', () => {
  it('要約プロンプトに固定セクションと記憶退避の指示が含まれる', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(userText(`q${i} ${'あ'.repeat(300)}`), asstText(`a${i} ${'い'.repeat(300)}`));
    }
    const provider = summarizerProvider('## 依頼の目的\nテスト');
    await compactHistory(provider, history, { thresholdTokens: 100, keepRecentTurns: 2 });
    const system = provider.calls[0]!.system;
    for (const section of SUMMARY_SECTIONS) expect(system).toContain(section);
    expect(system).toContain('記憶へ退避');
  });

  it('「## 記憶へ退避」は onMemoryEscape に渡り、履歴に残る要約からは除かれる', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(userText(`q${i} ${'あ'.repeat(300)}`), asstText(`a${i} ${'い'.repeat(300)}`));
    }
    const provider = summarizerProvider(
      '## 依頼の目的\nX\n\n## 完了したこと\nY\n\n## 記憶へ退避\n- ビルドは npm run build:all を使う',
    );
    const escaped: string[] = [];
    const compacted = await compactHistory(provider, history, {
      thresholdTokens: 100,
      keepRecentTurns: 2,
      onMemoryEscape: (t) => escaped.push(t),
    });
    expect(compacted).toBe(true);
    expect(escaped).toEqual(['- ビルドは npm run build:all を使う']);
    const first = history[0]!.content[0]!;
    expect(first.type === 'text' && first.text).toContain('依頼の目的');
    expect(first.type === 'text' && first.text).not.toContain('記憶へ退避');
  });

  it('splitMemoryEscape: 見出しが無ければ全文が要約・退避は null', () => {
    expect(splitMemoryEscape('## 依頼の目的\nX')).toEqual(['## 依頼の目的\nX', null]);
    expect(splitMemoryEscape('本文\n## 記憶へ退避\n- 知見')).toEqual(['本文', '- 知見']);
    expect(splitMemoryEscape('本文\n## 記憶へ退避\n   ')).toEqual(['本文', null]);
  });
});
