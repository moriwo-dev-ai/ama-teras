import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { OperationScope } from '../../shared/types';

/**
 * M9: 操作スコープ判定。ワークスペース外(= system)の操作を検出し、
 * 保護領域(userData / Windowsシステム領域 / リポジトリの .git)への書き込みをハード拒否する。
 * electron 非依存(テスト可能にするため、動的なパスは DenyPaths として注入する)。
 */

/** 書き込みを無条件で拒否するWindowsシステム領域(比較は常に大文字小文字非依存) */
const WINDOWS_DENY_WRITE_ROOTS = ['c:/windows', 'c:/program files', 'c:/program files (x86)'];

export interface DenyPaths {
  /** アプリ自身の userData(config.json / secrets.json / plugin-cache を含む) */
  userDataDir?: string;
  /** MyCodexリポジトリ自身の .git(進化パイプライン以外からの書き込み禁止) */
  repoGitDir?: string;
}

export interface ScopeOptions {
  /** パス比較の大文字小文字非依存。既定: Windows でのみ true */
  caseInsensitive?: boolean;
}

/** Windows形式の絶対パス(ドライブレター or UNC)か。実行OSと異なる形式のテスト入力を判別する */
function isWindowsStyle(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}

/**
 * シンボリックリンク・`..` 経由の迂回を防ぐための正規化。
 * 存在しないパスは「存在する最も近い祖先」を realpath し、残りの成分を付け直す。
 * 実行OSと異なる形式のパス(テスト入力)は fs を触らず字句的に解決するだけにする。
 */
function toRealPath(absPath: string): string {
  const winStyle = isWindowsStyle(absPath);
  const pathMod = winStyle ? win32 : posix;
  const resolved = pathMod.resolve(absPath);
  if (winStyle !== (process.platform === 'win32')) return resolved;

  let cur = resolved;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length > 0 ? pathMod.join(real, ...rest) : real;
    } catch {
      const parent = pathMod.dirname(cur);
      if (parent === cur) return resolved; // ルートまで存在しない(ドライブ未接続等)
      rest.unshift(pathMod.basename(cur));
      cur = parent;
    }
  }
}

/** 比較用に正規化: 実パス解決 → 区切りを '/' へ → 末尾スラッシュ除去 → 必要なら小文字化 */
function normalize(p: string, caseInsensitive: boolean): string {
  let n = toRealPath(p).replaceAll('\\', '/');
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return caseInsensitive ? n.toLowerCase() : n;
}

function isUnder(child: string, root: string): boolean {
  return child === root || child.startsWith(`${root}/`);
}

function defaultCaseInsensitive(opts?: ScopeOptions): boolean {
  return opts?.caseInsensitive ?? process.platform === 'win32';
}

/** 解決後の絶対パスが workspace 配下なら 'workspace'、それ以外(UNC含む)は 'system' */
export function classifyPath(absPath: string, workspaceRoot: string, opts?: ScopeOptions): OperationScope {
  const ci = defaultCaseInsensitive(opts);
  const p = normalize(absPath, ci);
  const ws = normalize(workspaceRoot, ci);
  return isUnder(p, ws) ? 'workspace' : 'system';
}

/**
 * ハード拒否判定。該当すれば拒否理由(承認ダイアログすら出さず即エラーにする)、なければ null。
 * - userData への書き込み(secrets.json は読み取りも禁止: 暗号化済みでも鍵素材を晒さない)
 * - Windowsシステム領域への書き込み
 * - MyCodexリポジトリの .git への書き込み
 */
export function isDenied(
  absPath: string,
  kind: 'read' | 'write',
  deny: DenyPaths = {},
  opts?: ScopeOptions,
): string | null {
  const ci = defaultCaseInsensitive(opts);
  const p = normalize(absPath, ci);

  if (deny.userDataDir) {
    const userData = normalize(deny.userDataDir, ci);
    if (isUnder(p, userData)) {
      if (kind === 'write') return 'アプリ設定領域(userData)への書き込みは禁止';
      if (p === `${userData}/secrets.json`) return 'secrets.json の読み取りは禁止';
    }
  }

  if (kind === 'write') {
    const lower = normalize(absPath, true);
    for (const root of WINDOWS_DENY_WRITE_ROOTS) {
      if (isUnder(lower, root)) return `Windowsシステム領域への書き込みは禁止(${root})`;
    }
    if (deny.repoGitDir) {
      const gitDir = normalize(deny.repoGitDir, ci);
      if (isUnder(p, gitDir)) return 'MyCodexリポジトリの .git への直接書き込みは禁止';
    }
  }

  return null;
}
