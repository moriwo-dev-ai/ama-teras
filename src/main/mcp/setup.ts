import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { McpCatalogEntry, McpReadiness } from '../../shared/types';
import { evaluateReadiness, type McpReadinessInput } from './catalog';

/**
 * M93: 前提の実測(PATH 上のコマンド有無・環境変数の有無)。
 * 判定ロジックそのものは catalog.evaluateReadiness(純粋)に委ね、ここは I/O だけ担う。
 */

/** 実行ファイルが PATH 上にあるか。Windows は PATHEXT(.EXE/.CMD 等)も見る */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['PATH'] ?? env['Path'] ?? '';
  const dirs = raw.split(delimiter).filter((d) => d.trim() !== '');
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((e) => e.trim())
        .filter((e) => e !== '')
    : [''];
  for (const dir of dirs) {
    if (existsSync(join(dir, name))) return true;
    for (const ext of exts) {
      if (ext !== '' && existsSync(join(dir, name + ext))) return true;
    }
  }
  return false;
}

/** 環境変数が定義済み(かつ空でない)か。値そのものは見ない(助手は預からない) */
export function envDefined(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '';
}

export interface DetectDeps {
  hasCommand?: (name: string) => boolean;
  hasEnv?: (name: string) => boolean;
}

/** 実測して準備状況を返す。deps 差し替えでテスト可能 */
export function detectReadiness(entry: McpCatalogEntry, deps: DetectDeps = {}): McpReadiness {
  const input: McpReadinessInput = {
    hasCommand: deps.hasCommand ?? ((n) => commandOnPath(n)),
    hasEnv: deps.hasEnv ?? ((n) => envDefined(n)),
  };
  return evaluateReadiness(entry, input);
}
