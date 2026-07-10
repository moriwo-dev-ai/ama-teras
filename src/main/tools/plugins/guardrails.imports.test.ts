import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M27-5: プラグインAPIの互換性契約(REGISTRY_DESIGN.md)のガードレール。
 * プラグイン(非テスト)が依存してよいのは:
 * - `../types`(ToolPlugin 契約。import type のみ)
 * - node 組み込みモジュール(`node:` 接頭辞あり/なし)
 * - `../../../shared/types` の **import type**(共有の型定義。実行時依存にならない)
 * それ以外の src/main 内部・外部npm・同ディレクトリの他プラグインへの import は禁止
 * (エクスポート/レジストリ流通時に単体ディレクトリで完結しなくなるため)。
 * 新しい違反が入るとこのテストが落ちる=レジストリCIの先行実装を兼ねる
 */

const PLUGINS_DIR = dirname(fileURLToPath(import.meta.url));
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

function collectImports(code: string): ImportRef[] {
  const refs: ImportRef[] = [];
  // import type {...} from 'x' / import {...} from 'x' / import 'x'(改行を跨ぐ形も許容)
  const importRe = /import\s+(type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/gs;
  for (const m of code.matchAll(importRe)) {
    const specifier = m[2] ?? m[3];
    if (specifier !== undefined) refs.push({ specifier, typeOnly: m[1] !== undefined });
  }
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(requireRe)) refs.push({ specifier: m[1]!, typeOnly: false });
  return refs;
}

function isAllowed(ref: ImportRef): boolean {
  if (ref.specifier === '../types') return true; // ToolPlugin 契約
  if (NODE_BUILTINS.has(ref.specifier)) return true;
  if (ref.specifier === '../../../shared/types' && ref.typeOnly) return true;
  return false;
}

describe('M27-5: プラグインの依存契約(src/main 内部 import 禁止)', () => {
  const pluginFiles = readdirSync(PLUGINS_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );

  it('プラグインファイルが存在する(走査対象の健全性)', () => {
    expect(pluginFiles.length).toBeGreaterThan(5);
  });

  it.each(pluginFiles)('%s は許可された import のみを使う', (file) => {
    const code = readFileSync(join(PLUGINS_DIR, file), 'utf8');
    const violations = collectImports(code).filter((ref) => !isAllowed(ref));
    expect(
      violations,
      `禁止された import: ${violations.map((v) => v.specifier).join(', ')}\n` +
        'プラグインが依存してよいのは ../types(ToolPlugin)・node組み込み・shared/types(import typeのみ)',
    ).toEqual([]);
  });

  it('検出ロジック自体の検証: 違反パターンを正しく拾う', () => {
    const bad = collectImports(`import { AgentService } from '../../core/service';\nconst x = require('lodash');`);
    expect(bad.filter((r) => !isAllowed(r))).toHaveLength(2);
    // 値importの shared/types は禁止、型importは許可
    expect(isAllowed({ specifier: '../../../shared/types', typeOnly: false })).toBe(false);
    expect(isAllowed({ specifier: '../../../shared/types', typeOnly: true })).toBe(true);
    expect(isAllowed({ specifier: './bash', typeOnly: false })).toBe(false);
  });
});
