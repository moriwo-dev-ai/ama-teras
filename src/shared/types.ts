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
  | {
      kind: 'error';
      sessionId: string;
      message: string;
      /** M30-2: エラーカードから設定を開く導線(models=モデル運用タブ / basic=基本タブ) */
      settingsHint?: 'models' | 'basic';
    }
  /** M16-1: 中立の情報カード(モデル切替検知・フォールバック発動等) */
  | { kind: 'info'; sessionId: string; message: string }
  /** M19: 品質レビューの採点カード */
  | ({ kind: 'review'; sessionId: string } & ReviewCardPayload)
  /** M21-1: 実行中に送られた追加指示がキューへ積まれた(次ターン境界で履歴へ注入される) */
  | { kind: 'instruction_queued'; sessionId: string; text: string }
  /** M21-4: 実行中ツールのライブ出力(bash等のstdout末尾。ctx.log経由・APIコストなし) */
  | { kind: 'tool_progress'; sessionId: string; toolUseId: string; name: string; outputTail: string }
  /** M29-5: 自律実行の終了時に出す仮導入の棚卸しカード(残す/削除は inventoryResolve IPC) */
  | { kind: 'inventory'; sessionId: string; items: ProvisionalInstall[] };

export type ProviderId = 'anthropic' | 'openai';

/**
 * M27-1: 無料APIモードのプロバイダプリセット。OpenAI互換エンドポイント
 * (openai SDK + baseURL差し替え)として動くため ProviderId は 'openai' のまま。
 * プリセットの実体(baseUrl・既定モデル・案内文)は shared/models.ts の PROVIDER_PRESETS
 */
/** M35-5: 'custom' = 任意のOpenAI互換エンドポイント(Ollama等。baseURLはconfig.customBaseUrl) */
export type ProviderPresetId = 'gemini' | 'groq' | 'openrouter' | 'custom';

/** APIキーの保存スロット。プリセットはOpenAIと別のキーを持つため独立スロット。
 *  M35-4: 'bluesky' はAPIキーではなく資格情報JSON({identifier, appPassword})を保存する。
 *  M91-2: 'github' はレジストリへのPR提出・本体への要望Issue提出に使うトークン
 *  (公開リポジトリへの書き込みのみ。fork+PRのため public_repo 相当で足りる) */
export type SecretSlot = ProviderId | ProviderPresetId | 'bluesky' | 'github';

/** 送信モード。plan は実装前に計画を提示し、ツールを実行しない(承認後に通常モードで実行) */
export type ChatMode = 'normal' | 'plan';

export interface SecretsStatus {
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  groq: boolean;
  openrouter: boolean;
  /** M35-5: カスタム(OpenAI互換)エンドポイント用スロット。ローカル(Ollama等)はキー不要 */
  custom: boolean;
  /** M35-4: Bluesky実行系の資格情報(identifier+app passwordのJSON)。有無のみ */
  bluesky: boolean;
  /** M91-2: GitHubトークン(レジストリPR・要望Issueの提出に使う)。有無のみ */
  github: boolean;
}

