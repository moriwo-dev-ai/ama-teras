import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ChoEntry, TsukuyomiEvent } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import {
  choContext,
  CONVERSATION_SYSTEM,
  converse,
  MAX_REPLY_CHARS,
  trimReply,
} from './conversation';
import { TsukuyomiManager } from './manager';

/**
 * M43-1(TUKU-yomi): 会話。
 * ここで固定するのは「作話させない」「短く返す」「会話OFFなら返事しない」の3点。
 * 記憶の義手が推測で予定を作り始めたら、道具として終わる。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-talk-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeProvider(reply: string, seen?: { system?: string }): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(req): AsyncGenerator<ProviderEvent> {
      if (seen !== undefined) seen.system = req.system;
      yield { type: 'text_delta', text: reply };
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [] },
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0 },
      };
    },
  };
}

const entry = (over: Partial<ChoEntry>): ChoEntry =>
  ({
    id: '1',
    ts: '2026-07-12T10:00:00.000Z',
    kind: 'promise',
    text: '明日13時にレビュー',
    source: 'voice',
    ...over,
  }) as ChoEntry;

describe('M43-1(TUKU-yomi) 会話: 作話させない・短く返す', () => {
  it('人格プロンプトが「帳に無いことは知らないと言う」を課している', () => {
    expect(CONVERSATION_SYSTEM).toContain('帳に無いことは「記録にありません」と言う');
    expect(CONVERSATION_SYSTEM).toContain('推測で予定や約束を作らない');
    expect(CONVERSATION_SYSTEM).toContain('他人の人物評・感想は言わない');
    expect(CONVERSATION_SYSTEM).toContain('1〜2文で返す');
  });

  it('帳を文脈として渡す(答えの根拠は承認済みの記録だけ)', async () => {
    const seen: { system?: string } = {};
    await converse('明日の予定は?', {
      provider: fakeProvider('明日13時にレビューの約束があります。', seen),
      entries: [entry({ text: '明日13時にレビュー', due: '2026-07-13T13:00' })],
    });
    expect(seen.system).toContain('明日13時にレビュー');
    expect(seen.system).toContain('[期日 2026-07-13T13:00]');
  });

  it('帳が空なら、空だと分かる文脈を渡す(何か知っているふりをさせない)', () => {
    expect(choContext([])).toContain('月の帳は空です');
  });

  it('長い返事は文の切れ目で切る(音声で聞くので長文は苦痛)', () => {
    const long = `${'あ'.repeat(100)}。${'い'.repeat(100)}。`;
    const cut = trimReply(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(cut.endsWith('。')).toBe(true);
  });

  it('会話OFFなら返事しない(耳だけ使う人の邪魔をしない)', async () => {
    const spoken: TsukuyomiEvent[] = [];
    const m = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () =>
        ({
          tsukuyomi: { enabled: true, ears: true, voiceOutput: true, sttMode: 'cloud' },
        }) as AppConfig,
      hasOwnerKey: () => true,
      emit: (e) => spoken.push(e),
      visionProvider: () => fakeProvider('[]'),
      cloudStt: () => vi.fn(async () => '明日の予定は?'),
    });
    const r = await m.transcribeAndExtract(Buffer.alloc(44));
    expect(r.reply).toBeUndefined();
    expect(spoken.filter((e) => e.type === 'speak')).toHaveLength(0);
  });

  it('会話ONなら声で返す。**割り込み予算は使わない**(本人が話しかけたから)', async () => {
    const spoken: TsukuyomiEvent[] = [];
    const m = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () =>
        ({
          tsukuyomi: {
            enabled: true,
            ears: true,
            voiceOutput: true,
            conversation: true,
            sttMode: 'cloud',
            interruptBudgetPerDay: 0, // 予算ゼロでも会話は返る
          },
        }) as AppConfig,
      hasOwnerKey: () => true,
      emit: (e) => spoken.push(e),
      visionProvider: () => fakeProvider('明日13時にレビューの約束があります。'),
      cloudStt: () => vi.fn(async () => '明日の予定は?'),
    });

    const r = await m.transcribeAndExtract(Buffer.alloc(44));
    expect(r.reply).toBe('明日13時にレビューの約束があります。');
    expect(spoken.filter((e) => e.type === 'speak')).toHaveLength(1);
    expect(m.status().interruptsLeft).toBe(0); // 予算は減らない(元から0)
  });
});
