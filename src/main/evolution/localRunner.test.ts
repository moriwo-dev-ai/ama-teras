import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolPlugin } from '../tools/types';
import type { ToolRisk } from '../../shared/types';
import {
  buildExemplarSection,
  chooseExemplarName,
  DEFAULT_EXEMPLARS,
  EXCLUDED_FROM_TOOL_GEN,
  extractMetaJson,
  GENERATION_TOOL_ALLOWLIST,
  isAllowedForGeneration,
  toolsForGeneration,
} from './job';

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

describe('M92-A1 手本(few-shot)の選択', () => {
  const candidates = [
    { name: 'csv_to_markdown', description: 'CSVをMarkdownの表に変換する', tags: ['テキスト処理'] },
    { name: 'yaml_to_json', description: 'YAMLをJSONに変換する', tags: ['テキスト処理'] },
    { name: 'web_fetch', description: 'URLを取得して本文を返す', tags: ['Web操作'] },
  ];

  it('依頼に最も近い既存プラグインを選ぶ(キーワード重なり)', () => {
    const pick = chooseExemplarName(
      { description: 'JSONをYAMLへ変換したい', expectedIO: 'json文字列→yaml文字列' },
      candidates,
    );
    expect(pick).toBe('yaml_to_json');
  });

  it('修正対象そのもの(exclude)は手本にしない', () => {
    const pick = chooseExemplarName(
      { description: 'yaml json 変換', expectedIO: 'yaml' },
      candidates,
      'yaml_to_json',
    );
    expect(pick).not.toBe('yaml_to_json');
  });

  it('重なりがゼロなら定番の手本へフォールバック(在るものの中から)', () => {
    const pick = chooseExemplarName(
      { description: 'まったく無関係なランダム機能', expectedIO: 'xyz' },
      candidates,
    );
    // csv_to_markdown が DEFAULT_EXEMPLARS の先頭かつ候補に在る
    expect(pick).toBe(DEFAULT_EXEMPLARS.find((n) => candidates.some((c) => c.name === n)));
  });

  it('候補が空なら null(手本無しでも生成は続ける)', () => {
    expect(chooseExemplarName({ description: 'x', expectedIO: 'y' }, [])).toBeNull();
  });
});

describe('M92-A1 手本セクションの整形', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amateras-exemplar-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('本体+テストの全文を「真似る対象」として差し込む', () => {
    writeFileSync(join(dir, 'sample.ts'), 'export default {} // 本体コード', 'utf8');
    writeFileSync(join(dir, 'sample.test.ts'), "it('x', () => {}) // テストコード", 'utf8');
    const section = buildExemplarSection([dir], 'sample');
    expect(section).toContain('sample.ts');
    expect(section).toContain('本体コード');
    expect(section).toContain('sample.test.ts');
    expect(section).toContain('テストコード');
    expect(section).toContain('真似よ');
  });

  it('ソースが読めなければ空文字(手本無しでも止めない)', () => {
    expect(buildExemplarSection([dir], 'does_not_exist')).toBe('');
    expect(buildExemplarSection([dir], null)).toBe('');
  });
});

/**
 * M92-実測(job #28 で顕在化): メタJSONの値に ``` が入る(markdownツールの smokeInput 等)と、
 * 旧 /```json([\s\S]*?)```/ が内側の ``` で切れて "Unterminated string in JSON" で生成が落ちた。
 * extractMetaJson はフェンスに頼らずブレース対応で括るので、内側の ``` に影響されない。
 */
describe('extractMetaJson(```json 内に ``` があっても壊れない)', () => {
  it('smokeInput の値に markdown コードフェンス(```)が入っても正しく括る', () => {
    const finalText =
      '実装しました。\n\n```json\n' +
      JSON.stringify({
        toolName: 'markdown_to_html',
        smokeInput: { markdown: '# Hi\n```\ncode\n```\ndone' },
      }) +
      '\n```\n以上です。';
    const meta = extractMetaJson(finalText) as { toolName: string; smokeInput: { markdown: string } };
    expect(meta.toolName).toBe('markdown_to_html');
    expect(meta.smokeInput.markdown).toContain('```');
  });

  it('文字列内の {} や " に惑わされずオブジェクトを閉じる', () => {
    const finalText = '```json\n{"toolName":"x","note":"a { b } \\" c"}\n```';
    const meta = extractMetaJson(finalText) as { toolName: string; note: string };
    expect(meta.toolName).toBe('x');
    expect(meta.note).toBe('a { b } " c');
  });

  it('フェンスが無くても最初の {..} を拾う', () => {
    expect(extractMetaJson('メタ: {"toolName":"y"} です')).toEqual({ toolName: 'y' });
  });

  it('JSONオブジェクトが無ければ投げる', () => {
    expect(() => extractMetaJson('メタが見当たらない')).toThrow('見つからない');
  });
});