/** M27-1: 接続テスト(設定画面の「無料で始める」等)の結果 */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
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
  /**
   * M28-1: 保護領域(聖域)への書き込み要求。UIは赤バナーで明示する。
   * 自律モード・自動承認では手前でハード拒否されるため、これが立つのは手動承認のみ
   */
  sanctuary?: boolean;
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
  /**
   * M26-3: 中間格上げ先(例: Opus)。レビュー差し戻しfixの3ラウンド目に使う
   * (round 1-2=worker → 3=midEscalation → 4+=escalation)。未指定なら escalation
   */
  midEscalation?: ModelBand;
  /**
   * M26-3: 調査用の帯(例: Haiku)。dispatch_agent の mode:"read"(調査)サブエージェントに
   * 使う。未指定なら worker 帯
   */
  explorer?: ModelBand;
  /**
   * M26-2: 日常レビュー(監査役)用の帯。未指定なら従来どおり planner 帯。
   * ただし最終マイルストーン完了時・コア領域に触れる変更・進化昇格前のレビューは
   * reviewer 指定があっても planner 帯で実施する(service側で固定)
   */
  reviewer?: ModelBand;
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
  /**
   * M92-A5-a: 自己進化のツール生成だけに使うモデル(同じ provider/キーでモデルだけ差し替え)。
   * 空/未設定なら本体モデル(model)を使う。難タスクの成功率を上げたいときに強モデルへ寄せる保険。
   */
  generationModel?: string;
  /**
   * M92-A6: 同時に走らせる生成ジョブ数(1〜4。未設定=2)。各ジョブは独立worktreeで隔離され
   * 生成・ゲートは並走するが、昇格(mainマージ)は必ず直列。夜間の大量生成のスループット用。
   */
  evolutionConcurrency?: number;
  /**
   * M27-1: 無料APIモードのプリセット(Gemini/Groq/OpenRouter)。provider='openai' の
   * ときだけ意味を持ち、OpenAI互換エンドポイント(baseURL差し替え)+専用キー
   * スロットで動く。未設定=従来どおり
   */
  providerPreset?: ProviderPresetId;
  /**
   * M27-1: 無料APIモード。true のとき既定を軽量化する(maxTurns既定15・
   * レビューゲートOFF・ModelPolicy無効)+ request_capability による新規生成を
   * 無効化(freeModeAllowEvolution=true でオプトイン解除可)。
   * プリセット選択時に自動ONになるが手動で切替可能
   */
  freeMode?: boolean;
  /** M27-1: 無料モードでも自己進化(新規プラグイン生成)を許可するオプトイン */
  freeModeAllowEvolution?: boolean;
  /**
   * M27-4: プラグイン失効リスト(キルスイッチ)のURL。既定は未設定=チェックしない。
   * 起動時にフェッチし、一致する導入済みプラグインを自動無効化する。不達は静かにスキップ
   */
  pluginRevocationUrl?: string;
  /**
   * M28-3: コミュニティレジストリのベースURL(「作る前に探す」)。既定=公式レジストリ
   * (M29-4)。空文字=検索無効。request_capability の生成前に <registryUrl>/index.json を
   * 検索し、既存プラグインがあれば承諾のうえ既存インポートパイプライン(検証ゲート付き)で導入する
   */
  registryUrl?: string;
  /**
   * M91-2: レジストリへ公開するときのクレジット(manifest.author / DCOのSigned-off-by)。
   * 未設定なら公開時に入力を求める(空のまま出すと、誰が作ったツールか分からなくなる)
   */
  registryAuthor?: string;
  /**
   * M91-3: 本体(コア/UI)への要望の宛先リポジトリ。既定=公式(ama-teras)。
   * 空文字=要望の提出を無効化。フォーク運用の人は自分のリポジトリへ向けられる
   */
  requestsRepoUrl?: string;
  /**
   * M91-6: GitHub Device Flow の OAuth App Client ID(公開情報)。既定は同梱の公式ID。
   * 自前のOAuth Appを使う人はここに入れる。空なら「GitHubと接続」は無効(PAT貼り付けにフォールバック)
   */
  githubClientId?: string;
  /**
   * M42-1: 本体の更新確認(GitHub Releases API)。既定=公式リリース。空文字=無効。
   * **通知だけ**を行う(自動ダウンロード・自動インストールはしない)
   */
  updateCheckUrl?: string;
  /**
   * M29-5: 自律モード(連続作業)開始時の包括承認の既定値。実行開始UIで上書き可能。
   * none=自動導入なし(既定)/ verified=検証済み+危険権限なしのみ仮導入 /
   * verified-generate=上記+新規生成プラグインも仮導入。
   * 仮導入は終了後の棚卸しカードで人間が最終判断する(残す/削除)
   */
  autonomousRegistryScope?: AutonomousRegistryScope;
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
  /**
   * M32-1: 運営(Project TAKAMA-gahara)。enabled は「オーナーモード」スイッチ
   * (既定OFF=運営タブ自体を表示しない。ON時のみ gh検出・メトリクス収集が動く)
   */
  operations?: OperationsConfig;
  /**
   * M42(TUKU-yomi): 月読モード。**オーナー機体限定**(userData/tsukuyomi/.owner が門)。
   * 鍵の無い機体では main 側が enabled:false に正規化するため、実質存在しないのと同じになる
   */
  tsukuyomi?: TsukuyomiConfig;
  /**
   * M35-5: providerPreset='custom' のときのOpenAI互換エンドポイント(Ollama等)。
   * http(s)のみ。localhost系はキー不要(ダミーキーで接続)
   */
  customBaseUrl?: string;
}

// ---- M32: Project TAKAMA-gahara(運営) ----

