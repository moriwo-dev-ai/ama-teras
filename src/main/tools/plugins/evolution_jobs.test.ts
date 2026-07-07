import { describe, expect, it } from 'vitest';
import evolutionJobs from './evolution_jobs';
import type { ToolContext } from '../types';
import type { EvolutionJobSummary } from '../../../shared/types';

function ctx(list?: () => EvolutionJobSummary[]): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    log: () => {},
    ...(list ? { evolution: { requestCapability: async () => ({ jobId: 0 }), list } } : {}),
  };
}

const failed: EvolutionJobSummary = {
  id: 6,
  description: 'ヘッドレスブラウザで\nスクショを撮るツール',
  status: 'failed',
  scope: 'tool',
  log: ['B環境を作成: /tmp/wt', 'ゲート不合格のため再生成', '検証ゲート不合格'],
  gates: [
    { name: 'typecheck', ok: true, detail: 'OK' },
    { name: 'smoke', ok: false, detail: 'processes 未注入' },
  ],
  error: '検証ゲート不合格(再生成でも解消せず)',
};

const done: EvolutionJobSummary = {
  id: 7,
  description: 'HTTPスクショ',
  status: 'done',
  scope: 'tool',
  toolName: 'http_screenshot',
  log: ['昇格完了: evolve/7'],
  gates: [{ name: 'smoke', ok: true, detail: 'OK' }],
};

describe('evolution_jobs(M24: 進化パイプラインの内部ログ確認)', () => {
  it('id 省略で全ジョブの一覧を返す(状態・失敗ゲート付き)', async () => {
    const r = await evolutionJobs.execute({}, ctx(() => [done, failed]));
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('6 | failed | tool | - | smoke |');
    expect(r.content).toContain('7 | done | tool | http_screenshot | - |');
    // 説明は1行に畳まれている(改行が残らない)
    expect(r.content.split('\n').filter((l) => l.startsWith('6 |'))).toHaveLength(1);
  });

  it('id 指定でゲート詳細とログ末尾を返す', async () => {
    const r = await evolutionJobs.execute({ id: 6 }, ctx(() => [failed]));
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('進化ジョブ #6');
    expect(r.content).toContain('[不合格] smoke: processes 未注入');
    expect(r.content).toContain('[合格] typecheck: OK');
    expect(r.content).toContain('error: 検証ゲート不合格');
    expect(r.content).toContain('検証ゲート不合格');
  });

  it('logTail でログ表示を末尾N行に絞る', async () => {
    const r = await evolutionJobs.execute({ id: 6, logTail: 1 }, ctx(() => [failed]));
    expect(r.content).toContain('末尾1行を表示');
    expect(r.content).toContain('検証ゲート不合格');
    expect(r.content).not.toContain('B環境を作成');
  });

  it('存在しないIDは既知IDを添えてエラー', async () => {
    const r = await evolutionJobs.execute({ id: 99 }, ctx(() => [done, failed]));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('#99');
    expect(r.content).toContain('6, 7');
  });

  it('ジョブが無ければ案内メッセージ(エラーではない)', async () => {
    const r = await evolutionJobs.execute({}, ctx(() => []));
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('進化ジョブはありません');
  });

  it('evolution.list 未注入ならエラー', async () => {
    const r = await evolutionJobs.execute({}, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('未注入');
  });

  it('数値でない入力はエラー', async () => {
    const r = await evolutionJobs.execute({ id: 'x' }, ctx(() => []));
    expect(r.isError).toBe(true);
  });
});
