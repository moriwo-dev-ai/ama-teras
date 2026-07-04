import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckpointInfo, CheckpointRestoreResult } from '../../shared/types';

/**
 * M11-3: 自動チェックポイント。workspace が git リポジトリの場合のみ有効。
 *
 * 不変条件(テストで固定):
 * - HEAD・index(ステージ)・作業ツリーを一切変更しない。スナップショットは
 *   一時 GIT_INDEX_FILE 上で add -A → write-tree → commit-tree して
 *   refs/mycodex/checkpoints/<sessionId> だけを動かす
 * - workspace が MyCodex リポジトリ自身でも安全(refs/mycodex/ 以外に触らない)
 * - git の無い workspace では完全 noop(ログのみ)
 * - 復元は作業ツリーのみ(git restore --source=<sha> --worktree -- . 相当)。
 *   復元前に現状態を pre-restore セッションへ自動退避する
 *
 * 既知の制約: 復元は「上書き」であり、チェックポイント作成後に増えたファイルは削除しない
 * (誤削除より安全側に倒す。必要なら pre-restore から往復できる)。
 */

const MESSAGE_PREFIX = '[mycodex-checkpoint] ';
/** 1セッションのチェーンを遡る上限(チェックポイント以外の履歴に達したら打ち切る) */
const LIST_LIMIT_PER_SESSION = 100;

function runGit(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(' ')} 失敗: ${stderr || err.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

export class CheckpointManager {
  /** null = 未判定(初回アクセスで git リポジトリか確認する) */
  private enabled: boolean | null = null;

  constructor(
    readonly workspace: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private async isEnabled(): Promise<boolean> {
    if (this.enabled === null) {
      try {
        await runGit(['rev-parse', '--git-dir'], this.workspace);
        this.enabled = true;
      } catch {
        this.enabled = false;
        this.log(`checkpoint: ${this.workspace} は git リポジトリではないため無効`);
      }
    }
    return this.enabled;
  }

  private refName(sessionId: string): string {
    // ref に使えない文字を機械的に無害化する(sessionId は UUID 想定)
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return `refs/mycodex/checkpoints/${safe}`;
  }

  private async revParse(ref: string): Promise<string | null> {
    try {
      const out = await runGit(['rev-parse', '--verify', '--quiet', ref], this.workspace);
      return out === '' ? null : out;
    } catch {
      return null;
    }
  }

  /**
   * 現在の作業ツリーをスナップショットする。直近チェックポイント(無ければHEAD)から
   * 変更が無ければ skip(null)。失敗してもエージェントループを止めない(ログして null)。
   */
  async snapshot(sessionId: string, label: string): Promise<string | null> {
    try {
      if (!(await this.isEnabled())) return null;
      const ref = this.refName(sessionId);
      const prev = await this.revParse(ref);
      const head = await this.revParse('HEAD');

      const tmpIndex = join(tmpdir(), `mycodex-ckpt-${randomBytes(8).toString('hex')}`);
      const env = { GIT_INDEX_FILE: tmpIndex };
      try {
        // tracked かつ .gitignore されたファイルを取りこぼさないよう HEAD の内容から始める
        if (head) await runGit(['read-tree', 'HEAD'], this.workspace, env);
        await runGit(['add', '-A', '--', '.'], this.workspace, env);
        const tree = await runGit(['write-tree'], this.workspace, env);

        const baseline = prev ?? head;
        if (baseline) {
          const baseTree = await runGit(['rev-parse', `${baseline}^{tree}`], this.workspace);
          if (baseTree === tree) return null; // 変更なし → skip
        }

        const args = [
          // ユーザーの git identity 未設定でも動くよう committer を固定する
          '-c',
          'user.name=mycodex-checkpoint',
          '-c',
          'user.email=checkpoint@mycodex.local',
          'commit-tree',
          tree,
          '-m',
          `${MESSAGE_PREFIX}${sessionId} ${label}`,
        ];
        const parent = prev ?? head;
        if (parent) args.push('-p', parent);
        const sha = await runGit(args, this.workspace, env);
        await runGit(['update-ref', ref, sha], this.workspace);
        return sha;
      } finally {
        await rm(tmpIndex, { force: true }).catch(() => {});
      }
    } catch (err) {
      this.log(`checkpoint スナップショット失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 全セッションのチェックポイントを新しい順に返す。無効時は空配列 */
  async list(): Promise<CheckpointInfo[]> {
    if (!(await this.isEnabled())) return [];
    const items: CheckpointInfo[] = [];
    try {
      const out = await runGit(
        ['for-each-ref', '--format=%(refname)', 'refs/mycodex/checkpoints/'],
        this.workspace,
      );
      const refs = out === '' ? [] : out.split('\n');
      for (const ref of refs) {
        const log = await runGit(
          ['log', `-n`, String(LIST_LIMIT_PER_SESSION), '--format=%H%x1f%cI%x1f%s', ref],
          this.workspace,
        );
        for (const line of log.split('\n')) {
          const [sha, createdAt, subject] = line.split('\x1f');
          if (!sha || !createdAt || subject === undefined) continue;
          // チェーンの親はいずれ HEAD 以前の通常コミットに達する。そこで打ち切る
          if (!subject.startsWith(MESSAGE_PREFIX)) break;
          const rest = subject.slice(MESSAGE_PREFIX.length);
          const spaceIdx = rest.indexOf(' ');
          items.push({
            sha,
            sessionId: spaceIdx === -1 ? rest : rest.slice(0, spaceIdx),
            createdAt,
            label: spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1),
          });
        }
      }
    } catch (err) {
      this.log(`checkpoint 一覧取得失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return items;
  }

  /** 指定チェックポイントの内容を作業ツリーへ復元する(HEAD/indexは不変) */
  async restore(sha: string): Promise<CheckpointRestoreResult> {
    if (!(await this.isEnabled())) {
      return { ok: false, message: 'workspace が git リポジトリではないため復元できない' };
    }
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      return { ok: false, message: `sha の形式が不正: ${sha.slice(0, 60)}` };
    }
    try {
      const type = await runGit(['cat-file', '-t', sha], this.workspace);
      if (type !== 'commit') return { ok: false, message: `commit ではない: ${type}` };
      // 復元で失う可能性のある現状態を先に退避する(戻り先を失わない)
      const backup = await this.snapshot('pre-restore', `restore ${sha.slice(0, 8)} 直前の自動退避`);
      await runGit(['restore', '--source', sha, '--worktree', '--', '.'], this.workspace);
      return {
        ok: true,
        message:
          `チェックポイント ${sha.slice(0, 8)} を作業ツリーへ復元した` +
          (backup ? `(直前の状態は pre-restore へ退避: ${backup.slice(0, 8)})` : ''),
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
