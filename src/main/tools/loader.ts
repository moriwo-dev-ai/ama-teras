import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonSchema, ToolPlugin } from './types';
import { PLUGIN_API_VERSION, satisfiesApiRange } from './versioning';

// ソース内容ハッシュでトランスパイル済みプラグインをメモ化する。
// reload のたびに全プラグインを再トランスパイル+再import すると無駄で、
// 変更が無いのに動的import が増え続けESMモジュールキャッシュが肥大していた。
// 変更が無いファイルはキャッシュ済みプラグインを返し、再importを避ける。
const transpileCache = new Map<string, { sourceHash: string; compiledPath: string; plugin: ToolPlugin }>();

// esbuild は「モジュール読込時」に ESBUILD_BINARY_PATH を変数へ固定する。
// 静的importだとESMのホイストで index.ts の環境変数設定(パッケージ版の
// asar外バイナリ指定)より先に評価され、asar内パスをspawnしてENOENTになる。
// 初回使用時の動的importにして、環境変数設定後に読み込まれることを保証する。
let cachedTransform: typeof import('esbuild').transform | undefined;
async function esbuildTransform(): Promise<typeof import('esbuild').transform> {
  if (!cachedTransform) {
    cachedTransform = (await import('esbuild')).transform;
  }
  return cachedTransform;
}

export interface LoadedPlugin {
  plugin: ToolPlugin;
  filePath: string;
}

export interface PluginLoadError {
  filePath: string;
  message: string;
}

export interface LoadResult {
  plugins: LoadedPlugin[];
  errors: PluginLoadError[];
}

