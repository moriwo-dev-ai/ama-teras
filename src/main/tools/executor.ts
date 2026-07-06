import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AutoApproveSettings, DiffLine, OperationScope, ScopeMode } from '../../shared/types';
import type { ApprovalBroker } from '../agent/approval';
import { lineDiff } from '../util/diff';
import { catastrophicCommandReason, collectStringValues } from './autonomy';
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
  /** M17-2: 自律モード(承認なし自動実行)で行われた操作 */
  autonomous?: boolean;
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
  /**
   * M14-5: fullPc の system スコープに「セッション中許可(このフォルダ)」を許すか。
   * 既定 false(未指定も false)= M9 どおり毎回承認。exec系・ハード拒否は設定に関係なく不変
   */
  getFullPcAllowSession?: () => boolean;
  /**
   * M17-2: 自律モード(フルアクセス・スイッチ)。true の間は safe/write/exec/system スコープ/
   * 動的承認をすべて自動承認し、全操作を autonomous:true で監査記録する。
   * ハード拒否(secrets/userData/システム領域の破壊)と project モードの system 拒否は不変。
   * exec 系はカタストロフィックなコマンドパターン(format 等)をトリップワイヤで即拒否する。
   * 進化ジョブの executor 依存には注入しないこと(guardrails テストで固定)。
   */
  getAutonomous?: () => boolean;
  /**
   * M22: 承認要求の出所(どの会話/プロジェクトからか)。複数会話の同時実行時に
   * ダイアログ・スマホの承認カードで取り違えを防ぐ表示に使う。未指定なら付けない
   */
  getOrigin?: () => { conversationId: string; title: string; workspace: string } | null;
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

