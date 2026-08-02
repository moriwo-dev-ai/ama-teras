import { describe, expect, it } from 'vitest';
import type { WorldCommand } from '../../../shared/types';
import type { ToolContext } from '../types';
import worldAct from './world_act';
import worldObserve from './world_observe';

/** M115: world_act の入力検証と world 注入の橋渡し */

function ctxWith(world: ToolContext['world']): ToolContext {
  return {
    cwd: 'C:/tmp',
    signal: new AbortController().signal,
    log: () => undefined,
    world,
  };
}

function fakeWorld(acted: WorldCommand[][]) {
  return {
    observe: () => ({ connected: true, state: { avatar: { x: 0, z: 0, motion: 'idle' } }, chat: [] }),
    act: async (cmds: WorldCommand[]) => {
      acted.push(cmds);
      return { ok: true, detail: `実行完了(${cmds.length}コマンド)` };
    },
  };
}

describe('world_act', () => {
  it('world 未注入なら明示エラー', async () => {
    const r = await worldAct.execute({ actions: [{ type: 'say', text: 'hi' }] }, ctxWith(undefined));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('注入されていない');
  });

  it('正しいコマンド列は world.act へ渡る', async () => {
    const acted: WorldCommand[][] = [];
    const r = await worldAct.execute(
      {
        actions: [
          { type: 'say', text: 'こんにちは!' },
          { type: 'motion', name: 'jab' },
          { type: 'move_to', x: 3, z: -2 },
          { type: 'spawn', shape: 'sign', x: 0, z: 4, label: 'ようこそ' },
          { type: 'camera', target: 'avatar' },
        ],
      },
      ctxWith(fakeWorld(acted)),
    );
    expect(r.isError).toBeFalsy();
    expect(acted).toHaveLength(1);
    expect(acted[0]).toHaveLength(5);
  });

  it.each([
    [{ actions: [] }, '1件以上'],
    [{ actions: [{ type: 'say' }] }, 'text が必要'],
    [{ actions: [{ type: 'motion', name: 'fly' }] }, 'motion: name'],
    [{ actions: [{ type: 'move_to', x: 100, z: 0 }] }, '広場'],
    [{ actions: [{ type: 'spawn', shape: 'sign', x: 0, z: 0 }] }, 'label が必要'],
    [{ actions: [{ type: 'teleport' }] }, 'type が不正'],
  ])('不正入力を拒否する: %j', async (input, fragment) => {
    const acted: WorldCommand[][] = [];
    const r = await worldAct.execute(input, ctxWith(fakeWorld(acted)));
    expect(r.isError).toBe(true);
    expect(r.content).toContain(fragment);
    expect(acted).toHaveLength(0);
  });
});

describe('world_observe', () => {
  it('world 未注入なら明示エラー、注入済みなら状態JSONを返す', async () => {
    const r1 = await worldObserve.execute({}, ctxWith(undefined));
    expect(r1.isError).toBe(true);
    const r2 = await worldObserve.execute({}, ctxWith(fakeWorld([])));
    expect(r2.isError).toBeFalsy();
    expect(JSON.parse(r2.content).connected).toBe(true);
  });
});