/** M32-1: 運営設定。enabled=オーナーモード(既定OFF)。M34のフィールドは全て任意=旧形式互換 */
export interface OperationsConfig {
  enabled: boolean;
  /** 観測対象リポジトリ('owner/repo' 形式) */
  repos: string[];
  /** 観測対象Zenn記事スラッグ(zenn.dev/api/articles/{slug}) */
  zennSlugs: string[];
  /**
   * M34-1: はてブ数の監視URL(任意追加分)。Zenn記事のURLは zennSlugs から
   * 自動導出(APIのpath)されるので、ここには他媒体のURLだけ入れればよい
   */
  watchUrls?: string[];
  /** M34-2: HN karma監視のユーザー名(読み取りのみ) */
  hnUser?: string;
  /** M34-2: HN監視スレッド(item idまたはitem?id=のURL) */
  hnThreads?: string[];
  /** M34-7: 神議(分析・週報)専用モデル帯。未設定=従来のplanner帯 */
  kamuhakariBand?: ModelBand;
  /** M34-7: 神々(判定・下書き)専用モデル帯。未設定=従来のworker帯 */
  godsBand?: ModelBand;
  /** M37: Zenn記事リポジトリ(zenn-content)のローカルパス。未設定=「Zenn記事化」は使えない */
  zennRepoDir?: string;
  /**
   * M41-3: 運営対象プロジェクトの自己紹介。神々のプロンプト(広報・記事・トリアージ・神議)へ
   * 差し込む。未設定なら観測対象リポジトリ名から推測する(一般ユーザーが自分のOSSで使える)
   */
  projectName?: string;
  projectDescription?: string;
  /**
   * M43-1: 発信テキストの {URL} の解決先(告知したいURL)。未設定なら観測対象リポジトリの
   * GitHub URL。どちらも無ければ {URL} は**プレースホルダごと落とす**(テンプレートを外に出さない)
   */
  projectUrl?: string;
  /** 巡回・X検索のキーワード。未設定なら神議が育てた god-params の値を使う */
  keywords?: string[];
  /** Zenn記事のfrontmatter topics。未設定なら ['ai'] */
  zennTopics?: string[];
}

/** M41-3: 神々のプロンプトに差し込むプロジェクトの自己紹介(manager が config から解決) */
export interface ProjectProfile {
  name: string;
  description: string;
}

/** アダプタ能力宣言(OPERATIONS_DESIGN.md の規約どおり) */
export interface AdapterCapabilities {
  /** 観測(メトリクス・投稿・反応の取得) */
  read: boolean;
  /** 発見(候補・言及の検索) */
  search: boolean;
  /** 下書き生成の対象か */
  draft: boolean;
  /** 承認後に実行可能なアクション(空=提案のみ) */
  execute: string[];
}

/** 外部媒体アダプタの宣言部(executor は含まれない=renderer へ渡してよい形) */
export interface MediaAdapter {
  id: string;
  capabilities: AdapterCapabilities;
  /** 規約上の制約メモ(UIに表示) */
  compliance: string;
}

/** 運営タブのアダプタ状態表示 */
export interface AdapterStatusInfo extends MediaAdapter {
  available: boolean;
  detail?: string;
}

/** 岩戸ゲートの承認ダイアログに渡す内容(何を・どこへ・全文プレビュー) */
export interface IwatoRequestPayload {
  id: string;
  adapterId: string;
  action: string;
  /** どこへ(リポジトリ/Issue番号/投稿先など人間が読める形) */
  target: string;
  /** 全文プレビュー(投稿・コメントの本文そのもの) */
  preview: string;
  /** アダプタの規約メモ(ダイアログに表示) */
  compliance: string;
}

/** OMOI-kami: リポジトリ単位のメトリクス */
export interface RepoMetrics {
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  openPRs: number;
  /** traffic API(push権限が要る。失敗時は undefined) */
  views?: number;
  viewsUnique?: number;
  clones?: number;
  clonesUnique?: number;
  referrers?: { referrer: string; count: number; uniques: number }[];
  /** リリースアセットの合計DL数 */
  downloads?: number;
}

export interface ZennMetrics {
  liked: number;
  comments: number;
  /** M34-1: 記事の正規URLパス(はてブ数導出用。旧スナップショットには無い=任意) */
  path?: string;
}

/** OMOI-kami: 日次スナップショット(userData/operations/metrics.jsonl に1行1件)。
 *  M34フィールドは全て任意=稼働中インスタンスが書いた旧形式もそのまま読める */
export interface MetricsSnapshot {
  ts: string;
  github: Record<string, RepoMetrics>;
  zenn: Record<string, ZennMetrics>;
  registry?: { plugins: number };
  /** M34-1: はてブ数(URL→件数) */
  hatena?: Record<string, number>;
  /** M34-2: HN観測(karma等) */
  hn?: { karma?: number };
}

/**
 * AMENO-uzume: 発信下書き。行き先ごとのアクション(M37)はあるが、
 * 外部への発行は必ず岩戸ゲート(承認)を通る。Xだけは規約上リンクを開くまで
 */
/** M38-3: 発信の効果測定(投稿→前後メトリクス差分)。相関であって因果ではない */
export interface MetricTotals {
  stars: number;
  zennLiked: number;
  zennComments: number;
  hatena: number;
  downloads: number;
  views: number;
}

