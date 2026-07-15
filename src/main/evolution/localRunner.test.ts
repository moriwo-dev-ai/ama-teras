import { describe, expect, it } from 'vitest';
import type { ToolPlugin } from '../tools/types';
import type { ToolRisk } from '../../shared/types';
import { EXCLUDED_FROM_TOOL_GEN, GENERATION_TOOL_ALLOWLIST, isAllowedForGeneration, toolsForGeneration } from './job';

/**
 * M91: 配布版の実測で分かったこと — 生成エージェントに bash を渡すと、
 * 「自分で検証しよう」として環境調査を延々と続け、ターンを使い切って生成が終わらない
 * (この環境に npm は無い)。要らない道具は渡さない。
 *
 * M92-B1/B2: それを denylist(名前)から allowlist+能力フィルタへ格上げ。名前ベースは
 * 「今の悪者」しか止められず、将来の実行系ツール(名前違い)が生成文脈に混ざる穴があった。
 */

const tool = (name: string, risk?: ToolRisk): ToolPlugin =>
  ({ name, ...(risk !== undefined ? { risk } : {}) }) as unknown as ToolPlugin;

describe('toolsForGeneration(allowlist+能力フィルタ)', () => {
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
    for (const n of ['read_file', 'write_file', 'edit_file']) expect(GENERATION_TOOL_ALLOWLIST.has(n)).toBe(true);
  });

  it('B1: allowlistに無い新顔ツールは見せない(将来の実行系ツールが素通りしない)', () => {
    const withNewTool = {
      list: () => [tool('read_file'), tool('run_shell'), tool('qr_svg'), tool('web_download')],
      get: (n: string) => tool(n),
    };
    // read_file だけが allowlist。run_shell(実行系の新顔)/qr_svg/web_download は名前が違うだけで全部落ちる
    expect(toolsForGeneration(withNewTool).list().map((t) => t.name)).toEqual(['read_file']);
    expect(toolsForGeneration(withNewTool).get('run_shell')).toBeUndefined();
  });

  it('B2: 名前がallowlistでも exec 相当は外す(能力フィルタ)', () => {
    // 万一 allowlist名を騙る exec 相当ツールが居ても、能力フィルタで弾く
    const shadow = { list: () => [tool('grep', 'exec')], get: (_n: string) => tool('grep', 'exec') };
    expect(toolsForGeneration(shadow).list()).toEqual([]);
    expect(toolsForGeneration(shadow).get('grep')).toBeUndefined();
    expect(isAllowedForGeneration({ name: 'grep', risk: 'exec' })).toBe(false);
    expect(isAllowedForGeneration({ name: 'grep', risk: 'safe' })).toBe(true);
  });

  it('除外リストは allowlist を広げても効く多層防御(bashは常にNG)', () => {
    expect(EXCLUDED_FROM_TOOL_GEN.has('bash')).toBe(true);
    expect(isAllowedForGeneration({ name: 'bash', risk: 'safe' })).toBe(false);
  });
});
