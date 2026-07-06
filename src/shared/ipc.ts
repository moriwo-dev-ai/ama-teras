import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  AppConfig,
  AutonomousStatePayload,
  ChatImageInput,
  ChatMode,
  CheckpointInfo,
  CheckpointRestoreResult,
  EvolutionEvent,
  EvolutionJobSummary,
  EvolutionScope,
  FilePreviewResult,
  McpConfig,
  McpServerStatus,
  PluginErrorInfo,
  ProviderId,
  RemoteStatusPayload,
  RunInfo,
  SecretsStatus,
  SessionLoadResult,
  SessionMeta,
  SubAgentUpdate,
  ToolExecResultPayload,
  ToolInfo,
  UsageSummary,
  WorkspaceGitStatus,
} from './types';

/** IPCチャネル名の一元定義。文字列リテラルを直接使わない */
export const IpcChannels = {
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',
  approvalRequest: 'approval:request',
  approvalRespond: 'approval:respond',
  /** M10: 承認がいずれかの画面(デスクトップ/リモート)で解決された通知 */
  approvalResolved: 'approval:resolved',
  toolsList: 'tools:list',
  toolsExecute: 'tools:execute',
  toolsReload: 'tools:reload',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  workspacePick: 'workspace:pick',
  memoryGet: 'memory:get',
  memorySet: 'memory:set',
  secretsSet: 'secrets:set',
  secretsStatus: 'secrets:status',
  evolutionEvent: 'evolution:event',
  evolutionPromoteRespond: 'evolution:promote-respond',
  evolutionEnqueue: 'evolution:enqueue',
  evolutionList: 'evolution:list',
  /** M11-3: 自動チェックポイント(Debugパネル) */
  checkpointList: 'checkpoint:list',
  checkpointRestore: 'checkpoint:restore',
  /** M12-1: セッション永続化(一覧・ロード・削除・新規) */
  sessionsList: 'sessions:list',
  sessionsLoad: 'sessions:load',
  sessionsDelete: 'sessions:delete',
  sessionsNew: 'sessions:new',
  /** M15-2: セッション検索・名前変更(追加のみ・既存チャネルは不変) */
  sessionsSearch: 'sessions:search',
  sessionsRename: 'sessions:rename',
  /** M15-3: ファイルプレビュー(読み取り専用・M9スコープ判定つき) */
  filePreview: 'file:preview',
  fileReveal: 'file:reveal',
  /** M15-4: 環境ウィジェット用の軽量git状態 */
  workspaceGitStatus: 'workspace:gitStatus',
  /** M12-2: 計画ファイル(AMATERAS_PLAN.md)の内容取得(計画パネル用・読み取り専用) */
  planGet: 'plan:get',
  /** M12-3: 並列サブエージェントの進行状況(エージェントパネル用) */
  subAgentUpdate: 'agent:sub_update',
  /** M13-2: MCPサーバー管理(デスクトップ専用) */
  mcpStatus: 'mcp:status',
  mcpSetConfig: 'mcp:set-config',
  /** M10: リモートアクセス管理(デスクトップ専用) */
  remoteStatus: 'remote:status',
  remoteSetEnabled: 'remote:set-enabled',
  remoteSetHost: 'remote:set-host',
  remoteRegenerateToken: 'remote:regenerate-token',
  /** M17-2: 自律モード(承認なし自動実行)の取得・切替・変更通知 */
  autonomousGet: 'autonomous:get',
  autonomousSet: 'autonomous:set',
  autonomousChanged: 'autonomous:changed',
  /** M22: 実行中ラン一覧(複数プロジェクト同時実行の状態) */
  runsList: 'runs:list',
  runsChanged: 'runs:changed',
  /** M23-2: 使用量サマリと残高ダッシュボードを開く */
  usageGet: 'usage:get',
  openBillingPage: 'billing:open',
  /** M20: 起動時フラグ(セーフモード/進化再起動完了)とセーフモード解除 */
  runtimeFlags: 'runtime:flags',
  safeModeClear: 'safemode:clear',
  /** M20: ロールバック履歴(evolveタグ)と「1つ前へ戻す」 */
  evolutionHistory: 'evolution:history',
  evolutionRollbackLast: 'evolution:rollback-last',
  /** M23-6: 進化で獲得した能力(スキル/自己書き換え)一覧 */
  evolutionCapabilities: 'evolution:capabilities',
} as const;

/** preload が window.api として公開するAPIの型。renderer はこれ経由でしか main と話せない */
export interface MyCodexApi {
  /** M14-2: images は任意(後方互換)。D&D/ペーストで添付した画像を渡す */
  chatSend(
    text: string,
    mode?: ChatMode,
    images?: ChatImageInput[],
  ): Promise<{ sessionId: string; conversationId?: string }>;
  chatCancel(sessionId: string): Promise<void>;
  /** 戻り値は購読解除関数 */
  onChatEvent(listener: (event: AgentEvent) => void): () => void;

  onApprovalRequest(listener: (req: ApprovalRequestPayload) => void): () => void;
  approvalRespond(id: string, decision: ApprovalDecision): Promise<void>;
  /** M10: 別画面(リモート等)で承認が解決されたらダイアログを閉じるための通知 */
  onApprovalResolved(listener: (payload: ApprovalResolvedPayload) => void): () => void;

