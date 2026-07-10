import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpConfig, McpServerConfig, McpServerStatus, McpServerState } from '../../shared/types';
import type { JsonSchema, ToolPlugin, ToolResult } from '../tools/types';

/**
 * M13-2: MCPクライアント。外部MCPサーバー(stdio起動型)へ接続し、そのツールを
 * `mcp__<server>__<tool>` 名の ToolPlugin として registry に外部登録する。
 * - 接続はアプリ起動をブロックしない(失敗は状態表示のみ・他サーバーは継続)
 * - risk 写像: readOnlyHint→safe / destructiveHint→exec / その他annotations→write /
 *   annotations 無し→exec(安全側)
 * - MCPツールはパスベースのスコープ判定(M9)の対象外。代わりに上記 risk 写像+
 *   サーバー単位の信頼確認(trusted、未信頼は接続自体しない)で制御する
 * - 進化ジョブは自前 ToolRegistry を作るため MCP ツールは見えない(guardrails で固定)
 */

export const MCP_TOOL_PREFIX = 'mcp__';
// サーバー名はツール名(mcp__<server>__<tool>)に埋め込むため、区切りの `__` と
// 衝突しない文字だけを許す
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

export function isValidServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name);
}

/** ツール名からサーバー名を取り出す(mcp__server__tool → server)。非MCP名は null */
export function mcpServerOfTool(toolName: string): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  return sep > 0 ? rest.slice(0, sep) : null;
}

interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  [key: string]: unknown;
}

/** MCP annotations → ToolPlugin.risk。annotations が無いツールは exec 扱い(安全側) */
export function riskForAnnotations(annotations: McpToolAnnotations | undefined): ToolPlugin['risk'] {
  if (!annotations) return 'exec';
  if (annotations.readOnlyHint === true) return 'safe';
  if (annotations.destructiveHint === true) return 'exec';
  return 'write';
}

/** MCPの任意JSON Schemaを内部のJsonSchema型へ寄せる(APIへはそのまま渡る) */
function toJsonSchema(schema: unknown): JsonSchema {
  if (typeof schema === 'object' && schema !== null && (schema as Record<string, unknown>)['type'] === 'object') {
    const rec = schema as Record<string, unknown>;
    if (typeof rec['properties'] !== 'object' || rec['properties'] === null) {
      return { type: 'object', properties: {} };
    }
    // MCP側のスキーマは内部型より表現力が広い。プロバイダへは素通しするため構造は保持する
    return schema as JsonSchema;
  }
  return { type: 'object', properties: {} };
}

interface McpListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

/** callTool 結果の content ブロックをツール結果文字列へ整形 */
function renderCallResult(result: { content?: unknown; isError?: boolean }): ToolResult {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const b of blocks) {
    const rec = typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
    if (rec['type'] === 'text' && typeof rec['text'] === 'string') parts.push(rec['text']);
    else if (typeof rec['type'] === 'string') parts.push(`[${rec['type']} ブロック]`);
  }
  const content = parts.join('\n').trim() || '(出力なし)';
  return result.isError === true ? { content, isError: true } : { content };
}

export interface McpRegistryLike {
  registerExternal(plugins: ToolPlugin[]): { rejected: string[] };
  clearExternal(prefix: string): void;
}

export interface McpManagerDeps {
  registry: McpRegistryLike;
  /** mcp.json の絶対パス(userData 配下) */
  configPath: string;
  log?: (line: string) => void;
  /** テスト用: transport 差し替え(既定は StdioClientTransport) */
  createTransport?: (name: string, sc: McpServerConfig) => Transport;
}

interface RuntimeState {
  state: McpServerState;
  error?: string;
  toolCount: number;
}

export class McpManager {
  private readonly clients = new Map<string, Client>();
  private readonly states = new Map<string, RuntimeState>();

  constructor(private readonly deps: McpManagerDeps) {}

  // ---- 設定 ----

