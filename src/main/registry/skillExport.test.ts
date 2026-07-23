import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateEvidence } from '../evolution/local';
import { addSkillFiles, buildRunnerEntry, buildSkillMd } from './skillExport';

const execFileP = promisify(execFile);

/**
 * M99-18: SKILL.mdエクスポート(普及ミッションの戦略機能)。
 * モックにしない: esbuildで本当にバンドルし、run.mjs を本物のnodeで実行して
 * 「他のエージェントの機体でそのまま動く」ことを確かめる(動かない配布物を出すのが最悪の失敗)。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-export-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PLUGIN = `import type { ToolPlugin } from '../types';

const plugin: ToolPlugin = {
  name: 'sum_numbers',
  description: 'Sums an array of numbers',
  risk: 'safe',
  inputSchema: {
    type: 'object',
    properties: { numbers: { type: 'array', items: { type: 'number' } } },
    required: ['numbers'],
  },
  async execute(input) {
    const numbers = (input as { numbers?: number[] }).numbers ?? [];
    if (!Array.isArray(numbers)) return { content: 'numbers must be an array', isError: true };
    return { content: String(numbers.reduce((a, b) => a + b, 0)), isError: false };
  },
};

export default plugin;
`;

describe('M99-18: buildSkillMd', () => {
  it('frontmatter(name/description)と証跡セクションを含む', () => {
    const evidence: GateEvidence = {
      toolName: 'sum_numbers',
      ok: true,
      gates: [
        { name: 'inspect', ok: true, detail: '' },
        { name: 'typecheck', ok: true, detail: '' },
        { name: 'test', ok: true, detail: '' },
        { name: 'smoke', ok: true, detail: '' },
      ],
      pluginApiVersion: '1.0.0',
      codeHash: 'abc123',
      verifiedAt: '2026-07-23T00:00:00.000Z',
      by: 'local',
    };
    const md = buildSkillMd({ name: 'sum_numbers', description: '数を合計する', evidence, repoUrl: 'https://x' });
    expect(md.startsWith('---\nname: sum_numbers\n')).toBe(true);
    expect(md).toContain('inspect → typecheck → test → smoke');
    expect(md).toContain('abc123');
    expect(md).toContain('node run.mjs');
    // 証跡なしは正直にそう書く(検証済みを装わない)
    const bare = buildSkillMd({ name: 'x', description: 'd', evidence: null, repoUrl: 'https://x' });
    expect(bare).toContain('No verification evidence');
  });
});

describe('M99-18: addSkillFiles(本物のesbuild+本物のnode実行)', () => {
  it('run.mjs が単体で動く: --schema と実入力の両方', { timeout: 30_000 }, async () => {
    const outDir = join(dir, 'out');
    const pluginsDir = join(dir, 'plugins');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(outDir, { recursive: true });
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(outDir, 'sum_numbers.ts'), PLUGIN);
    const evidence: GateEvidence = {
      toolName: 'sum_numbers', ok: true,
      gates: [{ name: 'smoke', ok: true, detail: '' }],
      pluginApiVersion: '1.0.0', codeHash: 'h', verifiedAt: '2026-07-23T00:00:00.000Z', by: 'local',
    };
    writeFileSync(join(pluginsDir, 'sum_numbers.gate.json'), JSON.stringify(evidence));

    const r = await addSkillFiles({
      outDir,
      toolName: 'sum_numbers',
      description: 'Sums numbers',
      pluginsDir,
      repoUrl: 'https://github.com/x/y',
    });
    expect(r.ok, r.detail).toBe(true);
    expect(existsSync(join(outDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(outDir, 'run.mjs'))).toBe(true);
    expect(existsSync(join(outDir, 'sum_numbers.gate.json'))).toBe(true);
    // SKILL.md に証跡が反映されている
    expect(readFileSync(join(outDir, 'SKILL.md'), 'utf8')).toContain('Verification evidence bundled');

    // 本物のnodeで実行(=Claude Code等の他機体での利用と同じ形)
    const schema = await execFileP(process.execPath, [join(outDir, 'run.mjs'), '--schema']);
    const parsed = JSON.parse(schema.stdout) as { name: string; inputSchema: { required: string[] } };
    expect(parsed.name).toBe('sum_numbers');
    expect(parsed.inputSchema.required).toEqual(['numbers']);

    const run = await execFileP(process.execPath, [join(outDir, 'run.mjs'), '{"numbers":[1,2,39]}']);
    expect(run.stdout.trim()).toBe('42');

    // ツールがエラーを返すケースは exit 1
    await expect(
      execFileP(process.execPath, [join(outDir, 'run.mjs'), '{"numbers":"x"}']),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('runner entry は --schema 分岐と JSON パース失敗の明示エラーを含む', () => {
    const src = buildRunnerEntry('t');
    expect(src).toContain("--schema");
    expect(src).toContain('must be a JSON string');
  });
});
