import { describe, expect, it, vi } from 'vitest';
import requestCapability from './request_capability';
import type { ToolContext } from '../types';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

const input = { description: 'CSVをMarkdownに', expected_io: '{"csv":"a,b"} -> "| a | b |"' };

describe('request_capability(指摘#10 の契約)', () => {
  it('ctx.evolution があれば進化ジョブを起動しjobIdを返す(scope省略=tool)', async () => {
    const requestCapabilityFn = vi.fn(async () => ({ jobId: 7 }));
    const r = await requestCapability.execute(input, ctx({ evolution: { requestCapability: requestCapabilityFn } }));
    expect(requestCapabilityFn).toHaveBeenCalledWith(input.description, input.expected_io, 'tool');
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('#7');
  });

  it('M20: scope renderer/core はそのまま渡り、応答に人間承認+再起動の注意が入る。不正scopeはエラー', async () => {
    const requestCapabilityFn = vi.fn(async () => ({ jobId: 8 }));
    const r = await requestCapability.execute(
      { ...input, scope: 'renderer' },
      ctx({ evolution: { requestCapability: requestCapabilityFn } }),
    );
    expect(requestCapabilityFn).toHaveBeenCalledWith(input.description, input.expected_io, 'renderer');
    expect(r.content).toContain('二段確認');

    const bad = await requestCapability.execute(
      { ...input, scope: 'everything' },
      ctx({ evolution: { requestCapability: requestCapabilityFn } }),
    );
    expect(bad.isError).toBe(true);
  });

  // ctx.evolution が注入されないと失敗する = ipc の全実行経路で注入が必要(デバッグパネル含む)
  it('ctx.evolution が無いとエラーになる', async () => {
    const r = await requestCapability.execute(input, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('進化ジョブを起動できない');
  });

  it('引数が文字列でなければエラー', async () => {
    const r = await requestCapability.execute({ description: 1, expected_io: 2 }, ctx({ evolution: { requestCapability: vi.fn() } }));
    expect(r.isError).toBe(true);
  });
});
