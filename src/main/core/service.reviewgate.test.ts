import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig, ReviewGateConfig } from '../../shared/types';
import type { ScopeAuditEvent } from '../tools/executor';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolPlugin } from '../tools/types';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps } from './service';

/**
 * M19: レビュー・ゲートの service 配線を固定する。
 * メイン・レビュアーは同一プロバイダ(応答キュー)で順番に消費される:
 * [メインturn1(plan書き込み)] → [レビュー応答…] → [メインturn2(完了)]
 */

// M26-1: この配線テスト群は severity 無しの findings を使うため、従来動作の score 方式に固定する
// (severity 方式の合否ロジック自体は gate.test.ts 側で担保)
const REVIEW_ON: ReviewGateConfig = {
  enabled: true,
  passMode: 'score',
  threshold: 4.0,
  maxRoundsPerMilestone: 2,
  axes: { code: true, ux: true, requirements: true, tests: true },
};

function queuedProvider(responses: ProviderEvent[][]): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id: 'anthropic',
    requests,
    async *complete(req: CompletionRequest) {
      requests.push({ ...req, messages: [...req.messages] });
      const next = responses.shift();
      if (!next) throw new Error('モック応答が尽きた');
      yield* next;
    },
  };
}

const text = (t: string): ProviderEvent[] => [
  {
    type: 'message_done',
    message: { role: 'assistant', content: [{ type: 'text', text: t }] },
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
  },
];

const toolUse = (id: string, name: string, input: unknown): ProviderEvent[] => [
  {
    type: 'message_done',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    stopReason: 'tool_use',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
  },
];

const reviewJson = (avg: { code: number; req: number; tests: number }, findings = 0): string => {
  const list = Array.from({ length: findings }, (_, i) => ({
    file: `f${i}.mjs`,
    location: `loc${i}`,
    problem: `problem${i}`,
    fix: `fix${i}`,
  }));
  return `\`\`\`json\n${JSON.stringify({
    scores: { code: avg.code, ux: null, requirements: avg.req, tests: avg.tests },
    findings: list,
    summary: 'summary',
  })}\n\`\`\``;
};

let ws: string;

/** plan / write ツール(実ファイルに書く。planはAMATERAS_PLAN.md固定) */
function plugins(): ToolPlugin[] {
  return [
    {
      name: 'plan',
      description: 'plan',
      inputSchema: { type: 'object', properties: {} },
      risk: 'safe',
      execute: async (input) => {
        const { content } = (input ?? {}) as { content?: string };
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(ws, 'AMATERAS_PLAN.md'), content ?? '', 'utf8');
        return { content: '計画を更新した' };
      },
    },
    {
      name: 'read_file',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      risk: 'safe',
      execute: async () => ({ content: 'file content' }),
    },
    {
      name: 'fake_write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      risk: 'write',
      execute: async () => ({ content: 'written' }),
    },
    {
      // M26-2: コア領域検知テスト用(pathParams宣言つき書き込みツール)
      name: 'core_write',
      description: 'write with path',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      risk: 'write',
      pathParams: ['path'],
      execute: async () => ({ content: 'written' }),
    },
  ];
}

function makeService(opts: {
  main: LLMProvider;
  worker?: LLMProvider;
  /** M26-2: reviewer帯のプロバイダ。指定時は modelPolicy に reviewer 帯が入る */
  reviewer?: LLMProvider;
  reviewGate?: ReviewGateConfig;
}): { svc: AgentService; bus: EventBus; events: AgentEvent[]; audits: ScopeAuditEvent[] } {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  const audits: ScopeAuditEvent[] = [];
  bus.subscribe('chat:event', (e) => events.push(e));
  const usePolicy = opts.worker !== undefined || opts.reviewer !== undefined;
  const config: AppConfig = {
    autoApprove: { safe: true, write: true, exec: true },
    provider: 'anthropic',
    model: '',
    scopeMode: 'project',
    workspace: ws,
    ...(opts.reviewGate !== undefined ? { reviewGate: opts.reviewGate } : {}),
    ...(usePolicy
      ? {
          modelPolicy: {
            enabled: true,
            planner: { provider: 'anthropic' as const, model: 'planner-m' },
            worker: { provider: 'anthropic' as const, model: 'worker-m' },
            ...(opts.reviewer
              ? { reviewer: { provider: 'anthropic' as const, model: 'reviewer-m' } }
              : {}),
            maxEscalationsPerTask: 0,
          },
        }
      : {}),
  };
  const reg = plugins();
  const svc = new AgentService({
    bus,
    registry: {
      list: () => reg,
      get: (n) => reg.find((p) => p.name === n),
      reload: async () => {},
      errors: [],
    },
    config: { get: () => structuredClone(config) },
    secrets: { get: () => 'key' },
    audit: { append: (e) => audits.push(e) },
    defaultWorkspace: () => ws,
    denyPaths: { userDataDir: join(ws, '..', 'x-userdata'), repoGitDir: join(ws, '..', 'x-git') },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    ...(usePolicy
      ? {
          bandProviderFactory: ((band: string) =>
            band === 'worker' && opts.worker
              ? opts.worker
              : band === 'reviewer' && opts.reviewer
                ? opts.reviewer
                : opts.main) as AgentServiceDeps['bandProviderFactory'],
        }
      : { providerFactory: () => opts.main }),
  } as AgentServiceDeps);
  return { svc, bus, events, audits };
}