  getConfig(): McpConfig {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.deps.configPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>)['servers'] === 'object') {
        return parsed as McpConfig;
      }
    } catch {
      /* 不在・壊れは空設定として扱う */
    }
    return { servers: {} };
  }

  async setConfig(config: McpConfig): Promise<void> {
    for (const name of Object.keys(config.servers)) {
      if (!isValidServerName(name)) {
        throw new Error(`MCPサーバー名が不正: ${name}(英数小文字とハイフン、32文字まで)`);
      }
    }
    mkdirSync(dirname(this.deps.configPath), { recursive: true });
    writeFileSync(this.deps.configPath, JSON.stringify(config, null, 2), 'utf8');
    await this.syncAll();
  }

  // ---- 接続 ----

  /** 設定と接続状態を一致させる。例外は投げない(起動をブロックしない) */
  async syncAll(): Promise<void> {
    const config = this.getConfig();
    // 設定から消えたサーバーを切断
    for (const name of [...this.clients.keys()]) {
      if (!config.servers[name]) await this.disconnect(name);
    }
    for (const name of [...this.states.keys()]) {
      if (!config.servers[name]) this.states.delete(name);
    }
    await Promise.all(
      Object.entries(config.servers).map(async ([name, sc]) => {
        if (sc.enabled === false) {
          await this.disconnect(name);
          this.states.set(name, { state: 'disabled', toolCount: 0 });
          return;
        }
        if (sc.trusted !== true) {
          await this.disconnect(name);
          this.states.set(name, { state: 'untrusted', toolCount: 0 });
          return;
        }
        await this.connect(name, sc);
      }),
    );
  }

  private async connect(name: string, sc: McpServerConfig): Promise<void> {
    await this.disconnect(name);
    if (!isValidServerName(name)) {
      this.states.set(name, { state: 'error', error: 'サーバー名が不正', toolCount: 0 });
      return;
    }
    this.states.set(name, { state: 'connecting', toolCount: 0 });
    try {
      const client = new Client({ name: 'amateras', version: '0.1.0' });
      const transport =
        this.deps.createTransport?.(name, sc) ??
        new StdioClientTransport({
          command: sc.command,
          args: sc.args ?? [],
          env: { ...getDefaultEnvironment(), ...(sc.env ?? {}) },
          stderr: 'ignore',
        });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, '接続');
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'tools/list');
      const tools = (listed.tools as McpListedTool[]).map((t) => this.adaptTool(name, client, t));
      const { rejected } = this.deps.registry.registerExternal(tools);
      this.clients.set(name, client);
      const state: RuntimeState = { state: 'connected', toolCount: tools.length - rejected.length };
      if (rejected.length > 0) {
        state.error = `名前衝突で未登録: ${rejected.join(', ')}`;
        this.deps.log?.(`[mcp] ${name}: ${state.error}`);
      }
      this.states.set(name, state);
      this.deps.log?.(`[mcp] ${name}: 接続(ツール${state.toolCount}件)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.states.set(name, { state: 'error', error: message, toolCount: 0 });
      this.deps.registry.clearExternal(`${MCP_TOOL_PREFIX}${name}__`);
      this.deps.log?.(`[mcp] ${name}: 接続失敗 — ${message}`);
    }
  }

  private adaptTool(server: string, client: Client, tool: McpListedTool): ToolPlugin {
    const risk = riskForAnnotations(tool.annotations);
    return {
      name: `${MCP_TOOL_PREFIX}${server}__${tool.name}`,
      description: `[MCP: ${server}] ${tool.description ?? tool.name}`,
      inputSchema: toJsonSchema(tool.inputSchema),
      risk,
      warnings: [
        `外部MCPサーバー「${server}」のツールを実行します(パスベースのスコープ判定は適用されません)`,
      ],
      execute: async (input): Promise<ToolResult> => {
        try {
          const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
          const result = await withTimeout(
            client.callTool({ name: tool.name, arguments: args }),
            CALL_TIMEOUT_MS,
            'callTool',
          );
          return renderCallResult(result as { content?: unknown; isError?: boolean });
        } catch (err) {
          return {
            content: `MCPツール実行エラー(${server}/${tool.name}): ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    };
  }

  private async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      this.clients.delete(name);
      await client.close().catch(() => {});
    }
    this.deps.registry.clearExternal(`${MCP_TOOL_PREFIX}${name}__`);
  }

  /** アプリ終了時: 全サーバー切断(stdio 子プロセスも transport ごと終了する) */
  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((name) => this.disconnect(name)));
  }

  status(): McpServerStatus[] {
    const config = this.getConfig();
    return Object.entries(config.servers).map(([name, sc]) => {
      const rt = this.states.get(name) ?? { state: 'disabled' as McpServerState, toolCount: 0 };
      const status: McpServerStatus = { name, state: rt.state, toolCount: rt.toolCount, config: sc };
      if (rt.error !== undefined) status.error = rt.error;
      return status;
    });
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} がタイムアウト(${Math.round(ms / 1000)}s)`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
