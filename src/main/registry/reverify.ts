import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginManifest } from '../../shared/types';
import { codeHashOf, type GateEvidence } from '../evolution/local';
import { verifyPlugin } from '../tools/verify';
import { PLUGIN_API_VERSION } from '../tools/versioning';
import { extractPermissions } from './permissions';

/**
 * M98: 既存ツールの「再検証」。
 *
 * レジストリ公開は検証証跡(<name>.gate.json)を要求するが、証跡を書き始めたのは M96 から。
 * それ以前に作られたツール(開発版で昇格したもの・組み込み)は、実際には厳しいゲートを
 * 通っているのに証跡が無く、公開できない。かといって**証跡を書くだけでは意味がない**
 * (証跡は「検証した」という主張ではなく「検証した事実」でなければならない)。
 *
 * よってここでは**本物の検証を今から回す**: 一時ディレクトリに一式を組み立て、
 * verifyPlugin の4ゲート(inspect/typecheck/test/smoke)を実際に実行し、
 * 合格したものにだけ証跡を書く。落ちたものは落ちたと返す(嘘の証跡は作らない)。
 */

export interface ReverifyDeps {
  /** ツール本体(<name>.ts)と、あればテストがある場所 */
  pluginsDir: string;
  /** 証跡(<name>.gate.json)の書き込み先。通常は pluginsDir と同じ */
  evidenceDir: string;
  /** ToolPlugin 型のルート(verifyPlugin の typesRoot) */
  typesRoot: string;
  typeRoots?: string;
  libDir?: string;
  /** 作業用ディレクトリ(userData配下) */
  workDir: string;
  /** manifest の description に使う(レジストリの説明文) */
  description: string;
  author?: string;
  signal?: AbortSignal;
}

export interface ReverifyOutcome {
  ok: boolean;
  toolName: string;
  message: string;
  gates?: { name: string; ok: boolean; detail: string }[];
}

/**
 * 1ツールを再検証し、合格なら証跡を書く。
 * テストが無いツールは検証できない(テスト無しで「検証済み」とは言えない)ため、その旨を返す。
 */
export async function reverifyPlugin(toolName: string, deps: ReverifyDeps): Promise<ReverifyOutcome> {
  const codePath = join(deps.pluginsDir, `${toolName}.ts`);
  if (!existsSync(codePath)) {
    return { ok: false, toolName, message: `ソースが見つからない: ${toolName}.ts` };
  }
  const testPath = join(deps.pluginsDir, `${toolName}.test.ts`);
  if (!existsSync(testPath)) {
    return {
      ok: false,
      toolName,
      message: 'テスト(<name>.test.ts)が無いため検証できない。テストの無いツールは公開できません',
    };
  }

  const code = await readFile(codePath, 'utf8');
  const stage = join(deps.workDir, `reverify-${toolName}-${process.pid}`);
  try {
    await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, `${toolName}.ts`), code, 'utf8');
    await writeFile(join(stage, `${toolName}.test.ts`), await readFile(testPath, 'utf8'), 'utf8');
    // 検証には manifest が要る(inspect ゲート)。既存があればそれを、無ければコードから起こす
    const existingManifest = join(deps.pluginsDir, `${toolName}.manifest.json`);
    const manifest: PluginManifest = existsSync(existingManifest)
      ? (JSON.parse(await readFile(existingManifest, 'utf8')) as PluginManifest)
      : {
          name: toolName,
          version: '1.0.0',
          pluginApiVersion: '^1',
          description: deps.description,
          author: deps.author ?? '',
          license: 'AGPL-3.0',
          // 権限はコードから静的抽出する(人間の自己申告ではなく実物から取る)
          permissions: extractPermissions(code),
          dependencies: [],
          smoke: { input: {} },
        };
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyPlugin({
      dir: stage,
      name: toolName,
      typesRoot: deps.typesRoot,
      workDir: deps.workDir,
      ...(deps.typeRoots !== undefined ? { typeRoots: deps.typeRoots } : {}),
      ...(deps.libDir !== undefined ? { libDir: deps.libDir } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    if (!result.ok) {
      const failed = result.gates.find((g) => !g.ok);
      return {
        ok: false,
        toolName,
        message: `検証に不合格(${failed?.name ?? '?'}): ${failed?.detail ?? ''}`.slice(0, 300),
        gates: result.gates,
      };
    }

    const evidence: GateEvidence = {
      toolName,
      ok: true,
      gates: result.gates,
      pluginApiVersion: PLUGIN_API_VERSION,
      codeHash: await codeHashOf(code),
      verifiedAt: new Date().toISOString(),
      by: 'local',
    };
    try {
      await mkdir(deps.evidenceDir, { recursive: true }).catch(() => {});
      await writeFile(
        join(deps.evidenceDir, `${toolName}.gate.json`),
        JSON.stringify(evidence, null, 2),
        'utf8',
      );
    } catch (err) {
      // 検証自体は通ったが証跡を残せない(読み取り専用の同梱ディレクトリ等)。事実をそのまま返す
      return {
        ok: false,
        toolName,
        message: `検証は合格したが証跡を書けなかった(${deps.evidenceDir}): ${err instanceof Error ? err.message : String(err)}`,
        gates: result.gates,
      };
    }
    return {
      ok: true,
      toolName,
      message: `検証OK(${result.gates.map((g) => g.name).join(' → ')})。証跡を作成した`,
      gates: result.gates,
    };
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
