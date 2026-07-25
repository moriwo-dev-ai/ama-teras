import { resolve, sep } from 'node:path';
import { runWorkSubAgent, type SubAgentTools } from '../agent/subagent';
import type { LLMProvider } from '../providers/types';
import { collectDeclaredPaths } from '../tools/executor';
import type { ToolContext, ToolPlugin, ToolResult } from '../tools/types';
import { TaskWorktreeManager, type TaskWorktreeInfo } from './taskWorktree';

/**
 * M108: バックグラウンドタスク — 隔離worktreeでのサブエージェント実行。
 *
 * 原理は進化のB環境と同じ: **worktree内は機械的スコープ制限つきで自動実行**
 * (使い捨てのコピーなので個別承認は不要)、**本体への取り込みだけが承認制**(diff全文)。
 *
 * v1のツール制限: read_file / write_file / edit_file / list_dir / grep のみ。
 * bash は与えない — bash は cd でworktreeの外に出られるため、機械的スコープ保証が
 * 成立しない(進化ジョブが restrictExec で検証コマンドだけに絞るのと同じ理由)。
 * 実行を要する検証は、取り込み後に本体側のエージェントが通常の承認フローで行う。
 */

export const BACKGROUND_ALLOWED_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep'] as const;

export interface BackgroundTaskRecord {
  id: number;
  instruction: string;
  status: 'running' | 'done' | 'failed' | 'applied' | 'discarded';
  summary: string;
  /** done時のみ: 取り込み待ちのpatch(空=変更なし) */
  patch: string;
  worktree: TaskWorktreeInfo | null;
  startedAt: string;
}

export interface BackgroundTasksDeps {
  worktrees: TaskWorktreeManager;
  provider: () => LLMProvider;
  registry: { list(): ToolPlugin[]; get(name: string): ToolPlugin | undefined };
  /** 完了・失敗を会話へ自動投入する(M107のresumeConversation) */
  notify: (text: string) => void;
  maxTurns?: number;
}

/** path が root 配下か(worktree脱出の機械的検査。相対・絶対の両方を root 基準で解決) */
export function isInsideRoot(root: string, path: string): boolean {
  const abs = resolve(root, path);
  const normRoot = resolve(root);
  return abs === normRoot || abs.startsWith(normRoot + sep);
}

export class BackgroundTasks {
  private readonly tasks = new Map<number, BackgroundTaskRecord>();
  private nextId = 1;

  constructor(private readonly deps: BackgroundTasksDeps) {}

  list(): BackgroundTaskRecord[] {
    return [...this.tasks.values()];
  }

  get(id: number): BackgroundTaskRecord | undefined {
    return this.tasks.get(id);
  }

