import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, EvolutionEvent } from '../../shared/types';
import { EventBus } from '../core/events';
import { AgentService, type EvolutionHooks } from '../core/service';

/**
 * M20【不変条件3・ユーザー確定】: 進化の昇格承認は、M17自律モードON中でも
 * 絶対に自動化されない(常に人間のUI操作 evolutionPromoteRespond でのみ解決される)。
 */

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: true, exec: true },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

function makeService(): { svc: AgentService; bus: EventBus; hooks: () => EvolutionHooks } {
  const bus = new EventBus();
  let hooks: EvolutionHooks | null = null;
  const svc = new AgentService({
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(BASE_CONFIG) },
    secrets: { get: () => 'key' },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: (h) => {
      hooks = h;
      return { list: () => [], enqueue: vi.fn(async () => 1) };
    },
  });
  return {
    svc,
    bus,
    hooks: () => {
      if (!hooks) throw new Error('createEvolution が呼ばれていない');
      return hooks;
    },
  };
}

describe('【不変条件3】自律モードでも昇格承認は自動化されない', () => {
  it('自律モードON中も promotion 承認は人間の respond まで未解決(自動allowされない)', async () => {
    const { svc, bus, hooks } = makeService();
    const events: EvolutionEvent[] = [];
    bus.subscribe('evolution:event', (e) => events.push(e));

    // M17自律モード + autoApprove全ON(=最も自動化された状態)にする
    svc.setAutonomous(true);
    expect(svc.getAutonomous()).toBe(true);

    let resolved: boolean | null = null;
    const approval = hooks()
      .requestPromotionApproval(
        { id: 7, description: 'core変更', status: 'awaiting_promotion', log: [], gates: [], scope: 'core', requiresRestart: true },
        'diff --git ...',
        ['警告'],
      )
      .then((v) => (resolved = v));

    // 承認要求イベントは出るが、自動では解決されない
    await new Promise((r) => setTimeout(r, 100));
    expect(resolved).toBeNull();
    const req = events.find((e) => e.kind === 'promotion_request');
    expect(req).toMatchObject({ kind: 'promotion_request', jobId: 7, scope: 'core', requiresRestart: true });
    expect(svc.getPendingPromotionRequests()).toHaveLength(1);

    // 人間のUI操作(evolutionPromoteRespond)でのみ解決される
    svc.evolutionPromoteRespond(7, true);
    await approval;
    expect(resolved).toBe(true);
  });

  it('ソース・トリップワイヤ: 昇格承認フローは autonomousMode を参照しない', () => {
    // M29-5(NIGHT_TASKS4 T5・ユーザー指示)で契約を更新: 唯一の無人承認は
    // 「実行開始時の包括承認で事前登録された仮導入」のみ(scope=tool+危険警告ゼロ)。
    // それでも autonomousMode / getAutonomous をこのブロックが直接参照しないことは不変
    // (自律モードそのものを理由に承認を自動化する経路の禁止)
    const src = readFileSync(fileURLToPath(new URL('../core/service.ts', import.meta.url)), 'utf8');
    const start = src.indexOf('requestPromotionApproval: (job, diff, warnings)');
    const end = src.indexOf('onEvent: (e) =>', start);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = src.slice(start, end);
    expect(block).not.toContain('autonomousMode');
    expect(block).not.toContain('getAutonomous');
    // 契約更新の経緯と条件がコメントに明記されている
    expect(src).toContain('自律モード(autonomousMode)そのものでは絶対に自動化しない');
    expect(src).toContain('M29-5');
    // 仮導入の全条件ガード(登録済み+tool+危険警告ゼロ+toolName確定)がソースに存在する
    expect(block).toContain("(job.scope ?? 'tool') === 'tool'");
    expect(block).toContain('warnings.length === 0');
  });

  it('ソース・トリップワイヤ: executor の自律モード自動承認は broker 経由の承認のみで、昇格(pendingPromotions)には触れない', () => {
    const executorSrc = readFileSync(
      fileURLToPath(new URL('../tools/executor.ts', import.meta.url)),
      'utf8',
    );
    expect(executorSrc).not.toContain('promotion');
    expect(executorSrc).not.toContain('Promotion');
  });
});
