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

export interface ToolContext {
  /** セッションの作業ディレクトリ(進化ジョブでは B worktree) */
  cwd: string;
  /** 書き込み許可パス(cwd相対のディレクトリ接頭辞)。undefined なら無制限 */
  writeAllowlist?: string[];
  signal: AbortSignal;
  log: (line: string) => void;
  /**
   * 自己進化への入口。request_capability プラグインだけが使う。
   * (プラグインは evolution モジュールを import できないため、コンテキスト経由で注入する)
   */
  evolution?: {
    requestCapability(description: string, expectedIO: string): Promise<{ jobId: number }>;
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
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
