import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import dispatch from './dispatch_agent';

/** M12-3: dispatch_agent の後方互換(mode未指定=完全に従来挙動)と並列入力の検証 */

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { cwd: '/x', signal: new AbortController().signal, log: () => {}, ...overrides };
}

function subagentMock(): {
  run: ReturnType<typeof vi.fn>;
  runParallel: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async () => '単発要約'),
    runParallel: vi.fn(async (tasks: string[]) => tasks.map((t) => `要約(${t})`)),
  };
}

describe('dispatch_agent(M12-3)', () => {
  it('mode / parallel 未指定は従来どおり run(読み取り専用の単発)だけを呼ぶ', async () => {
    const subagent = subagentMock();
    const r = await dispatch.execute({ task: '調査して' }, ctx({ subagent }));
    expect(r.isError).not.toBe(true);
    expect(r.content).toBe('単発要約');
    expect(subagent.run).toHaveBeenCalledWith('調査して', expect.anything());
    expect(subagent.runParallel).not.toHaveBeenCalled();
  });

  it('mode:"work" の単発は runParallel([task], "work") を呼ぶ', async () => {
    const subagent = subagentMock();
    const r = await dispatch.execute({ task: '作業して', mode: 'work' }, ctx({ subagent }));
    expect(r.content).toBe('要約(作業して)');
    expect(subagent.runParallel).toHaveBeenCalledWith(['作業して'], 'work', expect.anything());
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it('parallel は複数タスクを渡し、結果を見出し付きで結合する', async () => {
    const subagent = subagentMock();
    const r = await dispatch.execute(
      { parallel: [{ task: 'A' }, { task: 'B' }], mode: 'work' },
      ctx({ subagent }),
    );
    expect(subagent.runParallel).toHaveBeenCalledWith(['A', 'B'], 'work', expect.anything());
    expect(r.content).toContain('1/2');
    expect(r.content).toContain('要約(A)');
    expect(r.content).toContain('要約(B)');
  });

  it('parallel の mode 省略は read', async () => {
    const subagent = subagentMock();
    await dispatch.execute({ parallel: [{ task: 'A' }] }, ctx({ subagent }));
    expect(subagent.runParallel).toHaveBeenCalledWith(['A'], 'read', expect.anything());
  });

  it('parallel は既定最大3件(4件はエラー)・空配列もエラー', async () => {
    const subagent = subagentMock();
    const over = await dispatch.execute(
      { parallel: [{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }] },
      ctx({ subagent }),
    );
    expect(over.isError).toBe(true);
    expect(over.content).toContain('最大 3');
    const empty = await dispatch.execute({ parallel: [] }, ctx({ subagent }));
    expect(empty.isError).toBe(true);
    expect(subagent.runParallel).not.toHaveBeenCalled();
  });

  it('M21-2: ctx.subagent.maxParallel が上限になる(5設定で5件OK・6件はエラー)', async () => {
    const subagent = { ...subagentMock(), maxParallel: 5 };
    const five = await dispatch.execute(
      { parallel: Array.from({ length: 5 }, (_, i) => ({ task: `t${i}` })) },
      ctx({ subagent }),
    );
    expect(five.isError).not.toBe(true);
    expect(subagent.runParallel).toHaveBeenCalledTimes(1);

    const six = await dispatch.execute(
      { parallel: Array.from({ length: 6 }, (_, i) => ({ task: `t${i}` })) },
      ctx({ subagent }),
    );
    expect(six.isError).toBe(true);
    expect(six.content).toContain('最大 5');
  });

  it('不正な mode はエラー', async () => {
    const subagent = subagentMock();
    const r = await dispatch.execute({ task: 'x', mode: 'root' }, ctx({ subagent }));
    expect(r.isError).toBe(true);
  });

  it('runParallel 未対応コンテキストで work を要求するとエラー(read 単発へは劣化可)', async () => {
    const runOnly = { run: vi.fn(async () => 'ok') };
    const work = await dispatch.execute({ task: 'x', mode: 'work' }, ctx({ subagent: runOnly }));
    expect(work.isError).toBe(true);
    const read = await dispatch.execute({ task: 'x', mode: 'read' }, ctx({ subagent: runOnly }));
    expect(read.content).toBe('ok');
  });

  it('subagent 未注入はエラー(進化ジョブ等のコンテキスト)', async () => {
    const r = await dispatch.execute({ task: 'x' }, ctx());
    expect(r.isError).toBe(true);
  });
});
