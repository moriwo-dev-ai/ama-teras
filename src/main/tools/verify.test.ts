import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyPlugin } from './verify';

/**
 * M91: プラグイン単位の検証ゲート。**git も vitest も要らない**(=配布版でも通る)ことが
 * この機能の全て。だからここでは本物の esbuild / TypeScript コンパイラAPIを実際に動かす
 * (モックにすると「配布版で動くか」を何も確かめていないテストになる)
 */

const TYPES_ROOT = join(process.cwd(), 'src');
const TYPE_ROOTS = join(process.cwd(), 'node_modules', '@types');

const GOOD_PLUGIN = `import type { ToolPlugin } from '../types';

const plugin: ToolPlugin = {
  name: 'sum_numbers',
  description: '数値の配列を合計する',
  risk: 'safe',
  inputSchema: {
    type: 'object',
    properties: { numbers: { type: 'array', items: { type: 'number' } } },
    required: ['numbers'],
  },
  async execute(input) {
    const numbers = (input as { numbers?: number[] }).numbers ?? [];
    const total = numbers.reduce((a, b) => a + b, 0);
    return { content: String(total), isError: false };
  },
};

export default plugin;
export function sum(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0);
}
`;

const GOOD_TEST = `import { describe, expect, it } from 'vitest';
import { sum } from './sum_numbers';

describe('sum_numbers', () => {
  it('合計する', () => {
    expect(sum([1, 2, 3])).toBe(6);
  });
  it('空配列は0', () => {
    expect(sum([])).toBe(0);
  });
});
`;

const MANIFEST = {
  name: 'sum_numbers',
  version: '1.0.0',
  pluginApiVersion: '^1',
  description: '数値の配列を合計する',
  author: '',
  license: 'AGPL-3.0',
  permissions: { network: false, childProcess: false, fsScope: 'none' },
  dependencies: [],
  smoke: { input: { numbers: [1, 2] } },
};

let root: string;
let dir: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amateras-verify-'));
  dir = join(root, 'sum_numbers');
  work = join(root, 'work');
  await mkdir(dir, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(dir, 'sum_numbers.ts'), GOOD_PLUGIN, 'utf8');
  await writeFile(join(dir, 'sum_numbers.test.ts'), GOOD_TEST, 'utf8');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2), 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = () =>
  verifyPlugin({ dir, name: 'sum_numbers', typesRoot: TYPES_ROOT, typeRoots: TYPE_ROOTS, workDir: work });

describe('verifyPlugin', () => {
  it('正しいプラグインは4ゲート全部通る', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.gates.map((g) => g.name)).toEqual(['inspect', 'typecheck', 'test', 'smoke']);
    expect(r.gates.every((g) => g.ok)).toBe(true);
    expect(r.gates[2]?.detail).toContain('2件');
    expect(r.pluginApiVersion).toBe('1.0.0');
  }, 60_000);

  it('型が壊れていれば型検査で落ちる(テストまで進まない)', async () => {
    await writeFile(
      join(dir, 'sum_numbers.ts'),
      GOOD_PLUGIN.replace('return { content: String(total), isError: false };', 'return { content: total };'),
      'utf8',
    );
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)?.name).toBe('typecheck');
    expect(r.gates.at(-1)?.ok).toBe(false);
  }, 60_000);

  it('テストが落ちれば検証も落ちる(通ったことにしない)', async () => {
    await writeFile(join(dir, 'sum_numbers.test.ts'), GOOD_TEST.replace('toBe(6)', 'toBe(7)'), 'utf8');
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)?.name).toBe('test');
    expect(r.gates.at(-1)?.detail).toContain('合計する');
  }, 60_000);

  it('テストが無ければ落ちる(テスト0件を「成功」にしない)', async () => {
    await rm(join(dir, 'sum_numbers.test.ts'));
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)?.name).toBe('test');
  }, 60_000);

  it('実行時に例外を投げるプラグインはスモークで落ちる', async () => {
    await writeFile(
      join(dir, 'sum_numbers.ts'),
      GOOD_PLUGIN.replace(
        'const total = numbers.reduce((a, b) => a + b, 0);',
        "const total = numbers.reduce((a, b) => a + b, 0);\n    if (total > 0) throw new Error('爆発');",
      ),
      'utf8',
    );
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)?.name).toBe('smoke');
    expect(r.gates.at(-1)?.detail).toContain('爆発');
  }, 60_000);

  it('宣言していない権限(child_process)を使えば検査で落ちる', async () => {
    await writeFile(
      join(dir, 'sum_numbers.ts'),
      `import { execSync } from 'node:child_process';\n${GOOD_PLUGIN.replace(
        'const total = numbers.reduce((a, b) => a + b, 0);',
        "const total = numbers.reduce((a, b) => a + b, 0);\n    execSync('echo hi');",
      )}`,
      'utf8',
    );
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.gates[0]?.name).toBe('inspect');
    expect(r.gates[0]?.ok).toBe(false);
  }, 60_000);
});
