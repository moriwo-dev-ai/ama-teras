import { transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonSchema, ToolPlugin } from './types';

// ソース内容ハッシュでトランスパイル済みプラグインをメモ化する。
// reload のたびに全プラグインを再トランスパイル+再import すると無駄で、
// 変更が無いのに動的import が増え続けESMモジュールキャッシュが肥大していた。
// 変更が無いファイルはキャッシュ済みプラグインを返し、再importを避ける。
const transpileCache = new Map<string, { sourceHash: string; compiledPath: string; plugin: ToolPlugin }>();

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
  const { name, description, inputSchema, risk, warnings, execute } = mod;
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

/** dir 直下の *.ts(テストを除く)を全ロード。壊れたプラグインはスキップして errors に積む */
export async function loadPlugins(dir: string, cacheDir: string): Promise<LoadResult> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(dir, e.name));

  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];
  for (const filePath of files) {
    try {
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
