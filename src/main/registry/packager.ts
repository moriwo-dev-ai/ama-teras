import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginManifest } from '../../shared/types';
import { PLUGIN_API_VERSION, satisfiesApiRange } from '../tools/versioning';
import { validateManifest } from './manifest';
import { checkPermissions, extractPermissions } from './permissions';

/**
 * M27-4: プラグインのローカル・パッケージング。
 * 形式は「プラグイン1つ=1ディレクトリ」(REGISTRY_DESIGN.md のレジストリ実体と同じ):
 *   <name>/
 *     <name>.ts        … プラグイン本体
 *     <name>.test.ts   … ユニットテスト(あれば)
 *     manifest.json    … マニフェスト
 * zip は扱わない(依存ゼロで実装コストに見合わず、レジストリもgitディレクトリ方式のため)。
 */

export interface ExportOptions {
  /** 稼働中プラグインのディレクトリ(getPluginsDir) */
  pluginsDir: string;
  toolName: string;
  /** registry から引いた説明文(manifest.description に使う) */
  description: string;
  /** 書き出し先の親ディレクトリ(この下に <toolName>/ を作る) */
  destRoot: string;
  /** クレジット(未指定は空文字) */
  author?: string;
}

export interface ExportOutcome {
  ok: boolean;
  message: string;
  path?: string;
  manifest?: PluginManifest;
}

/** 導入済みプラグインを「コード+テスト+マニフェスト」のディレクトリとして書き出す */
export async function exportPlugin(opts: ExportOptions): Promise<ExportOutcome> {
  const srcCode = join(opts.pluginsDir, `${opts.toolName}.ts`);
  if (!existsSync(srcCode)) {
    return { ok: false, message: `プラグインファイルが見つからない: ${srcCode}` };
  }
  const code = await readFile(srcCode, 'utf8');
  const permissions = extractPermissions(code);
  const manifest: PluginManifest = {
    name: opts.toolName,
    version: '1.0.0',
    pluginApiVersion: '^1',
    description: opts.description,
    author: opts.author ?? '',
    license: 'AGPL-3.0',
    permissions,
    dependencies: [],
    // スモーク入力は生成時の値が残っていないため空で出す(インポート側ゲートの既定入力)
    smoke: { input: {} },
  };

  const outDir = join(opts.destRoot, opts.toolName);
  await mkdir(outDir, { recursive: true });
  await copyFile(srcCode, join(outDir, `${opts.toolName}.ts`));
  const srcTest = join(opts.pluginsDir, `${opts.toolName}.test.ts`);
  const hasTest = existsSync(srcTest);
  if (hasTest) await copyFile(srcTest, join(outDir, `${opts.toolName}.test.ts`));
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return {
    ok: true,
    message:
      `エクスポート完了: ${outDir}` +
      (hasTest ? '' : '(⚠ テストファイルが無いため未同梱。レジストリ投稿にはテストが必要)'),
    path: outDir,
    manifest,
  };
}

export interface ImportInspection {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: PluginManifest;
  /** インポート元のコード/テストの絶対パス(ok時) */
  codePath?: string;
  testPath?: string;
}

/**
 * インポート元ディレクトリの検査(検証ゲートの前段)。
 * manifest検証 → コード実在 → 権限の静的解析と宣言の突き合わせ(宣言外使用=エラー)
 */
export async function inspectImportDir(dir: string): Promise<ImportInspection> {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`manifest.json が見つからない: ${dir}`], warnings: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      errors: [`manifest.json がJSONとして不正: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
    };
  }
  const v = validateManifest(raw);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: [] };
  const manifest = v.manifest;

  // M27-5: 本体プラグインAPIとの互換範囲チェック(範囲外はインポート自体を拒否)
  if (!satisfiesApiRange(manifest.pluginApiVersion)) {
    return {
      ok: false,
      errors: [
        `pluginApiVersion "${manifest.pluginApiVersion}" は本体プラグインAPI v${PLUGIN_API_VERSION} の範囲外(このプラグインは本体の別バージョン向け)`,
      ],
      warnings: [],
      manifest,
    };
  }

  const codePath = join(dir, `${manifest.name}.ts`);
  if (!existsSync(codePath)) {
    return { ok: false, errors: [`プラグイン本体が見つからない: ${manifest.name}.ts`], warnings: [], manifest };
  }
  const code = await readFile(codePath, 'utf8');
  const check = checkPermissions(manifest.permissions, extractPermissions(code));
  if (check.errors.length > 0) {
    // 宣言と実装の不一致(宣言外API使用)= 自動リジェクト(REGISTRY_DESIGN.md)
    return { ok: false, errors: check.errors, warnings: check.warnings, manifest };
  }

  const testPath = join(dir, `${manifest.name}.test.ts`);
  const warnings = [...check.warnings];
  const hasTest = existsSync(testPath);
  if (!hasTest) warnings.push('テストファイルが同梱されていない(検証ゲートのvitestは既存テストのみで実行)');
  return {
    ok: true,
    errors: [],
    warnings,
    manifest,
    codePath,
    ...(hasTest ? { testPath } : {}),
  };
}
