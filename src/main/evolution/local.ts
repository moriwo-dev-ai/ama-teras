import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvolutionEvent, EvolutionJobSummary, PluginManifest } from '../../shared/types';
import { extractPermissions } from '../registry/permissions';
import { installPlugin, pluginDangerWarnings } from '../tools/install';
import { assertSafeToolName } from '../tools/name';
import { verifyPlugin, type PluginVerifyResult } from '../tools/verify';
import { PLUGIN_API_VERSION } from '../tools/versioning';
import { GenerationBudget } from './budget';
import { GenerationMetrics, type GenerationOutcome } from './metrics';
import type { EvolutionJobRunner, EvolutionRequest } from './job';
import { JobStore } from './jobStore';

/**
 * M91: **配布版でツールを作れなかった問題**の本体。
 *
 * 従来の進化パイプラインは「B環境(git worktree)を作り、リポジトリ全体を typecheck/vitest/build
 * して昇格(マージ+タグ)」だった。配布版にはソースツリーも .git も devDependencies も無い。
 * だから配布版の enqueue は常に例外を投げていた — **ツールを作れるのは開発機だけ**だった。
 *
 * だがツールはプラグイン=葉っぱで、コアを壊せない(import できるのは型と node 組み込みだけ。
 * ガードレールが機械検出する)。ならば **git もマージもタグも要らない**:
 *
 *   生成(サンドボックスに書かせる) → プラグイン単位の検証(tools/verify.ts) →
 *   全文承認 → userData/plugins に配置 → ホットリロード
 *
 * これが LocalToolEvolution。開発版の EvolutionManager と同じ EvolutionLike を満たすので、
 * UI(進化タブ・承認ダイアログ)も request_capability も、そのまま繋がる。
 * ※ scope が renderer/core の依頼はここでは扱えない(コアは配布版では書き換えない。
 *    それは「要望」としてリポジトリへ上げる — 別タスク)
 */

export interface LocalEvolutionDeps {
  /** 生成サンドボックスと検証の作業場(userData/plugin-gen) */
  workDir: string;
  /** 導入先(userData/plugins) */
  userPluginsDir: string;
  /** ToolPlugin 型のルート(main/tools/types.ts と shared/types.ts を含む) */
  typesRoot: string;
  /** @types のルート(node の型) */
  typeRoots?: string;
  /** TypeScript標準ライブラリ(lib.*.d.ts)のディレクトリ。配布版は同梱先を渡す */
  libDir?: string;
  runner: EvolutionJobRunner;
  /** 全文承認(承認ダイアログ)。false で rejected */
  requestPromotionApproval: (
    job: EvolutionJobSummary,
    code: string,
    warnings: string[],
  ) => Promise<boolean>;
  /** 導入後のホットリロード */
  reloadPlugins: () => Promise<void>;
  onEvent: (e: EvolutionEvent) => void;
  existingToolNames?: () => string[];
  /** ジョブ履歴(未指定=メモリのみ) */
  stateFile?: string;
  /** M92-A2: 生成→検証の最大試行(既定4)。M92-追加: 予算(累積キャップ2層。未注入=無制限) */
  maxGenerationAttempts?: number;
  budget?: GenerationBudget;
  estimateAttemptTokens?: number;
  /** M92-Phase0: 生成の計測(未注入なら記録しない) */
  metrics?: GenerationMetrics;
}

/** 検証の証跡。<name>.gate.json として導入先に残す(アップロード時に「本当に検証されたか」を機械が確かめる) */
export interface GateEvidence {
  toolName: string;
  ok: boolean;
  gates: PluginVerifyResult['gates'];
  pluginApiVersion: string;
  /** 検証したコードの内容ハッシュ。導入後に書き換えられたら証跡は無効になる */
  codeHash: string;
  verifiedAt: string;
  /** 'local' = このアプリのゲートで検証 */
  by: 'local';
}

export async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 証跡が「今そこにあるコード」に対するものか(導入後に書き換えられていないか) */
/** M96: 証跡ハッシュは改行正規化してから取る。開発版のプラグインはgit管理下にあり、
 *  checkout時のCRLF変換で同一内容でも生ハッシュが食い違う(実測)。LFのみの既存証跡は不変=後方互換 */
export async function codeHashOf(code: string): Promise<string> {
  return sha256(code.replaceAll('\r\n', '\n'));
}

export async function evidenceMatchesCode(evidence: GateEvidence, code: string): Promise<boolean> {
  return evidence.ok && evidence.codeHash === (await codeHashOf(code));
}

export class LocalToolEvolution {
  private readonly jobs = new Map<number, EvolutionJobSummary>();
  private queue: { id: number; req: EvolutionRequest }[] = [];
  private processing = false;
  private lastId = 0;
  private readonly store: JobStore | null;
  private activeCancel: { id: number; ac: AbortController } | null = null;

  constructor(private readonly deps: LocalEvolutionDeps) {
    this.store = deps.stateFile === undefined ? null : new JobStore(deps.stateFile);
  }

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

