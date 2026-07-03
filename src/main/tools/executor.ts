import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { AutoApproveSettings, DiffLine } from '../../shared/types';
import type { ApprovalBroker } from '../agent/approval';
import { lineDiff } from '../util/diff';
import type { ToolContext, ToolPlugin, ToolResult } from './types';

/** ToolRegistry を構造的に満たす最小インターフェース(テスト・エージェントループから注入) */
export interface ToolLookup {
  get(name: string): ToolPlugin | undefined;
}

export interface ExecutorDeps {
  registry: ToolLookup;
  broker: ApprovalBroker;
  getAutoApprove: () => AutoApproveSettings;
}

/** write_file / edit_file の承認ダイアログ用diffを作る。失敗しても承認自体は止めない */
async function buildDiffPreview(
  toolName: string,
  input: unknown,
  ctx: ToolContext,
): Promise<DiffLine[] | undefined> {
  if (typeof input !== 'object' || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const path = rec['path'];
  if (typeof path !== 'string') return undefined;
  const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);

  try {
    if (toolName === 'write_file' && typeof rec['content'] === 'string') {
      const before = await readFile(abs, 'utf8').catch(() => '');
      return lineDiff(before, rec['content']);
    }
    if (toolName === 'edit_file' && typeof rec['old_string'] === 'string' && typeof rec['new_string'] === 'string') {
      return lineDiff(rec['old_string'], rec['new_string']);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 承認フローを通してツールを実行する。エージェントループ(M3)とデバッグパネル共用の入口 */
export async function executeToolWithApproval(
  deps: ExecutorDeps,
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const plugin = deps.registry.get(name);
  if (!plugin) return { content: `未知のツール: ${name}`, isError: true };

  const auto = deps.getAutoApprove();
  const needsApproval = !auto[plugin.risk] && !deps.broker.isSessionAllowed(name);

  if (needsApproval) {
    const decision = await deps.broker.request(
      {
        toolName: plugin.name,
        risk: plugin.risk,
        inputPreview: JSON.stringify(input, null, 2) ?? String(input),
        diff: await buildDiffPreview(plugin.name, input, ctx),
        warnings: plugin.warnings ?? [],
      },
      ctx.signal,
    );
    if (decision === 'deny') {
      return { content: 'ユーザーがツール実行を拒否した', isError: true };
    }
    if (decision === 'allow-session') deps.broker.allowForSession(name);
  }

  try {
    return await plugin.execute(input, ctx);
  } catch (err) {
    return { content: `ツール実行例外: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
