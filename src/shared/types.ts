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
  /** M12-3: サブエージェント発の要求のとき、その子エージェント番号(UIで明示表示) */
  subAgentId?: number;
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
  /**
   * M11-1: エージェントループの最大ターン数。未設定=ループ既定の30。
   * 1〜200にクランプ(大きいほど長いタスクを自走できるがAPIコスト増)。
   */
  maxTurns?: number;
  /**
   * M11-4: 編集後フック。write_file / edit_file 成功のたびに workspace で実行され、
   * 出力(末尾4KB)が tool_result に追記される。空/未設定=無効。進化ジョブでは実行しない。
   */
  postEditHook?: string;
  /** M12-3: work サブエージェント1体あたりの最大ターン数。未設定=既定30(1〜100にクランプ) */
  subAgentMaxTurns?: number;
  /**
   * M10: スマホWebアクセス。既定 disabled。省略可(後方互換)で、ConfigStore が既定値を補う。
   * renderer からの settings:set では上書きされない(専用IPCでのみ変更)。
   */
  remote?: RemoteConfig;
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

/**
 * リモートアクセス設定。tokenHash は sha256(hex)のみ保存し、平文トークンは
 * 生成時にデスクトップUIへ一度だけ表示する(平文保存禁止)。
 */
export interface RemoteConfig {
  enabled: boolean;
  port: number;
  tokenHash?: string;
}

/** デスクトップ設定UI用のリモートサーバ状態 */
export interface RemoteStatusPayload {
  enabled: boolean;
  port: number;
  /** サーバが実際に listen 中か */
  running: boolean;
  /** トークンが発行済みか(平文は返さない) */
  tokenSet: boolean;
  /** listen 失敗等のエラー(UI表示用) */
  lastError?: string;
}

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

/** SSE 接続直後に送る現在状態(スマホUIの再接続時の状態回復用) */
export interface RemoteSnapshot {
  status: AgentStatusView;
  history: HistoryMessageView[];
  pendingApprovals: ApprovalRequestPayload[];
  pendingPromotions: Extract<EvolutionEvent, { kind: 'promotion_request' }>[];
  jobs: EvolutionJobSummary[];
  tools: ToolInfo[];
}

// ---- M12-3: 並列サブエージェント ----

/** main → renderer/remote: 子エージェントの進行状況(エージェントパネル用) */
export interface SubAgentUpdate {
  /** 会話内の子エージェント連番(1始まり) */
  id: number;
  task: string;
  mode: 'read' | 'work';
  status: 'running' | 'done' | 'error' | 'cancelled';
  /** 実行中のツール名(running のときのみ意味を持つ) */
  currentTool?: string;
  /** 子の最終テキスト(完了時)またはエラー概要の末尾 */
  summaryTail?: string;
}

// ---- M12-1: セッション永続化 ----

/** userData/sessions/ に保存された会話の一覧表示用メタ情報 */
export interface SessionMeta {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionLoadResult {
  ok: boolean;
  message?: string;
  /** ok 時のみ: 復元された履歴の表示用ビュー */
  history?: HistoryMessageView[];
}

// ---- M11-3: 自動チェックポイント ----

/** refs/mycodex/checkpoints/ 配下に積まれる作業ツリースナップショット(HEAD/indexは汚さない) */
export interface CheckpointInfo {
  sha: string;
  sessionId: string;
  /** コミット日時(ISO 8601) */
  createdAt: string;
  label: string;
}

export interface CheckpointRestoreResult {
  ok: boolean;
  message: string;
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
