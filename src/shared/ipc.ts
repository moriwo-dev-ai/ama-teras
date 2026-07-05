import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  AppConfig,
  ChatMode,
  CheckpointInfo,
  CheckpointRestoreResult,
  EvolutionEvent,
  EvolutionJobSummary,
  McpConfig,
  McpServerStatus,
  PluginErrorInfo,
  ProviderId,
  RemoteStatusPayload,
  SecretsStatus,
  SessionLoadResult,
  SessionMeta,
  SubAgentUpdate,
  ToolExecResultPayload,
  ToolInfo,
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
  /** M12-2: 計画ファイル(MYCODEX_PLAN.md)の内容取得(計画パネル用・読み取り専用) */
  planGet: 'plan:get',
  /** M12-3: 並列サブエージェントの進行状況(エージェントパネル用) */
  subAgentUpdate: 'agent:sub_update',
  /** M13-2: MCPサーバー管理(デスクトップ専用) */
  mcpStatus: 'mcp:status',
  mcpSetConfig: 'mcp:set-config',
  /** M10: リモートアクセス管理(デスクトップ専用) */
  remoteStatus: 'remote:status',
  remoteSetEnabled: 'remote:set-enabled',
  remoteRegenerateToken: 'remote:regenerate-token',
} as const;

/** preload が window.api として公開するAPIの型。renderer はこれ経由でしか main と話せない */
export interface MyCodexApi {
  chatSend(text: string, mode?: ChatMode): Promise<{ sessionId: string }>;
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

  /** 現在のワークスペースの MYCODEX.md(プロジェクト記憶)の内容 */
  memoryGet(): Promise<string>;
  memorySet(content: string): Promise<void>;

  /** APIキーは書き込みのみ。読み出しは有無のbooleanだけ */
  secretsSet(provider: ProviderId, apiKey: string): Promise<SecretsStatus>;
  secretsStatus(): Promise<SecretsStatus>;

  onEvolutionEvent(listener: (event: EvolutionEvent) => void): () => void;
  evolutionPromoteRespond(jobId: number, approved: boolean): Promise<void>;
  /** 手動で進化ジョブを起動(デバッグ・検証用) */
  evolutionEnqueue(description: string, expectedIo: string): Promise<{ jobId: number }>;
  evolutionList(): Promise<EvolutionJobSummary[]>;

  /** M11-3: 自動チェックポイントの一覧と作業ツリーへの復元(HEAD/indexは変更しない) */
  checkpointList(): Promise<CheckpointInfo[]>;
  checkpointRestore(sha: string): Promise<CheckpointRestoreResult>;

  /** M12-1: セッション永続化。load は実行中不可、履歴の表示用ビューを返す */
  sessionsList(): Promise<SessionMeta[]>;
  sessionsLoad(id: string): Promise<SessionLoadResult>;
  sessionsDelete(id: string): Promise<void>;
  sessionsNew(): Promise<{ ok: boolean; message?: string }>;

  /** M12-2: 現在のワークスペースの MYCODEX_PLAN.md の内容(無ければ空文字) */
  planGet(): Promise<string>;

  /** M12-3: 並列サブエージェントの進行イベント購読 */
  onSubAgentUpdate(listener: (update: SubAgentUpdate) => void): () => void;

  /** M13-2: MCPサーバーの接続状態と設定変更(変更は保存後に自動で再接続) */
  mcpStatus(): Promise<McpServerStatus[]>;
  mcpSetConfig(config: McpConfig): Promise<McpServerStatus[]>;

  /** M10: リモートアクセス(スマホWeb)管理。トークン平文は生成時に一度だけ返る */
  remoteStatus(): Promise<RemoteStatusPayload>;
  remoteSetEnabled(enabled: boolean, port: number): Promise<{ status: RemoteStatusPayload; token?: string }>;
  remoteRegenerateToken(): Promise<{ status: RemoteStatusPayload; token: string }>;
}