  cancel(id: number): boolean {
    const qi = this.queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      const job = this.jobs.get(id);
      if (job) this.update(job, { status: 'cancelled', error: 'ユーザーによりキャンセルされた' });
      return true;
    }
    const job = this.jobs.get(id);
    if (job && this.activeCancel?.id === id && (job.status === 'generating' || job.status === 'verifying')) {
      this.log(job, 'キャンセル要求を受理した');
      this.activeCancel.ac.abort();
      return true;
    }
    return false;
  }

  async enqueue(req: EvolutionRequest): Promise<number> {
    const scope = req.scope ?? 'tool';
    if (scope !== 'tool') {
      // コア/UIの書き換えは配布版では行わない(=誰の機体でも同じコアである、という前提を守る)。
      // 代わりに「要望」として開発リポジトリへ上げる経路を使う
      throw new Error(
        `配布版では ${scope}(本体コード)の書き換えはできません。全員が同じコア/UIを使う設計のためです。` +
          `本体への要望は「要望を送る」から開発リポジトリのIssueとして提出できます` +
          `(送信前に全文を確認・承認できます)。ツール(プラグイン)の生成は配布版でも動きます`,
      );
    }
    const id = ++this.lastId;
    const job: EvolutionJobSummary = {
      id,
      description: req.description,
      status: 'queued',
      log: [],
      gates: [],
      scope: 'tool',
      requiresRestart: false,
      ...(req.originConversationId !== undefined ? { originConversationId: req.originConversationId } : {}),
    };
    this.jobs.set(id, job);
    this.emit(job);
    this.queue.push({ id, req });
    void this.drain();
    return id;
  }

  private emit(job: EvolutionJobSummary): void {
    this.deps.onEvent({ kind: 'job_update', job: structuredClone(job) });
    if (this.store !== null) void this.store.save(this.list()).catch(() => {});
  }

  private update(job: EvolutionJobSummary, patch: Partial<EvolutionJobSummary>): void {
    const prevStatus = job.status;
    Object.assign(job, patch);
    this.emit(job);
    if (patch.status !== undefined && patch.status !== prevStatus) this.trackMetrics(job, patch.status);
  }

  /** M92-Phase0: 配布版でも生成の結末を計測へ流す(未注入なら何もしない) */
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
      for (;;) {
        const item = this.queue.shift();
        if (!item) break;
        await this.process(item.id, item.req);
      }
    } finally {
      this.processing = false;
    }
  }

  private async process(id: number, req: EvolutionRequest): Promise<void> {
    const job = this.jobs.get(id)!;
    const ac = new AbortController();
    this.activeCancel = { id, ac };
    const sandbox = join(this.deps.workDir, `job-${id}`);
    const stage = join(this.deps.workDir, `stage-${id}`);
    try {
      if (req.targetTool !== undefined) {
        const existing = this.deps.existingToolNames?.();
        if (existing !== undefined && !existing.includes(req.targetTool)) {
          this.update(job, { status: 'rejected', error: `target_tool "${req.targetTool}" という既存ツールが見つからない` });
          return;
        }
      }
      // Windows: 前ジョブの検証子プロセスの残ハンドルで EPERM になることがある → リトライ付き
      await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await mkdir(join(sandbox, 'src', 'main', 'tools', 'plugins'), { recursive: true });
      // 既存ツールの修正なら、現物をサンドボックスに置いてから読ませる(そうしないと編集対象が無い)
      if (req.targetTool !== undefined) {
        for (const f of [`${req.targetTool}.ts`, `${req.targetTool}.test.ts`]) {
          const src = join(this.deps.userPluginsDir, f);
          if (existsSync(src)) await copyFile(src, join(sandbox, 'src', 'main', 'tools', 'plugins', f));
        }
      }

      let verified: PluginVerifyResult | null = null;
      let toolName: string | undefined;
      let smokeInput: unknown = {};
      let feedback: string | undefined;
      // M92-A2: 最大試行(既定4)。M92-追加: 予算(累積キャップ2層)で総量を頭打ちにする
      const maxAttempts = this.deps.maxGenerationAttempts ?? 4;
      const estimateAttemptTokens = this.deps.estimateAttemptTokens ?? 8000;
      let budgetStop: string | null = null;
      let jobSpent = 0;

      for (let attempt = 1; attempt <= maxAttempts && verified?.ok !== true; attempt++) {
        if (ac.signal.aborted) throw new Error('cancelled');
        if (this.deps.budget) {
          const verdict = this.deps.budget.check(jobSpent, estimateAttemptTokens);
          if (!verdict.ok) {
            budgetStop = verdict.reason ?? '予算上限に達した';
            this.log(job, `予算上限: ${budgetStop}`);
            break;
          }
        }
        this.update(job, { status: 'generating' });
        if (attempt > 1) this.log(job, '検証ゲート不合格のため、失敗内容を渡して作り直す');
        this.deps.budget?.record(estimateAttemptTokens);
        jobSpent += estimateAttemptTokens;
        const artifacts = await this.deps.runner.generate(
          req,
          sandbox,
          (line) => this.log(job, line),
          ac.signal,
          feedback,
        );
        assertSafeToolName(artifacts.toolName);
        toolName = artifacts.toolName;
        smokeInput = artifacts.smokeInput ?? {};
        this.update(job, { toolName });

        const nameError = this.checkToolName(req, toolName);
        if (nameError !== null) {
          feedback = nameError;
          this.update(job, { gates: [{ name: 'tool-name', ok: false, detail: nameError }] });
          continue;
        }

        this.update(job, { status: 'verifying' });
        await this.stageArtifacts(sandbox, stage, toolName, req.description, smokeInput);
        verified = await verifyPlugin({
          dir: stage,
          name: toolName,
          typesRoot: this.deps.typesRoot,
          ...(this.deps.typeRoots !== undefined ? { typeRoots: this.deps.typeRoots } : {}),
          ...(this.deps.libDir !== undefined ? { libDir: this.deps.libDir } : {}),
          workDir: this.deps.workDir,
          signal: ac.signal,
        });
        this.update(job, { gates: verified.gates });
        if (!verified.ok) {
          feedback = verified.gates
            .filter((g) => !g.ok)
            .map((g) => `${g.name}: ${g.detail}`)
            .join('\n');
        }
      }
      if (ac.signal.aborted) throw new Error('cancelled');
      if (verified === null || !verified.ok || toolName === undefined) {
        this.update(job, {
          status: 'failed',
          error: budgetStop ?? '検証ゲート不合格(作り直しでも解消せず)',
        });
        return;
      }

      // 昇格 = 全文を人間に見せて承認を取る(配布版にマージもタグも無いが、**承認は必ずある**)
      this.update(job, { status: 'awaiting_promotion' });
      const code = await readFile(join(stage, `${toolName}.ts`), 'utf8');
      const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8')) as PluginManifest;
      const warnings = pluginDangerWarnings(code, manifest);
      const approved = await this.deps.requestPromotionApproval(structuredClone(job), code, warnings);
      if (!approved) {
        this.update(job, { status: 'rejected' });
        return;
      }

      this.update(job, { status: 'promoting' });
      await installPlugin(stage, this.deps.userPluginsDir, toolName);
      // 検証の証跡を残す。後から「本当にゲートを通ったのか」を機械が確かめられる
      // (アップロード可否の判断材料。コードを書き換えたら codeHash が合わなくなり無効になる)
      const evidence: GateEvidence = {
        toolName,
        ok: true,
        gates: verified.gates,
        pluginApiVersion: PLUGIN_API_VERSION,
        codeHash: await codeHashOf(code),
        verifiedAt: new Date().toISOString(),
        by: 'local',
      };
      await writeFile(
        join(this.deps.userPluginsDir, `${toolName}.gate.json`),
        JSON.stringify(evidence, null, 2),
        'utf8',
      );
      await this.deps.reloadPlugins();
      this.log(job, `導入完了: ${toolName}(検証済み。${verified.gates.map((g) => g.name).join(' → ')})`);
      this.update(job, { status: 'done' });
    } catch (err) {
      if (ac.signal.aborted) {
        this.update(job, { status: 'cancelled', error: 'ユーザーによりキャンセルされた' });
      } else {
        this.update(job, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.activeCancel = null;
      await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
      await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
  }

  private checkToolName(req: EvolutionRequest, toolName: string): string | null {
    if (req.targetTool !== undefined) {
      return toolName === req.targetTool
        ? null
        : `既存ツール「${req.targetTool}」の修正を依頼したのに、生成結果のtoolNameが「${toolName}」になっている。` +
            `ファイル名・toolNameは「${req.targetTool}」のまま修正すること`;
    }
    const existing = this.deps.existingToolNames?.();
    if (existing?.includes(toolName) === true) {
      return `toolName「${toolName}」は既存ツールと衝突している。新規のつもりなら別の名前にすること`;
    }
    return null;
  }

  /** サンドボックスの生成物を「レジストリと同じ1ディレクトリ形式」に整える(検証の入力形式) */
  private async stageArtifacts(
    sandbox: string,
    stage: string,
    name: string,
    description: string,
    smokeInput: unknown,
  ): Promise<void> {
    const src = join(sandbox, 'src', 'main', 'tools', 'plugins');
    await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await mkdir(stage, { recursive: true });
    const codePath = join(src, `${name}.ts`);
    if (!existsSync(codePath)) throw new Error(`生成物が見つからない: src/main/tools/plugins/${name}.ts`);
    const code = await readFile(codePath, 'utf8');
    await writeFile(join(stage, `${name}.ts`), code, 'utf8');
    const testPath = join(src, `${name}.test.ts`);
    if (existsSync(testPath)) await copyFile(testPath, join(stage, `${name}.test.ts`));
    const manifest: PluginManifest = {
      name,
      version: '1.0.0',
      pluginApiVersion: '^1',
      description,
      author: '',
      license: 'AGPL-3.0',
      permissions: extractPermissions(code),
      dependencies: [],
      smoke: { input: smokeInput },
    };
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
}
