import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// M31-4: パッケージ版のプラグインロード修理の回帰ピン。
// esbuild は読込時に ESBUILD_BINARY_PATH を固定するため、main プロセスの
// どこかに esbuild の「静的import」が1つでもあると、ESMホイストで
// index.ts の環境変数設定より先に評価され、パッケージ版で
// asar内パスのspawn(ENOENT)に戻ってしまう。実機インストールでしか
// 発現しないため、ソースパターンで固定する。
describe('M31-4: esbuild は動的importのみ(パッケージ版のasar外バイナリ指定を有効に保つ)', () => {
  const srcMain = join(__dirname, '..');

  it('loader.ts に esbuild の静的importが無い(動的importを使う)', async () => {
    const src = await readFile(join(__dirname, 'loader.ts'), 'utf8');
    expect(src).not.toMatch(/^import\s+[^;]*from\s+'esbuild';?\s*$/m);
    expect(src).toContain("await import('esbuild')");
  });

  it("index.ts はパッケージ版で ESBUILD_BINARY_PATH に app.asar.unpacked を指す", async () => {
    const src = await readFile(join(srcMain, 'index.ts'), 'utf8');
    expect(src).toContain("process.env['ESBUILD_BINARY_PATH']");
    expect(src).toContain('app.asar.unpacked');
  });

  it('main プロセス配下に esbuild の静的importが存在しない', async () => {
    const { readdir } = await import('node:fs/promises');
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) files.push(...(await walk(p)));
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(p);
      }
      return files;
    };
    for (const file of await walk(srcMain)) {
      const src = await readFile(file, 'utf8');
      expect(src, `${file} に esbuild の静的importがある`).not.toMatch(
        /^import\s+[^;]*from\s+'esbuild';?\s*$/m,
      );
    }
  });
});
