import { describe, expect, it } from 'vitest';
import plugin from './request_core_change';
import type { ToolContext } from '../types';

const ctx = (drafted: unknown[]): ToolContext =>
  ({
    cwd: '.',
    signal: new AbortController().signal,
    log: () => {},
    requests: {
      draft: async (kind: 'core' | 'ui', title: string, body: string) => {
        drafted.push({ kind, title, body });
        return { id: 'req-1' };
      },
    },
  }) as unknown as ToolContext;

describe('request_core_change', () => {
  it('下書きを起票するが、送信はしない(そう応答文でも明言する)', async () => {
    const drafted: unknown[] = [];
    const r = await plugin.execute(
      { kind: 'ui', title: '要望一覧が欲しい', body: 'UIでないと足せない' },
      ctx(drafted),
    );
    expect(r.isError).toBe(false);
    expect(drafted).toEqual([{ kind: 'ui', title: '要望一覧が欲しい', body: 'UIでないと足せない' }]);
    expect(r.content).toContain('まだ送信していない');
  });

  it('kind は core / ui だけ', async () => {
    const r = await plugin.execute({ kind: 'tool', title: 'a', body: 'b' }, ctx([]));
    expect(r.isError).toBe(true);
  });

  it('要望の口が無い環境では、黙って成功したことにしない', async () => {
    const bare = { cwd: '.', signal: new AbortController().signal, log: () => {} } as unknown as ToolContext;
    const r = await plugin.execute({ kind: 'core', title: 'a', body: 'b' }, bare);
    expect(r.isError).toBe(true);
  });
});
