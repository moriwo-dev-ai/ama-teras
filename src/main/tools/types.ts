import type { EvolutionJobSummary, ToolRisk } from '../../shared/types';

export type JsonSchemaProperty = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: JsonSchemaProperty;
  enum?: (string | number)[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** M11-2: バックグラウンドプロセスの状態スナップショット(bash_output が整形して返す) */
export interface BackgroundProcessSnapshot {
  id: number;
  command: string;
  running: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  /** sinceByte 以降の出力。リングバッファで切り捨て済みの範囲は返らない */
  output: string;
  /** これまでの総出力バイト数(次回の sinceByte に使う) */
  totalBytes: number;
  /** リングバッファ上限で先頭から切り捨てられたバイト数 */
  droppedBytes: number;
}

export interface ToolContext {
  /** セッションの作業ディレクトリ(進化ジョブでは B worktree) */
  cwd: string;
  /** 書き込み許可パス(cwd相対のディレクトリ接頭辞)。undefined なら無制限 */
  writeAllowlist?: string[];
  /**
   * true の場合、exec 系(bash)を検証コマンド(npm run / npx vitest / npx tsc)のみに制限する。
   * 進化ジョブ用: bash は writeAllowlist を強制できず任意パスへ書けてしまうため、
   * 実行できるコマンド自体を機械的に絞ってA環境・保護領域への書き込みを防ぐ。
   */
  restrictExec?: boolean;
  signal: AbortSignal;
  log: (line: string) => void;
  /**
   * M27-1: 自己進化の新規生成が方針で無効なとき、その理由文(request_capability が
   * ジョブを起動せずにこの文言を返す)。無料APIモード(freeMode)で設定される
   */
  evolutionDisabled?: string;
  /**
   * M89: 配布版か。配布版には**進化ジョブという概念自体が無い**(生成は無効、導入はその場で
   * 完結する)。これを伝えないと、evolution_jobs の「ジョブはありません」を見たエージェントが
   * 「申請が消えた/自分の呼び方が悪い」と誤診して迷走する(実機でそうなった)
   */
  packaged?: boolean;
  /**
   * 自己進化への入口。request_capability プラグインだけが使う。
   * (プラグインは evolution モジュールを import できないため、コンテキスト経由で注入する)
   */
  evolution?: {
    /**
     * M20: scope 省略時は 'tool'(従来)。renderer/core は本体変更の提案(常に人間承認)。
     * M25-8: targetTool を指定すると「新規作成」ではなく「既存ツールの修正」として扱われる
     * (scope='tool'のときのみ意味を持つ)
     */
    requestCapability(
      description: string,
      expectedIO: string,
      scope?: 'tool' | 'renderer' | 'core',
      targetTool?: string,
    ): Promise<{ jobId: number }>;
    /**
     * M24: 進化パイプラインの内部状態を読む(evolution_jobs ツール専用)。
     * 現行プロセスで走った/走っているジョブの状態・ゲート結果・ログを返す。
     * 再起動で揮発する(過去に昇格した能力は listEvolvedCapabilities / EvolutionPanel を参照)。
     */
    list?(): EvolutionJobSummary[];
    /**
     * M28-3: 「作る前に探す」。レジストリ(設定 registryUrl)を検索し、候補があれば
     * ユーザー承諾カード → ダウンロード → 既存インポートパイプライン(検証ゲート付き)へ。
     * imported=導入ジョブ開始 / declined=ユーザーが新規生成を選択 / none=候補なし・
     * レジストリ未設定・ネット不達(静かに生成へフォールバック)。
     * freeMode でも利用できる(無効なのは生成のみ=「無料ユーザーは消費者」の設計)
     */
    searchRegistryAndImport?(
      description: string,
      expectedIO: string,
      signal: AbortSignal,
    ): Promise<
      // M71: 配布版の導入は進化ジョブを起票しない(検査→承認→配置で完結)
      | { outcome: 'imported'; jobId?: number; name: string }
      | { outcome: 'declined'; name: string }
      | { outcome: 'none' }
    >;
  };
  /**
   * M25: ユーザー方針(AMATERAS-USER.md・全プロジェクト共通)の保存先ディレクトリ(userData)。
   * memory ツールの scope:'user' だけが使う。進化ジョブには注入されない
   */
  userMemoryDir?: string;
  /**
   * サブエージェント委譲(M8-4 / M12-3)。dispatch_agent プラグインだけが使う。
   * run は従来の読み取り専用の単発委譲。runParallel は最大3並列で、
   * mode:'work' なら書き込み/実行込みの子(すべて executor=承認フロー経由)。
   */
  subagent?: {
    run(task: string, signal: AbortSignal): Promise<string>;
    runParallel?(tasks: string[], mode: 'read' | 'work', signal: AbortSignal): Promise<string[]>;
    /** M21-2: 並列同時数の実効上限(AppConfig.subAgentMaxParallel。未注入なら既定3) */
    maxParallel?: number;
  };
  /**
   * M12-3: サブエージェント実行由来のツール呼び出し識別(1始まりの子番号)。
   * executor が承認ダイアログへ「サブエージェント #N からの要求」を表示するのに使う
   */
  subAgentId?: number;
  /**
   * M11-2: バックグラウンドプロセス管理。bash(background:true)/ bash_output / bash_kill が使う。
   * 進化ジョブ(restrictExec コンテキスト)には注入されない(未注入時は各ツールが明示エラー)。
   */
  processes?: {
    start(command: string, cwd: string): { id: number; pid: number | undefined };
    read(id: number, sinceByte?: number): BackgroundProcessSnapshot | undefined;
    kill(id: number): 'killed' | 'already-exited' | 'not-found';
  };
  /**
   * M14-2: URLスクリーンショット。screenshot プラグインだけが使う
   * (offscreen BrowserWindow は electron 依存のため main から注入する)。
   * 進化ジョブには注入されない
   */
  screenshot?: {
    capture(url: string, width?: number, height?: number): Promise<{ data: string; mediaType: string }>;
  };
}

/**
 * M14-2: 入力内容に応じた動的承認ポリシー(screenshot の外部URL等)。
 * - { error }: 実行前拒否(非httpスキーム等。承認ダイアログも出さない)
 * - required: true なら autoApprove / risk を無視して承認を要求する
 * - sessionKey: 「セッション中許可」の粒度キー(例: 'screenshot@example.com')。
 *   未指定なら allow-session を出さない(毎回承認)
 * - auditPaths: audit.jsonl へ記録する対象(自動許可された実行も含め全件記録される)
 */
export type DynamicApprovalPolicy =
  | { error: string }
  | {
      required: boolean;
      sessionKey?: string;
      sessionLabel?: string;
      warnings?: string[];
      auditPaths?: string[];
    };

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** M14-1: ツールが返す画像(base64)。tool_result ブロックに載りモデルへ渡る */
  images?: { mediaType: string; data: string; description?: string }[];
}

