import { describe, expect, it } from 'vitest';
import type { ToolPlugin } from '../tools/types';
import { EXCLUDED_FROM_TOOL_GEN, toolsForGeneration } from './job';

/**
 * M91: 配布版の実測で分かったこと — 生成エージェントに bash を渡すと、
 * 「自分で検証しよう」として環境調査を延々と続け、ターンを使い切って生成が終わらない
 * (この環境に npm は無い)。要らない道具は渡さない
 */

const tool = (name: string): ToolPlugin => ({ name }) as unknown as ToolPlugin;

describe('toolsForGeneration', () => {
  const full = {
    list: () => [tool('read_file'), tool('write_file'), tool('bash'), tool('request_capability')],
    get: (n: string) => tool(n),
  };

  it('bash と、入れ子の自己進化を呼ぶ道具は見せない', () => {
    expect(toolsForGeneration(full).list().map((t) => t.name)).toEqual(['read_file', 'write_file']);
  });

  it('名指しで呼ばれても渡さない(一覧から隠すだけでは足りない)', () => {
    expect(toolsForGeneration(full).get('bash')).toBeUndefined();
    expect(toolsForGeneration(full).get('write_file')?.name).toBe('write_file');
  });

  it('ファイルを書く道具は残す(これが無いと何も作れない)', () => {
    for (const n of ['read_file', 'write_file', 'edit_file']) expect(EXCLUDED_FROM_TOOL_GEN.has(n)).toBe(false);
  });
});
