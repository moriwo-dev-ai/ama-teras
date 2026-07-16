import { describe, expect, it, vi } from 'vitest';
import requestNightlyTools from './request_nightly_tools';
import type { ToolContext } from '../types';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

const tools = [
  { description: 'slugify', expected_io: '{"s":"Hello World"} -> "hello-world"' },
  { description: 'roman', expected_io: '{"n":4} -> "IV"' },
];

describe('request_nightly_tools(夜間バッチ起票)', () => {
  it('複数依頼を requestNightlyTools へ渡し、jobId 群と積み先ブランチを応答に載せる', async () => {
    const fn = vi.fn(async () => ({ jobIds: [12, 13], branch: 'evolve/nightly' }));
    const r = await requestNightlyTools.execute({ tools }, ctx({ evolution: { requestCapability: vi.fn(), requestNightlyTools: fn } }));
    expect(fn).toHaveBeenCalledWith([
      { description: 'slugify', expectedIO: '{"s":"Hello World"} -> "hello-world"' },
      { description: 'roman', expectedIO: '{"n":4} -> "IV"' },
    ]);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('#12');
    expect(r.content).toContain('#13');
    expect(r.content).toContain('evolve/nightly');
  });

  it('tools が空配列/非配列ならエラー(enqueueは呼ばない)', async () => {
    const fn = vi.fn(async () => ({ jobIds: [], branch: 'evolve/nightly' }));
    const c = ctx({ evolution: { requestCapability: vi.fn(), requestNightlyTools: fn } });
    expect((await requestNightlyTools.execute({ tools: [] }, c)).isError).toBe(true);
    expect((await requestNightlyTools.execute({ tools: 'x' }, c)).isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('各要素の description/expected_io が文字列でなければエラー', async () => {
    const fn = vi.fn(async () => ({ jobIds: [], branch: 'evolve/nightly' }));
    const r = await requestNightlyTools.execute(
      { tools: [{ description: 'ok', expected_io: 'ok' }, { description: 1, expected_io: 2 }] },
      ctx({ evolution: { requestCapability: vi.fn(), requestNightlyTools: fn } }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('tools[1]');
    expect(fn).not.toHaveBeenCalled();
  });

  it('freeMode(evolutionDisabled)では起動せず理由文を返す', async () => {
    const fn = vi.fn(async () => ({ jobIds: [1], branch: 'evolve/nightly' }));
    const reason = '無料モードでは新規生成は行えません(テスト)';
    const r = await requestNightlyTools.execute(
      { tools },
      ctx({ evolution: { requestCapability: vi.fn(), requestNightlyTools: fn }, evolutionDisabled: reason }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toBe(reason);
    expect(fn).not.toHaveBeenCalled();
  });

  it('requestNightlyTools 未注入(従来構成)ではエラーになる', async () => {
    const r = await requestNightlyTools.execute({ tools }, ctx({ evolution: { requestCapability: vi.fn() } }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('夜間自動生成を起動できない');
  });
});
