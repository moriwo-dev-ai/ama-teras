import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reverifyPlugin } from './reverify';

/**
 * M98: 既存ツール(M96より前に作られ、証跡が無い)を今から検証し直して公開可能にする。
 * 「証跡を書くだけ」にしない = 本物のゲートに落ちたら証跡は作らない、を固定する。
 */

let dir: string;
let plugins: string;

const GOOD = `import type { ToolPlugin, ToolContext, ToolResult } from '../types';
export function twice(n: number): number {
  return n * 2;
}
export default {
  name: 'twice_tool',
  description: '2倍にする',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  risk: 'safe',
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const n = (input as { n?: unknown }).n;
    if (typeof n !== 'number') return { content: 'n は数値', isError: true };
    return { content: String(twice(n)) };
  },
} satisfies ToolPlugin;
`;

const GOOD_TEST = `import { describe, expect, it } from 'vitest';
import { twice } from './twice_tool';
describe('twice', () => {
  it('2倍にする', () => {
    expect(twice(2)).toBe(4);
  });
});
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reverify-'));
  plugins = join(dir, 'plugins');
  mkdirSync(plugins, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const deps = (): Parameters<typeof reverifyPlugin>[1] => ({
  pluginsDir: plugins,
  evidenceDir: plugins,
  typesRoot: join(process.cwd(), 'src'),
  workDir: join(dir, 'work'),
  description: '2倍にする',
});

describe('reverifyPlugin', () => {
  it('ソースが無ければ検証しない(証跡も作らない)', async () => {
    const r = await reverifyPlugin('missing_tool', deps());
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ソースが見つからない');
    expect(existsSync(join(plugins, 'missing_tool.gate.json'))).toBe(false);
  });

  it('テストが無いツールは検証できない(テスト無しで検証済みとは言えない)', async () => {
    writeFileSync(join(plugins, 'notest_tool.ts'), GOOD.replace(/twice_tool/g, 'notest_tool'), 'utf8');
    const r = await reverifyPlugin('notest_tool', deps());
    expect(r.ok).toBe(false);
    expect(r.message).toContain('テスト');
    expect(existsSync(join(plugins, 'notest_tool.gate.json'))).toBe(false);
  });

  it('合格すると証跡ができ、codeHashが実コードと一致する(公開ゲートを通る形)', async () => {
    writeFileSync(join(plugins, 'twice_tool.ts'), GOOD, 'utf8');
    writeFileSync(join(plugins, 'twice_tool.test.ts'), GOOD_TEST, 'utf8');

    const r = await reverifyPlugin('twice_tool', deps());
    expect(r.ok).toBe(true);

    const evPath = join(plugins, 'twice_tool.gate.json');
    expect(existsSync(evPath)).toBe(true);
    const ev = JSON.parse(readFileSync(evPath, 'utf8'));
    expect(ev.toolName).toBe('twice_tool');
    expect(ev.ok).toBe(true);
    expect(ev.by).toBe('local');
    // 証跡は「今そこにあるコード」に対するもの(evidenceMatchesCode が真になる)
    const { codeHashOf } = await import('../evolution/local');
    expect(ev.codeHash).toBe(await codeHashOf(readFileSync(join(plugins, 'twice_tool.ts'), 'utf8')));
  }, 120_000);

  it('テストが落ちるツールには証跡を作らない(嘘の「検証済み」を作らない)', async () => {
    writeFileSync(join(plugins, 'bad_tool.ts'), GOOD.replace(/twice_tool/g, 'bad_tool'), 'utf8');
    writeFileSync(
      join(plugins, 'bad_tool.test.ts'),
      GOOD_TEST.replace(/twice_tool/g, 'bad_tool').replace('toBe(4)', 'toBe(5)'),
      'utf8',
    );

    const r = await reverifyPlugin('bad_tool', deps());
    expect(r.ok).toBe(false);
    expect(existsSync(join(plugins, 'bad_tool.gate.json'))).toBe(false);
  }, 120_000);
});
