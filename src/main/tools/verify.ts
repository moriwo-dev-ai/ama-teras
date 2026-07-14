import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectImportDir } from '../registry/packager';

/**
 * M91: **プラグイン1枚を検証するのに、アプリ全体を検証していた**。
 *
 * 進化ゲート(gates.ts)は `npm run typecheck`(プロジェクト全体の tsc)と
 * `npx vitest run`(全1361テスト)と `npm run build`(アプリ丸ごと再ビルド)を回す。
 * だから .git・ソースツリー・devDependencies が要り、**配布版ではツールを生成できなかった**。
 *
 * だがプラグインは構造上コアから切り離された葉っぱで(import してよいのは ToolPlugin の型と
 * Node 組み込みだけ。ガードレールで機械検出)、**コアを壊せない**。ならば検証もプラグイン1枚に
 * 閉じてよい。ここは git も vitest も要らない検証:
 *
 *   1. 検査   — manifest・API互換範囲・宣言外API使用(既存の inspectImportDir を再利用)
 *   2. 型検査 — その1ファイルだけを TypeScript コンパイラAPIで(プロジェクト全体を見ない)
 *   3. テスト — 同梱の esbuild でテストをバンドルし、vitest を**自前の最小実装**に差し替えて実行
 *              (vitest は同梱しない。インストーラを太らせずに、本物のテストを本当に走らせる)
 *   4. スモーク — 生成物を1回実行してみる(manifest.smoke.input)
 *
 * これは「弱いゲート」ではなく、**対象に合ったゲート**。全体の回帰テストは、コアを触れる
 * 開発版の進化パイプラインが引き続き担う。
 */

export interface PluginGateResult {
  name: 'inspect' | 'typecheck' | 'test' | 'smoke';
  ok: boolean;
  detail: string;
}

export interface PluginVerifyResult {
  ok: boolean;
  gates: PluginGateResult[];
  /** 検証したプラグインAPIのバージョン(証跡に残す。互換が切れたら再検証が要る) */
  pluginApiVersion: string;
}

export interface VerifyOptions {
  /** 検証するプラグイン一式(<name>.ts / <name>.test.ts / manifest.json)のあるディレクトリ */
  dir: string;
  name: string;
  /**
   * プラグインAPIの型のルート。この下に main/tools/types.ts と shared/types.ts がある想定
   * (プラグインの `../types` と、その先の `../../shared/types` を解決するため。
   *  開発時は src/、配布版は resources/plugin-api/)
   */
  typesRoot: string;
  /** @types のルート(node の型。無ければ node 組み込みの型は見ない) */
  typeRoots?: string;
  /** 作業用ディレクトリ(userData配下) */
  workDir: string;
  signal?: AbortSignal;
}

