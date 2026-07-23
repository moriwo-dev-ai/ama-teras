import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateEvidence } from '../evolution/local';

/**
 * M99-18: SKILL.md エクスポート(戦略機能・普及ミッション直結)。
 *
 * SKILL.md はエージェント能力のオープン標準で、2026年時点で16以上のツール
 * (Claude Code / Codex CLI / Cursor 等)が対応する。AMA-terasのプラグインを
 * この形式でも書き出すことで、**AMA-terasが作ったツールがエコシステム全体で動く配布物**になる。
 *
 * 差別化の輸出: マーケットプレイスの監査でスキルの12〜20%が悪性と報告される時代に、
 * うちのエクスポートは検証証跡(gate.json)を同梱し、SKILL.md にゲート通過を明記する。
 *
 * 実行形: プラグイン(TS)を esbuild で単一の run.mjs にバンドルし、
 * `node run.mjs '<JSON入力>'` で動く自己完結スクリプトにする(Node組み込みのみ=依存ゼロ)。
 * スキーマは静的解析せず `node run.mjs --schema` の実行時自己申告にする(嘘が入らない)。
 */

/** SKILL.md本文の組み立て(純関数・テスト可能) */
export function buildSkillMd(input: {
  name: string;
  description: string;
  evidence: GateEvidence | null;
  repoUrl: string;
}): string {
  const evidenceSection =
    input.evidence === null
      ? '> ⚠ No verification evidence bundled with this export.'
      : [
          `> ✅ **Verification evidence bundled** (\`${input.name}.gate.json\`):`,
          `> gates passed: ${input.evidence.gates.map((g) => g.name).join(' → ')} / verified at ${input.evidence.verifiedAt}`,
          `> code sha256: \`${input.evidence.codeHash}\``,
        ].join('\n');
  return `---
name: ${input.name}
description: ${input.description.replace(/\n/g, ' ').slice(0, 500)}
---

# ${input.name}

${input.description}

This skill was generated and verified by [AMA-teras](${input.repoUrl}) — a self-evolving
desktop AI agent whose generated tools must pass typecheck → unit tests → a smoke run →
human approval before they can run.

${evidenceSection}

## Usage

Run the bundled tool with a JSON input (Node.js 18+, no dependencies):

\`\`\`bash
node run.mjs '{"...": "..."}'
\`\`\`

Print the tool's input schema (self-reported at runtime, not hand-written):

\`\`\`bash
node run.mjs --schema
\`\`\`

The tool prints its result to stdout. Exit code 0 = success, 1 = tool-reported error.

## Files

- \`run.mjs\` — self-contained bundled tool (Node built-ins only)
- \`${input.name}.ts\` — original TypeScript source (for review)
- \`${input.name}.test.ts\` — unit tests (if bundled)
- \`${input.name}.gate.json\` — verification evidence (if bundled)

## License

AGPL-3.0 (same as AMA-teras).
`;
}

/** run.mjs のバンドル入口(esbuildに食わせるエントリソース) */
export function buildRunnerEntry(toolName: string): string {
  return `import plugin from './${toolName}.ts';

const arg = process.argv[2];
if (arg === '--schema') {
  console.log(JSON.stringify({ name: plugin.name, description: plugin.description, inputSchema: plugin.inputSchema }, null, 2));
  process.exit(0);
}
let input = {};
if (arg !== undefined && arg !== '') {
  try {
    input = JSON.parse(arg);
  } catch {
    console.error('input must be a JSON string (or --schema)');
    process.exit(1);
  }
}
const ctx = { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} };
plugin
  .execute(input, ctx)
  .then((r) => {
    console.log(r.content);
    process.exit(r.isError === true ? 1 : 0);
  })
  .catch((e) => {
    console.error(String((e && e.message) || e));
    process.exit(1);
  });
`;
}

/**
 * エクスポートディレクトリ(コード・テスト・manifest済み)にSKILL.md一式を追加する。
 * esbuildの失敗でエクスポート全体を失敗にしない(スキル形式はおまけであり本体ではない)
 */
export async function addSkillFiles(opts: {
  /** exportPlugin が作った出力ディレクトリ(<name>.ts がある場所) */
  outDir: string;
  toolName: string;
  description: string;
  /** 稼働プラグインのディレクトリ(gate.json を探す) */
  pluginsDir: string;
  repoUrl: string;
}): Promise<{ ok: boolean; detail: string }> {
  try {
    // 検証証跡(あれば同梱+SKILL.mdに明記)
    let evidence: GateEvidence | null = null;
    const gatePath = join(opts.pluginsDir, `${opts.toolName}.gate.json`);
    if (existsSync(gatePath)) {
      try {
        evidence = JSON.parse(await readFile(gatePath, 'utf8')) as GateEvidence;
        await writeFile(join(opts.outDir, `${opts.toolName}.gate.json`), JSON.stringify(evidence, null, 2), 'utf8');
      } catch {
        evidence = null; // 壊れた証跡は「無し」として正直に出す
      }
    }

    // run.mjs: エントリを書き、esbuildで単一ファイルへバンドル
    const entryPath = join(opts.outDir, `.runner-entry.ts`);
    await writeFile(entryPath, buildRunnerEntry(opts.toolName), 'utf8');
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: join(opts.outDir, 'run.mjs'),
      logLevel: 'silent',
    });
    const { rm } = await import('node:fs/promises');
    await rm(entryPath, { force: true });

    await writeFile(
      join(opts.outDir, 'SKILL.md'),
      buildSkillMd({ name: opts.toolName, description: opts.description, evidence, repoUrl: opts.repoUrl }),
      'utf8',
    );
    return { ok: true, detail: 'SKILL.md + run.mjs を同梱した(16以上のエージェントで利用可能な形式)' };
  } catch (err) {
    return { ok: false, detail: `SKILL.md同梱に失敗(本体のエクスポートは有効): ${err instanceof Error ? err.message : String(err)}` };
  }
}
