import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolPlugin } from '../tools/types';
import writeFilePlugin from '../tools/plugins/write_file';
import readFilePlugin from '../tools/plugins/read_file';
import { BackgroundTasks, isInsideRoot } from './backgroundTasks';
import { TaskWorktreeManager } from './taskWorktree';

/**
 * M108: バックグラウンドタスク。実git+実ツール+モックLLMで、
 * 「隔離の中では動く・外へは一歩も出られない・取り込みは明示操作のみ」を検証する。
 */

let root: string;
let repo: string;

const git = (args: string[], cwd: string): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bg-task-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** 指定のツール呼び出し列を1回ずつ返し、最後に完了するモックLLM */
function scriptedProvider(calls: { name: string; input: unknown }[]): LLMProvider {
  let turn = 0;
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      const i = turn++;
      if (i < calls.length) {
        yield {
          type: 'message_done',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: `tu-${i}`, name: calls[i]!.name, input: calls[i]!.input }],
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        } as ProviderEvent;
        return;
      }
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text: '完了: ファイルを更新した' }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      } as ProviderEvent;
    },
  };
}

const registry = (): { list(): ToolPlugin[]; get(name: string): ToolPlugin | undefined } => {
  const plugins: ToolPlugin[] = [writeFilePlugin as ToolPlugin, readFilePlugin as ToolPlugin];
  return { list: () => plugins, get: (n) => plugins.find((p) => p.name === n) };
};

describe('M108: isInsideRoot(worktree脱出の機械検査)', () => {
  it('配下はtrue、../ や絶対パスの脱出はfalse', () => {
    expect(isInsideRoot('C:/wt', 'sub/file.txt')).toBe(true);
    expect(isInsideRoot('C:/wt', 'C:/wt/x.txt')).toBe(true);
    expect(isInsideRoot('C:/wt', '../outside.txt')).toBe(false);
    expect(isInsideRoot('C:/wt', 'C:/other/x.txt')).toBe(false);
    expect(isInsideRoot('C:/wt', 'sub/../../evil.txt')).toBe(false);
  });
});

describe('M108: BackgroundTasks(実git+実ツール+モックLLM)', () => {
  const make = (provider: LLMProvider, notices: string[]): BackgroundTasks =>
    new BackgroundTasks({
      worktrees: new TaskWorktreeManager(repo, join(root, 'tasks')),
      provider: () => provider,
      registry: registry(),
      notify: (t) => notices.push(t),
      maxTurns: 5,
    });

  const waitDone = async (tasks: BackgroundTasks, id: number): Promise<void> => {
    const start = Date.now();
    while (tasks.get(id)?.status === 'running') {
      if (Date.now() - start > 15000) throw new Error('タスクが終わらない');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('worktree内の書き込み→diff生成→apply で本体に反映(却下なら無傷)', async () => {
    const notices: string[] = [];
    const tasks = make(
      scriptedProvider([{ name: 'write_file', input: { path: 'a.txt', content: 'hello\nbg-change\n' } }]),
      notices,
    );
    const { id } = await tasks.dispatch('a.txt に1行足す');
    await waitDone(tasks, id);

    const rec = tasks.get(id)!;
    expect(rec.status).toBe('done');
    expect(rec.patch).toContain('+bg-change');
    expect(notices.some((n) => n.includes(`[bg-task #${id} 完了]`))).toBe(true);
    // 本体はまだ無傷
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hello\n');

    const msg = await tasks.apply(id);
    expect(msg).toContain('適用した');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('bg-change');
    expect(tasks.get(id)!.status).toBe('applied');
  });

  it('worktreeの外への書き込みはツールが拒否され、本体もリポジトリ外も無傷', async () => {
    const escape = join(root, 'escape.txt');
    const notices: string[] = [];
    const tasks = make(
      scriptedProvider([{ name: 'write_file', input: { path: escape, content: 'evil' } }]),
      notices,
    );
    const { id } = await tasks.dispatch('外に書いてみる');
    await waitDone(tasks, id);
    expect(existsSync(escape)).toBe(false); // 脱出は一歩も許さない
    expect(tasks.get(id)!.patch.trim()).toBe(''); // worktree内にも成果なし
  });

  it('discard は本体無傷でworktreeを片付ける', async () => {
    const notices: string[] = [];
    const tasks = make(
      scriptedProvider([{ name: 'write_file', input: { path: 'b.txt', content: 'x' } }]),
      notices,
    );
    const { id } = await tasks.dispatch('捨てる予定の変更');
    await waitDone(tasks, id);
    const wtDir = tasks.get(id)!.worktree!.dir;
    const msg = await tasks.discard(id);
    expect(msg).toContain('破棄');
    expect(existsSync(wtDir)).toBe(false);
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);
    expect(tasks.get(id)!.status).toBe('discarded');
  });

  it('非gitワークスペースでは dispatch が明示エラー', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const tasks = new BackgroundTasks({
      worktrees: new TaskWorktreeManager(plain, join(root, 'tasks2')),
      provider: () => scriptedProvider([]),
      registry: registry(),
      notify: () => {},
    });
    await expect(tasks.dispatch('x')).rejects.toThrow(/gitリポジトリではない/);
  });
});
