// main / renderer 双方から参照する型。ロジックは置かない。

export type AgentStatus =
  | 'idle'
  | 'calling_llm'
  | 'awaiting_approval'
  | 'executing_tool'
  | 'done'
  | 'cancelled'
  | 'error'
  | 'max_turns_reached';

/** main → renderer へ push されるエージェント進行イベント */
export type AgentEvent =
  | { kind: 'status'; sessionId: string; status: AgentStatus }
  | { kind: 'text_delta'; sessionId: string; text: string }
  | { kind: 'message_done'; sessionId: string }
  | { kind: 'tool_start'; sessionId: string; toolUseId: string; name: string; inputPreview: string }
  | {
      kind: 'tool_result';
      sessionId: string;
      toolUseId: string;
      name: string;
      content: string;
      isError: boolean;
    }
  | { kind: 'error'; sessionId: string; message: string };

export type ProviderId = 'anthropic' | 'openai';

/** 送信モード。plan は実装前に計画を提示し、ツールを実行しない(承認後に通常モードで実行) */
export type ChatMode = 'normal' | 'plan';

export interface SecretsStatus {
  anthropic: boolean;
  openai: boolean;
}

export type ToolRisk = 'safe' | 'write' | 'exec';

/** M9: 操作スコープ。workspace = config.workspace 配下 / system = それ以外のPC全体 */
export type OperationScope = 'workspace' | 'system';

/** M9: 'project' = 従来どおりworkspace内のみ / 'fullPc' = system スコープを承認制で許可 */
export type ScopeMode = 'project' | 'fullPc';

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** main → renderer: ツール実行の承認依頼 */
export interface ApprovalRequestPayload {
  id: string;
  toolName: string;
  risk: ToolRisk;
  /** 整形済みJSON(表示用) */
  inputPreview: string;
  /** write_file / edit_file のときのみ */
  diff?: DiffLine[];
  warnings: string[];
  /** M9: 操作スコープ。'system' はプロジェクト外(毎回承認・allow-session 不可) */
  scope?: OperationScope;
  /** M9: スコープ判定に使った解決済み絶対パス('system' のときのみ) */
  resolvedPaths?: string[];
}

export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

export interface AutoApproveSettings {
  safe: boolean;
  write: boolean;
  exec: boolean;
}

export interface AppConfig {
  autoApprove: AutoApproveSettings;
  provider: ProviderId;
  /** 空文字ならプロバイダ既定モデル */
  model: string;
  /** エージェントの作業ディレクトリ。空/未設定なら既定(アプリのルート) */
  workspace?: string;
  /** M9: 操作範囲。既定 'project'(後方互換) */
  scopeMode: ScopeMode;
}

/** renderer のツール一覧・デバッグパネル用 */
export interface ToolInfo {
  name: string;
  description: string;
  risk: ToolRisk;
  warnings: string[];
}

export interface ToolExecResultPayload {
  content: string;
  isError: boolean;
}

/** プラグインロード失敗の通知(起動は継続し、UIに表示する) */
export interface PluginErrorInfo {
  filePath: string;
  message: string;
}

// ---- M10: リモートアクセス(スマホWeb) ----

/** main → renderer/remote: 承認要求がいずれかの画面で解決された通知(開いたままのダイアログを閉じる) */
export interface ApprovalResolvedPayload {
  id: string;
  decision: ApprovalDecision;
}

/** GET /api/history 用の表示用メッセージ(tool_result 等の内部ブロックは省く) */
export interface HistoryMessageView {
  role: 'user' | 'assistant';
  text: string;
}

/** GET /api/status と SSE snapshot の共通形 */
export interface AgentStatusView {
  status: AgentStatus;
  activeSessionId: string | null;
  scopeMode: ScopeMode;
}

// ---- 自己進化サブシステム ----

export type EvolutionJobStatus =
  | 'queued'
  | 'preparing_worktree'
  | 'generating'
  | 'verifying'
  | 'awaiting_promotion'
  | 'promoting'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'rolled_back';

export interface EvolutionGateResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface EvolutionJobSummary {
  id: number;
  description: string;
  status: EvolutionJobStatus;
  toolName?: string;
  log: string[];
  gates: EvolutionGateResult[];
  error?: string;
}

/** main → renderer: 進化ジョブの状態遷移・昇格承認依頼 */
export type EvolutionEvent =
  | { kind: 'job_update'; job: EvolutionJobSummary }
  | {
      kind: 'promotion_request';
      jobId: number;
      toolName: string;
      diff: string;
      /** child_process / ネットワークアクセス検出時の明示警告 */
      warnings: string[];
    };
