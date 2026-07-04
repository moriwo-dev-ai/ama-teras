import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { AutoApproveSettings, DiffLine, OperationScope, ScopeMode } from '../../shared/types';
import type { ApprovalBroker } from '../agent/approval';
import { lineDiff } from '../util/diff';
import { classifyPath, isDenied, type DenyPaths } from './scope';
import type { ToolContext, ToolPlugin, ToolResult } from './types';

/** ToolRegistry を構造的に満たす最小インターフェース(テスト・エージェントループから注入) */
export interface ToolLookup {
  get(name: string): ToolPlugin | undefined;
}

/** M9: スコープ制御の方針。通常セッション(ipc)から注入する */
export interface ScopePolicy {
  mode: ScopeMode;
  workspaceRoot: string;
  deny: DenyPaths;
}

/** M9-4: system スコープ操作の監査イベント(audit.jsonl の1行になる) */
export interface ScopeAuditEvent {
  tool: string;
  scope: OperationScope;
  paths: string[];
  event: 'hard-deny' | 'approval' | 'result';
  detail: string;
}

export interface ExecutorDeps {
  registry: ToolLookup;
  broker: ApprovalBroker;
  getAutoApprove: () => AutoApproveSettings;
  /**
   * M9: スコープ制御。未指定なら従来挙動のまま(進化ジョブは writeAllowlist / restrictExec が
   * 別途機械的に制限しており、本ポリシーの影響を受けない)。
   */
  getScopePolicy?: () => ScopePolicy;
  /** M9-4: system スコープの承認/拒否/実行結果の監査ログ。失敗しても実行は止めない */
  audit?: (e: ScopeAuditEvent) => void;
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

/** pathParams で宣言されたパス値を cwd 基準の絶対パスへ解決する。値が無ければ cwd を対象とみなす */
function collectDeclaredPaths(plugin: ToolPlugin, input: unknown, cwd: string): string[] {
  if (!plugin.pathParams || plugin.pathParams.length === 0) return [];
  const rec = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const out: string[] = [];
  for (const key of plugin.pathParams) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim() !== '') out.push(isAbsolute(v) ? resolve(v) : resolve(cwd, v));
  }
  // list_dir / grep の path 省略時は cwd が対象になるため、cwd で判定する
  if (out.length === 0) out.push(resolve(cwd));
  return out;
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

  // ---- M9: スコープ判定(ハード拒否 → project拒否 / fullPc強制承認) ----
  const policy = deps.getScopePolicy?.();
  let scope: OperationScope | undefined;
  let resolvedPaths: string[] | undefined;
  const scopeWarnings: string[] = [];

  if (policy) {
    const kind = plugin.risk === 'write' ? 'write' : 'read';
    const paths = collectDeclaredPaths(plugin, input, ctx.cwd);
    for (const abs of paths) {
      const reason = isDenied(abs, kind, policy.deny);
      if (reason) {
        // 保護領域は承認ダイアログすら出さず即エラー(設計 M9「ハード拒否」)
        deps.audit?.({ tool: plugin.name, scope: 'system', paths: [abs], event: 'hard-deny', detail: reason });
        return { content: `保護領域のため拒否: ${reason}(${abs})`, isError: true };
      }
    }
    scope = paths.some((p) => classifyPath(p, policy.workspaceRoot) === 'system') ? 'system' : 'workspace';
    if (scope === 'system') {
      if (policy.mode === 'project') {
        return {
          content:
            `プロジェクト外の操作は現在の設定(scopeMode: 'project')では拒否される。` +
            `対象: ${paths.join(', ')}。設定で fullPc を有効にすると毎回承認制で許可できる`,
          isError: true,
        };
      }
      resolvedPaths = paths;
    }
  }

  // system スコープは autoApprove / allow-session に関係なく毎回承認(設計の中核不変条件)
  const forced = scope === 'system';
  const auto = deps.getAutoApprove();
  const needsApproval = forced || (!auto[plugin.risk] && !deps.broker.isSessionAllowed(name));

  if (needsApproval) {
    const decision = await deps.broker.request(
      {
        toolName: plugin.name,
        risk: plugin.risk,
        inputPreview: JSON.stringify(input, null, 2) ?? String(input),
        diff: await buildDiffPreview(plugin.name, input, ctx),
        warnings: [...(plugin.warnings ?? []), ...scopeWarnings],
        ...(scope !== undefined ? { scope } : {}),
        ...(resolvedPaths !== undefined ? { resolvedPaths } : {}),
      },
      ctx.signal,
    );
    if (forced) {
      deps.audit?.({
        tool: plugin.name,
        scope: 'system',
        paths: resolvedPaths ?? [],
        event: 'approval',
        detail: decision === 'deny' ? 'deny' : 'allow',
      });
    }
    if (decision === 'deny') {
      return { content: 'ユーザーがツール実行を拒否した', isError: true };
    }
    // system スコープでは allow-session を受理しても記憶しない(毎回確認する)
    if (decision === 'allow-session' && !forced) deps.broker.allowForSession(name);
  }

  try {
    const result = await plugin.execute(input, ctx);
    if (forced) {
      deps.audit?.({
        tool: plugin.name,
        scope: 'system',
        paths: resolvedPaths ?? [],
        event: 'result',
        detail: result.isError === true ? `error: ${result.content.slice(0, 200)}` : 'ok',
      });
    }
    return result;
  } catch (err) {
    return { content: `ツール実行例外: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
