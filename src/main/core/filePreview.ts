import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type { FilePreviewResult, ScopeMode } from '../../shared/types';
import { classifyPath, isDenied, type DenyPaths } from '../tools/scope';

/**
 * M15-3: 右ペインのファイルプレビュー。読み取り専用。
 * - 相対パスは workspace 基準で解決
 * - M9 のスコープ判定を通す: 保護領域は拒否、workspace外は fullPc のときのみ
 * - テキスト1MB・画像8MBまで(超過テキストは先頭を切って truncated 表示)
 */

const TEXT_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface FilePreviewPolicy {
  workspaceRoot: string;
  scopeMode: ScopeMode;
  deny: DenyPaths;
}

export type RevealResolveResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * 整理1: 「フォルダで開く」(shell.showItemInFolder)の対象解決。ファイルもフォルダも可。
 * エクスプローラーに場所を見せるだけで内容は読まずrendererにも返さないため、
 * workspace外の制限は課さない(左ペインには現在以外のプロジェクトも並ぶ)。
 * 保護領域のdenyだけは多層防御として維持する。
 */
export async function resolveRevealTarget(
  rawPath: string,
  policy: FilePreviewPolicy,
): Promise<RevealResolveResult> {
  const trimmed = rawPath.trim();
  if (trimmed === '') return { ok: false, message: 'パスが空' };
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(policy.workspaceRoot, trimmed);

  const denied = isDenied(abs, 'read', policy.deny);
  if (denied) return { ok: false, message: `保護領域のため表示不可: ${denied}` };
  try {
    await stat(abs);
  } catch {
    return { ok: false, message: `見つからない: ${abs}` };
  }
  return { ok: true, path: abs };
}

export async function previewFile(rawPath: string, policy: FilePreviewPolicy): Promise<FilePreviewResult> {
  const trimmed = rawPath.trim();
  if (trimmed === '') return { ok: false, message: 'パスが空' };
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(policy.workspaceRoot, trimmed);

  const denied = isDenied(abs, 'read', policy.deny);
  if (denied) return { ok: false, message: `保護領域のため表示不可: ${denied}` };
  if (classifyPath(abs, policy.workspaceRoot) === 'system' && policy.scopeMode !== 'fullPc') {
    return { ok: false, message: 'workspace外のファイルは fullPc モードでのみ表示できる' };
  }

  let st;
  try {
    st = await stat(abs);
  } catch {
    return { ok: false, message: `ファイルが見つからない: ${abs}` };
  }
  if (!st.isFile()) return { ok: false, message: 'ファイルではない(ディレクトリ等)' };

  const ext = extname(abs).toLowerCase();
  const imageType = IMAGE_TYPES[ext];
  if (imageType) {
    if (st.size > IMAGE_LIMIT) return { ok: false, message: `画像が大きすぎる(${Math.round(st.size / 1024 / 1024)}MB)` };
    const bytes = await readFile(abs);
    return { ok: true, path: abs, kind: 'image', dataUrl: `data:${imageType};base64,${bytes.toString('base64')}` };
  }

  const bytes = await readFile(abs);
  // バイナリ判定: 先頭8KBにNUL文字があればテキストとして表示しない
  if (bytes.subarray(0, 8192).includes(0)) {
    return { ok: false, message: 'バイナリファイルはプレビュー不可' };
  }
  const truncated = bytes.byteLength > TEXT_LIMIT;
  const content = bytes.subarray(0, TEXT_LIMIT).toString('utf8');
  return {
    ok: true,
    path: abs,
    kind: ext === '.md' || ext === '.markdown' ? 'markdown' : 'code',
    content,
    ...(truncated ? { truncated: true } : {}),
  };
}
