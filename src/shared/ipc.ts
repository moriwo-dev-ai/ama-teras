import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequestPayload,
  AppConfig,
  EvolutionEvent,
  EvolutionJobSummary,
  PluginErrorInfo,
  ProviderId,
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
} as const;

/** preload が window.api として公開するAPIの型。renderer はこれ経由でしか main と話せない */
export interface MyCodexApi {
  chatSend(text: string): Promise<{ sessionId: string }>;
  chatCancel(sessionId: string): Promise<void>;
  /** 戻り値は購読解除関数 */
  onChatEvent(listener: (event: AgentEvent) => void): () => void;

  onApprovalRequest(listener: (req: ApprovalRequestPayload) => void): () => void;
  approvalRespond(id: string, decision: ApprovalDecision): Promise<void>;

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
}
