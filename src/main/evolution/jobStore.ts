import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EvolutionJobSummary } from '../../shared/types';

/** 保持するジョブ数(古いものから捨てる) */
const MAX_JOBS = 30;
/** 1ジョブあたりに残すログ行数(生成ログは長い。末尾=結論に近い側を残す) */
const MAX_LOG_LINES = 40;

/** 起動時に「実行中」で残っていたジョブ = 前回の終了で中断された(成果は残っていない) */
const RUNNING: string[] = ['queued', 'preparing_worktree', 'generating', 'verifying'];

/**
 * M70: awaiting_promotion を RUNNING に入れていたため、**全ゲートを通過して人間の承認だけを
 * 待っていたジョブ**が、再起動のたびに「アプリ終了により中断された」失敗として上書きされていた。
 * 中断されたのは承認待ちの待機だけで、生成物はブランチに残っている。同じ「失敗」でも、
 * 捨てるしかないものと、拾い直せるものを混ぜない
 */
function restoreStatus(job: EvolutionJobSummary): EvolutionJobSummary {
  if (job.status === 'awaiting_promotion') {
    const branch = `evolve/job-${job.id}`;
    return {
      ...job,
      status: 'failed',
      error: `アプリ終了で昇格の承認待ちが失われた。検証ゲートは全て通過しており、成果はブランチ ${branch} に残っている(同じ要求を出し直すか、手動でマージできる)`,
    };
  }
  return RUNNING.includes(job.status) ? { ...job, status: 'failed', error: 'アプリ終了により中断された' } : job;
}

/**
 * M52: 進化ジョブの履歴を永続化する。
 *
 * ジョブはこれまで**メモリ上のMapだけ**にあった。アプリを再起動すると進化タブは空になり、
 * 「ジョブ16がゲートで落ちた」という事実そのものが消える。人間も、神議も、
 * 何が失敗したかを二度と参照できない(実害: ジョブ14・15・16の失敗が毎回消えた)。
 */
/**
 * 壊れたJSONから「先頭からの正しいJSON値」を回収する。
 *
 * 実害(2026-07-17): core昇格の再起動時、直列化されていない save が重なって
 * jobs.json が「正しいJSONの後ろに前の書き込みの残骸」という引き裂かれた状態になり、
 * 履歴38件が起動時に全部消えた(load が丸ごと [] に落ちるため)。
 * JSON.parse のエラーメッセージは「完全な値が終わった位置」を教えてくれるので、
 * そこまでを切り出せば残骸だけを捨てられる。
 */
export function salvageJsonPrefix(raw: string): unknown | null {
  let end = raw.length;
  for (let i = 0; i < 8 && end > 0; i++) {
    try {
      return JSON.parse(raw.slice(0, end));
    } catch (e) {
      const m = /position (\d+)/.exec(e instanceof Error ? e.message : '');
      const pos = m === null ? NaN : Number(m[1]);
      if (Number.isInteger(pos) && pos > 0 && pos < end) end = pos;
      else return null; // 位置が取れない壊れ方は諦める(補助情報のため)
    }
  }
  return null;
}

export class JobStore {
  constructor(private readonly file: string) {}

  /** 保存の直列化。fire-and-forget の save が重なるとファイルが引き裂かれる(実害あり) */
  private saveChain: Promise<void> = Promise.resolve();

  async load(): Promise<EvolutionJobSummary[]> {
    const raw = await readFile(this.file, 'utf8').catch(() => '');
    if (raw.trim() === '') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 引き裂かれたファイルでも、先頭からの正しい部分に全履歴が残っていることが多い。
      // 回収できなければ従来どおり履歴なしで進む(壊れていても進化を止めない)
      parsed = salvageJsonPrefix(raw);
      if (parsed === null) return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((j): j is EvolutionJobSummary => typeof j === 'object' && j !== null && 'id' in j)
      // 前回の終了で中断されたジョブを「実行中」のまま復元すると、永遠に終わらないジョブに見える
      .map(restoreStatus);
  }

  async save(jobs: EvolutionJobSummary[]): Promise<void> {
    // 呼び出し時点のスナップショットを直列に書く(後勝ち。途中の状態が最終状態を上書きしない)
    const trimmed = jobs
      .slice(-MAX_JOBS)
      .map((j) => ({ ...j, log: j.log.slice(-MAX_LOG_LINES) }));
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true }).catch(() => {});
        // tmp→rename のアトミック置換(書き込み途中でプロセスが死んでも原本は壊れない)
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(trimmed, null, 1), 'utf8');
        await rename(tmp, this.file);
      });
    return this.saveChain;
  }
}