export interface ImpactEntry {
  draftId: string;
  title: string;
  media: string | null;
  /** 本文から拾った最初のURL(どの投稿かを人間が辿る手掛かり) */
  url: string | null;
  postedAt: string;
  /** 計測窓(時間)。この時間ぶん経ってから after を取る */
  windowHours: number;
  /** false = まだ計測窓が閉じていない/スナップショットが足りない */
  measurable: boolean;
  before: MetricTotals | null;
  after: MetricTotals | null;
  delta: MetricTotals | null;
  note: string;
}

export interface OperationsDraft {
  id: string;
  /** M37: article-body = アウトラインから起こしたZenn記事本文(frontmatter込み) */
  kind: 'x-post' | 'release-note' | 'article-outline' | 'article-body' | 'reply' | 'weekly-report';
  title: string;
  body: string;
  createdAt: string;
  /**
   * M57: staged = 出す準備までできたが**まだ非公開**(Zennの published:false /
   * GitHubのdraft release)。公開には人間があと1手打つ必要がある。
   * posted と混ぜてはいけない — 混ぜていたせいで、誰にも読まれていない記事を
   * 「発信した」と数え、神議が「物量過多」と誤診していた
   */
  status: 'draft' | 'staged' | 'posted' | 'discarded';
  /** 「投稿済み」マークの日時(OMOI-kamiの反応突き合わせ用) */
  postedAt?: string;
  /** 投稿先媒体(x / zenn / hatena / hn / reddit / bluesky 等) */
  media?: string;
  /**
   * M87: この下書きが実体になった先の識別子(GitHubリリースのタグ / Zennのslug)。
   * これが無かったせいで、**公開済みのリリースなのに台帳は「公開待ち」のまま**だった
   * (どの下書きがどのリリースなのか、突き合わせる手掛かりが無い)。
   * 台帳の状態は、これを鍵にして一次情報(gh/Zenn)から書き直す
   */
  tag?: string;
}

/** AMENO-uzume: 仲間発見の候補カード */
export interface CommunityCandidate {
  id: string;
  /** 入力経路(x-paste / bluesky-search 等) */
  source: string;
  /** 貼り付けられた/取得したプロフィール・投稿の原文(要約はLLM評価側) */
  profile: string;
  verdict: 'match' | 'no-match' | 'unclear';
  /** なぜこの人か(ヒューリスティクス: 自作公開/失敗談/売り込み導線なし/実験の話) */
  reasons: string[];
  /** その人の直近の話題への返信下書き(宣伝ではなく内容への反応) */
  replyDraft?: string;
  createdAt: string;
  status: 'new' | 'kept' | 'discarded';
}

/** TEDIKA-rao: Issue/PRトリアージカード */
export interface TriageFinding {
  severity: 'high' | 'medium' | 'low';
  note: string;
}

export interface TriageCard {
  id: string;
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  author: string;
  summary: string;
  findings: TriageFinding[];
  replyDraft: string;
  labels: string[];
  /** マージ可否等の推奨アクション(実行は岩戸ゲート経由のみ) */
  recommendation: string;
  /** レジストリPR等のCI結果(check-runs) */
  ci?: { name: string; status: string; conclusion: string }[];
  createdAt: string;
}

// ---- M33: 神議(かむはかり)アーキテクチャ ----

/** M33-1: 神の時計(スケジューラのジョブ)。intervalMin か dailyTimes のどちらかの時計を持つ */
export interface GodClockJob {
  id: string;
  godId: string;
  intervalMin: number;
  /** 神議用: 毎日の実行時刻 'HH:MM'。指定時は intervalMin より優先 */
  dailyTimes?: string[];
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  /** 1日トークン予算(0=無制限)。超過で間隔自動倍化+報告 */
  dailyTokenBudget: number;
  /**
   * M36-1: ユーザーが手動設定した予算(true のとき神議の自律調整=引き下げも不可。
   * 人間承認済みの変更は可)。任意フィールド=旧形式互換
   */
  budgetSetByUser?: boolean;
  spentToday: number;
  spentDate?: string;
  baseIntervalMin?: number;
}

/** M33-2: 受け箱(神々の成果物キュー) */
export type InboxItemKind =
  | 'metrics'
  | 'candidate'
  | 'draft'
  | 'triage'
  | 'budget-alert'
  | 'kamuhakari-report'
  /** M34-2: HNの新着コメント・自コメントへの返信(payload.fullText に全文) */
  | 'hn-reply'
  /** M38-2: 承認された能力ギャップから進化ジョブを起票した通知 */
  | 'evolution'
  /**
   * M58: 神が**仕事をできなかった**という報告。
   * 巡回の神はBluesky検索が403(認証必須化)を返しても「巡回完了(評価0)」と
   * 成功を報告し続けていた。働けない神は、働けないと言わなければならない
   */
  | 'god-failure';

