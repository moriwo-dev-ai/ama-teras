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

/**
 * main → renderer へ push されるエージェント進行イベント。
 * M22: 複数会話の同時実行のため、全イベントに conversationId が付く(単一会話でも同じ)。
 * renderer/remote は「表示中の会話」のイベントだけをチャットへ反映する
 */
export type AgentEvent = AgentEventBody & { conversationId?: string };

export type AgentEventBody =
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
      /** M14-3: 画像付きツール結果のサムネイル表示用(data URL) */
      images?: string[];
    }
  | { kind: 'error'; sessionId: string; message: string }
  /** M16-1: 中立の情報カード(モデル切替検知・フォールバック発動等) */
  | { kind: 'info'; sessionId: string; message: string }
  /** M19: 品質レビューの採点カード */
  | ({ kind: 'review'; sessionId: string } & ReviewCardPayload)
  /** M21-1: 実行中に送られた追加指示がキューへ積まれた(次ターン境界で履歴へ注入される) */
  | { kind: 'instruction_queued'; sessionId: string; text: string }
  /** M21-4: 実行中ツールのライブ出力(bash等のstdout末尾。ctx.log経由・APIコストなし) */
  | { kind: 'tool_progress'; sessionId: string; toolUseId: string; name: string; outputTail: string };

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
  /** M13-2: 外部MCPサーバーのツールのとき、そのサーバー名(UIで出所を明示表示) */
  mcpServer?: string;
  /** M14-2: 「このセッションでは常に許可」の粒度表示(例: ドメイン名)。動的承認ツール用 */
  allowSessionLabel?: string;
  /** M22: どの会話(プロジェクト)からの承認要求か。複数同時実行時の取り違え防止表示 */
  origin?: { conversationId: string; title: string; workspace: string };
}

/** M14-2: チャット送信に添付する画像(renderer → main) */
export interface ChatImageInput {
  /** 例: image/png */
  mediaType: string;
  /** base64(データURLのプレフィックスは含まない) */
  data: string;
  /** 表示・compaction置換用の説明(ファイル名等) */
  description?: string;
}

export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

export interface AutoApproveSettings {
  safe: boolean;
  write: boolean;
  exec: boolean;
}

/** M18: モデル帯(役割ごとのプロバイダ+モデル指定) */
export interface ModelBand {
  provider: ProviderId;
  /** 空文字ならプロバイダ既定モデル */
  model: string;
}

/** M18: 役割ベースのモデル自動切替設定 */
export interface ModelPolicy {
  enabled: boolean;
  planner: ModelBand;
  worker: ModelBand;
  /** 未指定なら planner 帯を格上げ先に使う */
  escalation?: ModelBand;
  /** workerタスク1件あたりの最大格上げ回数。既定1(0で格上げ無効) */
  maxEscalationsPerTask?: number;
}

/** M19: 品質レビュー・ゲート設定 */
export interface ReviewGateConfig {
  enabled: boolean;
  /**
   * M26-1: 合格判定方式。'severity'=high指摘ゼロなら合格(スコア平均は表示用)。
   * 'score'=従来の平均閾値方式。未指定は 'severity'(平均4.0方式は worker帯成果物が
   * 構造的に不合格→エスカレーション多発したため既定を再較正)
   */
  passMode?: 'severity' | 'score';
  /** 合格閾値(1〜5)。passMode='score' のとき平均がこれ未満なら差し戻し。既定 4.0 */
  threshold: number;
  /** 1マイルストーンあたりの差し戻し上限。既定 2(0でレビューのみ・差し戻し無し) */
  maxRoundsPerMilestone: number;
  /** 採点軸のON/OFF。ux はUI無しタスクではレビュアー判断でスキップされる */
  axes: { code: boolean; ux: boolean; requirements: boolean; tests: boolean };
}

/** M19: レビュー1件の具体指摘(抽象指摘禁止のため4フィールド必須) */
export interface ReviewFinding {
  file: string;
  location: string;
  problem: string;
  fix: string;
  /**
   * M26-1: 深刻度。high=マイルストーンの要件を満たさない/壊れている、
   * medium=品質上望ましくないが動く、low=好みの問題。
   * passMode='severity' では high のみが差し戻し対象になる
   */
  severity: 'high' | 'medium' | 'low';
}