  /** タスクを開始し、即座にIDを返す(実行は非同期。完了はnotify経由で会話へ届く) */
  async dispatch(instruction: string): Promise<{ id: number }> {
    const id = this.nextId++;
    const rec: BackgroundTaskRecord = {
      id,
      instruction,
      status: 'running',
      summary: '',
      patch: '',
      worktree: null,
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(id, rec);
    // worktree作成は同期的に待つ(非gitワークスペース等の失敗を呼び出し元へ即返す)
    rec.worktree = await this.deps.worktrees.create(id);
    void this.run(rec); // 以降は非同期
    return { id };
  }

  private async run(rec: BackgroundTaskRecord): Promise<void> {
    const wt = rec.worktree!;
    try {
      const summary = await runWorkSubAgent(
        {
          provider: this.deps.provider(),
          tools: this.restrictedTools(),
          cwd: wt.dir,
          executeTool: (name, input, ctx) => this.executeScoped(wt.dir, name, input, ctx),
          ...(this.deps.maxTurns !== undefined ? { maxTurns: this.deps.maxTurns } : {}),
        },
        rec.id,
        `${rec.instruction}\n\n(注: あなたは隔離worktreeで作業している。変更はdiffとして提示され、人間の承認後に本体へ取り込まれる。使えるのはファイル読み書き系ツールのみ=コマンド実行はできない)`,
        new AbortController().signal,
      );
      rec.summary = summary.slice(0, 2000);
      rec.patch = await this.deps.worktrees.diff(wt);
      rec.status = 'done';
      const head = rec.patch === '' ? '(変更なし)' : `patch ${Math.ceil(rec.patch.length / 1024)}KB`;
      this.deps.notify(
        `[bg-task #${rec.id} 完了] ${head}\n要約: ${rec.summary.slice(0, 500)}\n` +
          (rec.patch === ''
            ? 'ファイル変更は無かった。worktreeは破棄してよい(discard)。'
            : `取り込むなら apply_background_task {"taskId": ${rec.id}} を呼ぶこと(承認ダイアログでdiffの適用可否を人間が決める)。捨てるなら discard。diff先頭:\n${rec.patch.slice(0, 1500)}`),
      );
    } catch (err) {
      rec.status = 'failed';
      rec.summary = err instanceof Error ? err.message : String(err);
      this.deps.notify(`[bg-task #${rec.id} 失敗] ${rec.summary.slice(0, 300)}(本体は無傷。worktreeは破棄される)`);
      await this.discard(rec.id).catch(() => {});
    }
  }

  /** 許可リストのツールだけを子に見せる */
  private restrictedTools(): SubAgentTools {
    const allowed = new Set<string>(BACKGROUND_ALLOWED_TOOLS);
    const list = (): ToolPlugin[] => this.deps.registry.list().filter((p) => allowed.has(p.name));
    return { list, get: (name) => (allowed.has(name) ? this.deps.registry.get(name) : undefined) };
  }

  /**
   * worktree内スコープの直接実行。承認は挟まない(使い捨てコピーのため)代わりに、
   * ツールが宣言する全パスがworktree配下であることを機械検査する(脱出=即エラー)
   */
  private async executeScoped(root: string, name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!(BACKGROUND_ALLOWED_TOOLS as readonly string[]).includes(name)) {
      return { content: `バックグラウンドタスクでは ${name} は使えない(許可: ${BACKGROUND_ALLOWED_TOOLS.join('/')})`, isError: true };
    }
    const plugin = this.deps.registry.get(name);
    if (plugin === undefined) return { content: `未知のツール: ${name}`, isError: true };
    // collectDeclaredPaths は cwd 基準で絶対化して返す(executorと同じ検査基盤を使う)
    for (const p of collectDeclaredPaths(plugin, input, root)) {
      if (!isInsideRoot(root, p)) {
        return { content: `worktreeの外へのアクセスは禁止: ${p}(隔離タスクは ${root} の中だけで作業する)`, isError: true };
      }
    }
    return plugin.execute(input, { ...ctx, cwd: root });
  }

  /** 承認後の取り込み(呼び出し側=apply_background_taskツールが承認フローを通る) */
  async apply(id: number): Promise<string> {
    const rec = this.tasks.get(id);
    if (rec === undefined) return `タスク#${id}は存在しない`;
    if (rec.status !== 'done') return `タスク#${id}は取り込める状態ではない(${rec.status})`;
    if (rec.patch === '') return `タスク#${id}に変更は無い(取り込むものが無い)`;
    await this.deps.worktrees.applyPatch(rec.patch);
    rec.status = 'applied';
    if (rec.worktree !== null) await this.deps.worktrees.remove(rec.worktree).catch(() => {});
    return `タスク#${id}のpatchを本体へ適用した(worktreeは破棄済み)`;
  }

  /** 破棄(本体は無傷) */
  async discard(id: number): Promise<string> {
    const rec = this.tasks.get(id);
    if (rec === undefined) return `タスク#${id}は存在しない`;
    if (rec.worktree !== null) await this.deps.worktrees.remove(rec.worktree).catch(() => {});
    if (rec.status !== 'applied') rec.status = 'discarded';
    return `タスク#${id}のworktreeを破棄した(本体は無傷)`;
  }
}