const RISKS = ['safe', 'write', 'exec'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** default export がToolPlugin規約を満たすか検証。満たさなければ理由付きで例外 */
export function validatePlugin(mod: unknown, expectedName: string): ToolPlugin {
  if (!isRecord(mod)) throw new Error('default export がオブジェクトではない');
  const { name, description, inputSchema, risk, warnings, pathParams, execute } = mod;
  if (typeof name !== 'string' || name !== expectedName) {
    throw new Error(`name はファイル名 '${expectedName}' と一致する文字列であること(実際: ${String(name)})`);
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('description は空でない文字列であること');
  }
  if (!isRecord(inputSchema) || inputSchema['type'] !== 'object' || !isRecord(inputSchema['properties'])) {
    throw new Error("inputSchema は { type: 'object', properties: {...} } であること");
  }
  if (typeof risk !== 'string' || !RISKS.includes(risk as (typeof RISKS)[number])) {
    throw new Error(`risk は ${RISKS.join('/')} のいずれかであること`);
  }
  if (warnings !== undefined && (!Array.isArray(warnings) || warnings.some((w) => typeof w !== 'string'))) {
    throw new Error('warnings は string[] であること');
  }
  if (pathParams !== undefined && (!Array.isArray(pathParams) || pathParams.some((p) => typeof p !== 'string'))) {
    throw new Error('pathParams は string[] であること');
  }
  if (typeof execute !== 'function') throw new Error('execute は関数であること');
  return mod as unknown as ToolPlugin;
}

/**
 * TSプラグイン1ファイルをESMへトランスパイルして動的import。
 * コンパイル結果は内容ハッシュ名で cacheDir に置き、URLが変わることで
 * import キャッシュをバイパスする(=再起動なしのリロード)。
 */
export async function loadPluginFile(filePath: string, cacheDir: string): Promise<ToolPlugin> {
  const source = await readFile(filePath, 'utf8');
  const sourceHash = createHash('sha1').update(source).digest('hex').slice(0, 12);
  // 内容が変わっていなければ再トランスパイル・再importせずキャッシュを返す
  const cached = transpileCache.get(filePath);
  if (cached && cached.sourceHash === sourceHash) return cached.plugin;

  const transform = await esbuildTransform();
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  const name = basename(filePath, '.ts');
  const compiledPath = join(cacheDir, `${name}.${sourceHash}.mjs`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(compiledPath, code, 'utf8');
  const mod: unknown = await import(pathToFileURL(compiledPath).href);
  if (!isRecord(mod)) throw new Error('モジュール評価に失敗');
  const plugin = validatePlugin(mod['default'], name);
  transpileCache.set(filePath, { sourceHash, compiledPath, plugin });
  return plugin;
}

/** cacheDir から、現在使用中でない古い .mjs を削除する(内容変更ごとに孤児が溜まるため) */
async function pruneCache(cacheDir: string, keep: Set<string>): Promise<void> {
  const entries = await readdir(cacheDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((e) => e.endsWith('.mjs') && !keep.has(join(cacheDir, e)))
      .map((e) => rm(join(cacheDir, e), { force: true }).catch(() => {})),
  );
}

/**
 * M27-5: `<name>.manifest.json`(インポート/共有プラグインが持つ)の pluginApiVersion を
 * 本体APIバージョンと照合する。範囲外なら理由を返す(=クラッシュではなく無効化+理由表示)。
 * マニフェスト無し=組み込み・従来プラグイン(現行APIと同梱なので常に互換)
 */
async function apiVersionBlockReason(filePath: string): Promise<string | null> {
  const manifestPath = filePath.replace(/\.ts$/, '.manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return null; // マニフェスト無し=互換扱い
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const range =
      isRecord(parsed) && typeof parsed['pluginApiVersion'] === 'string'
        ? parsed['pluginApiVersion']
        : null;
    if (range === null) return null; // 範囲未記載は互換扱い(強制するのはレジストリCIの担当)
    if (!satisfiesApiRange(range)) {
      return `互換性のため無効化: pluginApiVersion "${range}" は本体プラグインAPI v${PLUGIN_API_VERSION} の範囲外`;
    }
    return null;
  } catch {
    // マニフェスト破損はプラグイン自体は動かす(バージョン照合だけ諦める)
    return null;
  }
}

/**
 * dir 直下の *.ts(テストを除く)を全ロード。壊れたプラグインはスキップして errors に積む。
 *
 * M71: dir は複数取れる。配布版には**書き込めるプラグイン置き場が無かった**
 * (同梱先は Program Files 配下の resources/plugins)ため、導入したツールを置く場所が
 * どこにも無く、レジストリからの導入が構造的に成立していなかった。
 * userData/plugins を第2の置き場として読む。組み込みと同名のものは**組み込みが勝つ**
 * (導入物が組み込みを乗っ取れない。理由はツール一覧のエラー欄に出す)
 */
export async function loadPlugins(dirs: string | string[], cacheDir: string): Promise<LoadResult> {
  const dirList = typeof dirs === 'string' ? [dirs] : dirs;
  const files: string[] = [];
  const errors: PluginLoadError[] = [];
  const seen = new Set<string>();
  for (const dir of dirList) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
      const filePath = join(dir, e.name);
      if (seen.has(e.name)) {
        errors.push({
          filePath,
          message: `同名のツールが先に読み込まれているため無効(組み込み/先に登録されたものが優先): ${e.name.replace(/\.ts$/, '')}`,
        });
        continue;
      }
      seen.add(e.name);
      files.push(filePath);
    }
  }

  const plugins: LoadedPlugin[] = [];
  for (const filePath of files) {
    try {
      // M27-5: 範囲外プラグインは import せず無効化(理由はツール一覧のエラー欄に出る)
      const blocked = await apiVersionBlockReason(filePath);
      if (blocked !== null) {
        errors.push({ filePath, message: blocked });
        continue;
      }
      plugins.push({ plugin: await loadPluginFile(filePath, cacheDir), filePath });
    } catch (err) {
      errors.push({ filePath, message: err instanceof Error ? err.message : String(err) });
    }
  }
  // 現行プラグインの .mjs 以外(=内容変更で残った古い版)を掃除する
  const keep = new Set(files.map((f) => transpileCache.get(f)?.compiledPath).filter((p): p is string => !!p));
  await pruneCache(cacheDir, keep);
  return { plugins, errors };
}

export type { JsonSchema };
