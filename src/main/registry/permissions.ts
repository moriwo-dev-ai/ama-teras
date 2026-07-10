import type { PluginPermissions } from '../../shared/types';

/**
 * M27-4: プラグインコードの静的解析による権限の自動抽出と、宣言との不一致検出。
 * エクスポート時のマニフェスト自動生成と、インポート/将来のレジストリCIの
 * 「宣言外API使用=自動リジェクト」の両方で使う共通ロジック。
 *
 * 検出はモジュール参照(import/require の文字列)+代表的なグローバルAPIのみの
 * 保守的なヒューリスティック。難読化された回避は検出できないが、その層の防御は
 * B環境の検証ゲート+承認ダイアログ(diff全文+危険API警告)が担う(多層防御)。
 */

/** 引用符で囲まれたモジュール指定子を列挙する(import 'x' / from 'x' / require('x')) */
function moduleSpecifiers(code: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(re)) out.push(m[1]!);
  // 副作用import(import 'node:fs')
  const side = /import\s+['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(side)) out.push(m[1]!);
  return out;
}

const NETWORK_MODULES = new Set(['http', 'https', 'net', 'tls', 'dns', 'dgram', 'http2', 'undici', 'ws']);
const FS_MODULES = new Set(['fs', 'fs/promises']);

function stripPrefix(spec: string): string {
  return spec.startsWith('node:') ? spec.slice(5) : spec;
}

/** コードから権限を自動抽出する */
export function extractPermissions(code: string): PluginPermissions {
  const mods = moduleSpecifiers(code).map(stripPrefix);
  const childProcess = mods.includes('child_process');
  let network = mods.some((m) => NETWORK_MODULES.has(m));
  // グローバルAPI: fetch / WebSocket / XMLHttpRequest(プロパティアクセスは除外)
  if (!network) {
    network =
      /(?<![.\w])fetch\s*\(/.test(code) ||
      /new\s+WebSocket\s*\(/.test(code) ||
      /new\s+XMLHttpRequest\s*\(/.test(code);
  }
  const usesFs = mods.some((m) => FS_MODULES.has(m));
  return { network, childProcess, fsScope: usesFs ? 'workspace' : 'none' };
}

export interface PermissionCheck {
  /** 宣言外のAPI使用(=自動リジェクト対象) */
  errors: string[];
  /** 宣言はあるが使用が検出されない(過剰宣言。掲載時の注意情報) */
  warnings: string[];
}

/** 宣言(manifest)と抽出結果の突き合わせ。宣言外使用は errors、過剰宣言は warnings */
export function checkPermissions(
  declared: PluginPermissions,
  extracted: PluginPermissions,
): PermissionCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (extracted.network && !declared.network) {
    errors.push('宣言外のネットワークAPI使用を検出(permissions.network を true にして再エクスポートすること)');
  }
  if (!extracted.network && declared.network) {
    warnings.push('permissions.network が宣言されているがコードからは検出されなかった(過剰宣言)');
  }
  if (extracted.childProcess && !declared.childProcess) {
    errors.push('宣言外の child_process 使用を検出(permissions.childProcess を true にして再エクスポートすること)');
  }
  if (!extracted.childProcess && declared.childProcess) {
    warnings.push('permissions.childProcess が宣言されているがコードからは検出されなかった(過剰宣言)');
  }
  if (extracted.fsScope === 'workspace' && declared.fsScope === 'none') {
    errors.push('宣言外のファイルAPI使用を検出(permissions.fsScope を "workspace" にすること)');
  }
  if (extracted.fsScope === 'none' && declared.fsScope === 'workspace') {
    warnings.push('permissions.fsScope: "workspace" が宣言されているがファイルAPIは検出されなかった(過剰宣言)');
  }
  return { errors, warnings };
}
