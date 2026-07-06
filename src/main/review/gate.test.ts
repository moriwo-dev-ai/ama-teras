import { describe, expect, it, vi } from 'vitest';
import type { ReviewCardPayload, ReviewGateConfig } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolPlugin } from '../tools/types';
import {
  averageScore,
  buildFixTask,
  parseReviewOutput,
  runReviewCycle,
  runReviewer,
} from './gate';

const AXES_ALL = { code: true, ux: true, requirements: true, tests: true };

const CONFIG: ReviewGateConfig = {
  enabled: true,
  threshold: 4.0,
  maxRoundsPerMilestone: 2,
  axes: AXES_ALL,
};

function card(overrides: Partial<ReviewCardPayload>): ReviewCardPayload {
  return {
    milestone: 'm',
    round: 0,
    scores: { code: 4, ux: null, requirements: 4, tests: 4 },
    average: 4,
    pass: true,
    findings: [],
    summary: 's',
    ...overrides,
  };
}

describe('parseReviewOutput', () => {
  it('jsonフェンスから採点・具体指摘を取り出す(スコアは1〜5クランプ)', () => {
    const text = `確認した。\n\`\`\`json\n{"scores":{"code":9,"ux":null,"requirements":4,"tests":0.5},"findings":[{"file":"a.mjs","location":"f()","problem":"p","fix":"x"}],"summary":"総評"}\n\`\`\``;
    const r = parseReviewOutput(text, AXES_ALL)!;
    expect(r.scores).toEqual({ code: 5, ux: null, requirements: 4, tests: 1 });
    expect(r.findings).toHaveLength(1);
    expect(r.summary).toBe('総評');
  });

  it('抽象指摘(4フィールド未満)は機械的に落とす', () => {
    const text = `\`\`\`json\n{"scores":{"code":3,"ux":null,"requirements":3,"tests":3},"findings":[{"file":"a.mjs","location":"f()","problem":"具体的","fix":"直す"},{"problem":"全体的に改善が必要"},{"file":"b.mjs","location":"","problem":"p","fix":"x"}],"summary":""}\n\`\`\``;
    const r = parseReviewOutput(text, AXES_ALL)!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.file).toBe('a.mjs');
  });

  it('無効化された軸のスコアは強制null(軸OFF設定を反映)', () => {
    const text = `\`\`\`json\n{"scores":{"code":4,"ux":5,"requirements":4,"tests":4},"findings":[],"summary":""}\n\`\`\``;
    const r = parseReviewOutput(text, { ...AXES_ALL, ux: false })!;
    expect(r.scores.ux).toBeNull();
  });

  it('フェンス無しでも最後の {"scores"... から拾える。壊れたJSONはnull', () => {
    expect(
      parseReviewOutput(`前置き {"scores":{"code":4,"ux":null,"requirements":4,"tests":4},"findings":[],"summary":"ok"}`, AXES_ALL),
    ).not.toBeNull();
    expect(parseReviewOutput('JSONが無い応答', AXES_ALL)).toBeNull();
    expect(parseReviewOutput('```json\n{broken\n```', AXES_ALL)).toBeNull();
  });

  it('averageScore は非null軸の平均(全nullはnull)', () => {
    expect(averageScore({ code: 4, ux: null, requirements: 5, tests: 3 })).toBe(4);
    expect(averageScore({ code: null, ux: null, requirements: null, tests: null })).toBeNull();
  });
});

describe('runReviewCycle', () => {
  it('高スコア→そのまま通過(fixは呼ばれない)', async () => {
    const fix = vi.fn(async () => {});
    const onCard = vi.fn();
    const r = await runReviewCycle({
      config: CONFIG,
      review: async (round) => card({ round, average: 4.5, pass: true }),
      fix,
      onCard,
      signal: new AbortController().signal,
    });
    expect(r.resolved).toBe(true);
    expect(r.fixRounds).toBe(0);
    expect(fix).not.toHaveBeenCalled();
    expect(onCard).toHaveBeenCalledTimes(1);
  });

  it('低スコア→fix→再レビューで合格', async () => {
    const fix = vi.fn(async (_card: ReviewCardPayload, _round: number) => {});
    const results = [
      card({ round: 0, average: 3.0, pass: false, findings: [{ file: 'a', location: 'l', problem: 'p', fix: 'f' }] }),
      card({ round: 1, average: 4.3, pass: true }),
    ];
    const r = await runReviewCycle({
      config: CONFIG,
      review: async () => results.shift()!,
      fix,
      onCard: () => {},
      signal: new AbortController().signal,
    });
    expect(r.resolved).toBe(true);
    expect(r.fixRounds).toBe(1);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(fix.mock.calls[0]![1]).toBe(1); // round番号
  });

  it('maxRounds到達でも不合格なら resolved=false(残課題)', async () => {
    const fix = vi.fn(async () => {});
    const r = await runReviewCycle({
      config: CONFIG, // maxRounds=2
      review: async (round) => card({ round, average: 2.5, pass: false }),
      fix,
      onCard: () => {},
      signal: new AbortController().signal,
    });
    expect(r.resolved).toBe(false);
    expect(r.fixRounds).toBe(2); // 上限で停止
    expect(fix).toHaveBeenCalledTimes(2);
  });

  it('初回レビュー自体が失敗(null)→素通し扱い(reviewFailed)', async () => {
    const r = await runReviewCycle({
      config: CONFIG,
      review: async () => null,
      fix: async () => {},
      onCard: () => {},
      signal: new AbortController().signal,
    });
    expect(r).toMatchObject({ final: null, resolved: true, reviewFailed: true, fixRounds: 0 });
  });

  it('maxRounds=0 はレビューのみ(不合格でも差し戻さない)', async () => {
    const fix = vi.fn(async () => {});
    const r = await runReviewCycle({
      config: { ...CONFIG, maxRoundsPerMilestone: 0 },
      review: async (round) => card({ round, average: 2, pass: false }),
      fix,
      onCard: () => {},
      signal: new AbortController().signal,
    });
    expect(fix).not.toHaveBeenCalled();
    expect(r.resolved).toBe(false);
  });
});

