import { spawn } from 'node:child_process';
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
  /**
   * M11-4: 編集後フック。write_file / edit_file 成功直後に実行するコマンドと cwd
   * (fullPc でも cwd は workspace)。null なら無効。進化ジョブには注入されず、
   * さらに restrictExec コンテキストでは注入されていても実行しない(二重防御)。
   */
  getPostEditHook?: () => { command: string; cwd: string } | null;
}

const HOOK_TIMEOUT_MS = 60_000;
const HOOK_TAIL_BYTES = 4096;

/**
 * M11-4: 編集後フックの実行。結果は常に文字列で返し、例外を投げない
 * (フックの失敗はツール結果への「情報」であり、ツール実行自体は成功のまま)。
 * timeoutMs はテスト用に注入可能(既定60秒)。
 */
export async function runPostEditHook(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number = HOOK_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(command, { cwd, shell: true, windowsHide: true, timeout: timeoutMs, signal });
      let out = '';
      const append = (chunk: Buffer): void => {
        out += chunk.toString('utf8');
        // 末尾4KBだけ使うため、溜め込みすぎない
        if (out.length > 64_000) out = out.slice(-HOOK_TAIL_BYTES * 2);
      };
      const tailOf = (): string =>
        out.length > HOOK_TAIL_BYTES ? `…(先頭切り詰め)\n${out.slice(-HOOK_TAIL_BYTES)}` : out;
      // spawn の timeout はシェルのみを kill し、孫プロセスが stdio を握ったままだと
      // 'close' が発火しない。フォールバックタイマーで必ず戻る(ループを固めない)
      const fallback = setTimeout(() => {
        child.kill();
        resolvePromise(
          `${tailOf()}\n[フックはタイムアウト(${Math.round(timeoutMs / 1000)}s)で打ち切られた(子プロセスが残っている可能性あり)]`,
        );
      }, timeoutMs + 500);
      fallback.unref?.();
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', (err) => {
        clearTimeout(fallback);
        resolvePromise(`(フック起動エラー: ${err.message})`);
      });
      child.on('close', (code, sig) => {
        clearTimeout(fallback);
        const tail = tailOf();
        if (sig) {
          resolvePromise(`${tail}\n[フックはシグナル ${sig} で終了(タイムアウトまたはキャンセル)]`);
        } else if (code !== 0) {
          resolvePromise(`${tail}\n[フック exit code: ${code}]`);
        } else {
          resolvePromise(tail.trim() === '' ? '(フック成功・出力なし)' : tail);
        }
      });
    } catch (err) {
      resolvePromise(`(フック起動エラー: ${err instanceof Error ? err.message : String(err)})`);
    }
  });
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
export function collectDeclaredPaths(plugin: ToolPlugin, input: unknown, cwd: string): string[] {
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
    if (plugin.risk === 'exec' && policy.mode === 'fullPc') {
      // bash 等はどのパスに触るか静的に判定できない → fullPc では常に system 扱い(毎回承認)
      scope = 'system';
      scopeWarnings.push('このコマンドはPC全体に影響し得ます(fullPcモードのため毎回承認)');
    }
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
        // M12-3: サブエージェント発の要求は承認UIで出所を明示する
        ...(ctx.subAgentId !== undefined ? { subAgentId: ctx.subAgentId } : {}),
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
    // M11-4: 編集後フック。編集成功時のみ・restrictExec(進化ジョブ)では実行しない。
    // フックの成否に関わらずツール結果は成功のまま、出力を情報として追記する
    if (
      result.isError !== true &&
      ctx.restrictExec !== true &&
      (plugin.name === 'write_file' || plugin.name === 'edit_file')
    ) {
      const hook = deps.getPostEditHook?.();
      if (hook && hook.command.trim() !== '') {
        const hookOut = await runPostEditHook(hook.command, hook.cwd, ctx.signal);
        return {
          ...result,
          content: `${result.content}\n\n[post-edit hook] ${hook.command}\n${hookOut}`,
        };
      }
    }
    return result;
  } catch (err) {
    return { content: `ツール実行例外: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