/** M13-2: ツール名からMCPサーバー名を導出(mcp__<server>__<tool>)。非MCPツールは null */
function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  return sep > 0 ? rest.slice(0, sep) : null;
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

  // ---- M14-2: 動的承認ポリシー(screenshot の外部URL等) ----
  const dynRaw = plugin.dynamicApproval?.(input);
  if (dynRaw && 'error' in dynRaw) {
    // 非httpスキーム等は承認ダイアログも出さず実行前拒否
    return { content: dynRaw.error, isError: true };
  }
  const dyn = dynRaw && !('error' in dynRaw) ? dynRaw : undefined;

  // ---- M9: スコープ判定(ハード拒否 → project拒否 / fullPc強制承認) ----
  // M17-2: 自律モード。承認をすべて自動化する(ハード拒否・project拒否は不変)
  const autonomous = deps.getAutonomous?.() === true;
  const policy = deps.getScopePolicy?.();
  let scope: OperationScope | undefined;
  let resolvedPaths: string[] | undefined;
  const scopeWarnings: string[] = [];

  if (policy) {
    const kind = plugin.risk === 'write' ? 'write' : 'read';
    const paths = collectDeclaredPaths(plugin, input, ctx.cwd);
    for (const abs of paths) {
      const reason = isDenied(abs, kind, policy.deny, autonomous ? { autonomous: true } : undefined);
      if (reason) {
        // 保護領域は承認ダイアログすら出さず即エラー(設計 M9「ハード拒否」)
        deps.audit?.({
          tool: plugin.name,
          scope: 'system',
          paths: [abs],
          event: 'hard-deny',
          detail: reason,
          ...(autonomous ? { autonomous: true } : {}),
        });
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

  // M17-2: 自律モードの exec 系はカタストロフィックなコマンドをトリップワイヤで即拒否
  // (通常モードは人間の目視承認が防波堤のため、この機械判定は挟まない)
  if (autonomous && plugin.risk === 'exec') {
    for (const value of collectStringValues(input)) {
      const reason = catastrophicCommandReason(value);
      if (reason) {
        deps.audit?.({
          tool: plugin.name,
          scope: scope ?? 'system',
          paths: [],
          event: 'hard-deny',
          detail: `自律モードの破壊的コマンド拒否: ${reason}`,
          autonomous: true,
        });
        return {
          content: `自律モードでも破壊的コマンドは拒否される: ${reason}。必要なら自律モードを切って通常の承認で実行すること`,
          isError: true,
        };
      }
    }
  }

  // system スコープは autoApprove / allow-session に関係なく毎回承認(設計の中核不変条件)
  const forced = scope === 'system';
  const auto = deps.getAutoApprove();
  // M14-5: fullPcAllowSession が ON のとき、systemスコープでも「ツール×ディレクトリ」粒度の
  // セッション許可を認める(exec系はパスで範囲を限定できないため対象外・従来どおり毎回)。
  // ハード拒否はここより前で判定済みのため設定に関係なく不変
  const fullPcDirKeys =
    forced &&
    deps.getFullPcAllowSession?.() === true &&
    plugin.risk !== 'exec' &&
    resolvedPaths !== undefined &&
    resolvedPaths.length > 0
      ? resolvedPaths.map((p) => `fullpc:${plugin.name}:${dirname(resolve(p)).toLowerCase()}`)
      : null;
  const fullPcSessionAllowed =
    fullPcDirKeys !== null && fullPcDirKeys.every((k) => deps.broker.isSessionAllowed(k));
  // M14-2: 動的承認は autoApprove を無視して要求する(セッションキーで許可済みならスキップ)
  const dynSessionAllowed =
    dyn?.sessionKey !== undefined && deps.broker.isSessionAllowed(dyn.sessionKey);
  const dynNeedsApproval = dyn?.required === true && !dynSessionAllowed;
  // M17-2: 自律モードは承認を一切要求しない(ここより前のハード拒否・denylist が唯一の防壁)
  const needsApproval =
    !autonomous &&
    ((forced && !fullPcSessionAllowed) ||
      dynNeedsApproval ||
      (!auto[plugin.risk] && !deps.broker.isSessionAllowed(name)));

  // M14-5: セッション許可で自動通過する system 操作も監査に「承認(自動)」として残す
  if (!autonomous && forced && !needsApproval && fullPcSessionAllowed) {
    deps.audit?.({
      tool: plugin.name,
      scope: 'system',
      paths: resolvedPaths ?? [],
      event: 'approval',
      detail: 'allow(session-auto)',
    });
  }

  if (needsApproval) {
    const decision = await deps.broker.request(
      {
        toolName: plugin.name,
        risk: plugin.risk,
        inputPreview: JSON.stringify(input, null, 2) ?? String(input),
        diff: await buildDiffPreview(plugin.name, input, ctx),
        warnings: [...(plugin.warnings ?? []), ...scopeWarnings, ...(dyn?.warnings ?? [])],
        ...(scope !== undefined ? { scope } : {}),
        ...(resolvedPaths !== undefined ? { resolvedPaths } : {}),
        // M14-2: 「セッション中許可」の粒度をUIに明示(例: ドメイン単位)
        ...(dyn?.sessionKey !== undefined && dyn.sessionLabel !== undefined
          ? { allowSessionLabel: dyn.sessionLabel }
          : {}),
        // M14-5: fullPcAllowSession ON のときは system スコープでも「このフォルダ」粒度で
        // セッション許可ボタンを出す(UIは allowSessionLabel の有無で表示を切り替える)
        ...(fullPcDirKeys !== null && resolvedPaths !== undefined && resolvedPaths.length > 0
          ? { allowSessionLabel: `このフォルダ: ${dirname(resolve(resolvedPaths[0]!))}` }
          : {}),
        // M12-3: サブエージェント発の要求は承認UIで出所を明示する
        ...(ctx.subAgentId !== undefined ? { subAgentId: ctx.subAgentId } : {}),
        // M13-2: MCPツールはサーバー名を出所として明示する(名前 mcp__<server>__<tool> から導出)
        ...(mcpServerOf(plugin.name) !== null ? { mcpServer: mcpServerOf(plugin.name)! } : {}),
        // M22: どの会話(プロジェクト)からの要求か(複数同時実行時の取り違え防止)
        ...(deps.getOrigin?.() != null ? { origin: deps.getOrigin()! } : {}),
      },
      ctx.signal,
    );
    if (forced) {
      deps.audit?.({
        tool: plugin.name,
        scope: 'system',
        paths: resolvedPaths ?? [],
        event: 'approval',
        detail:
          decision === 'deny' ? 'deny' : decision === 'allow-session' ? 'allow-session' : 'allow',
      });
    }
    // M14-2: 動的承認対象(外部URL等)の承認判断も監査へ残す
    if (dyn?.auditPaths && dyn.auditPaths.length > 0) {
      deps.audit?.({
        tool: plugin.name,
        scope: 'system',
        paths: dyn.auditPaths,
        event: 'approval',
        detail: decision === 'deny' ? 'deny' : 'allow',
      });
    }
    if (decision === 'deny') {
      return { content: 'ユーザーがツール実行を拒否した', isError: true };
    }
    if (decision === 'allow-session') {
      if (forced) {
        // M14-5: system スコープは fullPcAllowSession ON のディレクトリ粒度キーのみ記憶する
        // (OFF のときはボタン自体が出ないが、受理しても記憶しない=M9の従来仕様)
        if (fullPcDirKeys !== null) for (const k of fullPcDirKeys) deps.broker.allowForSession(k);
      } else if (dyn?.required === true && dyn.sessionKey !== undefined) {
        // 動的承認はキー粒度(例: screenshot@example.com)で記憶
        deps.broker.allowForSession(dyn.sessionKey);
      } else if (dyn?.required !== true) {
        deps.broker.allowForSession(name);
      }
    }
  }

  try {
    const result = await plugin.execute(input, ctx);
    // M17-2: 自律モード中は workspace 内も含む全操作を autonomous:true で監査に残す
    if (forced || autonomous) {
      deps.audit?.({
        tool: plugin.name,
        scope: scope ?? (forced ? 'system' : 'workspace'),
        paths: resolvedPaths ?? [],
        event: 'result',
        detail: result.isError === true ? `error: ${result.content.slice(0, 200)}` : 'ok',
        ...(autonomous ? { autonomous: true } : {}),
      });
    }
    // M14-2: 動的承認対象はセッション許可で自動通過した実行も含め全件監査に残す
    if (dyn?.auditPaths && dyn.auditPaths.length > 0) {
      deps.audit?.({
        tool: plugin.name,
        scope: 'system',
        paths: dyn.auditPaths,
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
