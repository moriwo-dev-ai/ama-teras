import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvolutionEvent, EvolutionJobSummary } from '../../shared/types';
import { runGates as defaultRunGates, type CommandRunner, type GateOptions, type GatesOutcome } from './gates';
import { runGit } from './git';
import type { EvolutionJobRunner, EvolutionRequest } from './job';
import { EVOLUTION_WRITE_ALLOWLIST } from './job';
import { nextJobId, promoteBranch, rollbackMerge } from './promote';
import { WorktreeManager } from './worktree';

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
  /** 昇格後の健全性チェック。false で自動ロールバック */
  healthCheck: (toolName: string, smokeInput: unknown) => Promise<boolean>;
  onEvent: (e: EvolutionEvent) => void;
  /** テスト用注入 */
  runGatesFn?: (opts: GateOptions) => Promise<GatesOutcome>;
  runCommand?: CommandRunner;
}

/** 生成diffからの危険操作の自己申告に加えて機械的にも検出し、承認ダイアログで明示警告する */
export function detectDangerWarnings(diffText: string): string[] {
  const warnings: string[] = [];
  if (/child_process|execFile|spawn\s*\(/.test(diffText)) {
    warnings.push('child_process(コマンド実行)を使用するコードを含む');
  }
  if (/fetch\s*\(|node:https?|node:net|node:dgram|XMLHttpRequest|WebSocket/.test(diffText)) {
    warnings.push('ネットワークアクセスを行う可能性のあるコードを含む');
  }
  return warnings;
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
    let worktree: Awaited<ReturnType<WorktreeManager['create']>> | null = null;
    try {
      this.update(job, { status: 'preparing_worktree' });
      worktree = await this.worktrees.create(id, this.baseRef);
      this.log(job, `B環境を作成: ${worktree.dir}`);

      this.update(job, { status: 'generating' });
      const ac = new AbortController();
      const artifacts = await this.deps.runner.generate(
        req,
        worktree.dir,
        (line) => this.log(job, line),
        ac.signal,
      );
      this.update(job, { toolName: artifacts.toolName });

      // B内の生成物をコミット(差分検査・マージの前提)
      await runGit(['add', '-A'], worktree.dir);
      await runGit(
        ['-c', 'user.name=MyCodex Evolution', '-c', 'user.email=evolution@mycodex.local',
         'commit', '-m', `evolve: ${artifacts.toolName} を生成 (job-${id})`],
        worktree.dir,
      );

      this.update(job, { status: 'verifying' });
      const smokeDir = await mkdtemp(join(tmpdir(), 'mycodex-smoke-'));
      const smokeInputPath = join(smokeDir, 'input.json');
      await writeFile(smokeInputPath, JSON.stringify(artifacts.smokeInput ?? {}), 'utf8');

      const gates = await (this.deps.runGatesFn ?? defaultRunGates)({
        repoDir: this.deps.repoDir,
        worktreeDir: worktree.dir,
        branch: worktree.branch,
        baseRef: this.baseRef,
        allowedPaths: EVOLUTION_WRITE_ALLOWLIST,
        toolName: artifacts.toolName,
        smokeInputPath,
        ...(this.deps.runCommand ? { runCommand: this.deps.runCommand } : {}),
      });
      this.update(job, { gates: gates.results });
      if (!gates.ok) {
        this.update(job, { status: 'failed', error: '検証ゲート不合格' });
        return;
      }

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
      const { mergeCommit, tag } = await promoteBranch(
        this.deps.repoDir,
        worktree.branch,
        id,
        this.baseRef,
      );
      this.log(job, `昇格完了: ${tag} (${mergeCommit.slice(0, 8)})`);
      await this.deps.reloadPlugins();

      const healthy = await this.deps.healthCheck(artifacts.toolName, artifacts.smokeInput);
      if (!healthy) {
        this.log(job, '健全性チェック失敗。自動ロールバックする');
        await rollbackMerge(this.deps.repoDir, mergeCommit);
        await this.deps.reloadPlugins();
        this.update(job, { status: 'rolled_back', error: '昇格後の健全性チェック失敗によりrevert済み' });
        return;
      }

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
