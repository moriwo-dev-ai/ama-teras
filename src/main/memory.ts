import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendToLearnedSection } from './tools/plugins/memory';

/**
 * プロジェクト記憶(M8-2)。作業フォルダの AMATERAS.md を読み、system プロンプトへ
 * 注入する。ユーザーがこのワークスペースに定めた規約・文脈を毎回反映させる。
 * M17-1: 旧名(MYCODEX.md / MYCODEX_PLAN.md)は後方互換で読み込み、初回書き込み時に新名へ移行する。
 */
export const MEMORY_FILENAME = 'AMATERAS.md';
export const LEGACY_MEMORY_FILENAME = 'MYCODEX.md';

/** 新名があれば新名、無ければ旧名(それも無ければ新名)を読む */
function resolveRead(dir: string, newName: string, legacyName: string): string {
  const next = join(dir, newName);
  if (existsSync(next)) return next;
  const legacy = join(dir, legacyName);
  return existsSync(legacy) ? legacy : next;
}

/** 初回書き込み時の移行: 旧名だけが存在するなら新名へリネーム(失敗時はコピーで代替) */
function migrateLegacy(dir: string, newName: string, legacyName: string): void {
  const next = join(dir, newName);
  const legacy = join(dir, legacyName);
  if (existsSync(next) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, next);
  } catch {
    try {
      copyFileSync(legacy, next);
    } catch {
      // 移行失敗でも読み取りフォールバックが効くため続行
    }
  }
}

export function memoryPath(workspaceDir: string): string {
  return join(workspaceDir, MEMORY_FILENAME);
}

/** プロジェクト記憶を読む。無ければ空文字(不在は正常)。旧名 MYCODEX.md も後方互換で読む */
export function readProjectMemory(workspaceDir: string): string {
  try {
    return readFileSync(resolveRead(workspaceDir, MEMORY_FILENAME, LEGACY_MEMORY_FILENAME), 'utf8');
  } catch {
    return '';
  }
}

export function writeProjectMemory(workspaceDir: string, content: string): void {
  migrateLegacy(workspaceDir, MEMORY_FILENAME, LEGACY_MEMORY_FILENAME);
  const p = memoryPath(workspaceDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

/**
 * M13-1: 「## 学習メモ」節へタイムスタンプ付きで1件追記する。
 * compaction の記憶退避(要約で消える範囲の重要知見)が使う。失敗は握りつぶさず投げる
 */
export function appendLearnedMemory(workspaceDir: string, entry: string): void {
  migrateLegacy(workspaceDir, MEMORY_FILENAME, LEGACY_MEMORY_FILENAME);
  const p = memoryPath(workspaceDir);
  const current = ((): string => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  })();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, appendToLearnedSection(current, entry), 'utf8');
}

/** ベースの system プロンプトにプロジェクト記憶を連結する(空なら素通し) */
export function composeSystemPrompt(base: string, memory: string): string {
  if (memory.trim() === '') return base;
  return (
    `${base}\n\n# プロジェクト固有の指示(${MEMORY_FILENAME})\n` +
    'このワークスペースでユーザーが定めた規約・文脈。一般規範より優先して従うこと。\n\n' +
    memory.trim()
  );
}

/**
 * M12-2: 計画ファイル(AMATERAS_PLAN.md)。plan ツールが書き、毎ターン system prompt へ
 * 注入することで、compaction(要約畳み込み)後もタスクリストが失われないようにする。
 */
export const PLAN_FILENAME = 'AMATERAS_PLAN.md';
export const LEGACY_PLAN_FILENAME = 'MYCODEX_PLAN.md';

export function planPath(workspaceDir: string): string {
  return join(workspaceDir, PLAN_FILENAME);
}

/** 計画ファイルを読む。無ければ空文字(不在は正常)。旧名 MYCODEX_PLAN.md も後方互換で読む */
export function readProjectPlan(workspaceDir: string): string {
  try {
    return readFileSync(resolveRead(workspaceDir, PLAN_FILENAME, LEGACY_PLAN_FILENAME), 'utf8');
  } catch {
    return '';
  }
}

/** system プロンプト末尾に現在の計画を連結する(空なら素通し) */
export function composePlanSection(base: string, plan: string): string {
  if (plan.trim() === '') return base;
  return (
    `${base}\n\n## 現在の計画(${PLAN_FILENAME})\n` +
    '進行中のタスクリスト。作業を進めたら plan ツールで「- [x]」へ更新すること。\n\n' +
    plan.trim()
  );
}
