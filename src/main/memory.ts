import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendToLearnedSection } from './tools/plugins/memory';

/**
 * プロジェクト記憶(M8-2)。作業フォルダの MYCODEX.md を読み、system プロンプトへ
 * 注入する。ユーザーがこのワークスペースに定めた規約・文脈を毎回反映させる。
 */
export const MEMORY_FILENAME = 'MYCODEX.md';

export function memoryPath(workspaceDir: string): string {
  return join(workspaceDir, MEMORY_FILENAME);
}

/** MYCODEX.md を読む。無ければ空文字(不在は正常) */
export function readProjectMemory(workspaceDir: string): string {
  try {
    return readFileSync(memoryPath(workspaceDir), 'utf8');
  } catch {
    return '';
  }
}

export function writeProjectMemory(workspaceDir: string, content: string): void {
  const p = memoryPath(workspaceDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

/**
 * M13-1: 「## 学習メモ」節へタイムスタンプ付きで1件追記する。
 * compaction の記憶退避(要約で消える範囲の重要知見)が使う。失敗は握りつぶさず投げる
 */
export function appendLearnedMemory(workspaceDir: string, entry: string): void {
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
 * M12-2: 計画ファイル(MYCODEX_PLAN.md)。plan ツールが書き、毎ターン system prompt へ
 * 注入することで、compaction(要約畳み込み)後もタスクリストが失われないようにする。
 */
export const PLAN_FILENAME = 'MYCODEX_PLAN.md';

export function planPath(workspaceDir: string): string {
  return join(workspaceDir, PLAN_FILENAME);
}

/** MYCODEX_PLAN.md を読む。無ければ空文字(不在は正常) */
export function readProjectPlan(workspaceDir: string): string {
  try {
    return readFileSync(planPath(workspaceDir), 'utf8');
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
