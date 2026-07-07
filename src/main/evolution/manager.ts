import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvolutionEvent, EvolutionJobSummary, EvolutionScope } from '../../shared/types';
import {
  defaultRunCommand,
  detectDangerWarnings,
  runGates as defaultRunGates,
  type CommandRunner,
  type GateOptions,
  type GatesOutcome,
} from './gates';
import { runGit } from './git';
import type { EvolutionJobRunner, EvolutionRequest } from './job';
import { assertPromotable, nextJobId, promoteBranch, rollbackMerge } from './promote';
import { SCOPE_ALLOWLISTS, scopeRequiresRestart } from './scopes';
import { WorktreeManager } from './worktree';

// 互換re-export(manager.test 等が従来のimport元として参照)
export { detectDangerWarnings } from './gates';

export interface EvolutionManagerDeps {
  repoDir: string;
  worktreeBase: string;
  baseRef?: string;
  runner: EvolutionJobRunner;
  /** 昇格前のユーザー承認(renderer のダイアログへ)。false で rejected */
  requestPromotionApproval: (
    job: EvolutionJobSummary,
    diff: string,
    warnings: string[],
  ) => Promise<boolean>;
  /** 昇格後のホットリロード(A の registry.reload) */
  reloadPlugins: () => Promise<void>;
  /** 昇格後の健全性チェック(scope='tool')。false で自動ロールバック */
  healthCheck: (toolName: string, smokeInput: unknown) => Promise<boolean>;
  /**
   * M20: renderer/core 昇格後の再ビルド+フルアプリ健全性チェック(supervisor.rebuildAndHealthBoot)。
   * 未注入なら renderer/core の昇格は失敗する(配線漏れの安全側)
   */
  rebuildAndHealthBoot?: (repoDir: string) => Promise<{ ok: boolean; output: string }>;
  /**
   * M20: 健全性確定後の再起動要求(センチネル書き込み+app.relaunch は electron 側=ipc.ts が担う)。
   * tag=昇格タグ、prevCommit=昇格前HEAD(センチネル・復旧案内用)
   */
  requestRestart?: (tag: string, prevCommit: string) => void;
  onEvent: (e: EvolutionEvent) => void;
  /** テスト用注入 */
  runGatesFn?: (opts: GateOptions) => Promise<GatesOutcome>;
  runCommand?: CommandRunner;
}

/** 進化ジョブのライフサイクル管理。ジョブは直列実行(worktree衝突と検証混線の回避) */
export class EvolutionManager {
  private readonly worktrees: WorktreeManager;
  private readonly baseRef: string;
  private readonly jobs = new Map<number, EvolutionJobSummary>();
  private queue: { id: number; req: EvolutionRequest }[] = [];
  private processing = false;
  private lastId = 0;

  constructor(private readonly deps: EvolutionManagerDeps) {
    this.worktrees = new WorktreeManager(deps.repoDir, deps.worktreeBase);
    this.baseRef = deps.baseRef ?? 'main';
  }

  list(): EvolutionJobSummary[] {
    return [...this.jobs.values()];
  }

  async enqueue(req: EvolutionRequest): Promise<number> {
    if (this.lastId === 0) this.lastId = (await nextJobId(this.deps.repoDir)) - 1;
    const id = ++this.lastId;
    const job: EvolutionJobSummary = {
      id,
      description: req.description,
      status: 'queued',
      log: [],
      gates: [],
      ...(req.originConversationId !== undefined
        ? { originConversationId: req.originConversationId }
        : {}),
    };
    this.jobs.set(id, job);
    this.emit(job);
    this.queue.push({ id, req });
    void this.drain();
    return id;
  }

  private emit(job: EvolutionJobSummary): void {
    this.deps.onEvent({ kind: 'job_update', job: structuredClone(job) });
  }

  private update(job: EvolutionJobSummary, patch: Partial<EvolutionJobSummary>): void {
    Object.assign(job, patch);
    this.emit(job);
  }

