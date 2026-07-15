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
import { GenerationBudget } from './budget';
import { GenerationMetrics, type GenerationOutcome } from './metrics';
import { runGit } from './git';
import type { EvolutionJobRunner, EvolutionRequest } from './job';
import { JobStore } from './jobStore';
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
  /**
   * M25-8: 現在Aで実際にロードされているツール名一覧(scope='tool'の新規/修正判定に使う)。
   * 未注入なら衝突チェックはスキップする(配線漏れで新規作成そのものが止まらないようにする)
   */
  existingToolNames?: () => string[];
  /**
   * M52: ジョブ履歴の保存先(userData/evolution/jobs.json)。
   * 未注入ならメモリのみ = 再起動で履歴が消える(テストの既定)
   */
  stateFile?: string;
  /** テスト用注入 */
  runGatesFn?: (opts: GateOptions) => Promise<GatesOutcome>;
  runCommand?: CommandRunner;
  /**
   * M92-A2: 生成→ゲートの最大試行回数(既定 4。以前は 2 固定)。Claude Code のように
   * 「失敗→フィードバックで直す」を厚くするほど成功率が上がる。予算(budget)で総量は守る。
   */
  maxGenerationAttempts?: number;
  /**
   * M92-追加: 生成の予算ガード(累積キャップ2層)。未注入なら無制限(従来どおり)。
   * 各試行の前に check し、超過ならジョブを打ち切る。試行後に概算トークンを record する。
   */
  budget?: GenerationBudget;
  /**
   * 1試行あたりの概算トークン(予算計上に使う。実測を配線するまでの安全側の見積り。既定 8000)。
   * これにより「リトライを厚くしても総量は budget で頭打ち」が成立する。
   */
  estimateAttemptTokens?: number;
  /**
   * M92-Phase0: 生成の計測(成功率・試行回数・所要時間・失敗内訳)。未注入なら記録しない。
   * どのレバー(手本/反復/…)が効いたかを後から測るための土台。
   */
  metrics?: GenerationMetrics;
}

/** 進化ジョブのライフサイクル管理。ジョブは直列実行(worktree衝突と検証混線の回避) */
export class EvolutionManager {
  private readonly worktrees: WorktreeManager;
  private readonly baseRef: string;
  private readonly jobs = new Map<number, EvolutionJobSummary>();
  private queue: { id: number; req: EvolutionRequest }[] = [];
  private processing = false;
  private lastId = 0;
  /** M52: ジョブ履歴の保存先(未注入=メモリのみ) */
  private readonly store: JobStore | null;
  /** M50: 残骸掃除は起動後の最初の enqueue で1回だけ(履歴復元でlastIdが進むので専用フラグ) */
  private swept = false;
  /** M25-7: renderer/core昇格がrequestRestartを呼んだら立つ。以降drainはキューを進めない
   *  (5秒後のapp.exit(0)までの間に次のジョブが着手→強制終了で消えるのを防ぐ) */
  private restarting = false;
  /** M26-6: 実行中ジョブのキャンセル用(直列実行なので高々1件) */
  private activeCancel: { id: number; ac: AbortController } | null = null;

  constructor(private readonly deps: EvolutionManagerDeps) {
    this.baseRef = deps.baseRef ?? 'main';
    this.worktrees = new WorktreeManager(deps.repoDir, deps.worktreeBase, this.baseRef);
    this.store = deps.stateFile === undefined ? null : new JobStore(deps.stateFile);
  }

  /** M52: 保存済みのジョブ履歴を読み戻す(起動時に1回。失敗しても進化は動かす) */
  async restore(): Promise<void> {
    if (this.store === null) return;
    for (const job of await this.store.load().catch(() => [])) {
      this.jobs.set(job.id, job);
      this.lastId = Math.max(this.lastId, job.id);
    }
  }

  list(): EvolutionJobSummary[] {
    return [...this.jobs.values()];
  }

