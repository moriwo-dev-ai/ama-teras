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