  private log(job: EvolutionJobSummary, line: string): void {
    job.log.push(line);
    this.emit(job);
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        await this.process(item.id, item.req);
      }
    } finally {
      this.processing = false;
    }
  }

  private async process(id: number, req: EvolutionRequest): Promise<void> {
    const job = this.jobs.get(id)!;
    // M20: スコープ段階化。未指定は tool(従来挙動)
    const scope: EvolutionScope = req.scope ?? 'tool';
    let worktree: Awaited<ReturnType<WorktreeManager['create']>> | null = null;
    try {
      this.update(job, {
        status: 'preparing_worktree',
        scope,
        requiresRestart: scopeRequiresRestart(scope),
      });
      worktree = await this.worktrees.create(id, this.baseRef);
      this.log(job, `B環境を作成: ${worktree.dir}(scope: ${scope})`);

      // 生成→ゲートを最大2回試行。1回目のゲート不合格は失敗内容をフィードバックして再生成する
      let artifacts: Awaited<ReturnType<EvolutionJobRunner['generate']>> | null = null;
      let gatesOk = false;
      let feedback: string | undefined;
      // NOTE: 進化ジョブのキャンセルUIは未実装のため ac.abort() を呼ぶ経路はまだ無い
      //       (将来キャンセルを足すときのための signal 配線)。
      const ac = new AbortController();
      const generate = (): ReturnType<EvolutionJobRunner['generate']> =>
        this.deps.runner.generate(req, worktree!.dir, (line) => this.log(job, line), ac.signal, feedback);

      for (let attempt = 1; attempt <= 2 && !gatesOk; attempt++) {
        this.update(job, { status: 'generating' });
        if (attempt > 1) this.log(job, 'ゲート不合格のため、フィードバック付きで再生成する');
        try {
          artifacts = await generate();
        } catch (err) {
          // 生成自体の失敗は1回だけリトライ
          if (attempt === 2) throw err;
          this.log(job, `生成失敗(リトライする): ${err instanceof Error ? err.message : String(err)}`);
          artifacts = await generate();
        }
        if (artifacts.toolName !== undefined) this.update(job, { toolName: artifacts.toolName });

        // B内の生成物をコミット(差分検査・マージの前提)
        await runGit(['add', '-A'], worktree.dir);
        await runGit(
          ['-c', 'user.name=AMA-teras Evolution', '-c', 'user.email=evolution@amateras.local',
           'commit', '--allow-empty', '-m',
           `evolve: ${artifacts.toolName ?? scope} を生成 (job-${id}, 試行${attempt})`],
          worktree.dir,
        );

        this.update(job, { status: 'verifying' });
        let smokeInputPath: string | undefined;
        if (scope === 'tool') {
          const smokeDir = await mkdtemp(join(tmpdir(), 'mycodex-smoke-'));
          smokeInputPath = join(smokeDir, 'input.json');
          await writeFile(smokeInputPath, JSON.stringify(artifacts.smokeInput ?? {}), 'utf8');
        }

        const gates = await (this.deps.runGatesFn ?? defaultRunGates)({
          repoDir: this.deps.repoDir,
          worktreeDir: worktree.dir,
          branch: worktree.branch,
          baseRef: this.baseRef,
          scope,
          allowedPaths: SCOPE_ALLOWLISTS[scope],
          ...(artifacts.toolName !== undefined ? { toolName: artifacts.toolName } : {}),
          ...(smokeInputPath !== undefined ? { smokeInputPath } : {}),
          ...(this.deps.runCommand ? { runCommand: this.deps.runCommand } : {}),
        });
        this.update(job, { gates: gates.results });

        // M20: 聖域トリップワイヤ不合格は再生成せず即reject(承認ダイアログにも出さない)
        const protectedHit = gates.results.find((r) => r.name === 'protected' && !r.ok);
        if (protectedHit) {
          this.update(job, {
            status: 'rejected',
            protectedReject: true,
            error: `保護領域のため拒否: ${protectedHit.detail}`,
          });
          return;
        }

        gatesOk = gates.ok;
        if (!gatesOk) {
          feedback = gates.results
            .filter((r) => !r.ok)
            .map((r) => `${r.name}: ${r.detail}`)
            .join('\n');
        }
      }
      if (!gatesOk || !artifacts) {
        this.update(job, { status: 'failed', error: '検証ゲート不合格(再生成でも解消せず)' });
        return;
      }

      // 承認ダイアログを出す前に昇格の前提を検査する(承認後に落ちるUX破綻を避ける)
      await assertPromotable(this.deps.repoDir, this.baseRef);

      this.update(job, { status: 'awaiting_promotion' });
      const diff = await runGit(
        ['diff', `${this.baseRef}...${worktree.branch}`],
        this.deps.repoDir,
      );
      const warnings = detectDangerWarnings(diff);
      const approved = await this.deps.requestPromotionApproval(structuredClone(job), diff, warnings);
      if (!approved) {
        this.update(job, { status: 'rejected' });
        return;
      }

      this.update(job, { status: 'promoting' });
      // M20: 昇格前HEADを記録(センチネル・セーフモード時の手動復旧案内に使う)
      const prevCommit = await runGit(['rev-parse', 'HEAD'], this.deps.repoDir);
      const { mergeCommit, tag } = await promoteBranch(
        this.deps.repoDir,
        worktree.branch,
        id,
        this.baseRef,
        job.description,
      );
      this.log(job, `昇格完了: ${tag} (${mergeCommit.slice(0, 8)})`);

      if (scope === 'tool') {
        // 従来どおり: ホットリロード+ツールスモーク健全性(再起動なし)
        await this.deps.reloadPlugins();
        const healthy = await this.deps.healthCheck(artifacts.toolName!, artifacts.smokeInput);
        if (!healthy) {
          this.log(job, '健全性チェック失敗。自動ロールバックする');
          await rollbackMerge(this.deps.repoDir, mergeCommit);
          await this.deps.reloadPlugins();
          this.update(job, { status: 'rolled_back', error: '昇格後の健全性チェック失敗によりrevert済み' });
          return;
        }
        this.update(job, { status: 'done' });
        return;
      }

      // M20: renderer/core — 健全性が確定するまで再起動しない。
      // 稼働中アプリは旧バンドルのまま、Aで再ビルド+--smoke-boot健全性チェックを行う
      this.log(job, 'Aを再ビルドして健全性チェック(この間アプリは旧バンドルで稼働継続)');
      if (this.deps.rebuildAndHealthBoot === undefined) {
        // 配線漏れの安全側: 昇格を取り消して失敗させる
        await rollbackMerge(this.deps.repoDir, mergeCommit);
        this.update(job, { status: 'failed', error: 'rebuildAndHealthBoot 未注入のためrevert済み(配線漏れ)' });
        return;
      }
      const health = await this.deps.rebuildAndHealthBoot(this.deps.repoDir);
      if (!health.ok) {
        this.log(job, `健全性チェック失敗。自動revert+旧バンドル再ビルドする: ${health.output.slice(0, 300)}`);
        await rollbackMerge(this.deps.repoDir, mergeCommit);
        const restore = await (this.deps.runCommand ?? defaultRunCommand)(
          'npm run build',
          this.deps.repoDir,
        );
        this.update(job, {
          status: 'rolled_back',
          error:
            '昇格後の健全性チェック失敗によりrevert+再ビルド済み(アプリは無停止)' +
            (restore.code === 0 ? '' : '。⚠ 旧バンドルの再ビルドにも失敗: 手動で npm run build を実行してください'),
        });
        return;
      }

      this.log(job, `健全性OK。再起動を要求する(復旧点: ${prevCommit.slice(0, 8)})`);
      this.deps.requestRestart?.(tag, prevCommit);
      this.update(job, { status: 'done' });
    } catch (err) {
      this.update(job, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (worktree) await this.worktrees.remove(worktree).catch(() => {});
    }
  }
}
