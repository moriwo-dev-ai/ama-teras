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
 *   refs/amateras/checkpoints/<sessionId> だけを動かす
 * - workspace が AMA-teras リポジトリ自身でも安全(refs/amateras/ 以外に触らない)
 * - git の無い workspace では完全 noop(ログのみ)
 * - 復元は作業ツリーのみ(git restore --source=<sha> --worktree -- . 相当)。
 *   復元前に現状態を pre-restore セッションへ自動退避する
 *
 * 既知の制約: 復元は「上書き」であり、チェックポイント作成後に増えたファイルは削除しない
 * (誤削除より安全側に倒す。必要なら pre-restore から往復できる)。
 *
 * M27-7(旧称一掃): ref 名は refs/mycodex/ → refs/amateras/ へ移行した。
 * 旧 ref は初回アクセス時に新名へ自動移行し(migrateLegacyRefs)、旧メッセージ接頭辞
 * '[mycodex-checkpoint] ' は読み取り互換として認識し続ける(移行元参照なので残す)
 */

const MESSAGE_PREFIX = '[amateras-checkpoint] ';
/** 〜M27-6 のチェックポイントが持つ接頭辞(読み取り互換のみ。新規作成には使わない) */
const LEGACY_MESSAGE_PREFIX = '[mycodex-checkpoint] ';
const REFS_BASE = 'refs/amateras/checkpoints/';
/** 〜M27-6 の ref 置き場(移行元) */
const LEGACY_REFS_BASE = 'refs/mycodex/checkpoints/';
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
  /** M27-7: 旧 refs/mycodex/ からの移行は1インスタンス1回だけ試す */
  private legacyMigrated = false;

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
    if (this.enabled) await this.migrateLegacyRefs();
    return this.enabled;
  }

  /**
   * M27-7: 旧称の ref(refs/mycodex/checkpoints/*)を新名へ移す。
   * 新名側が既にあれば旧を消すだけ(新しい方を正とする)。失敗しても機能を止めない
   */
  private async migrateLegacyRefs(): Promise<void> {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    try {
      // 注意: for-each-ref は log と違い %x1f(hex)を解釈しない。ref名に空白は
      // 使えない(git仕様)ため空白区切りで安全に分割できる
      const out = await runGit(
        ['for-each-ref', '--format=%(objectname) %(refname)', LEGACY_REFS_BASE],
        this.workspace,
      );
      const lines = out === '' ? [] : out.split('\n');
      for (const line of lines) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) continue;
        const sha = line.slice(0, spaceIdx);
        const oldRef = line.slice(spaceIdx + 1);
        if (oldRef === '' || sha === '') continue;
        const newRef = REFS_BASE + oldRef.slice(LEGACY_REFS_BASE.length);
        if ((await this.revParse(newRef)) === null) {
          await runGit(['update-ref', newRef, sha], this.workspace);
        }
        await runGit(['update-ref', '-d', oldRef], this.workspace);
      }
      if (lines.length > 0) this.log(`checkpoint: 旧ref ${lines.length}件を refs/amateras/ へ移行した`);
    } catch (err) {
      this.log(`checkpoint 旧ref移行失敗(継続): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private refName(sessionId: string): string {
    // ref に使えない文字を機械的に無害化する(sessionId は UUID 想定)
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return REFS_BASE + safe;
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

      const tmpIndex = join(tmpdir(), `amateras-ckpt-${randomBytes(8).toString('hex')}`);
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
          'user.name=amateras-checkpoint',
          '-c',
          'user.email=checkpoint@amateras.local',
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
        ['for-each-ref', '--format=%(refname)', REFS_BASE],
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
          // チェーンの親はいずれ HEAD 以前の通常コミットに達する。そこで打ち切る。
          // M27-7: 旧接頭辞のチェックポイント(移行済みref内の過去分)も読める
          const prefix = subject.startsWith(MESSAGE_PREFIX)
            ? MESSAGE_PREFIX
            : subject.startsWith(LEGACY_MESSAGE_PREFIX)
              ? LEGACY_MESSAGE_PREFIX
              : null;
          if (prefix === null) break;
          const rest = subject.slice(prefix.length);
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
