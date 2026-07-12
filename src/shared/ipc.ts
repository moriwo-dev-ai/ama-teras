import type {
  AdapterStatusInfo,
  AgentEvent,
  ApprovalBatch,
  ApprovalDecision,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  AppConfig,
  CommunityCandidate,
  GodClockJob,
  ImpactEntry,
  InboxItem,
  IwatoRequestPayload,
  MediaStrategyEntry,
  MetricsSnapshot,
  OperationsDraft,
  OpsThreadMessage,
  TriageCard,
  AutonomousRegistryScope,
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
  ConnectionTestResult,
  PluginExportResult,
  PluginImportStartResult,
  ProviderId,
  ProvisionalInstall,
  RegistryGodInfo,
  RemoteStatusPayload,
  RunInfo,
  SecretSlot,
  SecretsStatus,
  SessionLoadResult,
  SessionMeta,
  SubAgentUpdate,
  ToolExecResultPayload,
  ChoEntry,
  ToolInfo,
  TsukuyomiEvent,
  TsukuyomiStatus,
  UpdateInfo,
  UsageSummary,
  WorkspaceGitStatus,
} from './types';
import type { BulkRespondResult } from './operations';

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
  userMemoryGet: 'memory:user-get',
  userMemorySet: 'memory:user-set',
  secretsSet: 'secrets:set',
  secretsStatus: 'secrets:status',
  /** M27-1: 現在の設定で最小1リクエストを送る接続テスト(無料で始める導線用) */
  connectionTest: 'connection:test',
  evolutionEvent: 'evolution:event',
  evolutionPromoteRespond: 'evolution:promote-respond',
  evolutionEnqueue: 'evolution:enqueue',
  evolutionList: 'evolution:list',
  /** M26-6: ジョブのキャンセル(queued=キュー除去/実行中=abort) */
  evolutionCancel: 'evolution:cancel',
  /** M27-4: プラグインのエクスポート(コード+テスト+マニフェストのディレクトリ書き出し) */
  pluginsExport: 'plugins:export',
  /** M27-4: プラグインのインポート(検査→既存の検証ゲート→承認→導入) */
  pluginsImport: 'plugins:import',
  /** M26-7: 表示中の会話の workspace を明示的に移動する */
  conversationMoveWorkspace: 'conversation:move-workspace',
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
  /** M29-5: 仮導入(包括承認)の棚卸し */
  inventoryList: 'inventory:list',
  inventoryResolve: 'inventory:resolve',
  /** M22: 実行中ラン一覧(複数プロジェクト同時実行の状態) */
  runsList: 'runs:list',
  runsChanged: 'runs:changed',
  /** M23-2: 使用量サマリと残高ダッシュボードを開く */
  usageGet: 'usage:get',
  openBillingPage: 'billing:open',
  /** M41-2: 外部URLを既定ブラウザで開く(X投稿画面・はてブ等。http/https のみ) */
  openExternal: 'external:open',
  /** M20: 起動時フラグ(セーフモード/進化再起動完了)とセーフモード解除 */
  runtimeFlags: 'runtime:flags',
  safeModeClear: 'safemode:clear',
  /** M20: ロールバック履歴(evolveタグ)と「1つ前へ戻す」 */
  evolutionHistory: 'evolution:history',
  evolutionRollbackLast: 'evolution:rollback-last',
  /** M23-6: 進化で獲得した能力(スキル/自己書き換え)一覧 */
  evolutionCapabilities: 'evolution:capabilities',
  /** M32: 運営(Project TAKAMA-gahara)。operations.enabled=オーナーモード時のみ有効 */
  operationsStatus: 'operations:status',
  operationsSnapshot: 'operations:snapshot',
  operationsHistory: 'operations:history',
  operationsWeeklyReport: 'operations:weekly-report',
  operationsDraftsGenerate: 'operations:drafts-generate',
  operationsDraftsList: 'operations:drafts-list',
  operationsDraftUpdate: 'operations:draft-update',
  /** M37: 下書きの行き先(種類ごとに固定)。どちらも岩戸ゲートの承認を通る */
  operationsDraftRelease: 'operations:draft-release',
  /** M46: 次のリリース版を自動採番するための現況(最新タグ・アプリ版) */
  operationsReleaseInfo: 'operations:release-info',
  /** M47: package.json の version をリリースに合わせて上げる(承認必須) */
  operationsBumpVersion: 'operations:bump-version',
  /** M48: 下書きリリースの公開(全利用者へ更新通知が飛ぶ。岩戸ゲート承認必須) */
  operationsReleasePublish: 'operations:release-publish',
  operationsDraftZennArticle: 'operations:draft-zenn-article',
  /** M38-3: 発信の効果測定(投稿→前後メトリクス差分) */
  operationsImpacts: 'operations:impacts',
  operationsStrategyBoard: 'operations:strategy-board',
  operationsDiscoverySearch: 'operations:discovery-search',
  operationsCandidateAnalyze: 'operations:candidate-analyze',
  operationsCandidatesList: 'operations:candidates-list',
  operationsCandidateResolve: 'operations:candidate-resolve',
  operationsTriage: 'operations:triage',
  /** 岩戸ゲート: 実行要求(main内で承認フローが走る)と承認ダイアログの橋渡し */
  operationsExecute: 'operations:execute',
  operationsApprovalRequest: 'operations:approval-request',
  operationsApprovalRespond: 'operations:approval-respond',
  /** M34-6: 岩戸承認がどこか(デスクトップ/リモート/タイムアウト)で解決された通知 */
  operationsApprovalResolved: 'operations:approval-resolved',
  /** M33: 神議アーキテクチャ(時計・受け箱・⛩運営スレッド・承認バッチ) */
  operationsClocks: 'operations:clocks',
  operationsClockUpdate: 'operations:clock-update',
  operationsInboxList: 'operations:inbox-list',
  operationsInboxMarkRead: 'operations:inbox-mark-read',
  operationsThreadList: 'operations:thread-list',
  operationsThreadSend: 'operations:thread-send',
  operationsThreadBatches: 'operations:thread-batches',
  operationsThreadPending: 'operations:thread-pending',
  operationsBatchRespond: 'operations:batch-respond',
  /** M39: 同種(媒体×アクション)の一括承認。岩戸ダイアログは全件まとめて1回 */
  operationsBulkRespond: 'operations:bulk-respond',
  operationsKamuhakariRun: 'operations:kamuhakari-run',
  /** M33-5: 神の宣言的定義(適用は岩戸ゲート承認必須) */
  operationsGodDefs: 'operations:god-defs',
  operationsGodDefApply: 'operations:god-def-apply',
  /** M42-3: レジストリで配布されている神の一覧・迎え入れ・書き出し */
  operationsGodRegistry: 'operations:god-registry',
  operationsGodInstall: 'operations:god-install',
  operationsGodExport: 'operations:god-export',
  /** M42-1: アプリ本体の更新確認(通知だけ。自動更新はしない) */
  updateCheck: 'update:check',
  /** M42(TUKU-yomi): 月読モード。**remote-ui へは中継しない**(鉄則4) */
  tsukuyomiStatus: 'tsukuyomi:status',
  tsukuyomiList: 'tsukuyomi:list',
  tsukuyomiAdd: 'tsukuyomi:add',
  tsukuyomiSetDone: 'tsukuyomi:set-done',
  tsukuyomiSpeak: 'tsukuyomi:speak',
  tsukuyomiEvent: 'tsukuyomi:event',
} as const;