describe('runReviewer(モックproviderで結合)', () => {
  function reviewerProvider(finalText: string): LLMProvider & { requests: CompletionRequest[] } {
    const requests: CompletionRequest[] = [];
    return {
      id: 'anthropic',
      requests,
      async *complete(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
        requests.push(req);
        yield {
          type: 'message_done',
          message: { role: 'assistant', content: [{ type: 'text', text: finalText }] },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        };
      },
    };
  }

  function fakeTool(name: string, risk: ToolPlugin['risk']): ToolPlugin {
    return {
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      risk,
      execute: async () => ({ content: `${name} ok` }),
    };
  }

  const TOOLS = [
    fakeTool('read_file', 'safe'),
    fakeTool('grep', 'safe'),
    fakeTool('write_file', 'write'),
    fakeTool('bash', 'exec'),
    fakeTool('screenshot', 'safe'),
  ];
  const registry = { list: () => TOOLS, get: (n: string) => TOOLS.find((t) => t.name === n) };

  it('採点JSONをカードに変換し、閾値でpass判定する', async () => {
    const provider = reviewerProvider(
      `\`\`\`json\n{"scores":{"code":3,"ux":null,"requirements":4,"tests":3},"findings":[{"file":"a","location":"l","problem":"p","fix":"f"}],"summary":"厳しめ"}\n\`\`\``,
    );
    const cardResult = await runReviewer(
      { provider, tools: registry, cwd: '/x', axes: AXES_ALL, threshold: 4.0 },
      { milestone: 'M', userRequest: 'req', planContent: '' },
      0,
      new AbortController().signal,
    );
    expect(cardResult).toMatchObject({ pass: false, round: 0, milestone: 'M' });
    expect(cardResult!.average).toBeCloseTo(3.33, 1);
    // レビュアーには読み取り専用のみ提示(write/exec は見せない)。
    // captureUrl未注入なので screenshot も除外される
    const shown = provider.requests[0]!.tools.map((t) => t.name).sort();
    expect(shown).toEqual(['grep', 'read_file']);
  });

  it('captureUrl注入+ux軸ONなら screenshot がツールに載る', async () => {
    const provider = reviewerProvider(
      `\`\`\`json\n{"scores":{"code":5,"ux":5,"requirements":5,"tests":5},"findings":[],"summary":"ok"}\n\`\`\``,
    );
    await runReviewer(
      {
        provider,
        tools: registry,
        cwd: '/x',
        axes: AXES_ALL,
        threshold: 4.0,
        captureUrl: async () => ({ data: 'x', mediaType: 'image/png' }),
      },
      { milestone: 'M', userRequest: 'req', planContent: '' },
      0,
      new AbortController().signal,
    );
    expect(provider.requests[0]!.tools.map((t) => t.name)).toContain('screenshot');
  });

  it('JSONを出さない応答は null(素通し用)', async () => {
    const provider = reviewerProvider('うーん、全体的によいと思います。');
    const r = await runReviewer(
      { provider, tools: registry, cwd: '/x', axes: AXES_ALL, threshold: 4.0 },
      { milestone: 'M', userRequest: 'req', planContent: '' },
      0,
      new AbortController().signal,
    );
    expect(r).toBeNull();
  });
});

describe('buildFixTask', () => {
  it('指摘を番号付きで具体的なまま埋め込む', () => {
    const task = buildFixTask(
      { milestone: 'API実装', userRequest: 'r', planContent: '' },
      card({
        average: 3.2,
        pass: false,
        findings: [
          { file: 'app.mjs', location: 'PUT /todos', problem: '404を返さない', fix: '存在確認を追加' },
        ],
      }),
    );
    expect(task).toContain('app.mjs(PUT /todos): 404を返さない → 修正方法: 存在確認を追加');
    expect(task).toContain('API実装');
    expect(task).toContain('3.2');
  });
});
