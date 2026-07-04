import type { ToolRisk } from '../../shared/types';

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
   * 自己進化への入口。request_capability プラグインだけが使う。
   * (プラグインは evolution モジュールを import できないため、コンテキスト経由で注入する)
   */
  evolution?: {
    requestCapability(description: string, expectedIO: string): Promise<{ jobId: number }>;
  };
  /**
   * サブエージェント委譲(M8-4 / M12-3)。dispatch_agent プラグインだけが使う。
   * run は従来の読み取り専用の単発委譲。runParallel は最大3並列で、
   * mode:'work' なら書き込み/実行込みの子(すべて executor=承認フロー経由)。
   */
  subagent?: {
    run(task: string, signal: AbortSignal): Promise<string>;
    runParallel?(tasks: string[], mode: 'read' | 'work', signal: AbortSignal): Promise<string[]>;
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
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * プラグイン規約:
 * - 1ツール = plugins/ 直下の1ファイル。`export default { ... } satisfies ToolPlugin`
 * - name はファイル名(拡張子なし)と一致させる
 * - 実行時 import は node 組み込みモジュールのみ可(相対importはトランスパイル先で解決できない)。
 *   型は `import type` でのみ参照する
 */
export interface ToolPlugin {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 'safe' は読み取り専用。'write' はファイル変更。'exec' は任意コード実行相当 */
  risk: ToolRisk;
  /** 承認ダイアログに出す追加警告(child_process / ネットワーク使用は必ず自己申告) */
  warnings?: string[];
  /**
   * input のうちファイルパスを表すフィールド名(M9)。executor が実行前のスコープ判定
   * (workspace / system)と保護領域のハード拒否に使う。パスを触るツールは必ず宣言する。
   */
  pathParams?: string[];
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