/** preload が window.api として公開するAPIの型。renderer はこれ経由でしか main と話せない */
export interface AmaterasApi {
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
  /** M25: ユーザー方針(AMATERAS-USER.md・全プロジェクト共通) */
  userMemoryGet(): Promise<string>;
  userMemorySet(content: string): Promise<void>;

  /** APIキーは書き込みのみ。読み出しは有無のbooleanだけ */
  secretsSet(slot: SecretSlot, apiKey: string): Promise<SecretsStatus>;
  secretsStatus(): Promise<SecretsStatus>;
  /** M27-1: 現在の設定で1リクエスト送る接続テスト */
  connectionTest(): Promise<ConnectionTestResult>;

  onEvolutionEvent(listener: (event: EvolutionEvent) => void): () => void;
  evolutionPromoteRespond(jobId: number, approved: boolean): Promise<void>;
  /** 手動で進化ジョブを起動(デバッグ・検証用) */
  evolutionEnqueue(description: string, expectedIo: string, scope?: EvolutionScope): Promise<{ jobId: number }>;
  evolutionList(): Promise<EvolutionJobSummary[]>;
  /** M26-6: ジョブのキャンセル。ok=false は対象外の状態(昇格待ち以降・完了済み等) */
  evolutionCancel(jobId: number): Promise<{ ok: boolean }>;
  /** M27-4: プラグインのエクスポート(書き出し先はダイアログで選択) */
  pluginsExport(toolName: string): Promise<PluginExportResult>;
  /** M27-4: プラグインのインポート(フォルダ選択→検査→検証ゲートつき進化ジョブ) */
  pluginsImport(): Promise<PluginImportStartResult>;
  /** M26-7: 表示中の会話の workspace を移動(実行中は不可)。以降のツール実行が移動先を参照 */
  conversationMoveWorkspace(newWorkspace: string): Promise<{ ok: boolean; message: string }>;

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
  /** M29-5: ON時に包括承認範囲を指定できる(省略=設定の既定値、それも無ければ none) */
  autonomousSet(on: boolean, registryScope?: AutonomousRegistryScope): Promise<{ on: boolean }>;
  /** M29-5: 仮導入(棚卸し待ち)の一覧と応答(keep=残す / false=完全アンインストール) */
  inventoryList(): Promise<ProvisionalInstall[]>;
  inventoryResolve(jobId: number, keep: boolean): Promise<{ ok: boolean; message: string }>;
  onAutonomousChanged(listener: (payload: AutonomousStatePayload) => void): () => void;

