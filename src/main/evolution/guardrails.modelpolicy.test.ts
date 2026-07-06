import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M18 guardrail: modelPolicy(役割ベースのモデル自動切替)は進化ジョブへ波及しない。
 * 進化ジョブのプロバイダは createProviderOrThrow → createProvider(従来の cfg.provider/model)
 * であり、帯選択(bandLLM/createBandProvider)はメイン会話・サブエージェント専用。
 * ソースレベルで参照が無いことを固定する(service.modelpolicy.test.ts の動作テストと対)
 */

const evolutionDir = fileURLToPath(new URL('.', import.meta.url));

describe('guardrail: modelPolicy の進化ジョブ非波及(M18)', () => {
  it('src/main/evolution/ は modelPolicy / bandLLM / createBandProvider を参照しない', () => {
    const files = readdirSync(evolutionDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(evolutionDir, f), 'utf8');
      for (const banned of ['modelPolicy', 'bandLLM', 'createBandProvider', 'BandProvider']) {
        expect(src, `${f} が ${banned} を参照している`).not.toContain(banned);
      }
    }
  });

  it('createProvider(進化ジョブの経路)は modelPolicy を参照しない(帯選択は chatSend 側)', () => {
    const serviceSrc = readFileSync(
      fileURLToPath(new URL('../core/service.ts', import.meta.url)),
      'utf8',
    );
    const createProviderBody = serviceSrc.slice(
      serviceSrc.indexOf('createProvider(): LLMProvider | string {'),
      serviceSrc.indexOf('// ---- M18: モデル自動切替'),
    );
    expect(createProviderBody).not.toContain('modelPolicy');
    expect(createProviderBody).not.toContain('bandLLM');
  });
});
