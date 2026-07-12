import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, TsukuyomiEvent } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { hasWakeWord, shouldConverse, stripWakeWord, WAKE_WINDOW_MS } from '../../shared/wakeWord';
import { TsukuyomiManager } from './manager';

/**
 * M43-4(TUKU-yomi): ウェイクワード。
 * 常時聴取に返事をさせるのは「呼ばれた時」だけ。呼ばれていない独り言・テレビの音に
 * 返事を始めたら事故(実機で「これやばいな、レジ使ってとか」に返事をした)。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-wake-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeProvider(reply: string): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
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

function manager(said: string, events: TsukuyomiEvent[], nowFn?: () => Date): TsukuyomiManager {
  return new TsukuyomiManager({
    userDataDir: dir,
    getConfig: () =>
      ({
        tsukuyomi: {
          enabled: true,
          ears: true,
          voiceOutput: true,
          conversation: true,
          sttMode: 'cloud',
        },
      }) as AppConfig,
    hasOwnerKey: () => true,
    emit: (e) => events.push(e),
    visionProvider: () => fakeProvider('[]'),
    cloudStt: () => vi.fn(async () => said),
    ...(nowFn !== undefined ? { nowFn } : {}),
  });
}

describe('M43-4(TUKU-yomi) ウェイクワード: 呼ばれた時だけ返事する', () => {
  it('呼びかけの表記ゆれを拾う(「月」だけのような短い語は入れない=誤爆する)', () => {
    expect(hasWakeWord('つくよみ、明日の予定は?')).toBe(true);
    expect(hasWakeWord('月読 明日の予定')).toBe(true);
    expect(hasWakeWord('TUKU-yomi!')).toBe(true);
    expect(hasWakeWord('今日は月がきれいだ')).toBe(false);
    expect(hasWakeWord('これやばいな、レジ使ってとか')).toBe(false);
  });

  it('呼びかけを外して用件だけを渡す(呼び名に返事をさせない)', () => {
    expect(stripWakeWord('つくよみ、明日の予定は?')).toBe('明日の予定は?');
    expect(stripWakeWord('月読')).toBe('');
  });

  it('呼ばれた直後の30秒は、呼ばずに続けて話せる', () => {
    const t0 = 1_000_000;
    expect(shouldConverse('ears', '明日の予定は?', null, t0)).toBe(false); // 呼ばれていない
    expect(shouldConverse('ears', '明日の予定は?', t0, t0 + 10_000)).toBe(true); // 呼ばれた直後
    expect(shouldConverse('ears', '明日の予定は?', t0, t0 + WAKE_WINDOW_MS + 1)).toBe(false); // 時間切れ
    expect(shouldConverse('ptt', '明日の予定は?', null, t0)).toBe(true); // 押して話したら常に返す
  });

  it('常時聴取: **呼ばれていない発話には返事をしない**(テレビの音に喋り出さない)', async () => {
    const events: TsukuyomiEvent[] = [];
    const m = manager('これやばいな、レジ使ってとか', events);
    const r = await m.transcribeAndExtract(Buffer.alloc(44), 'ears');
    expect(r.reply).toBeUndefined();
    expect(events.filter((e) => e.type === 'speak')).toHaveLength(0);
  });

  it('常時聴取: 呼ばれたら返事をする(用件は呼びかけを外した部分)', async () => {
    const events: TsukuyomiEvent[] = [];
    const m = manager('つくよみ、明日の予定は?', events);
    const r = await m.transcribeAndExtract(Buffer.alloc(44), 'ears');
    expect(r.reply).toBe('[]'); // 偽プロバイダの返事がそのまま来る(中身は問わない)
    expect(events.filter((e) => e.type === 'speak')).toHaveLength(1);
  });
});
