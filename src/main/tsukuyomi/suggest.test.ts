import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, TsukuyomiConfig, TsukuyomiEvent } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { TsukuyomiManager } from './manager';
import { parseSuggestion, SUGGEST_PROMPT, worthJudging } from './suggest';

/**
 * M44-2(TUKU-yomi): 気づいて提案する。
 *
 * 月読の中で**一番危ない機能**。うるさければ電源を切られて二度と点けてもらえない。
 * ここで固定するのは「黙るのが既定」「予算と静音時間を必ず通る」
 * 「LLMを呼ぶ前に足切りする(黙っているだけで課金しない)」の3点。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-sug-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeProvider(reply: string, calls?: { n: number }): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      if (calls !== undefined) calls.n++;
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
  tsu: Partial<TsukuyomiConfig>,
  said: string,
  reply: string,
  events: TsukuyomiEvent[],
  calls?: { n: number },
  nowFn?: () => Date,
): TsukuyomiManager {
  return new TsukuyomiManager({
    userDataDir: dir,
    getConfig: () =>
      ({
        tsukuyomi: {
          enabled: true,
          ears: true,
          voiceOutput: true,
          sttMode: 'cloud',
          proactive: true,
          ...tsu,
        },
      }) as AppConfig,
    hasOwnerKey: () => true,
    emit: (e) => events.push(e),
    // 抽出(常に[])と提案で同じプロバイダが使われる。提案の返事だけを見たいので両方これで返す
    visionProvider: () => fakeProvider(reply, calls),
    cloudStt: () => vi.fn(async () => said),
    ...(nowFn !== undefined ? { nowFn } : {}),
  });
}

describe('M44-2(TUKU-yomi) 気づいて提案: 黙るのが既定', () => {
  it('プロンプトが「迷ったら黙る」を課している', () => {
    expect(SUGGEST_PROMPT).toContain('迷ったら黙る');
    expect(SUGGEST_PROMPT).toContain('声をかけない方が常に安全');
    expect(SUGGEST_PROMPT).toContain('疑問形'); // 勝手にやらない(提案までで止める)
  });

  it('壊れた返事・speak:false は黙る(パースに失敗したら喋らない側へ倒す)', () => {
    expect(parseSuggestion('{"speak":false}')).toEqual({ speak: false });
    expect(parseSuggestion('壊れた')).toEqual({ speak: false });
    expect(parseSuggestion('{"speak":true}')).toEqual({ speak: false }); // say が無い
    expect(parseSuggestion('{"speak":true,"say":"13時から15時に変えますか?"}')).toEqual({
      speak: true,
      say: '13時から15時に変えますか?',
    });
  });

  it('LLMを呼ぶ前に足切りする(雑談・相槌で判定APIを叩かない)', () => {
    expect(worthJudging(['うん'])).toBe(false);
    expect(worthJudging(['今日のご飯なんだろうね、お腹すいたな'])).toBe(false);
    expect(worthJudging(['明日のレビュー、13時から15時に変えてもらえますか'])).toBe(true);
  });

  it('提案は**割り込み予算**を通る(予算ゼロなら黙る)', async () => {
    const events: TsukuyomiEvent[] = [];
    const calls = { n: 0 };
    const m = manager(
      { interruptBudgetPerDay: 0 },
      '明日のレビュー、13時から15時に変えてもらえますか',
      '{"speak":true,"say":"13時から15時に変えておきましょうか?"}',
      events,
      calls,
    );
    await m.transcribeAndExtract(Buffer.alloc(44), 'ears');
    await new Promise((r) => setTimeout(r, 30)); // 提案は裏で走る
    expect(events.filter((e) => e.type === 'speak')).toHaveLength(0);
  });

  it('静音時間なら黙る(夜中に話しかけない)', async () => {
    const events: TsukuyomiEvent[] = [];
    const night = new Date(2026, 6, 13, 2, 0, 0); // 02:00(既定の静音 23:00-07:00)
    const m = manager(
      {},
      '明日のレビュー、13時から15時に変えてもらえますか',
      '{"speak":true,"say":"13時から15時に変えておきましょうか?"}',
      events,
      undefined,
      () => night,
    );
    await m.transcribeAndExtract(Buffer.alloc(44), 'ears');
    await new Promise((r) => setTimeout(r, 30));
    expect(events.filter((e) => e.type === 'speak')).toHaveLength(0);
  });

  it('proactive がOFFなら、判定すらしない(黙っているだけで課金しない)', async () => {
    const events: TsukuyomiEvent[] = [];
    const m = manager(
      { proactive: false },
      '明日のレビュー、13時から15時に変えてもらえますか',
      '{"speak":true,"say":"変えましょうか?"}',
      events,
    );
    await m.transcribeAndExtract(Buffer.alloc(44), 'ears');
    await new Promise((r) => setTimeout(r, 30));
    expect(events.filter((e) => e.type === 'speak')).toHaveLength(0);
  });

  it('条件が揃えば向こうから話しかける(帳の予定が変わる話)', async () => {
    const events: TsukuyomiEvent[] = [];
    // 昼の時刻を渡す(実時刻に依存させない。深夜に流すと静音時間で必ず黙るため)
    const noon = new Date(2026, 6, 13, 14, 0, 0);
    const m = manager(
      {},
      '明日のレビュー、13時から15時に変えてもらえますか',
      '{"speak":true,"say":"13時から15時に変えておきましょうか?"}',
      events,
      undefined,
      () => noon,
    );
    await m.transcribeAndExtract(Buffer.alloc(44), 'ears');
    await new Promise((r) => setTimeout(r, 50));
    const spoke = events.filter((e) => e.type === 'speak');
    expect(spoke).toHaveLength(1);
    expect(spoke[0]).toMatchObject({ text: '13時から15時に変えておきましょうか?' });
    // 予算を1回使っている(自発的な割り込みなので)
    expect(m.status().interruptsLeft).toBe(4);
  });
});
