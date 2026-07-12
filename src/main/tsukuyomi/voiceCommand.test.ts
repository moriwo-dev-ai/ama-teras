import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, TsukuyomiEvent } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import {
  CONFIRM_WORDS,
  isCancel,
  isConfirm,
  isReadOnly,
  needsConfirm,
  parseIntent,
} from '../../shared/voiceIntent';
import { INTENT_PROMPT } from './voiceCommand';
import { TsukuyomiManager } from './manager';

/**
 * M44-1(TUKU-yomi): 声で AMA-teras を操作する。
 *
 * ここで固定するのは「相槌では動かない」「許可リストの外は動かない」
 * 「外部発信は声では実行しない」の3点。**岩戸ゲートは外さない**。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-cmd-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 発話ごとに違う返事をする偽プロバイダ(意図判定 → 会話、の順で呼ばれる) */
function scriptedProvider(replies: string[]): LLMProvider {
  let i = 0;
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      const reply = replies[Math.min(i++, replies.length - 1)] ?? '';
      yield { type: 'text_delta', text: reply };
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [] },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      };
    },
  };
}

function manager(
  said: string[],
  providerReplies: string[],
  actions?: Partial<NonNullable<ConstructorParameters<typeof TsukuyomiManager>[0]['voiceActions']>>,
  events: TsukuyomiEvent[] = [],
): { m: TsukuyomiManager; events: TsukuyomiEvent[]; heard: string[] } {
  const heard = [...said];
  const m = new TsukuyomiManager({
    userDataDir: dir,
    getConfig: () =>
      ({
        tsukuyomi: {
          enabled: true,
          ears: true,
          voiceOutput: true,
          conversation: true,
          voiceCommand: true,
          sttMode: 'cloud',
        },
      }) as AppConfig,
    hasOwnerKey: () => true,
    emit: (e) => events.push(e),
    visionProvider: () => scriptedProvider(providerReplies),
    cloudStt: () => vi.fn(async () => heard.shift() ?? ''),
    voiceActions: {
      runningCount: () => 0,
      pendingApprovals: () => 2,
      godIds: () => ['metrics'],
      ...actions,
    },
  });
  return { m, events, heard };
}

describe('M44-1(TUKU-yomi) 声で操作: 相槌では動かない', () => {
  it('確認語は「明示的にやれと言った言葉」だけ(「うん」「はい」では動かない)', () => {
    expect(isConfirm('実行して')).toBe(true);
    expect(isConfirm('お願いします')).toBe(true);
    expect(isConfirm('うん')).toBe(false); // 相槌・テレビの音で本番操作が飛ぶ
    expect(isConfirm('はい')).toBe(false);
    expect(isConfirm('そうだね')).toBe(false);
    expect(isCancel('やめて')).toBe(true);
    expect(CONFIRM_WORDS).not.toContain('はい');
  });

  it('許可リストの外の操作は捨てる(モデルが何を言おうと実行に行かせない)', () => {
    expect(parseIntent('{"action":"cho.done","target":"レビュー","say":"済みにします"}')?.action).toBe(
      'cho.done',
    );
    expect(parseIntent('{"action":"shell.exec","target":"rm -rf /","say":"消します"}')).toBeNull();
    expect(parseIntent('null')).toBeNull();
    expect(parseIntent('壊れた')).toBeNull();
  });

  it('読み取りは確認不要・副作用のある操作は確認が要る', () => {
    expect(isReadOnly('read.approvals')).toBe(true);
    expect(needsConfirm('read.approvals')).toBe(false);
    expect(needsConfirm('cho.done')).toBe(true);
    expect(needsConfirm('ops.godRun')).toBe(true);
  });

  it('判定プロンプトが「迷ったら操作にしない」を課している', () => {
    expect(INTENT_PROMPT).toContain('迷ったら null');
    expect(INTENT_PROMPT).toContain('blocked.publish');
  });

  it('読み取りの操作は確認なしで即答する(何も壊れない)', async () => {
    const { m } = manager(
      ['承認待ち何件?'],
      ['{"action":"read.approvals","say":"承認待ちを読みます"}'],
    );
    const r = await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    expect(r.reply).toBe('承認待ちが2件あります。');
  });

  it('副作用のある操作は**復唱して確認語を待つ**(その場では実行しない)', async () => {
    const runGod = vi.fn(async () => ({ ok: true, detail: '動いた' }));
    const { m } = manager(
      ['メトリクスの神を動かして', 'うん', '実行して'],
      ['{"action":"ops.godRun","target":"metrics","say":"metrics を今すぐ動かします"}'],
      { runGod },
    );

    const first = await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    expect(first.reply).toContain('いいですか?');
    expect(runGod).not.toHaveBeenCalled(); // まだ動かさない

    const second = await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    expect(runGod).not.toHaveBeenCalled(); // 「うん」では動かない

    const third = await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    expect(runGod).toHaveBeenCalledWith('metrics'); // 「実行して」で初めて動く
    expect(third.reply).toContain('動かしました');
  });

  it('「やめて」で確認を捨てる(放置した確認語で後から動き出さない)', async () => {
    const runGod = vi.fn(async () => ({ ok: true, detail: '動いた' }));
    const { m } = manager(
      ['メトリクスの神を動かして', 'やめて', '実行して'],
      ['{"action":"ops.godRun","target":"metrics","say":"metrics を今すぐ動かします"}'],
      { runGod },
    );
    await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    const cancelled = await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    expect(cancelled.reply).toContain('やめておきます');

    await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    expect(runGod).not.toHaveBeenCalled(); // 取り消した後の「実行して」では動かない
  });

  it('**外部発信・リリースは声では実行しない**(言い間違い・誤認識で本番に出たら戻せない)', async () => {
    const { m } = manager(
      ['さっきのドラフトXに投稿しといて'],
      ['{"action":"blocked.publish","say":"投稿を頼まれました"}'],
    );
    const r = await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    expect(r.reply).toContain('声では実行しません');
    expect(r.reply).toContain('画面で承認');
  });

  it('知らない神は動かさない(モデルが名前を作っても実行に行かない)', async () => {
    const runGod = vi.fn(async () => ({ ok: true, detail: '動いた' }));
    const { m } = manager(
      ['謎の神を動かして', '実行して'],
      ['{"action":"ops.godRun","target":"存在しない神","say":"動かします"}', '普通の返事'],
      { runGod },
    );
    const r = await m.transcribeAndExtract(Buffer.alloc(44), 'ptt');
    expect(r.reply).not.toContain('いいですか?'); // 操作にならず、普通の会話に落ちる
    expect(runGod).not.toHaveBeenCalled();
  });
});