  /** M22: 実行中ラン一覧(初期取得+変更購読)。複数プロジェクト同時実行の左ペイン表示用 */
  runsList(): Promise<RunInfo[]>;
  onRunsChanged(listener: (runs: RunInfo[]) => void): () => void;

  /** M23-2: 使用量(トークン・概算コスト)サマリ / プロバイダの残高ダッシュボードを開く */
  usageGet(): Promise<UsageSummary>;
  /** M27-1: プリセット(gemini等)はAPIキー取得ページを開く(URLはmain側の固定allowlist) */
  openBillingPage(provider: SecretSlot): Promise<void>;
  /** M41-2: 外部URLを既定ブラウザで開く(アプリ内ウィンドウでは開かない) */
  openExternal(url: string): Promise<void>;

  /** M20: 起動時フラグ(セーフモード/進化再起動完了のバナー用)とセーフモード解除 */
  runtimeFlags(): Promise<{
    safeMode: boolean;
    safeModeInfo?: { tag: string; prevCommit: string };
    restartedFrom?: string;
    /** M28-2: 配布版(進化機能は無効化され、UIで理由を表示する) */
    packaged?: boolean;
  }>;
  safeModeClear(): Promise<{ cleared: boolean }>;

  /** M20: 進化のロールバック履歴と「1つ前へ戻す」(HEADが最新evolveマージのときのみ) */
  evolutionHistory(): Promise<
    { tag: string; commit: string; date: string; subject: string; body: string }[]
  >;
  evolutionRollbackLast(): Promise<{ ok: boolean; message: string }>;
  /** M23-6: 昇格ごとの獲得内容(kind/ツール名/変更ファイル)。M25-3: body にジョブ説明が入る */
  evolutionCapabilities(): Promise<
    {
      tag: string;
      commit: string;
      date: string;
      subject: string;
      body: string;
      kind: 'tool' | 'renderer' | 'core';
      toolNames: string[];
      files: string[];
    }[]
  >;