export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  ts: string;
  godId: string;
  title: string;
  payload: Record<string, unknown>;
}

/** M33-4: 神議のパラメータ変更(2段階制)。自律可/承認必須の分類は kamuhakari.ts の純関数 */
export interface ParamChange {
  kind:
    | 'interval'
    | 'keywords'
    | 'pause'
    | 'resume'
    | 'tool-toggle'
    | 'rate-limit'
    | 'budget-decrease'
    | 'new-tool'
    | 'judge-prompt'
    | 'budget-increase'
    | 'god-create'
    | 'god-delete';
  godId: string;
  reason: string;
  value?: unknown;
}

export interface ApprovalBatchItem {
  id: string;
  kind: 'exec-action' | 'param-approval' | 'capability-gap';
  title: string;
  detail: string;
  action?: { adapterId: string; actionName: string; target: string; preview: string; params: Record<string, unknown> };
  change?: ParamChange;
  /**
   * M33-6: 能力ギャップの3分岐。adhoc=単発カバー(通常チャットで実行)/
   * evolve=request_capability起票案 / new-god=新神定義の下書き(承認→岩戸ゲート→有効化)
   * M42-2/3: registry / godRegistry が付いていれば「作る前に探す」がレジストリで既存を
   * 見つけている。承認すると生成ではなく **取り込み** に進む(検証ゲートは同じ)
   */
  gap?: {
    branch: 'adhoc' | 'evolve' | 'new-god';
    godDraft?: unknown;
    registry?: RegistryMatchRef;
    godRegistry?: RegistryMatchRef;
    /**
     * M91-4: 起票する進化ジョブのスコープ(未指定=tool)。KUEBIKO が拾った
     * 本体への要望(request:core / request:ui)は core / renderer として起票される
     */
    scope?: EvolutionScope;
    /** M91-4: 出どころのIssue(承認カードから元の要望へ辿れるように) */
    sourceIssue?: { repo: string; number: number; url: string };
  };
  status: 'pending' | 'approved' | 'rejected';
}

/** M42: レジストリで見つかった既存の進化(ツール/神)への参照。UIが候補カードに出す */
export interface RegistryMatchRef {
  /** ツールなら name、神なら id */
  key: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  /** レジストリCI+人間承認を通過したか */
  verified: boolean;
}

/** M42-3: レジストリで配布されている神定義(index.json の gods[]) */
export interface RegistryGodInfo {
  id: string;
  name: string;
  description: string;
  engine: string;
  version: string;
  author: string;
  verified: boolean;
}

/**
 * M42(TUKU-yomi): 月読モードの設定。
 *
 * 鉄則: 既定は全部OFF。オーナー機体限定(userData/tsukuyomi/.owner の存在が門)。
 * 鍵が無い機体では main 側が enabled を強制 false に正規化する(UIの出し分けだけに頼らない)。
 * 一度ONにした目・耳は再起動後も継続するが、稼働中は必ず可視インジケータと1クリック停止が出る。
 */
export interface TsukuyomiConfig {
  /** モード本体。鍵ファイルが無ければ main 側で false に落とされる */
  enabled: boolean;
  /** 口: 実PC音声で喋る(既定false) */
  voiceOutput?: boolean;
  /** 目: カメラ常時(既定false)。ローカル在席検知のみでAPIには何も送らない */
  camera?: boolean;
  /** 目: 映像理解(選別した静止フレームをAPIへ送る。既定false・camera前提) */
  cameraUnderstanding?: boolean;
  /** 耳: 常時聴取(既定false) */
  ears?: boolean;
  /**
   * M42-7: 文字起こしの場所。
   * 'local' = ローカル whisper(音声はPCの外に出ない・遅い)/
   * 'cloud' = OpenAI へ音声を送る(速い・正確。**音声がクラウドに出る**)。
   * 既定は 'local'。cloud はイヤホンマイク装着が前提(同席者・テレビを拾いにくくする)
   */
  sttMode?: 'local' | 'cloud';
  /** M42-7: クラウド文字起こしへ送ってよい音声の1日あたりの分数(既定60分) */
  cloudMinutesPerDay?: number;
  /**
   * M43-4: 呼びかけ(「つくよみ」)で会話に入る(既定true)。
   * false にすると常時聴取は一切返事をしない(押して話す時だけ会話する)
   */
  wakeWord?: boolean;
  /**
   * M44-1: 声で AMA-teras を操作する(既定false)。
   * 副作用のある操作は復唱+確認語が要る。外部発信・リリースは声からは実行できない
   */
  voiceCommand?: boolean;
  /**
   * M44-2: 気づいて向こうから提案する(既定false)。
   * 帳に関わる話をしている時だけ。割り込み予算・静音時間を必ず通り、10分に1回まで
   */
  proactive?: boolean;
  /**
   * M43-4: 呼びかけの言葉(カンマ区切り。既定は「アマテラス」等)。
   * 文字起こしが安定して返す語でないと意味がない — 実機で「つくよみ」は
   * 「月曜日」「作り」に化けて呼びかけが通らなかった
   */
  wakeWords?: string;
  /**
   * M43-3: 使うマイク(deviceId)。未指定だとWindowsの既定=内蔵マイクを拾い、
   * イヤホンを着けていても遠くの声を拾って誤認識する(実機で起きた)
   */
  micDeviceId?: string;
  /**
   * M43-1: 会話(既定false)。押して話すと月読が声で返す。
   * 答えの根拠は月の帳だけ(帳に無いことは「記録にありません」と言う)
   */
  conversation?: boolean;
  /** PC窓観測(アクティブウィンドウのタイトルとプロセス名のみ。既定false) */
  pcObserver?: boolean;
  /** 自発的な発話の1日あたり上限(既定5)。ユーザー起点の操作は対象外 */
  interruptBudgetPerDay?: number;
  /** 映像理解のフレーム送信上限(既定: 1時間6枚) */
  framesPerHour?: number;
  /** 同上(既定: 1日50枚) */
  framesPerDay?: number;
  /** 静音時間(既定 23:00〜07:00)。この間は自発的に喋らない */
  quietHours?: { start: string; end: string };
}

