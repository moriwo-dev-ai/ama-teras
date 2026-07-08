import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvolutionRequest } from './job';

/**
 * M25-7: 進化キューの再起動またぎ永続化。
 *
 * 背景: EvolutionManager は直列キュー(1件ずつ処理)だが、renderer/core の昇格が
 * requestRestart を呼んだ直後もキューは即座に次のジョブを処理してしまい(5秒後の
 * app.exit(0) までの間に新しいB環境作成・生成が始まりうる)、かつ EvolutionManager 自体が
 * 完全にインメモリで次回起動時に空の状態から作られるため、再起動をまたぐと
 * 「キュー中でまだ着手していなかった依頼」がエラーにも履歴にもならず消えていた。
 *
 * 対策: manager.ts 側で restartingフラグが立った時点でキューの巻き取りを止め、
 * まだ手つかずの EvolutionRequest[] をここでファイルへ退避する。次回(非セーフモード)起動時に
 * 読み戻して再度 enqueue することで、依頼そのものは失われない(生成途中の作業内容までは
 * 復元できないが、依頼を最初からやり直す形で継続できる)
 */

export const PENDING_QUEUE_FILENAME = 'evolution-pending-queue.json';

function pendingQueuePath(userDataDir: string): string {
  return join(userDataDir, PENDING_QUEUE_FILENAME);
}

function isValidRequest(v: unknown): v is EvolutionRequest {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return typeof rec['description'] === 'string' && typeof rec['expectedIO'] === 'string';
}

/** 再起動直前(旧インスタンス)に、キュー中でまだ着手していない依頼を書く。0件なら何もしない */
export function writePendingQueue(userDataDir: string, requests: EvolutionRequest[]): void {
  if (requests.length === 0) return;
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(pendingQueuePath(userDataDir), JSON.stringify(requests, null, 2), 'utf8');
}

/**
 * 起動時に読み出して即削除する(読んだら消費済み扱い。再enqueueは呼び出し側の責務)。
 * ファイルが無い/壊れている場合は空配列を返す(通常起動を妨げない)
 */
export function readAndClearPendingQueue(userDataDir: string): EvolutionRequest[] {
  const path = pendingQueuePath(userDataDir);
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    rmSync(path, { force: true });
    if (!Array.isArray(raw)) return [];
    return raw.filter(isValidRequest);
  } catch {
    rmSync(path, { force: true });
    return [];
  }
}
