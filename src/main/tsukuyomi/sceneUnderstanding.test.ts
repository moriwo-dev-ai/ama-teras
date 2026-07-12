import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { TsukuyomiManager } from './manager';
import { isUsefulObservation, SCENE_PROMPT, trimObservation, understandScene } from './sceneUnderstanding';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-scene-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 送られた内容を記録するダミープロバイダ(実APIは叩かない) */
function fakeProvider(reply: string): { provider: LLMProvider; sent: unknown[] } {
  const sent: unknown[] = [];
  const provider: LLMProvider = {
    id: 'anthropic',
    async *complete(req): AsyncGenerator<ProviderEvent> {
      sent.push(req);
      yield { type: 'text_delta', text: reply };
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [] },
        stopReason: 'end_turn',
        usage: { inputTokens: 800, outputTokens: 20, cacheReadTokens: 0 },
      };
    },
  };
  return { provider, sent };
}

describe('M42-4(TUKU-yomi) 目②: 映像理解のプロンプト(他人をジャッジしない)', () => {
  it('人物の評価・容姿・感情の推測を禁じ、本人以外は記述させない(鉄則1)', () => {
    expect(SCENE_PROMPT).toContain('人物の評価・容姿・服装・感情の推測は書かない');
    expect(SCENE_PROMPT).toContain('本人以外の人物が映っていても、その人については何も書かない');
    expect(SCENE_PROMPT).toContain('不明');
  });

  it('帳に入るのは一文だけ。長文は切る。空・拒否・「不明」は入れない', () => {
    expect(trimObservation('- 机でノートPCに向かって作業している\n(他の行)')).toBe('机でノートPCに向かって作業している');
    expect(trimObservation('あ'.repeat(80))).toHaveLength(61); // 60文字+…
    expect(isUsefulObservation('不明')).toBe(false);
    expect(isUsefulObservation('')).toBe(false);
    expect(isUsefulObservation('すみません、お答えできません')).toBe(false);
    expect(isUsefulObservation('机で作業している')).toBe(true);
  });

  it('送るのは1枚の画像+プロンプトだけ(映像も他のフレームも送らない)', async () => {
    const { provider, sent } = fakeProvider('机でノートPCに向かって作業している');
    const onUsage = vi.fn();
    const result = await understandScene('BASE64JPEG', { provider, onUsage });

    expect(result.text).toBe('机でノートPCに向かって作業している');
    const req = sent[0] as { messages: { content: { type: string }[] }[] };
    const blocks = req.messages[0]?.content ?? [];
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(1); // 1枚だけ
    expect(blocks.filter((b) => b.type === 'text')).toHaveLength(1);
    expect(onUsage).toHaveBeenCalledWith(800, 20); // usage集計へ
  });
});

describe('M42-4(TUKU-yomi) 目②: 上限と保存しないこと', () => {
  const make = (over: Record<string, unknown> = {}, reply = '机で作業している') => {
    const { provider, sent } = fakeProvider(reply);
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () =>
        ({
          tsukuyomi: { enabled: true, camera: true, cameraUnderstanding: true, framesPerHour: 2, framesPerDay: 3, ...over },
        }) as AppConfig,
      hasOwnerKey: () => true,
      emit: () => {},
      visionProvider: () => provider,
      nowFn: () => new Date('2026-07-12T12:00:00'),
    });
    return { manager, sent };
  };

  it('上限に達したら送らない(理解を止めるだけ。在席検知は続く)', async () => {
    const { manager, sent } = make();
    expect(await manager.understandFrame('A')).toBe('机で作業している');
    expect(await manager.understandFrame('B')).toBe('机で作業している');
    // 1時間2枚の上限に到達 → 3枚目は送らない
    expect(await manager.understandFrame('C')).toBeNull();
    expect(sent).toHaveLength(2);

    // 在席検知(ローカル)は上限と無関係に続く
    manager.onPresence('away', '12:30 離席');
    expect(manager.list().some((e) => e.text === '12:30 離席')).toBe(true);
  });

  it('理解トグルがOFFなら1枚も送らない(カメラONでも)', async () => {
    const { manager, sent } = make({ cameraUnderstanding: false });
    expect(await manager.understandFrame('A')).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('理解結果は observation として帳へ。画像はどこにも保存しない', async () => {
    const { manager } = make();
    await manager.understandFrame('BASE64');
    const entries = manager.list();
    expect(entries[0]).toMatchObject({ kind: 'observation', source: 'camera', text: '机で作業している' });

    // userData/tsukuyomi に画像ファイルが1つも無いこと(帳と状態だけ)
    const files = readdirSync(join(dir, 'tsukuyomi'));
    expect(files.every((f) => f.endsWith('.jsonl') || f.endsWith('.json'))).toBe(true);
  });

  it('「不明」や拒否応答は帳に入れない(ゴミを覚えない)', async () => {
    const { manager } = make({}, '不明');
    expect(await manager.understandFrame('A')).toBeNull();
    expect(manager.list()).toHaveLength(0);
  });
});
