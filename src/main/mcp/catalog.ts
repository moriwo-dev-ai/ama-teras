import type {
  McpCatalogEntry,
  McpReadiness,
  McpReadinessItem,
  McpServerConfig,
} from '../../shared/types';

/**
 * M93: MCPセットアップ助手のカタログと純粋ロジック。
 *
 * カタログの command/args は「編集可能な下書きテンプレ」であって断定ではない。
 * パッケージ名が将来変わっても、助手は最後に probe(実接続テスト)で真偽を確かめ、
 * 人間が微調整できる。だから助手が肩代わりするのは「調べて・埋めて・試す」までで、
 * 信頼(trusted)・APIキー・ホストアプリ導入は人間が握り続ける。
 *
 * このモジュールは純粋(I/Oなし)。PATH/環境変数の実測は setup.ts が担う。
 */

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'filesystem',
    suggestedName: 'fs',
    title: 'ファイルシステム',
    description: '指定フォルダ配下の読み書き。まず動作を確かめるのに最適(公式・無料・鍵不要)。',
    category: 'files',
    cost: 'free',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{{dir}}'],
    placeholders: [{ token: 'dir', hint: '公開してよいフォルダの絶対パス', default: 'C:\\dev' }],
    prereqs: [{ kind: 'command', name: 'npx', hint: 'Node.js(npx)が PATH にあること' }],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'memory',
    suggestedName: 'memory',
    title: '記憶(ナレッジグラフ)',
    description: '会話をまたいで覚えておく簡易メモリ(公式・無料・鍵不要)。',
    category: 'memory',
    cost: 'free',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    prereqs: [{ kind: 'command', name: 'npx', hint: 'Node.js(npx)が PATH にあること' }],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'fetch',
    suggestedName: 'fetch',
    title: 'Web取得',
    description: 'URL を取得して本文を Markdown 化(公式・無料・鍵不要・uv で起動)。',
    category: 'web',
    cost: 'free',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    prereqs: [{ kind: 'command', name: 'uvx', hint: 'uv(uvx)が PATH にあること' }],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'blender',
    suggestedName: 'blender',
    title: 'Blender(3D操作)',
    description: 'Blender をチャットから操作して 3D シーンを作る。広報向けの派手枠(無料)。',
    category: 'visual',
    cost: 'free',
    command: 'uvx',
    args: ['blender-mcp'],
    prereqs: [
      { kind: 'command', name: 'uvx', hint: 'uv(uvx)が PATH にあること' },
      {
        kind: 'manual',
        hint: 'Blender をインストールし blender-mcp アドオンを有効化 →「Connect」で待受にしておく',
      },
    ],
    homepage: 'https://github.com/ahujasid/blender-mcp',
  },
  {
    id: 'sequential-thinking',
    suggestedName: 'think',
    title: '逐次思考',
    description: '難しい問題を段階に分けて考えさせる補助ツール(公式・無料・鍵不要)。',
    category: 'other',
    cost: 'free',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    prereqs: [{ kind: 'command', name: 'npx', hint: 'Node.js(npx)が PATH にあること' }],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
];

/** カタログ検索 */
export function catalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

const PLACEHOLDER_RE = /^\{\{([a-z0-9_]+)\}\}$/;

/** args のトークン `{{name}}` を values で置換。未指定/空はそのまま残す(=probe で顕在化) */
export function fillArgs(args: readonly string[], values: Record<string, string>): string[] {
  return args.map((a) => {
    const m = PLACEHOLDER_RE.exec(a);
    if (!m) return a;
    const key = m[1] as string;
    const v = values[key];
    return v !== undefined && v.trim() !== '' ? v : a;
  });
}

/** args にまだ未解決のプレースホルダが残っているか(残っていれば設定は不完全) */
export function unresolvedPlaceholders(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    const m = PLACEHOLDER_RE.exec(a);
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** カタログ + ユーザー入力 → mcp.json の1サーバー設定(未信頼で作る) */
export function toServerConfig(
  entry: McpCatalogEntry,
  values: Record<string, string> = {},
): McpServerConfig {
  return {
    command: entry.command,
    args: fillArgs(entry.args, values),
    enabled: true,
    trusted: false, // 信頼確認は人間が握る
  };
}

/** 前提点検の入力(実測は setup.ts。ここは純粋に判定するだけ) */
export interface McpReadinessInput {
  /** 実行ファイル名 → PATH にあるか */
  hasCommand: (name: string) => boolean;
  /** 環境変数名 → 定義済みか */
  hasEnv: (name: string) => boolean;
}

/**
 * 前提を点検して準備状況を返す(純粋)。
 * - command/env は自動判定(ok: true/false)
 * - manual は人間が確認(ok: null)。ready の勘定には入れない
 * - requiredEnv は env prereq が無くても未設定なら manualCount に足す
 */
export function evaluateReadiness(entry: McpCatalogEntry, input: McpReadinessInput): McpReadiness {
  const items: McpReadinessItem[] = [];
  for (const p of entry.prereqs) {
    if (p.kind === 'command' && p.name) {
      items.push({ kind: 'command', name: p.name, hint: p.hint, ok: input.hasCommand(p.name) });
    } else if (p.kind === 'env' && p.name) {
      items.push({ kind: 'env', name: p.name, hint: p.hint, ok: input.hasEnv(p.name) });
    } else {
      items.push({ kind: 'manual', hint: p.hint, ok: null });
    }
  }
  // カタログ宣言の requiredEnv も点検(prereq に無くても拾う)
  const declaredEnv = new Set(
    entry.prereqs.filter((p) => p.kind === 'env' && p.name).map((p) => p.name as string),
  );
  for (const key of entry.requiredEnv ?? []) {
    if (declaredEnv.has(key)) continue;
    items.push({
      kind: 'env',
      name: key,
      hint: `環境変数 ${key} を設定(値は人間が用意。助手は預からない)`,
      ok: input.hasEnv(key),
    });
  }

  const auto = items.filter((i) => i.ok !== null);
  const ready = auto.every((i) => i.ok === true);
  const manualCount =
    items.filter((i) => i.ok === null).length + items.filter((i) => i.kind === 'env' && i.ok === false).length;
  return { entryId: entry.id, ready, items, manualCount };
}