/** vitest の代わりに差し込む最小の describe/it/expect(テストを本当に走らせるため) */
const VITEST_SHIM = `
const suites = [];
let current = null;
export function describe(title, fn) {
  const prev = current;
  current = { title, tests: [] };
  suites.push(current);
  fn();
  current = prev;
}
export const it = (title, fn) => {
  const target = current ?? (suites[0] ?? (suites.push({ title: '', tests: [] }), suites[0]));
  target.tests.push({ title, fn });
};
it.each = () => {
  throw new Error('it.each はこの実行機では未対応(テストを書き下してください)');
};
export const test = it;

function fmt(v) {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function matchers(received, negated) {
  const check = (pass, message) => {
    if (negated ? pass : !pass) throw new Error(message);
  };
  return {
    toBe: (e) => check(Object.is(received, e), \`toBe: 期待 \${fmt(e)} / 実際 \${fmt(received)}\`),
    toEqual: (e) => check(deepEqual(received, e), \`toEqual: 期待 \${fmt(e)} / 実際 \${fmt(received)}\`),
    toStrictEqual: (e) => check(deepEqual(received, e), \`toStrictEqual: 期待 \${fmt(e)} / 実際 \${fmt(received)}\`),
    toContain: (e) =>
      check(
        typeof received === 'string' ? received.includes(e) : Array.isArray(received) && received.includes(e),
        \`toContain: \${fmt(received)} に \${fmt(e)} が無い\`,
      ),
    toMatch: (re) => check(new RegExp(re).test(String(received)), \`toMatch: \${fmt(received)} が \${re} に一致しない\`),
    toHaveLength: (n) => check(received?.length === n, \`toHaveLength: 期待 \${n} / 実際 \${received?.length}\`),
    toBeTruthy: () => check(Boolean(received), \`toBeTruthy: \${fmt(received)}\`),
    toBeFalsy: () => check(!received, \`toBeFalsy: \${fmt(received)}\`),
    toBeNull: () => check(received === null, \`toBeNull: \${fmt(received)}\`),
    toBeUndefined: () => check(received === undefined, \`toBeUndefined: \${fmt(received)}\`),
    toBeDefined: () => check(received !== undefined, \`toBeDefined: \${fmt(received)}\`),
    toBeGreaterThan: (n) => check(received > n, \`toBeGreaterThan: \${fmt(received)} > \${n}\`),
    toBeGreaterThanOrEqual: (n) => check(received >= n, \`toBeGreaterThanOrEqual: \${fmt(received)} >= \${n}\`),
    toBeLessThan: (n) => check(received < n, \`toBeLessThan: \${fmt(received)} < \${n}\`),
    toBeLessThanOrEqual: (n) => check(received <= n, \`toBeLessThanOrEqual: \${fmt(received)} <= \${n}\`),
    toThrow: (msg) => {
      let threw = false;
      let text = '';
      try {
        received();
      } catch (e) {
        threw = true;
        text = e instanceof Error ? e.message : String(e);
      }
      const pass = threw && (msg === undefined || new RegExp(msg).test(text));
      check(pass, \`toThrow: 例外が出ない、または \${msg} に一致しない(実際: \${text})\`);
    },
  };
}

export function expect(received) {
  const api = matchers(received, false);
  api.not = matchers(received, true);
  api.rejects = {
    toThrow: async (msg) => {
      let threw = false;
      let text = '';
      try {
        await received;
      } catch (e) {
        threw = true;
        text = e instanceof Error ? e.message : String(e);
      }
      if (!threw || (msg !== undefined && !new RegExp(msg).test(text))) {
        throw new Error(\`rejects.toThrow: 例外が出ない、または一致しない(実際: \${text})\`);
      }
    },
  };
  api.resolves = {
    toBe: async (e) => {
      const v = await received;
      if (!Object.is(v, e)) throw new Error(\`resolves.toBe: 期待 \${fmt(e)} / 実際 \${fmt(v)}\`);
    },
  };
  return api;
}
export const vi = new Proxy(
  {},
  {
    get() {
      throw new Error('vi(モック)はこの実行機では未対応。副作用に依存しないテストを書いてください');
    },
  },
);
export const beforeEach = (fn) => { globalThis.__beforeEach = fn; };
export const afterEach = (fn) => { globalThis.__afterEach = fn; };

export async function __run() {
  const failures = [];
  let passed = 0;
  for (const s of suites) {
    for (const t of s.tests) {
      try {
        if (globalThis.__beforeEach) await globalThis.__beforeEach();
        await t.fn();
        passed++;
      } catch (e) {
        failures.push(\`\${s.title ? s.title + ' > ' : ''}\${t.title}: \${e instanceof Error ? e.message : String(e)}\`);
      } finally {
        if (globalThis.__afterEach) await globalThis.__afterEach();
      }
    }
  }
  return { passed, failures };
}
`;

async function esbuild(): Promise<typeof import('esbuild')> {
  return await import('esbuild');
}

/**
 * `../types`(ToolPlugin の型)は型専用importのはずだが、`import type` を付け忘れた
 * プラグインでもバンドルが落ちないよう、値としては空モジュールに差し替える。
 * 型の破れは型検査ゲートが見ているので、ここで落とす必要はない
 */
function typesStubPlugin(stubPath: string): { name: string; setup: (b: import('esbuild').PluginBuild) => void } {
  return {
    name: 'plugin-types-stub',
    setup(b) {
      b.onResolve({ filter: /(\.\.\/)+(types|shared\/types)$/ }, () => ({ path: stubPath }));
    },
  };
}