/** M42(TUKU-yomi): 月の帳のエントリ。生ログは残さない — 残るのは抽出された一文だけ */
/**
 * M43-2(TUKU-yomi): 会話ログの1行(左ペインの「TUKU-yomi」に出す)。
 * **生の発話がそのまま残る**(帳と違い抽出前の言葉)。userData の中だけ・スマホには流さない
 */
export interface TalkEntry {
  id: string;
  ts: string;
  /** you=本人の声 / tsukuyomi=月読の返事 / action=月読が実行したこと */
  role: 'you' | 'tsukuyomi' | 'action';
  text: string;
}

export interface ChoEntry {
  id: string;
  ts: string;
  kind: 'promise' | 'decision' | 'todo' | 'observation';
  text: string;
  source: 'chat' | 'voice' | 'camera' | 'pc' | 'manual';
  /** 期限(ISO文字列。約束・ToDoのみ) */
  due?: string;
  done?: boolean;
}

/** M42(TUKU-yomi): 月読タブが表示する現況 */
export interface TsukuyomiStatus {
  /** 鍵ファイルの有無。false なら設定トグル自体を描画しない */
  ownerKeyPresent: boolean;
  enabled: boolean;
  voiceOutput: boolean;
  camera: boolean;
  cameraUnderstanding: boolean;
  ears: boolean;
  pcObserver: boolean;
  /** 今日あと何回まで自発的に喋れるか */
  interruptsLeft: number;
  /** 映像理解のフレーム送信の残り(時間・日) */
  framesLeftThisHour: number;
  framesLeftToday: number;
  /** 静音時間の最中か */
  quiet: boolean;
  /** M42-7: 文字起こしの場所。UIは必ずこれを表示する(音声の行き先を隠さない) */
  sttMode: 'local' | 'cloud';
  /** M42-7: クラウドへ送れる音声の残り(分)。local の時は意味を持たない */
  sttMinutesLeft: number;
  /** M43-1: 会話がONか(左ペインの案内文が変わる) */
  conversation: boolean;
  /** M43-3: 使うマイク(未設定なら既定デバイス) */
  micDeviceId?: string;
}

/** M42(TUKU-yomi): main→renderer の通知。remote-ui(スマホ)へは中継しない */
export type TsukuyomiEvent =
  | { type: 'speak'; text: string }
  | { type: 'cho-changed' }
  /** M43-2: 左ペインの会話履歴が変わった */
  | { type: 'talk-changed' }
  | { type: 'status'; status: TsukuyomiStatus };

/** M42-1: アプリ本体の更新確認の結果。newer=true のときだけUIに出す */
export interface UpdateInfo {
  current: string;
  latest: string;
  /** リリースページのURL(既定ブラウザで開く) */
  url: string;
  name: string;
  newer: boolean;
}

/** M33-4: 承認バッチ(神議がまとめる1枚のカード。バラバラ通知の禁止) */
export interface ApprovalBatch {
  id: string;
  ts: string;
  analysis: string;
  items: ApprovalBatchItem[];
}

/** M33-4: ⛩運営スレッドのメッセージ */
export interface OpsThreadMessage {
  id: string;
  ts: string;
  role: 'user' | 'kamuhakari' | 'system';
  kind: 'text' | 'approval-batch' | 'notice';
  body: string;
  batchId?: string;
}

