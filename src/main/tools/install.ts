import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectImportDir } from '../registry/packager';
import type { PluginManifest } from '../../shared/types';

/**
 * M71: 配布版のプラグイン導入。
 *
 * 従来、導入は必ず進化パイプライン(git worktree → typecheck → vitest → 昇格マージ)を
 * 通っていた。配布版にはソースツリーも .git も devDependencies も無いため、
 * **ファイルからもレジストリからもツールを入れられなかった**(しかも置き場すら無い:
 * 同梱先は Program Files 配下の resources/plugins)。
 *
 * ここは git を使わない導入経路: 検査(manifest/API範囲/宣言外API使用) → 危険警告 →
 * ユーザー承認(全文表示) → userData/plugins へ配置 → リロード → 読めなければ撤去。
 * 検証ゲート(typecheck/vitest)は**開発版の生成物のためのもの**で、レジストリの成果物は
 * 配布前にレジストリ側CIで検証済みという前提に立つ(REGISTRY_DESIGN.md)。
 */

export interface InstalledPlugin {
  name: string;
  manifest: PluginManifest;
  /** 導入したコードの全文(承認ダイアログで人間が読むもの) */
  code: string;
}

/** 導入前の検査。ok でなければ何も置かない */
export async function preparePluginInstall(
  srcDir: string,
): Promise<{ ok: false; errors: string[] } | { ok: true; plugin: InstalledPlugin; warnings: string[] }> {
  const inspection = await inspectImportDir(srcDir);
  if (!inspection.ok || inspection.manifest === undefined || inspection.codePath === undefined) {
    return { ok: false, errors: inspection.errors };
  }
  const code = await readFile(inspection.codePath, 'utf8');
  return {
    ok: true,
    plugin: { name: inspection.manifest.name, manifest: inspection.manifest, code },
    warnings: inspection.warnings,
  };
}

/**
 * userData/plugins へ配置する。manifest も並べて置く(何をどこから入れたかを後から辿れる)。
 * 組み込みツールと同名のものは loader 側で無効化されるため、ここでは弾かない
 * (弾くと「同名だが別物を入れたい」意図まで潰れる。無効化理由はツール一覧に出る)
 */
export async function installPlugin(srcDir: string, userPluginsDir: string, name: string): Promise<void> {
  await mkdir(userPluginsDir, { recursive: true });
  await copyFile(join(srcDir, `${name}.ts`), join(userPluginsDir, `${name}.ts`));
  const manifestSrc = join(srcDir, 'manifest.json');
  if (existsSync(manifestSrc)) {
    await copyFile(manifestSrc, join(userPluginsDir, `${name}.manifest.json`));
  }
}

/** 導入の撤去(読み込めなかった場合の巻き戻し・ユーザーによる削除) */
export async function uninstallPlugin(userPluginsDir: string, name: string): Promise<void> {
  await rm(join(userPluginsDir, `${name}.ts`), { force: true });
  await rm(join(userPluginsDir, `${name}.manifest.json`), { force: true });
}

/** userData/plugins に入っているものの一覧(設定UI・棚卸し用) */
export async function listInstalledPlugins(userPluginsDir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(userPluginsDir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => f.replace(/\.ts$/, ''));
}

/** 危険性の申告(承認ダイアログで赤字にするもの)。gates.ts の検出と同じ観点をコード全文に当てる */
export function pluginDangerWarnings(code: string, manifest: PluginManifest): string[] {
  const warnings: string[] = [];
  if (/child_process|execFile|spawn\s*\(/.test(code)) warnings.push('コマンド実行(child_process)を含む');
  if (/fetch\s*\(|node:https?|node:net|node:dgram|WebSocket/.test(code)) warnings.push('ネットワークアクセスを含む');
  if (/writeFile|rm\s*\(|unlink|rmdir/.test(code)) warnings.push('ファイルの書き込み・削除を含む');
  const p = manifest.permissions;
  const declared = [
    ...(p.network ? ['ネットワーク'] : []),
    ...(p.childProcess ? ['コマンド実行'] : []),
    ...(p.fsScope === 'workspace' ? ['作業ディレクトリのファイル操作'] : []),
  ];
  warnings.push(declared.length > 0 ? `宣言された権限: ${declared.join(' / ')}` : '宣言された権限: なし');
  return warnings;
}

/** 承認ダイアログに出す全文(diff の代わり。新規ファイルなので全行が追加) */
export function installPreview(plugin: InstalledPlugin, origin: string): string {
  return [
    `# 導入するツール: ${plugin.name} (v${plugin.manifest.version})`,
    `# 取得元: ${origin}`,
    `# 説明: ${plugin.manifest.description}`,
    '',
    plugin.code,
  ].join('\n');
}

/** 配置後にファイルが本当に置かれたか(呼び出し側の巻き戻し判断用) */
export function isInstalled(userPluginsDir: string, name: string): boolean {
  return existsSync(join(userPluginsDir, `${name}.ts`));
}

/** テスト用: 最小のプラグイン一式を作る */
export async function writeFixturePlugin(dir: string, name: string, code: string, manifest: object): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.ts`), code, 'utf8');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
}
