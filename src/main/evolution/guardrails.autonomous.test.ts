import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M17-2 guardrail: 自律モードは進化ジョブへ波及しない。
 * - 進化サブシステム(src/main/evolution/)は autonomous フラグを一切参照しない
 *   (進化ジョブのツール実行は AgentService.executorDeps() を経由しないため、
 *   参照が無い=注入経路が無い、をソースレベルで固定する)
 * - service.ts の executorDeps にだけ getAutonomous が配線されている
 */

const evolutionDir = fileURLToPath(new URL('.', import.meta.url));

describe('guardrail: 自律モードの進化ジョブ非波及(M17-2)', () => {
  it('src/main/evolution/ は getAutonomous / autonomousMode を参照しない', () => {
    const files = readdirSync(evolutionDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(evolutionDir, f), 'utf8');
      expect(src, `${f} が自律モードを参照している`).not.toContain('getAutonomous');
      expect(src, `${f} が自律モードを参照している`).not.toContain('autonomousMode');
    }
  });

  it('getAutonomous の配線は service.executorDeps(メインループ系)に限られる', () => {
    const serviceSrc = readFileSync(join(evolutionDir, '..', 'core', 'service.ts'), 'utf8');
    expect(serviceSrc).toContain('getAutonomous: () => this.autonomousMode');
    // 進化ジョブが使う AgentJobRunner の経路に自律モードの分岐が無いこと
    const jobSrc = readFileSync(join(evolutionDir, 'job.ts'), 'utf8');
    expect(jobSrc).not.toContain('autonomous');
  });
});