  /**
   * M32: 運営(Project TAKAMA-gahara)。operations.enabled=オーナーモードOFFのとき、
   * status は enabled:false を返し、他は空/nullを返す(UIはタブ自体を出さない)
   */
  operationsStatus(): Promise<{
    enabled: boolean;
    ghDetected: boolean;
    ghPath: string | null;
    adapters: AdapterStatusInfo[];
    /** M37: リリースノート下書きの行き先候補 */
    repos: string[];
  }>;
  operationsSnapshot(): Promise<MetricsSnapshot | null>;
  operationsHistory(limit?: number): Promise<MetricsSnapshot[]>;
  operationsWeeklyReport(): Promise<OperationsDraft | null>;
  operationsDraftsGenerate(): Promise<OperationsDraft[]>;
  operationsDraftsList(): Promise<OperationsDraft[]>;
  operationsDraftUpdate(
    id: string,
    patch: { status?: 'draft' | 'posted' | 'discarded'; body?: string; title?: string; media?: string },
  ): Promise<OperationsDraft | null>;
  /** M37: リリースノート下書き → GitHub Release(下書き。承認ダイアログ経由) */
  /** M46: 最新リリースと次バージョンの候補(人間が前回の版を覚えなくてよくする) */
  operationsReleaseInfo(repo: string): Promise<{
    latestTag: string | null;
    appVersion: string;
    suggestions: { patch: string | null; minor: string | null; major: string | null };
    mismatch: boolean;
    pendingDraft: { tag: string; assets: string[] } | null;
  }>;
  /** M48: 下書きリリースを公開する(承認ダイアログで「全利用者に通知が出る」ことを明示) */
  operationsReleasePublish(repo: string, tag: string): Promise<{ ok: boolean; detail: string }>;
  /** M47: package.json の version をタグに合わせて上げ、コミット・pushする(岩戸ゲート経由) */
  operationsBumpVersion(tag: string): Promise<{ ok: boolean; detail: string }>;
  operationsDraftRelease(
    draftId: string,
    repo: string,
    tag: string,
  ): Promise<{ ok: boolean; detail: string }>;
  /** M37: 記事アウトライン → 本文をLLMで起こし、承認後 zenn-content に published:false でコミット */
  operationsDraftZennArticle(
    draftId: string,
  ): Promise<{ ok: boolean; detail: string; bodyDraftId?: string }>;
  /** M38-3: 投稿ごとの前後メトリクス差分(相関であって因果ではない) */
  operationsImpacts(windowHours?: number): Promise<ImpactEntry[]>;
  operationsStrategyBoard(): Promise<MediaStrategyEntry[]>;
  operationsDiscoverySearch(keywords: string[]): Promise<{
    x: { label: string; query: string; url: string }[];
    bluesky: { author: string; handle: string; text: string; uri: string }[];
    /** M33-7: HN検索(read専用アダプタ) */
    hn: { id: number; title: string; url: string; points: number; numComments: number; author: string }[];
  }>;
  operationsCandidateAnalyze(pastedText: string, source: string): Promise<CommunityCandidate | null>;
  operationsCandidatesList(): Promise<CommunityCandidate[]>;
  operationsCandidateResolve(id: string, status: 'kept' | 'discarded'): Promise<CommunityCandidate | null>;
  operationsTriage(): Promise<TriageCard[]>;
  /** 岩戸ゲート: 承認ダイアログ(onOperationsApprovalRequest)を経てのみ実行される */
  operationsExecute(
    adapterId: string,
    action: string,
    target: string,
    preview: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; detail: string }>;
  onOperationsApprovalRequest(listener: (req: IwatoRequestPayload) => void): () => void;
  operationsApprovalRespond(id: string, approved: boolean): Promise<void>;
  /** M34-6: リモート/タイムアウトで解決された岩戸承認をデスクトップ側ダイアログからも消す */
  onOperationsApprovalResolved(listener: (payload: { id: string; approved: boolean }) => void): () => void;