/**
 * プラグイン規約:
 * - 1ツール = plugins/ 直下の1ファイル。`export default { ... } satisfies ToolPlugin`
 * - name はファイル名(拡張子なし)と一致させる
 * - 実行時 import は node 組み込みモジュールのみ可(相対importはトランスパイル先で解決できない)。
 *   型は `import type` でのみ参照する
 *
 * M27-5: このインターフェースは **プラグインAPI v1 として凍結**(正本は
 * tools/versioning.ts の PLUGIN_API_VERSION)。マイナー=後方互換の追加のみ、
 * 破壊的変更はメジャーを上げること。プラグインが依存してよいのはこの契約と
 * 実行時に渡される ToolContext のみ(src/main 内部への import は
 * plugins/guardrails.imports.test.ts が機械検出して禁止する)
 */
export interface ToolPlugin {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 'safe' は読み取り専用。'write' はファイル変更。'exec' は任意コード実行相当 */
  risk: ToolRisk;
  /** M25-8: 分類タグ(例: 'ファイル操作' / 'Web操作' / '進化')。UIの絞り込み・検索専用で挙動には影響しない */
  tags?: string[];
  /** 承認ダイアログに出す追加警告(child_process / ネットワーク使用は必ず自己申告) */
  warnings?: string[];
  /**
   * input のうちファイルパスを表すフィールド名(M9)。executor が実行前のスコープ判定
   * (workspace / system)と保護領域のハード拒否に使う。パスを触るツールは必ず宣言する。
   */
  pathParams?: string[];
  /** M14-2: 入力内容に応じた動的承認(screenshot の外部URL等)。executor が実行前に評価する */
  dynamicApproval?(input: unknown): DynamicApprovalPolicy;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
