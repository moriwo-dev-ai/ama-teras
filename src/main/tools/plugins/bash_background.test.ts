import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../../core/processes';
import type { ToolContext } from '../types';
import bash from './bash';
import bash_kill from './bash_kill';
import bash_output from './bash_output';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor タイムアウト');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('bash_output / bash_kill(M11-2)', () => {
  it('processes 未注入のコンテキストでは両ツールとも明示エラー(進化ジョブ非波及)', async () => {
    const o = await bash_output.execute({ id: 1 }, ctx());
    expect(o.isError).toBe(true);
    expect(o.content).toContain('processes 未注入');
    const k = await bash_kill.execute({ id: 1 }, ctx());
    expect(k.isError).toBe(true);
    expect(k.content).toContain('processes 未注入');
  });

  it('id が整数でなければエラー', async () => {
    const pm = new ProcessManager();
    const c = ctx({ processes: pm });
    expect((await bash_output.execute({ id: 'x' }, c)).isError).toBe(true);
    expect((await bash_kill.execute({}, c)).isError).toBe(true);
  });

  it('bash(background)→bash_output→bash_kill の通しフロー(実プロセス)', async () => {
    const pm = new ProcessManager();
    const c = ctx({ processes: pm });

    const started = await bash.execute(
      { command: `node -e "console.log('bg-ready'); setInterval(() => {}, 1000)"`, background: true },
      c,
    );
    expect(started.isError).toBeUndefined();
    const m = /id=(\d+)/.exec(started.content);
    expect(m).not.toBeNull();
    const id = Number(m![1]);

    await waitFor(() => (pm.read(id)?.output ?? '').includes('bg-ready'));
    const out = await bash_output.execute({ id }, c);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('実行中');
    expect(out.content).toContain('bg-ready');

    const killed = await bash_kill.execute({ id }, c);
    expect(killed.isError).toBeUndefined();
    await waitFor(() => pm.read(id)?.running === false);
    const after = await bash_output.execute({ id }, c);
    expect(after.content).toContain('終了');

    const again = await bash_kill.execute({ id }, c);
    expect(again.content).toContain('既に終了');
  });

  it('存在しない id はエラーを返す', async () => {
    const pm = new ProcessManager();
    const c = ctx({ processes: pm });
    expect((await bash_output.execute({ id: 42 }, c)).isError).toBe(true);
    expect((await bash_kill.execute({ id: 42 }, c)).isError).toBe(true);
  });

  it('since_byte が増分取得として bash_output に渡る', async () => {
    const pm = new ProcessManager();
    const c = ctx({ processes: pm });
    const { id } = pm.start(`node -e "process.stdout.write('AAAABBBB')"`, process.cwd());
    await waitFor(() => pm.read(id)?.running === false);
    const r = await bash_output.execute({ id, since_byte: 4 }, c);
    expect(r.content).toContain('BBBB');
    expect(r.content).not.toContain('AAAA');
  });
});
