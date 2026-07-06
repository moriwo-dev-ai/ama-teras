import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M19 guardrail: 品質レビュー・ゲートは進化ジョブへ波及しない。
 * 進化ジョブの品質保証は既存の4ゲート(typecheck/vitest/smoke/差分検査)が担い、
 * reviewGate はメイン会話(chatSend)専用。ソースレベルで参照が無いことを固定する。
 */

const evolutionDir = fileURLToPath(new URL('.', import.meta.url));

describe('guardrail: reviewGate の進化ジョブ非波及(M19)', () => {
  it('src/main/evolution/ は reviewGate / runReviewGate / review/gate を参照しない', () => {
    const files = readdirSync(evolutionDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(evolutionDir, f), 'utf8');
      for (const banned of ['reviewGate', 'runReviewGate', "review/gate", 'runReviewCycle']) {
        expect(src, `${f} が ${banned} を参照している`).not.toContain(banned);
      }
    }
  });

  it('レビュー・ゲートの発動箇所は service.ts の chatSend 系のみ', () => {
    const serviceSrc = readFileSync(
      fileURLToPath(new URL('../core/service.ts', import.meta.url)),
      'utf8',
    );
    // runReviewGate の呼び出しは2箇所(マイルストーン発動+完了時縮退)だけ
    const calls = serviceSrc.match(/this\.runReviewGate\(/g) ?? [];
    expect(calls.length).toBe(2);
  });
});