function waitForTerminal(bus: EventBus): Promise<void> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe('chat:event', (e) => {
      if (e.kind === 'status' && ['done', 'error', 'cancelled', 'max_turns_reached'].includes(e.status)) {
        unsub();
        resolve();
      }
    });
  });
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'amateras-review-'));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => {});
});

describe('M19: レビュー・ゲート(service配線)', () => {
  it('無効(未設定)なら plan完了でもレビューは走らない(従来挙動)', async () => {
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] A' }),
      text('done'),
    ]);
    const { svc, bus, events } = makeService({ main });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    expect(events.some((e) => e.kind === 'review')).toBe(false);
    expect(main.requests).toHaveLength(2); // レビュー分の消費なし
  });

  it('マイルストーン完了で発動: 高スコア→合格カード+tool_resultに追記+audit', async () => {
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] A\n- [ ] B' }),
      reviewJson({ code: 5, req: 5, tests: 4 }).split('\n').length > 0
        ? text(reviewJson({ code: 5, req: 5, tests: 4 }))
        : text(''),
      text('完了'),
    ]);
    const { svc, bus, events, audits } = makeService({ main, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    const review = events.find((e) => e.kind === 'review');
    expect(review).toMatchObject({ kind: 'review', pass: true, round: 0, milestone: 'A' });
    // メインループへの tool_result に合否が追記されている(3リクエスト目のmessages内)
    const lastReq = main.requests[2]!;
    expect(JSON.stringify(lastReq.messages)).toContain('[品質レビュー] 合格');
    expect(audits.filter((a) => a.tool === 'review-gate')).toHaveLength(1);
  });

  it('不合格→worker帯でfix→再レビュー合格(差し戻し1回)', async () => {
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] A' }),
      text(reviewJson({ code: 3, req: 3, tests: 3 }, 2)), // 初回レビュー不合格
      text(reviewJson({ code: 5, req: 4, tests: 4 })), // 再レビュー合格
      text('完了'),
    ]);
    const worker = queuedProvider([text('指摘を修正した')]);
    const { svc, bus, events } = makeService({ main, worker, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    const reviews = events.filter((e) => e.kind === 'review');
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ pass: false, round: 0 });
    expect(reviews[1]).toMatchObject({ pass: true, round: 1 });
    expect(worker.requests).toHaveLength(1); // fixはworker帯で1回
    expect(JSON.stringify(worker.requests[0]!.messages)).toContain('problem0'); // 指摘が渡っている
    expect(JSON.stringify(main.requests[3]!.messages)).toContain('差し戻し1回で改善');
  });

  it('上限到達でも不合格: 自律OFF→承認要求が出て、allowで続行', async () => {
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] A' }),
      text(reviewJson({ code: 2, req: 2, tests: 2 }, 1)),
      text(reviewJson({ code: 2, req: 2, tests: 2 }, 1)),
      text(reviewJson({ code: 2, req: 2, tests: 2 }, 1)),
      text('完了'),
    ]);
    const worker = queuedProvider([text('fix1'), text('fix2')]);
    const { svc, bus, events } = makeService({ main, worker, reviewGate: REVIEW_ON });
    bus.subscribe('approval:request', (req) => {
      expect(req.toolName).toBe('review-gate');
      svc.approvalRespond(req.id, 'allow');
    });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    const reviews = events.filter((e) => e.kind === 'review');
    // 3回のレビューカード + 未解決の再掲(unresolved:true)
    expect(reviews).toHaveLength(4);
    expect(reviews[reviews.length - 1]).toMatchObject({ unresolved: true });
    expect(worker.requests).toHaveLength(2); // maxRounds=2
    expect(
      events.some((e) => e.kind === 'info' && e.message.includes('残課題を許容して続行')),
    ).toBe(true);
    expect(JSON.stringify(main.requests[4]!.messages)).toContain('上限到達・残課題');
  });

  it('自律モードONなら承認要求なしで警告infoのみ', async () => {
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] A' }),
      text(reviewJson({ code: 2, req: 2, tests: 2 }, 1)),
      text(reviewJson({ code: 2, req: 2, tests: 2 }, 1)),
      text(reviewJson({ code: 2, req: 2, tests: 2 }, 1)),
      text('完了'),
    ]);
    const worker = queuedProvider([text('fix1'), text('fix2')]);
    const { svc, bus, events } = makeService({ main, worker, reviewGate: REVIEW_ON });
    let approvalRequested = false;
    bus.subscribe('approval:request', () => {
      approvalRequested = true;
    });
    svc.setAutonomous(true);
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    expect(approvalRequested).toBe(false);
    expect(
      events.some((e) => e.kind === 'info' && e.message.includes('許容して続行します(自律モード)')),
    ).toBe(true);
  });

  it('計画未使用の短いタスクは完了時に1回だけ縮退レビュー(write成功あり)', async () => {
    const main = queuedProvider([
      toolUse('t1', 'fake_write', {}),
      text('書いた'),
      text(reviewJson({ code: 5, req: 5, tests: 5 })), // 完了時レビュー
    ]);
    const { svc, bus, events } = makeService({ main, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    // terminal(done)後にレビューが走る — reviewイベントを少し待つ
    await new Promise((r) => setTimeout(r, 100));
    const reviews = events.filter((e) => e.kind === 'review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ milestone: '完成時レビュー', pass: true });
  });

  it('成果物なし(読み取りのみ)の会話では完了時レビューも走らない', async () => {
    const main = queuedProvider([toolUse('t1', 'read_file', {}), text('読んだだけ')]);
    const { svc, bus, events } = makeService({ main, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    await new Promise((r) => setTimeout(r, 100));
    expect(events.some((e) => e.kind === 'review')).toBe(false);
    expect(main.requests).toHaveLength(2);
  });

  it('レビュアーがJSONを出せなかったら素通し+警告info', async () => {
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] A' }),
      text('JSONなしの応答'),
      text('完了'),
    ]);
    const { svc, bus, events } = makeService({ main, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    expect(events.some((e) => e.kind === 'review')).toBe(false);
    expect(
      events.some((e) => e.kind === 'info' && e.message.includes('素通しで続行')),
    ).toBe(true);
    expect(JSON.stringify(main.requests[2]!.messages)).toContain('レビュー実行失敗');
  });

  it('M26-2: 途中マイルストーン(未完了項目が残る)のレビューは reviewer 帯で走る', async () => {
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] A\n- [ ] B' }),
      text('完了'),
    ]);
    const reviewer = queuedProvider([text(reviewJson({ code: 5, req: 5, tests: 5 }))]);
    const { svc, bus, events } = makeService({ main, reviewer, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    expect(events.find((e) => e.kind === 'review')).toMatchObject({ pass: true, milestone: 'A' });
    expect(reviewer.requests).toHaveLength(1); // レビューは reviewer 帯
    expect(main.requests).toHaveLength(2); // メインはレビューを消費しない
  });

  it('M26-2: 最終マイルストーン(未完了項目なし)のレビューは reviewer 指定があっても planner 帯', async () => {
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] A' }),
      text(reviewJson({ code: 5, req: 5, tests: 5 })), // planner(=main)がレビューを消費
      text('完了'),
    ]);
    const reviewer = queuedProvider([]);
    const { svc, bus, events } = makeService({ main, reviewer, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    expect(events.some((e) => e.kind === 'review')).toBe(true);
    expect(reviewer.requests).toHaveLength(0);
    expect(main.requests).toHaveLength(3);
  });

  it('M26-2: コア領域(聖域)への書き込みがあったランは、途中マイルストーンでも planner 帯でレビュー', async () => {
    const main = queuedProvider([
      toolUse('t1', 'core_write', { path: 'src/main/ipc.ts' }),
      toolUse('t2', 'plan', { action: 'write', content: '- [x] A\n- [ ] B' }),
      text(reviewJson({ code: 5, req: 5, tests: 5 })), // planner(=main)がレビューを消費
      text('完了'),
    ]);
    const reviewer = queuedProvider([]);
    const { svc, bus, events } = makeService({ main, reviewer, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    expect(events.some((e) => e.kind === 'review')).toBe(true);
    expect(reviewer.requests).toHaveLength(0); // コア領域に触れたので reviewer 帯は使わない
  });

  it('M26-2: 完成時レビュー(縮退モード)は planner 帯で実施する', async () => {
    const main = queuedProvider([
      toolUse('t1', 'fake_write', {}),
      text('書いた'),
      text(reviewJson({ code: 5, req: 5, tests: 5 })), // planner(=main)が完了時レビューを消費
    ]);
    const reviewer = queuedProvider([]);
    const { svc, bus, events } = makeService({ main, reviewer, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    await new Promise((r) => setTimeout(r, 100));
    expect(events.filter((e) => e.kind === 'review')).toHaveLength(1);
    expect(reviewer.requests).toHaveLength(0);
  });

  it('計画に既存の完了項目があっても、新規完了だけがマイルストーンになる', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(ws, 'AMATERAS_PLAN.md'), '- [x] 既存\n- [ ] B', 'utf8');
    const main = queuedProvider([
      toolUse('t1', 'plan', { action: 'write', content: '- [x] 既存\n- [x] B' }),
      text(reviewJson({ code: 5, req: 5, tests: 5 })),
      text('完了'),
    ]);
    const { svc, bus, events } = makeService({ main, reviewGate: REVIEW_ON });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    const review = events.find((e) => e.kind === 'review');
    expect(review).toMatchObject({ milestone: 'B' });
  });
});
