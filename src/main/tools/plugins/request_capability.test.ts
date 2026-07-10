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

  describe('M25-8: target_tool(既存ツール修正)', () => {
    it('target_toolを指定すると4引数目として渡り、応答に既存修正の注意が入る', async () => {
      const requestCapabilityFn = vi.fn(async () => ({ jobId: 9 }));
      const r = await requestCapability.execute(
        { ...input, target_tool: 'web_search' },
        ctx({ evolution: { requestCapability: requestCapabilityFn } }),
      );
      expect(requestCapabilityFn).toHaveBeenCalledWith(input.description, input.expected_io, 'tool', 'web_search');
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain('web_search');
    });

    it('target_tool省略時は従来どおり3引数のまま呼ぶ(回帰: 呼び出し引数を増やさない)', async () => {
      const requestCapabilityFn = vi.fn(async () => ({ jobId: 10 }));
      await requestCapability.execute(input, ctx({ evolution: { requestCapability: requestCapabilityFn } }));
      expect(requestCapabilityFn).toHaveBeenCalledWith(input.description, input.expected_io, 'tool');
    });

    it('target_toolが文字列でなければエラー', async () => {
      const r = await requestCapability.execute(
        { ...input, target_tool: 123 },
        ctx({ evolution: { requestCapability: vi.fn() } }),
      );
      expect(r.isError).toBe(true);
    });

    it('target_toolはscope=tool以外では指定できない', async () => {
      const r = await requestCapability.execute(
        { ...input, scope: 'renderer', target_tool: 'web_search' },
        ctx({ evolution: { requestCapability: vi.fn() } }),
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain('scope="tool"');
    });
  });
});

describe('M27-1: 無料モードでの新規生成無効化', () => {
  it('ctx.evolutionDisabled があるとジョブを起動せず理由文を返す', async () => {
    const requestCapabilityFn = vi.fn(async () => ({ jobId: 99 }));
    const reason = '無料モードでは新規生成は行えません(テスト理由文)';
    const r = await requestCapability.execute(
      input,
      ctx({ evolution: { requestCapability: requestCapabilityFn }, evolutionDisabled: reason }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toBe(reason);
    expect(requestCapabilityFn).not.toHaveBeenCalled();
  });
});

describe('M28-3: 「作る前に探す」(searchRegistryAndImport)', () => {
  const search = (outcome: 'imported' | 'declined' | 'none') =>
    vi.fn(async () =>
      outcome === 'imported'
        ? ({ outcome: 'imported', jobId: 42, name: 'text_stats' } as const)
        : outcome === 'declined'
          ? ({ outcome: 'declined', name: 'text_stats' } as const)
          : ({ outcome: 'none' } as const),
    );

  it('候補が導入されたら生成ジョブは起動せず、インポートジョブ番号を返す', async () => {
    const requestCapabilityFn = vi.fn(async () => ({ jobId: 7 }));
    const searchFn = search('imported');
    const r = await requestCapability.execute(
      input,
      ctx({ evolution: { requestCapability: requestCapabilityFn, searchRegistryAndImport: searchFn } }),
    );
    expect(searchFn).toHaveBeenCalledWith(input.description, input.expected_io, expect.anything());
    expect(requestCapabilityFn).not.toHaveBeenCalled();
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('#42');
    expect(r.content).toContain('text_stats');
  });

  it('declined / none は従来どおり生成ジョブへフォールバックする', async () => {
    for (const outcome of ['declined', 'none'] as const) {
      const requestCapabilityFn = vi.fn(async () => ({ jobId: 8 }));
      const r = await requestCapability.execute(
        input,
        ctx({ evolution: { requestCapability: requestCapabilityFn, searchRegistryAndImport: search(outcome) } }),
      );
      expect(requestCapabilityFn).toHaveBeenCalledTimes(1);
      expect(r.content).toContain('#8');
    }
  });

  it('freeMode(evolutionDisabled)でも検索・導入はでき、生成のみ止まる', async () => {
    const requestCapabilityFn = vi.fn(async () => ({ jobId: 9 }));
    // 導入成功 → 無効文言ではなく導入メッセージ
    const ok = await requestCapability.execute(
      input,
      ctx({
        evolution: { requestCapability: requestCapabilityFn, searchRegistryAndImport: search('imported') },
        evolutionDisabled: '無料モードでは新規生成は行えません(テスト)',
      }),
    );
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toContain('#42');
    // 候補なし → 生成は無効文言で止まる(enqueueは呼ばれない)
    const blocked = await requestCapability.execute(
      input,
      ctx({
        evolution: { requestCapability: requestCapabilityFn, searchRegistryAndImport: search('none') },
        evolutionDisabled: '無料モードでは新規生成は行えません(テスト)',
      }),
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('無料モード');
    expect(requestCapabilityFn).not.toHaveBeenCalled();
  });

  it('target_tool 指定(既存修正)ではレジストリ検索しない', async () => {
    const requestCapabilityFn = vi.fn(async () => ({ jobId: 10 }));
    const searchFn = search('imported');
    await requestCapability.execute(
      { ...input, target_tool: 'web_search' },
      ctx({ evolution: { requestCapability: requestCapabilityFn, searchRegistryAndImport: searchFn } }),
    );
    expect(searchFn).not.toHaveBeenCalled();
    expect(requestCapabilityFn).toHaveBeenCalledTimes(1);
  });

  it('searchRegistryAndImport 未注入(従来構成)は従来どおり', async () => {
    const requestCapabilityFn = vi.fn(async () => ({ jobId: 11 }));
    const r = await requestCapability.execute(input, ctx({ evolution: { requestCapability: requestCapabilityFn } }));
    expect(r.content).toContain('#11');
  });
});