  /** M25-7: キュー中でまだ着手していない依頼(再起動前の永続化用に公開) */
  pendingRequests(): EvolutionRequest[] {
    return this.queue.map((q) => q.req);
  }

  /**
   * M26-6: ジョブのキャンセル。queued=キューから除去して即 cancelled、
   * 実行中(preparing_worktree/generating/verifying)=AbortController.abort()で中断させる。
   * awaiting_promotion 以降は対象外(昇格ダイアログの「却下」やロールバックが担当領域)。
   * 戻り値=キャンセル要求を受理したか
   */
  cancel(id: number): boolean {
    const qi = this.queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      const job = this.jobs.get(id);
      if (job) this.update(job, { status: 'cancelled', error: 'ユーザーによりキャンセルされた' });
      return true;
    }
    const job = this.jobs.get(id);
    if (
      job !== undefined &&
      this.activeCancel?.id === id &&
      (job.status === 'preparing_worktree' || job.status === 'generating' || job.status === 'verifying')
    ) {
      this.log(job, 'キャンセル要求を受理した(実行中の処理を中断する)');
      this.activeCancel.ac.abort();
      return true;
    }
    return false;
  }

  /**
   * M29-5: 仮導入の棚卸しで「削除」されたプラグインの完全アンインストール。
   * evolve/N タグのマージコミットを revert し、プラグインをホットリロードで外す。
   * 後続変更との競合で revert できない場合は失敗を返す(ユーザーへ手動対応を案内)
   */
  async uninstallPromotion(jobId: number): Promise<{ ok: boolean; message: string }> {
    const tag = `evolve/${jobId}`;
    try {
      const commit = await runGit(['rev-list', '-n', '1', tag], this.deps.repoDir);
      if (commit === '') return { ok: false, message: `タグ ${tag} が見つからない` };
      await rollbackMerge(this.deps.repoDir, commit);
      await this.deps.reloadPlugins();
      return { ok: true, message: `${tag} を revert してアンインストールした` };
    } catch (err) {
      return {
        ok: false,
        message:
          `アンインストール失敗(後続変更との競合の可能性): ${err instanceof Error ? err.message : String(err)}。` +
          `手動で \`git revert -m 1 ${tag}\` を実行してください`,
      };
    }
  }

  async enqueue(req: EvolutionRequest): Promise<number> {
    if (!this.swept) {
      // M50: この起動で最初の1件 = ジョブは1件も走っていない。この瞬間にしか残骸掃除はできない
      // (走り出した後に evolve/job-* を消すと、動いているB環境を足元から消すことになる)
      this.swept = true;
      await this.worktrees.sweepStale().catch(() => []);
      // 復元した履歴の最大IDとgit由来のIDの大きいほう(履歴・タグ・ブランチのどれから見ても未使用)
      this.lastId = Math.max(this.lastId, (await nextJobId(this.deps.repoDir)) - 1);
    }
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
    // M52: 状態が動くたびに保存する。落ちる瞬間まで残っていてほしいのは、まさに落ちたジョブの記録
    if (this.store !== null) void this.store.save(this.list()).catch(() => {});
  }

  private update(job: EvolutionJobSummary, patch: Partial<EvolutionJobSummary>): void {
    const prevStatus = job.status;
    Object.assign(job, patch);
    this.emit(job);
    if (patch.status !== undefined && patch.status !== prevStatus) this.trackMetrics(job, patch.status);
  }

  /** M92-Phase0: ジョブの試行回数・所要時間・結末を計測へ流す(未注入なら何もしない) */
  private readonly jobMeta = new Map<number, { startedAt: number; attempts: number }>();
  private trackMetrics(job: EvolutionJobSummary, status: EvolutionJobSummary['status']): void {
    if (this.deps.metrics === undefined) return;
    let meta = this.jobMeta.get(job.id);
    if (meta === undefined) {
      meta = { startedAt: Date.now(), attempts: 0 };
      this.jobMeta.set(job.id, meta);
    }
    if (status === 'generating') meta.attempts += 1;
    const TERMINAL: EvolutionJobSummary['status'][] = ['done', 'failed', 'rejected', 'cancelled', 'rolled_back'];
    if (!TERMINAL.includes(status)) return;
    this.jobMeta.delete(job.id);
    const outcome: GenerationOutcome = status === 'done' ? 'promoted' : (status as GenerationOutcome);
    const failureKinds = (job.gates ?? []).filter((g) => !g.ok).map((g) => g.name);
    this.deps.metrics.record({
      jobId: job.id,
      scope: job.scope ?? 'tool',
      ...(job.toolName !== undefined ? { toolName: job.toolName } : {}),
      outcome,
      attempts: meta.attempts,
      durationMs: Date.now() - meta.startedAt,
      ...(failureKinds.length > 0 ? { failureKinds } : {}),
      ...(job.error?.includes('トークン上限') ? { budgetStopped: true } : {}),
      at: new Date().toISOString(),
    });
  }

  private log(job: EvolutionJobSummary, line: string): void {
    job.log.push(line);
    this.emit(job);
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.restarting) {
        const item = this.queue.shift();
        if (!item) break;
        await this.process(item.id, item.req);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * M25-8: 生成結果のtoolNameが依頼と整合しているか検証する(scope='tool'のみ意味を持つ)。
   * - targetTool指定(既存修正のつもり)なのに別名で生成された → 修正対象を取り違えている
   * - targetTool未指定(新規のつもり)なのに既存ツール名と衝突 → 気づかず上書き/重複してしまう
   * どちらも合格扱いにせず、フィードバック付きで再生成させる(通常のゲート不合格と同じ経路)
   */
  private checkToolNameConsistency(req: EvolutionRequest, toolName: string): string | null {
    if (req.targetTool !== undefined) {
      if (toolName !== req.targetTool) {
        return (
          `既存ツール「${req.targetTool}」の修正を依頼したのに、生成結果のtoolNameが` +
          `「${toolName}」になっている。ファイル名・toolNameを変更せず「${req.targetTool}」のまま修正すること`
        );
      }
      return null;
    }
    const existing = this.deps.existingToolNames?.();
    if (existing !== undefined && existing.includes(toolName)) {
      return (
        `toolName「${toolName}」は既に存在する既存ツールと衝突している。既存ツールを修正したいなら` +
        `target_tool で明示すること。新規ツールのつもりなら別の名前にすること`
      );
    }
    return null;
  }

  private async process(id: number, req: EvolutionRequest): Promise<void> {
    const job = this.jobs.get(id)!;
    // M20: スコープ段階化。未指定は tool(従来挙動)
    const scope: EvolutionScope = req.scope ?? 'tool';
    let worktree: Awaited<ReturnType<WorktreeManager['create']>> | null = null;
    // M26-6: キャンセルUI用。worktree作成〜検証までを中断可能にする(awaiting_promotion以降は対象外)
    const ac = new AbortController();
    this.activeCancel = { id, ac };
    try {
      // M25-8: target_tool指定なら、worktreeを作る前に対象が実在するか確認する
      if (scope === 'tool' && req.targetTool !== undefined) {
        const existing = this.deps.existingToolNames?.();
        if (existing !== undefined && !existing.includes(req.targetTool)) {
          this.update(job, {
            status: 'rejected',
            error: `target_tool "${req.targetTool}" という既存ツールが見つからない`,
          });
          return;
        }
      }
      this.update(job, {
        status: 'preparing_worktree',
        scope,
        requiresRestart: scopeRequiresRestart(scope),
      });
      worktree = await this.worktrees.create(id, this.baseRef);
      this.log(job, `B環境を作成: ${worktree.dir}(scope: ${scope})`);
      if (ac.signal.aborted) throw new Error('cancelled');

      // M92-A2: 生成→ゲートを最大 maxAttempts 回試行(既定4)。ゲート不合格は失敗内容を
      // フィードバックして再生成する。総トークンは M92-追加の予算(budget)で頭打ちにする。
      const maxAttempts = this.deps.maxGenerationAttempts ?? 4;
      const estimateAttemptTokens = this.deps.estimateAttemptTokens ?? 8000;
      let artifacts: Awaited<ReturnType<EvolutionJobRunner['generate']>> | null = null;
      let gatesOk = false;
      let feedback: string | undefined;
      let budgetStop: string | null = null;
      let jobSpent = 0;
      const generate = (): ReturnType<EvolutionJobRunner['generate']> =>
        this.deps.runner.generate(req, worktree!.dir, (line) => this.log(job, line), ac.signal, feedback);

      for (let attempt = 1; attempt <= maxAttempts && !gatesOk; attempt++) {
        if (ac.signal.aborted) throw new Error('cancelled');
        // M92-追加: 予算チェック(累積キャップ2層)。超過なら試行に入らず打ち切る
        if (this.deps.budget) {
          const verdict = this.deps.budget.check(jobSpent, estimateAttemptTokens);
          if (!verdict.ok) {
            budgetStop = verdict.reason ?? '予算上限に達した';
            this.log(job, `予算上限: ${budgetStop}`);
            break;
          }
        }
        this.update(job, { status: 'generating' });
        if (attempt > 1) this.log(job, 'ゲート不合格のため、フィードバック付きで再生成する');
        // この試行のトークンを予算へ計上(概算。実測配線までの安全側)
        this.deps.budget?.record(estimateAttemptTokens);
        jobSpent += estimateAttemptTokens;
        try {
          artifacts = await generate();
        } catch (err) {
          // M26-6: キャンセル起因の失敗はリトライせず即座に中断へ
          if (ac.signal.aborted) throw err;
          // 生成自体の失敗は1回だけリトライ
          if (attempt === 2) throw err;
          this.log(job, `生成失敗(リトライする): ${err instanceof Error ? err.message : String(err)}`);
          artifacts = await generate();
        }
        if (artifacts.toolName !== undefined) this.update(job, { toolName: artifacts.toolName });

        // M25-8: 新規作成/既存修正の名前整合性チェック(gateの前段。不一致ならgate実行やcommitを
        // 待たずに次のattemptへフィードバックする)
        if (scope === 'tool' && artifacts.toolName !== undefined) {
          const nameError = this.checkToolNameConsistency(req, artifacts.toolName);
          if (nameError !== null) {
            gatesOk = false;
            feedback = nameError;
            this.update(job, { gates: [{ name: 'tool-name', ok: false, detail: nameError }] });
            continue;
          }
        }

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
          const smokeDir = await mkdtemp(join(tmpdir(), 'amateras-smoke-'));
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
      if (ac.signal.aborted) throw new Error('cancelled');
      if (!gatesOk || !artifacts) {
        this.update(job, {
          status: 'failed',
          error: budgetStop ?? '検証ゲート不合格(再生成でも解消せず)',
        });
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
      // M25-7: 先にrestartingを立ててからdeps呼び出し(deps側がpendingRequests()で
      // キューの残りを読むより前に、drainが次のジョブへ進んでしまわないようにする)
      this.restarting = true;
      this.deps.requestRestart?.(tag, prevCommit);
      this.update(job, { status: 'done' });
    } catch (err) {
      // M26-6: キャンセル起因の中断は failed と区別する(abort後の生成側エラーも含む)
      if (ac.signal.aborted) {
        this.update(job, { status: 'cancelled', error: 'ユーザーによりキャンセルされた' });
      } else {
        this.update(job, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.activeCancel = null;
      if (worktree) await this.worktrees.remove(worktree).catch(() => {});
    }
  }
}