/** 1: 検査(manifest・API互換・宣言外API使用) */
async function gateInspect(dir: string): Promise<PluginGateResult> {
  const r = await inspectImportDir(dir);
  return {
    name: 'inspect',
    ok: r.ok,
    detail: r.ok
      ? `検査OK${r.warnings.length > 0 ? `(警告: ${r.warnings.join(' / ')})` : ''}`
      : r.errors.join(' / '),
  };
}

/** 2: 型検査(その1ファイルだけ。プロジェクト全体を見ない) */
async function gateTypecheck(opts: VerifyOptions, tmp: string): Promise<PluginGateResult> {
  const ts = await import('typescript');
  // プラグインの import (`../types` → その先の `../../shared/types`)が解決できるよう、
  // リポジトリと同じ相対配置を一時ツリーに再現する
  const pluginsDir = join(tmp, 'main', 'tools', 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  await mkdir(join(tmp, 'shared'), { recursive: true });
  await writeFile(
    join(tmp, 'main', 'tools', 'types.ts'),
    await readFile(join(opts.typesRoot, 'main', 'tools', 'types.ts'), 'utf8'),
    'utf8',
  );
  await writeFile(
    join(tmp, 'shared', 'types.ts'),
    await readFile(join(opts.typesRoot, 'shared', 'types.ts'), 'utf8'),
    'utf8',
  );
  await writeFile(
    join(tmp, 'vitest.d.ts'),
    // テスト側の import を通すためだけの宣言(テストの中身の型までは見ない)
    "declare module 'vitest' {\n  export const describe: any;\n  export const it: any;\n  export const test: any;\n  export const expect: any;\n  export const vi: any;\n  export const beforeEach: any;\n  export const afterEach: any;\n}\n",
    'utf8',
  );
  const code = join(pluginsDir, `${opts.name}.ts`);
  await writeFile(code, await readFile(join(opts.dir, `${opts.name}.ts`), 'utf8'), 'utf8');
  const testSrc = join(opts.dir, `${opts.name}.test.ts`);
  const files = [code, join(tmp, 'vitest.d.ts')];
  if (existsSync(testSrc)) {
    const t = join(pluginsDir, `${opts.name}.test.ts`);
    await writeFile(t, await readFile(testSrc, 'utf8'), 'utf8');
    files.push(t);
  }

  const hasNodeTypes = opts.typeRoots !== undefined && existsSync(join(opts.typeRoots, 'node'));
  const program = ts.createProgram(files, {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    allowJs: false,
    ...(hasNodeTypes
      ? { types: ['node'], typeRoots: [opts.typeRoots as string] }
      : { types: [] }), // node の型が無い環境(テスト等)では組み込みモジュールの型は見ない
  });
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => {
    if (hasNodeTypes) return true;
    const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    return !/Cannot find module 'node:|Cannot find name '(console|process|Buffer|setTimeout|clearTimeout|URL|TextEncoder|TextDecoder)'/.test(
      text,
    );
  });
  if (diags.length === 0) return { name: 'typecheck', ok: true, detail: '型検査OK' };
  const lines = diags.slice(0, 5).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (d.file && d.start !== undefined) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${d.file.fileName.split(/[\\/]/).pop()}:${line + 1} ${text}`;
    }
    return text;
  });
  return { name: 'typecheck', ok: false, detail: lines.join('\n') };
}

/** 3: テスト(esbuildでバンドルし、vitest を自前実装に差し替えて実行) */
async function gateTest(opts: VerifyOptions, tmp: string): Promise<PluginGateResult> {
  const testSrc = join(opts.dir, `${opts.name}.test.ts`);
  if (!existsSync(testSrc)) {
    return { name: 'test', ok: false, detail: 'テストが無い(<name>.test.ts が必要)' };
  }
  const shimPath = join(tmp, 'vitest-shim.mjs');
  await writeFile(shimPath, VITEST_SHIM, 'utf8');
  const stubPath = join(tmp, 'types-stub.mjs');
  await writeFile(stubPath, 'export {};\n', 'utf8');
  const bundlePath = join(tmp, 'bundle.mjs');
  // テストと同じバンドルの中から実行器を取り出す。shim を別 import すると
  // 「バンドルに取り込まれた shim」と「別読みした shim」が**別インスタンス**になり、
  // 登録された describe/it が空に見えて「0件成功」になる
  const entryPath = join(tmp, 'entry.ts');
  await writeFile(
    entryPath,
    `import ${JSON.stringify(testSrc.replace(/\\/g, '/'))};\nexport { __run } from 'vitest';\n`,
    'utf8',
  );
  const { build } = await esbuild();
  try {
    await build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundlePath,
      logLevel: 'silent',
      plugins: [
        {
          name: 'vitest-shim',
          setup(b) {
            b.onResolve({ filter: /^vitest$/ }, () => ({ path: shimPath }));
          },
        },
        typesStubPlugin(stubPath),
      ],
    });
  } catch (e) {
    return { name: 'test', ok: false, detail: `テストをバンドルできない: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const mod = (await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)) as {
      __run: () => Promise<{ passed: number; failures: string[] }>;
    };
    const { passed, failures } = await mod.__run();
    if (failures.length > 0) {
      return { name: 'test', ok: false, detail: `${failures.length}件失敗:\n${failures.slice(0, 5).join('\n')}` };
    }
    if (passed === 0) return { name: 'test', ok: false, detail: 'テストが1件も無い(通ったことにしない)' };
    return { name: 'test', ok: true, detail: `${passed}件のテストが通った` };
  } catch (e) {
    return { name: 'test', ok: false, detail: `テストの実行に失敗: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 4: スモーク(生成物を1回実行してみる) */
async function gateSmoke(opts: VerifyOptions, tmp: string): Promise<PluginGateResult> {
  const manifestPath = join(opts.dir, 'manifest.json');
  let smokeInput: unknown = {};
  try {
    const m = JSON.parse(await readFile(manifestPath, 'utf8')) as { smoke?: { input?: unknown } };
    smokeInput = m.smoke?.input ?? {};
  } catch {
    /* manifest は検査ゲートが見ている。ここでは既定入力で試す */
  }
  const outfile = join(tmp, `${opts.name}.smoke.mjs`);
  const stubPath = join(tmp, 'types-stub.mjs');
  await writeFile(stubPath, 'export {};\n', 'utf8');
  const { build } = await esbuild();
  try {
    await build({
      entryPoints: [join(opts.dir, `${opts.name}.ts`)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'silent',
      plugins: [typesStubPlugin(stubPath)],
    });
    const mod = (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as {
      default?: { execute?: (input: unknown, ctx: unknown) => Promise<{ content: string; isError?: boolean }> };
    };
    const execute = mod.default?.execute;
    if (typeof execute !== 'function') return { name: 'smoke', ok: false, detail: 'default export に execute が無い' };
    const ctx = {
      cwd: tmp,
      signal: opts.signal ?? new AbortController().signal,
      log: () => {},
    };
    const r = await execute(smokeInput, ctx);
    // isError:true でも「動いた」= 例外を投げずに、エラーを構造化して返せている(想定内)
    return { name: 'smoke', ok: true, detail: `1回実行できた(${String(r?.content ?? '').slice(0, 60)})` };
  } catch (e) {
    return { name: 'smoke', ok: false, detail: `実行で例外: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * プラグイン1枚を検証する。**gitもvitestも要らない**(配布版でも動く)。
 * 1つでも落ちたら、そこで止める(落ちたゲートより先の結果は意味を持たない)
 */
export async function verifyPlugin(opts: VerifyOptions): Promise<PluginVerifyResult> {
  const { PLUGIN_API_VERSION } = await import('./versioning');
  const tmp = join(opts.workDir, `verify-${opts.name}-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const gates: PluginGateResult[] = [];
  try {
    for (const run of [
      () => gateInspect(opts.dir),
      () => gateTypecheck(opts, tmp),
      () => gateTest(opts, tmp),
      () => gateSmoke(opts, tmp),
    ]) {
      const g = await run();
      gates.push(g);
      if (!g.ok) return { ok: false, gates, pluginApiVersion: PLUGIN_API_VERSION };
    }
    return { ok: true, gates, pluginApiVersion: PLUGIN_API_VERSION };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
