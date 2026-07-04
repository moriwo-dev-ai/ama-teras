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
  PluginErrorInfo,
  ProviderId,
  RemoteStatusPayload,
  SecretsStatus,
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

  /** M10: リモートアクセス(スマホWeb)管理。トークン平文は生成時に一度だけ返る */
  remoteStatus(): Promise<RemoteStatusPayload>;
  remoteSetEnabled(enabled: boolean, port: number): Promise<{ status: RemoteStatusPayload; token?: string }>;
  remoteRegenerateToken(): Promise<{ status: RemoteStatusPayload; token: string }>;
}