  /** M33: 神議アーキテクチャ。オーナーモードOFF時は空/nullを返す */
  operationsClocks(): Promise<GodClockJob[]>;
  operationsClockUpdate(
    id: string,
    patch: {
      intervalMin?: number;
      enabled?: boolean;
      dailyTokenBudget?: number;
      /** M38-1: false=🔓 予算の調整権限を神議へ返す(施錠は予算設定時に自動) */
      budgetSetByUser?: boolean;
    },
  ): Promise<GodClockJob | null>;
  operationsInboxList(limit?: number): Promise<(InboxItem & { read: boolean })[]>;
  operationsInboxMarkRead(ids: string[]): Promise<void>;
  operationsThreadList(): Promise<OpsThreadMessage[]>;
  operationsThreadSend(text: string): Promise<OpsThreadMessage[]>;
  operationsThreadBatches(): Promise<ApprovalBatch[]>;
  operationsThreadPending(): Promise<number>;
  operationsBatchRespond(batchId: string, itemId: string, approved: boolean): Promise<{ ok: boolean; detail: string }>;
  /**
   * M39: 同種(媒体×アクション)の複数項目を一括で承認/却下する。
   * 実行系は岩戸ダイアログに全件の全文が並び、承認後に1件ずつ実行(部分成功を返す)。
   * X/はてブは links を返すので renderer が開く(投稿ボタンは人間が押す)
   */
  operationsBulkRespond(batchId: string, itemIds: string[], approved: boolean): Promise<BulkRespondResult>;
  /** 神議の手動開催(定刻を待たずに1回) */
  operationsKamuhakariRun(): Promise<{ analysis: string; batchItems: number; applied: number }>;
  /** M33-5: 神の定義一覧と変更申請(適用は承認ダイアログ=岩戸ゲートを通る) */
  operationsGodDefs(): Promise<unknown[]>;
  operationsGodDefApply(definition: unknown): Promise<{ ok: boolean; detail: string }>;
  /** M42-3: レジストリの神を探す / 迎える(迎え入れは岩戸ゲートで定義JSON全文を確認) */
  operationsGodRegistry(query?: string): Promise<RegistryGodInfo[]>;
  operationsGodInstall(id: string): Promise<{ ok: boolean; detail: string }>;
  /** M42-3: 自分の神の定義をファイルに書き出す(レジストリへPRするため) */
  operationsGodExport(id: string): Promise<{ ok: boolean; message: string }>;
  /** M42-1: 更新確認。newer=true のときだけUIに出す(nullは未確認・無効・不達) */
  updateCheck(): Promise<UpdateInfo | null>;
  /** M42(TUKU-yomi): 月読モード。鍵の無い機体では enabled:false が返り、タブもトグルも出ない */
  tsukuyomiStatus(): Promise<TsukuyomiStatus>;
  tsukuyomiList(): Promise<ChoEntry[]>;
  tsukuyomiAdd(entry: { kind: ChoEntry['kind']; text: string; source: ChoEntry['source']; due?: string }): Promise<ChoEntry | null>;
  tsukuyomiSetDone(id: string, done: boolean): Promise<ChoEntry | null>;
  /** ユーザー起点の発話(予算を消費しない) */
  tsukuyomiSpeak(text: string): Promise<boolean>;
  onTsukuyomiEvent(listener: (event: TsukuyomiEvent) => void): () => void;
}