/** メディア戦略ボードの1媒体 */
export interface MediaStrategyEntry {
  media: string;
  audience: string;
  /** 規約・特性メモ */
  note: string;
  /** 次アクションの提案(静的初期データ+メトリクスからの示唆) */
  nextAction: string;
}

/** renderer のツール一覧・デバッグパネル用 */
export interface ToolInfo {
  name: string;
  description: string;
  risk: ToolRisk;
  warnings: string[];
  /** M25-8: 分類タグ(絞り込み・検索用) */
  tags: string[];
  /** M29-5: 仮導入(棚卸し未確定)のプラグイン。UIで「仮」マークを付ける */
  provisional?: boolean;
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

// ---- M27-4: プラグインのエクスポート/インポート(REGISTRY_DESIGN.md マニフェスト仕様) ----

/** 権限宣言。実装コードの静的解析で自動抽出し、宣言との不一致は検出される */
export interface PluginPermissions {
  network: boolean;
  childProcess: boolean;
  /** 'none'=ファイル未使用 / 'workspace'=fs使用(実行時スコープはexecutorが強制) */
  fsScope: 'none' | 'workspace';
}

/** プラグイン1つ=1ディレクトリ(<name>.ts + <name>.test.ts + manifest.json)の manifest */
export interface PluginManifest {
  name: string;
  /** semver */
  version: string;
  /** 本体プラグインAPIとの互換範囲(例 "^1") */
  pluginApiVersion: string;
  description: string;
  author: string;
  /** AGPL互換ライセンスのみ受け入れる(投稿時DCO同意の前提) */
  license: string;
  permissions: PluginPermissions;
  /** フェーズ1は外部依存ゼロをルール化(空配列のみ有効) */
  dependencies: string[];
  /** スモークテスト(検証ゲート3段目)に使う入力。未指定は {} */
  smoke?: { input: unknown };
}

export interface PluginExportResult {
  ok: boolean;
  message: string;
  /** 書き出したディレクトリ(成功時) */
  path?: string;
}

/**
 * M91-2: 公開(レジストリへPR)の下見。**送信はしない**。
 * 人間はこの preview の全文を読んでから承認する
 */
export interface PluginUploadPlanResult {
  ok: boolean;
  message: string;
  toolName: string;
  /** 宛先(registryUrl から導出。既定は公式レジストリ) */
  target?: string;
  /** 送信する全ファイルの全文 */
  preview?: string;
  /** 機械チェック(秘密・ローカルパス)の検出。空でなければ送信できない */
  leaks?: string[];
  /** 検証の状態。verified 以外は公開できない */
  verification: 'verified' | 'unverified' | 'stale';
  /** 改善1: 既に公開済みなら true(下見を見せず、公開を止める) */
  published?: boolean;
  /** 公開済みの場合の既存PR URL */
  publishedUrl?: string;
}

export interface PluginUploadResult {
  ok: boolean;
  message: string;
  /** 提出したPRのURL(成功時) */
  url?: string;
}

/** 改善1: 公開済みツールの控え(ツール名→ここ)。UIの「公開済み」表示に使う */
export interface PublishedPluginInfo {
  url: string;
  ts: string;
}

/** M91-6: Device Flow 開始の結果(この user_code をユーザーに見せ、ブラウザで承認させる) */
export interface GithubAuthStartResult {
  ok: boolean;
  message: string;
  userCode?: string;
  verificationUri?: string;
  expiresInSec?: number;
}

/** M91-6: 承認待ちの結果(承認が済むか、期限切れ/拒否まで待って返る) */
export interface GithubAuthPollResult {
  ok: boolean;
  message: string;
}

// ---- M91-3: 本体(コア/UI)への要望 ----

/** ツールでは解決できない=コア/UIを直さないと届かない話だけがここに来る */
export type CoreRequestKind = 'core' | 'ui';
/** human=人が書いた / agent=AMA-teras が制約に当たって書いた */
export type CoreRequestSource = 'human' | 'agent';
export type CoreRequestStatus = 'draft' | 'sent' | 'discarded';

export interface CoreRequest {
  id: string;
  kind: CoreRequestKind;
  title: string;
  body: string;
  source: CoreRequestSource;
  status: CoreRequestStatus;
  createdAt: string;
  /** 送信後のIssue URL */
  url?: string;
}

/** 送信の下見(送信しない)。重複候補と機械チェックを添えて人間に見せる */
export interface CoreRequestPlanResult {
  ok: boolean;
  message: string;
  /** 送信する全文(タイトル+本文+ラベル+宛先) */
  preview?: string;
  leaks?: string[];
  /** 既に似た要望が出ていないか(重複提出を防ぐ) */
  similar?: { title: string; url: string; number: number }[];
}

export interface CoreRequestSubmitResult {
  ok: boolean;
  message: string;
  url?: string;
}

export interface PluginImportStartResult {
  ok: boolean;
  message: string;
  /** 検証ゲートへ進んだ進化ジョブID(成功時。以降は進化パネルで追跡) */
  jobId?: number;
  manifest?: PluginManifest;
  warnings?: string[];
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
/**
 * M29-5: 自律モードの包括承認範囲(NIGHT_TASKS4 T5)。
 * 「承認を消すのではなく、承認のタイミングを作業の前後(開始時の包括承認+終了後の棚卸し)へ移す」
 */
export type AutonomousRegistryScope = 'none' | 'verified' | 'verified-generate';

/** M29-5: 仮導入されたプラグイン(棚卸しの対象)。userData に永続化され未応答なら再提示 */
export interface ProvisionalInstall {
  jobId: number;
  toolName: string;
  origin: 'registry' | 'generated';
  /** 昇格タグ(evolve/N)。削除=このマージをrevertする */
  tag: string;
  installedAt: string;
}

export interface AutonomousStatePayload {
  on: boolean;
  /** M29-5: この実行の包括承認範囲(offのときは省略) */
  registryScope?: AutonomousRegistryScope;
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

// ---- M93: MCPセットアップ助手(既知サーバーのカタログ / 事前確認 / 接続テスト) ----
// 助手は「テンプレを埋めて→前提を点検して→接続を試す」までを助ける。
// 信頼(trusted)・APIキー・ホストアプリの導入は人間が握り続ける(助手は肩代わりしない)。

export type McpPrereqKind = 'command' | 'env' | 'manual';

/** サーバー起動に必要な前提。command/env は自動点検、manual は人間が判断 */
export interface McpPrereq {
  kind: McpPrereqKind;
  /** command: 実行ファイル名(node 等) / env: 環境変数名 / manual: 省略 */
  name?: string;
  hint: string;
}

/** 引数テンプレ中の穴(ユーザーが埋める)。args に `{{token}}` として現れる */
export interface McpPlaceholder {
  token: string;
  hint: string;
  /** 初期値(あれば) */
  default?: string;
}

/** カタログ1件 = 既知MCPサーバーの起動テンプレ(command/args は編集可能な下書き) */
export interface McpCatalogEntry {
  id: string;
  /** mcp.json のサーバー名の初期候補(編集可) */
  suggestedName: string;
  title: string;
  description: string;
  category: 'files' | 'visual' | 'data' | 'web' | 'memory' | 'other';
  cost: 'free' | 'paid';
  command: string;
  args: string[];
  placeholders?: McpPlaceholder[];
  /** 値は人間が用意する環境変数キー名(助手は値を預からない) */
  requiredEnv?: string[];
  prereqs: McpPrereq[];
  homepage?: string;
}

/** 前提1件の点検結果。ok=null は「人間が確認するもの(manual)」 */
export interface McpReadinessItem {
  kind: McpPrereqKind;
  name?: string;
  hint: string;
  ok: boolean | null;
}

/** カタログ1件の準備状況。ready=自動点検分が全て満たされている(manual は勘定に入れない) */
export interface McpReadiness {
  entryId: string;
  ready: boolean;
  items: McpReadinessItem[];
  /** 人間が確認すべき項目数(manual + 未設定env) */
  manualCount: number;
}

/** 接続テスト(probe)の結果。設定を残さず・信頼も昇格させずに1回だけ繋いで確かめる */
export interface McpProbeResult {
  ok: boolean;
  toolCount: number;
  toolNames: string[];
  error?: string;
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

/** M26-4: 帯(planner/worker/reviewer/explorer/escalation等)別の集計行 */
export interface UsageBandRow {
  /** 帯ラベル。band無しの旧記録・進化ジョブ等は 'other' に集約 */
  band: string;
  today: UsageCellView;
  total: UsageCellView;
}

export interface UsageSummary {
  /** 集計上の「今日」(YYYY-MM-DD・ローカル) */
  day: string;
  models: UsageModelRow[];
  /** M26-4: 帯別集計(band付きで記録された分のみ。旧データはmodelsだけに現れる) */
  bands: UsageBandRow[];
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

/** refs/amateras/checkpoints/ 配下に積まれる作業ツリースナップショット(HEAD/indexは汚さない) */
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
  /** M26-6: ユーザーによる明示キャンセル(queued=キューから除去、実行中=abort) */
  | 'cancelled'
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
  /** M92-A6-2: 夜間自動昇格で積んだ専用ブランチ名(例 'evolve/nightly')。auto昇格したジョブのみ設定 */
  autoBranch?: string;
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