  toolsList(): Promise<{ tools: ToolInfo[]; errors: PluginErrorInfo[] }>;
  /** デバッグパネル用の手動ツール実行(承認フローを通る) */
  toolsExecute(name: string, inputJson: string): Promise<ToolExecResultPayload>;
  toolsReload(): Promise<{ tools: ToolInfo[]; errors: PluginErrorInfo[] }>;

  settingsGet(): Promise<AppConfig>;
  settingsSet(config: AppConfig): Promise<AppConfig>;
  /** ディレクトリ選択ダイアログを開き、選ばれたパスを返す(キャンセルで null) */
  pickWorkspace(): Promise<string | null>;

  /** 現在のワークスペースの AMATERAS.md(プロジェクト記憶)の内容 */
  memoryGet(): Promise<string>;
  memorySet(content: string): Promise<void>;

  /** APIキーは書き込みのみ。読み出しは有無のbooleanだけ */
  secretsSet(provider: ProviderId, apiKey: string): Promise<SecretsStatus>;
  secretsStatus(): Promise<SecretsStatus>;

  onEvolutionEvent(listener: (event: EvolutionEvent) => void): () => void;
  evolutionPromoteRespond(jobId: number, approved: boolean): Promise<void>;
  /** 手動で進化ジョブを起動(デバッグ・検証用) */
  evolutionEnqueue(description: string, expectedIo: string, scope?: EvolutionScope): Promise<{ jobId: number }>;
  evolutionList(): Promise<EvolutionJobSummary[]>;

  /** M11-3: 自動チェックポイントの一覧と作業ツリーへの復元(HEAD/indexは変更しない) */
  checkpointList(): Promise<CheckpointInfo[]>;
  checkpointRestore(sha: string): Promise<CheckpointRestoreResult>;

  /** M12-1: セッション永続化。load は実行中不可、履歴の表示用ビューを返す */
  sessionsList(): Promise<SessionMeta[]>;
  sessionsLoad(id: string): Promise<SessionLoadResult>;
  sessionsDelete(id: string): Promise<void>;
  sessionsNew(): Promise<{ ok: boolean; message?: string }>;
  /** M15-2: タイトル+本文の部分一致検索 / 名前変更 */
  sessionsSearch(query: string): Promise<SessionMeta[]>;
  sessionsRename(id: string, title: string): Promise<boolean>;

  /** M15-3: 右ペインのファイルプレビュー(読み取り専用)/ エクスプローラで表示 */
  filePreview(path: string): Promise<FilePreviewResult>;
  fileReveal(path: string): Promise<void>;

  /** M15-4: 現在workspaceのgit状態(git無しは isGit:false) */
  workspaceGitStatus(): Promise<WorkspaceGitStatus>;

  /** M12-2: 現在のワークスペースの AMATERAS_PLAN.md の内容(無ければ空文字) */
  planGet(): Promise<string>;

  /** M12-3: 並列サブエージェントの進行イベント購読 */
  onSubAgentUpdate(listener: (update: SubAgentUpdate) => void): () => void;

  /** M13-2: MCPサーバーの接続状態と設定変更(変更は保存後に自動で再接続) */
  mcpStatus(): Promise<McpServerStatus[]>;
  mcpSetConfig(config: McpConfig): Promise<McpServerStatus[]>;

  /** M10: リモートアクセス(スマホWeb)管理。トークン平文は生成時に一度だけ返る */
  remoteStatus(): Promise<RemoteStatusPayload>;
  remoteSetEnabled(enabled: boolean, port: number): Promise<{ status: RemoteStatusPayload; token?: string }>;
  remoteSetHost(host: string): Promise<RemoteStatusPayload>;
  remoteRegenerateToken(): Promise<{ status: RemoteStatusPayload; token: string }>;

  /** M17-2: 自律モード(承認なし自動実行)。状態はセッション単位・再起動でOFF */
  autonomousGet(): Promise<{ on: boolean }>;
  autonomousSet(on: boolean): Promise<{ on: boolean }>;
  onAutonomousChanged(listener: (payload: AutonomousStatePayload) => void): () => void;

  /** M22: 実行中ラン一覧(初期取得+変更購読)。複数プロジェクト同時実行の左ペイン表示用 */
  runsList(): Promise<RunInfo[]>;
  onRunsChanged(listener: (runs: RunInfo[]) => void): () => void;

  /** M23-2: 使用量(トークン・概算コスト)サマリ / プロバイダの残高ダッシュボードを開く */
  usageGet(): Promise<UsageSummary>;
  openBillingPage(provider: ProviderId): Promise<void>;

  /** M20: 起動時フラグ(セーフモード/進化再起動完了のバナー用)とセーフモード解除 */
  runtimeFlags(): Promise<{
    safeMode: boolean;
    safeModeInfo?: { tag: string; prevCommit: string };
    restartedFrom?: string;
  }>;
  safeModeClear(): Promise<{ cleared: boolean }>;

  /** M20: 進化のロールバック履歴と「1つ前へ戻す」(HEADが最新evolveマージのときのみ) */
  evolutionHistory(): Promise<{ tag: string; commit: string; date: string; subject: string }[]>;
  evolutionRollbackLast(): Promise<{ ok: boolean; message: string }>;
  /** M23-6: 昇格ごとの獲得内容(kind/ツール名/変更ファイル) */
  evolutionCapabilities(): Promise<
    {
      tag: string;
      commit: string;
      date: string;
      subject: string;
      kind: 'tool' | 'renderer' | 'core';
      toolNames: string[];
      files: string[];
    }[]
  >;
}
