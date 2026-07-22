import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { LLMProvider } from '../providers/types';
import { OperationsManager } from './manager';

/**
 * M99-11: 運営チャットからの神の実行(<action> run-god)。
 * 「公開準備して」→ チャットが uzume-drafts を実行、まで人手のボタンを挟まない。
 * 未知の神は実行しない。実行結果は必ずスレッドに残る(黙って動かない)。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm99thread-'));
  mkdirSync(join(dir, 'operations'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function providerReturning(output: string): LLMProvider {
  return {
    name: 'fake',
    // eslint-disable-next-line @typescript-eslint/require-await
    async *complete() {
      yield { type: 'text_delta', text: output };
      yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;
}

/** 呼び出しごとに違う応答を返す台本つきプロバイダ(最後の要素を繰り返す) */
function scriptedProvider(outputs: string[]): { provider: LLMProvider; calls: () => number } {
  let n = 0;
  const provider = {
    name: 'fake',
    // eslint-disable-next-line @typescript-eslint/require-await
    async *complete() {
      const out = outputs[Math.min(n, outputs.length - 1)]!;
      n++;
      yield { type: 'text_delta', text: out };
      yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;
  return { provider, calls: () => n };
}

function makeManager(reply: string): OperationsManager {
  return new OperationsManager({
    userDataDir: dir,
    getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: () => Promise.resolve(false),
    bandProvider: () => providerReturning(reply),
  });
}

describe('M99-11: 運営チャットの run-god アクション', () => {
  it('返信の <action> で uzume-drafts が実行され、結果がスレッドに残る', async () => {
    const manager = makeManager(
      '下書きを生成します。\n<action>{"kind":"run-god","godId":"uzume-drafts"}</action>',
    );
    await manager.status();
    const messages = await manager.threadSend('リリースノートの下書きを作って');

    const bodies = messages.map((m) => m.body);
    // 返信本文からタグは消えている
    expect(bodies.some((b) => b.includes('<action>'))).toBe(false);
    // 実行の宣言と結果が両方残る(✓/✗どちらでも「結果が残る」ことが本体)
    expect(bodies.some((b) => b.includes('uzume-drafts を実行する'))).toBe(true);
    expect(bodies.some((b) => /[✓✗] uzume-drafts:/.test(b))).toBe(true);
  });

  it('未知の神は実行せず、その旨をスレッドに残す', async () => {
    const manager = makeManager('やります。\n<action>{"kind":"run-god","godId":"evil-god"}</action>');
    await manager.status();
    const messages = await manager.threadSend('何かやって');
    const bodies = messages.map((m) => m.body);
    expect(bodies.some((b) => b.includes('未知の神は実行できない: evil-god'))).toBe(true);
    expect(bodies.some((b) => b.includes('evil-god を実行する'))).toBe(false);
  });

  it('アクションの無い普通の返答は従来どおり', async () => {
    const manager = makeManager('クローンは伸びていますが閲覧が少なく、ボット比率が高そうです。');
    await manager.status();
    const messages = await manager.threadSend('クローンの推移どう?');
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('kamuhakari');
    expect(last?.body).toContain('ボット比率');
  });
});

/**
 * M99-13: 読み取り専用ツールのループ。
 * 「読むのは自由、変えるのは承認」— ツールで調べ、何を見たかをスレッドに残し、
 * 暴走(同一呼び出しの繰り返し)は中間報告で打ち切る。
 */
describe('M99-13: 運営チャットの読み取りツールループ', () => {
  function makeScripted(outputs: string[]): { manager: OperationsManager; calls: () => number } {
    const { provider, calls } = scriptedProvider(outputs);
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false),
      bandProvider: () => provider,
    });
    return { manager, calls };
  }

  it('ツール要求→結果を踏まえた最終回答、と繋がり「🔍 調べた」がスレッドに残る', async () => {
    const { manager, calls } = makeScripted([
      '台帳を確認します。\n<tool>{"name":"metrics_history","args":{}}</tool>',
      '台帳を見ると観測点は1点だけで、推移を語るにはまだ足りません。',
    ]);
    await manager.status();
    const messages = await manager.threadSend('クローンの推移の全履歴を見て');
    const bodies = messages.map((m) => m.body);
    expect(calls()).toBe(2); // ツール1回+最終回答
    expect(bodies.some((b) => b.startsWith('🔍 調べた: metrics_history'))).toBe(true);
    expect(messages[messages.length - 1]?.body).toContain('まだ足りません');
    // ツールタグが表示に漏れない
    expect(bodies.some((b) => b.includes('<tool>'))).toBe(false);
  });

  it('同一ツール+同一引数の繰り返しは実行せず、中間報告で打ち切る(暴走ガード)', async () => {
    // 台本: 永遠に同じツールを要求し続けるモデル
    const { manager, calls } = makeScripted(['見ます。\n<tool>{"name":"drafts_all","args":{}}</tool>']);
    await manager.status();
    const messages = await manager.threadSend('何か調べて');
    // 1回目(実行)→2回目(同一検知)→強制の中間報告、で3回しか呼ばれない(8回上限まで回らない)
    expect(calls()).toBe(3);
    const notice = messages.find((m) => m.body.startsWith('🔍 調べた'));
    expect(notice?.body).toBe('🔍 調べた: drafts_all');
    // 最後は kamuhakari の本文(空にならない)
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('kamuhakari');
    expect(last?.body.length).toBeGreaterThan(0);
  });
});