/** M19: 採点結果(スキップされた軸は null) */
export interface ReviewScores {
  code: number | null;
  ux: number | null;
  requirements: number | null;
  tests: number | null;
}

/** M19: チャットのレビューカード表示用ペイロード */
export interface ReviewCardPayload {
  /** レビュー対象(完了したマイルストーン項目 or「完成時レビュー」) */
  milestone: string;
  /** 0=初回レビュー、1〜=差し戻し後の再レビュー */
  round: number;
  scores: ReviewScores;
  average: number;
  pass: boolean;
  findings: ReviewFinding[];
  summary: string;
  /** 上限到達で未解決のまま先へ進んだ */
  unresolved?: boolean;
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
   * M21-2: dispatch_agent parallel の同時実行数上限。未設定=既定3(1〜8にクランプ)。
   * 実質の制限はAPIレート/コスト(429はM16リトライが吸収)
   */
  subAgentMaxParallel?: number;
  /**
   * M14-5: fullPc の system スコープ承認に「セッション中許可(このフォルダ)」を出す。
   * 既定 false(=M9どおり毎回承認)。粒度はツール×ディレクトリ、exec系は対象外。
   * セッション許可で自動通過した操作も全件 audit.jsonl に記録される
   */
  fullPcAllowSession?: boolean;
  /**
   * M16-2: 課金系エラー(残高枯渇等)時の自動フォールバック(既定 無効)。
   * 発動しても本体の provider/model 設定は書き換えず、その会話の実行だけ切り替える。
   * 1会話につき1回まで(往復ループ禁止)
   */
  fallback?: { enabled: boolean; provider: ProviderId; model: string };
  /**
   * M18: モデル自動切替(役割ベース割当)。既定 undefined=無効(従来の単一モデル挙動)。
   * planner=メイン会話(計画・レビュー・最終応答)/ worker=dispatch_agentのサブ(実行の手数)/
   * escalation=workerが詰まったときの格上げ先(未指定なら planner を使う)。
   * 各帯は独立にプロバイダ+モデルを指定可(プロバイダ横断可)。
   * 進化ジョブは影響を受けない(従来の provider/model 設定を使う)
   */
  modelPolicy?: ModelPolicy;
  /**
   * M19: 品質レビュー・ゲート。既定 undefined=無効(従来挙動)。
   * マイルストーン(AMATERAS_PLAN.md項目完了)ごとに planner 帯が4軸採点し、
   * 閾値未満なら worker 帯へ具体指摘つきで差し戻す。進化ジョブには適用しない
   */
  reviewGate?: ReviewGateConfig;
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
  /** M25-8: 分類タグ(絞り込み・検索用) */
  tags: string[];
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
  /**
   * 接続ホスト名(TailscaleのMagicDNS名等)。QR/接続URLの組み立て用。
   * 以前はrendererのlocalStorage保存だったが、userData移行等で消えるため本体設定に永続化
   */
  host?: string;
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
  /** 接続ホスト名(設定済みの場合) */
  host?: string;
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
  /** M17-2: 自律モード(承認なし自動実行)が有効か。セッション単位・再起動でOFF */
  autonomous: boolean;
}

/** M17-2: 自律モードの状態変更通知(main → renderer/remote) */
export interface AutonomousStatePayload {
  on: boolean;
}

/** SSE 接続直後に送る現在状態(スマホUIの再接続時の状態回復用) */
export interface RemoteSnapshot {
  status: AgentStatusView;
  history: HistoryMessageView[];
  pendingApprovals: ApprovalRequestPayload[];
  pendingPromotions: Extract<EvolutionEvent, { kind: 'promotion_request' }>[];
  jobs: EvolutionJobSummary[];
  tools: ToolInfo[];
  /** M22: 表示中の会話ID(chat:eventのフィルタ用)と実行中ラン一覧 */
  conversationId?: string;
  runs?: RunInfo[];
}

// ---- M13-2: MCPクライアント ----

