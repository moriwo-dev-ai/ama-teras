import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EvolutionJobSummary } from '../../shared/types';

/** 保持するジョブ数(古いものから捨てる) */
const MAX_JOBS = 30;
/** 1ジョブあたりに残すログ行数(生成ログは長い。末尾=結論に近い側を残す) */
const MAX_LOG_LINES = 40;

/** 起動時に「実行中」で残っていたジョブ = 前回の終了で中断された */
const RUNNING: string[] = ['queued', 'preparing_worktree', 'generating', 'verifying', 'awaiting_promotion'];

/**
 * M52: 進化ジョブの履歴を永続化する。
 *
 * ジョブはこれまで**メモリ上のMapだけ**にあった。アプリを再起動すると進化タブは空になり、
 * 「ジョブ16がゲートで落ちた」という事実そのものが消える。人間も、神議も、
 * 何が失敗したかを二度と参照できない(実害: ジョブ14・15・16の失敗が毎回消えた)。
 */
export class JobStore {
  constructor(private readonly file: string) {}

  async load(): Promise<EvolutionJobSummary[]> {
    const raw = await readFile(this.file, 'utf8').catch(() => '');
    if (raw.trim() === '') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return []; // 壊れていても進化を止めない(履歴は補助情報)
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((j): j is EvolutionJobSummary => typeof j === 'object' && j !== null && 'id' in j)
      .map((j) =>
        // 前回の終了で中断されたジョブを「実行中」のまま復元すると、永遠に終わらないジョブに見える
        RUNNING.includes(j.status)
          ? { ...j, status: 'failed' as const, error: 'アプリ終了により中断された' }
          : j,
      );
  }

  async save(jobs: EvolutionJobSummary[]): Promise<void> {
    const trimmed = jobs
      .slice(-MAX_JOBS)
      .map((j) => ({ ...j, log: j.log.slice(-MAX_LOG_LINES) }));
    await mkdir(dirname(this.file), { recursive: true }).catch(() => {});
    await writeFile(this.file, JSON.stringify(trimmed, null, 1), 'utf8');
  }
}
