import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** ベースの system プロンプトにプロジェクト記憶を連結する(空なら素通し) */
export function composeSystemPrompt(base: string, memory: string): string {
  if (memory.trim() === '') return base;
  return (
    `${base}\n\n# プロジェクト固有の指示(${MEMORY_FILENAME})\n` +
    'このワークスペースでユーザーが定めた規約・文脈。一般規範より優先して従うこと。\n\n' +
    memory.trim()
  );
}