/** userData/mcp.json の1サーバー分の設定(stdio起動型のみ・v1) */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 接続対象にするか(既定 true) */
  enabled?: boolean;
  /** ユーザーがこのサーバーのツール実行を許可したか(未信頼は接続しない) */
  trusted?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export type McpServerState = 'connected' | 'connecting' | 'error' | 'disabled' | 'untrusted';

/** Settings のMCP節に出す接続状態 */
export interface McpServerStatus {
  name: string;
  state: McpServerState;
  error?: string;
  toolCount: number;
  config: McpServerConfig;
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
  /** M18: 上位モデル(escalation帯)へ格上げされた(UIバッジ表示用) */
  escalated?: boolean;
  /** M21-4: 最新の思考テキスト末尾(ストリーミングの生かじり。running中のライブ表示用) */
  narration?: string;
  /** M21-4: 開始時刻(epoch ms)。UI側で経過時間を表示する */
  startedAt?: number;
  /** M22: どの会話(プロジェクト)の子か(複数同時実行時の出所表示) */
  conversationId?: string;
  /** M23: この子が使っているモデル(worker帯。格上げ後はescalation帯のモデル) */
  model?: string;
}

// ---- M23-2: 使用量メーター(残高に準ずるもの) ----

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface UsageCellView {
  input: number;
  output: number;
  cacheRead: number;
  calls: number;
  /** 既知単価からの概算($)。未知モデルは null(トークンのみ表示) */
  costUsd: number | null;
}

export interface UsageModelRow {
  /** "provider/model" */
  model: string;
  today: UsageCellView;
  total: UsageCellView;
}

export interface UsageSummary {
  /** 集計上の「今日」(YYYY-MM-DD・ローカル) */
  day: string;
  models: UsageModelRow[];
  todayCostUsd: number | null;
  totalCostUsd: number | null;
}

// ---- M22: 複数会話の同時実行 ----

/** 実行中ラン一覧(runs:changed / runs:list)。左ペインの実行中表示・状態復元に使う */
export interface RunInfo {
  conversationId: string;
  title: string;
  workspace: string;
  sessionId: string;
  startedAt: number;
  /** M23: メイン会話が使っているモデル(provider/model。フォールバック発動で更新される) */
  model?: string;
}

// ---- M15-4: 環境ウィジェット ----

export interface WorkspaceGitStatus {
  isGit: boolean;
  branch?: string;
  /** 未コミット変更(ステージ済み含む)のファイル数 */
  dirtyCount?: number;
}

// ---- M15-3: ファイルプレビュー ----

export interface FilePreviewResult {
  ok: boolean;
  message?: string;
  /** 解決済み絶対パス */
  path?: string;
  kind?: 'markdown' | 'code' | 'image';
  /** markdown / code の本文(最大1MB。超過分は truncated) */
  content?: string;
  /** image の data URL */
  dataUrl?: string;
  truncated?: boolean;
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
  /** M22: 開いた会話が実行中なら、そのラン情報(UIが実行状態へ復帰する) */
  running?: { sessionId: string; startedAt: number };
  /** M22: 開いた会話のID(イベントのフィルタに使う) */
  conversationId?: string;
  /** M22: 開いた会話の自律モード(会話単位の状態) */
  autonomous?: boolean;
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

/**
 * M20: 進化スコープの段階。tool=プラグインのみ(従来) / renderer=UI / core=本体main。
 * renderer/core は常に人間承認+再ビルド・再起動を要する。聖域(PROTECTED_PATHS)は
 * どのスコープでも変更不可
 */
export type EvolutionScope = 'tool' | 'renderer' | 'core';

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
  /** M20: 進化スコープ(未設定は tool=従来) */
  scope?: EvolutionScope;
  /** M20: 昇格に再ビルド+再起動を要する(renderer/core) */
  requiresRestart?: boolean;
  /** M20: 聖域トリップワイヤによる拒否(通常の failed と区別してUI表示) */
  protectedReject?: boolean;
  /** M23-7: 依頼元の会話(request_capability経由)。結果をモデルへ自動フィードバックする宛先 */
  originConversationId?: string;
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
      /** M20: スコープ(renderer/core は昇格UIで二段確認+本体変更の強調) */
      scope?: EvolutionScope;
      /** M20: 承認後に再ビルド+再起動が走る */
      requiresRestart?: boolean;
    };
