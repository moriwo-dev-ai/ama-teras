import { transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonSchema, ToolPlugin } from './types';

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
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  const hash = createHash('sha1').update(code).digest('hex').slice(0, 12);
  const name = basename(filePath, '.ts');
  const compiledPath = join(cacheDir, `${name}.${hash}.mjs`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(compiledPath, code, 'utf8');
  const mod: unknown = await import(pathToFileURL(compiledPath).href);
  if (!isRecord(mod)) throw new Error('モジュール評価に失敗');
  return validatePlugin(mod['default'], name);
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
  return { plugins, errors };
}

export type { JsonSchema };
