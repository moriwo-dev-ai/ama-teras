import { app, ipcMain, safeStorage, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { IpcChannels } from '../shared/ipc';
import type {
  AgentEvent,
  ApprovalDecision,
  AppConfig,
  PluginErrorInfo,
  ProviderId,
  SecretsStatus,
  ToolInfo,
} from '../shared/types';
import { ApprovalBroker } from './agent/approval';
import { runAgentLoop } from './agent/loop';
import { ConfigStore } from './config';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './providers/anthropic';
import type { ChatMessage, LLMProvider } from './providers/types';
import { SecretStore, type SecretCipher } from './secrets';
import { executeToolWithApproval } from './tools/executor';
import { ToolRegistry } from './tools/registry';

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`IPC payload ${name} must be a string`);
}

const DECISIONS: ApprovalDecision[] = ['allow', 'allow-session', 'deny'];

function assertDecision(value: unknown): asserts value is ApprovalDecision {
  if (typeof value !== 'string' || !DECISIONS.includes(value as ApprovalDecision)) {
    throw new Error('IPC payload decision が不正');
  }
}

function assertProvider(value: unknown): asserts value is ProviderId {
  if (value !== 'anthropic' && value !== 'openai') throw new Error('IPC payload provider が不正');
}

function assertConfig(value: unknown): asserts value is AppConfig {
  const rec = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  const auto = rec?.['autoApprove'];
  const ok =
    rec !== null &&
    typeof auto === 'object' &&
    auto !== null &&
    (['safe', 'write', 'exec'] as const).every(
      (k) => typeof (auto as Record<string, unknown>)[k] === 'boolean',
    ) &&
    (rec['provider'] === 'anthropic' || rec['provider'] === 'openai') &&
    typeof rec['model'] === 'string';
  if (!ok) throw new Error('IPC payload config が不正');
}

/** 稼働リポジトリ直上のプラグインソースを直接ロードする(進化昇格後のホットリロードも同経路) */
export function getPluginsDir(): string {
  return process.env['MYCODEX_PLUGINS_DIR'] ?? join(app.getAppPath(), 'src/main/tools/plugins');
}

export function getPluginCacheDir(): string {
  return join(app.getPath('userData'), 'plugin-cache');
}

function electronSafeStorageCipher(): SecretCipher {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted),
  };
}

const SYSTEM_PROMPT = `あなたは MyCodex — ユーザーのマシン上で動くコーディングエージェント。
与えられたツールを使ってファイルの調査・編集・コマンド実行を行い、ユーザーの指示を完遂する。

規範:
- 手を動かす前に不明点があれば read_file / list_dir / grep で自分で調べる
- 変更は最小限に。既存のコードスタイルに合わせる
- 破壊的な操作は慎重に。ツール実行はユーザー承認制の場合がある
- 完了したら何をしたか簡潔に日本語で報告する`;

function toToolInfos(registry: ToolRegistry): { tools: ToolInfo[]; errors: PluginErrorInfo[] } {
  return {
    tools: registry.list().map((p) => ({
      name: p.name,
      description: p.description,
      risk: p.risk,
      warnings: p.warnings ?? [],
    })),
    errors: registry.errors,
  };
}

export interface MainServices {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  config: ConfigStore;
  secrets: SecretStore;
}

export async function registerIpcHandlers(
  getWebContents: () => WebContents | null,
): Promise<MainServices> {
  const push = <T>(channel: string, payload: T): void => {
    const wc = getWebContents();
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  };

  const registry = new ToolRegistry(getPluginsDir(), getPluginCacheDir());
  await registry.reload();
  const broker = new ApprovalBroker((req) => push(IpcChannels.approvalRequest, req));
  const config = new ConfigStore(join(app.getPath('userData'), 'config.json'));
  const secrets = new SecretStore(
    join(app.getPath('userData'), 'secrets.json'),
    electronSafeStorageCipher(),
  );

  // 会話は1本(M3)。sessionId は実行(run)単位でUIのライフサイクルに使う
  const history: ChatMessage[] = [];
  let activeRun: { sessionId: string; ac: AbortController } | null = null;

  const createProvider = (): LLMProvider | string => {
    const cfg = config.get();
    if (cfg.provider === 'openai') return 'OpenAIプロバイダはM6で対応予定';
    const key = secrets.get('anthropic');
    if (!key) return 'Anthropic APIキーが未設定(設定画面から登録)';
    return new AnthropicProvider(key, cfg.model || DEFAULT_ANTHROPIC_MODEL);
  };

  // ---- chat ----
  ipcMain.handle(IpcChannels.chatSend, (_e, text: unknown) => {
    assertString(text, 'text');
    const sessionId = randomUUID();
    const emit = (event: AgentEvent): void => push(IpcChannels.chatEvent, event);

    if (activeRun) {
      emit({ kind: 'error', sessionId, message: '別の実行が進行中' });
      emit({ kind: 'status', sessionId, status: 'error' });
      return { sessionId };
    }
    const provider = createProvider();
    if (typeof provider === 'string') {
      emit({ kind: 'error', sessionId, message: provider });
      emit({ kind: 'status', sessionId, status: 'error' });
      return { sessionId };
    }

    const ac = new AbortController();
    activeRun = { sessionId, ac };
    history.push({ role: 'user', content: [{ type: 'text', text }] });

    void runAgentLoop(
      {
        provider,
        tools: registry,
        executeTool: (name, input, ctx) =>
          executeToolWithApproval(
            { registry, broker, getAutoApprove: () => config.get().autoApprove },
            name,
            input,
            ctx,
          ),
        emit,
        systemPrompt: SYSTEM_PROMPT,
        cwd: app.getAppPath(),
      },
      sessionId,
      history,
      ac.signal,
    ).finally(() => {
      activeRun = null;
    });

    return { sessionId };
  });

  ipcMain.handle(IpcChannels.chatCancel, (_e, sessionId: unknown) => {
    assertString(sessionId, 'sessionId');
    if (activeRun?.sessionId === sessionId) activeRun.ac.abort();
  });

  // ---- 承認 ----
  ipcMain.handle(IpcChannels.approvalRespond, (_e, id: unknown, decision: unknown) => {
    assertString(id, 'id');
    assertDecision(decision);
    broker.respond(id, decision);
  });

  // ---- ツール ----
  ipcMain.handle(IpcChannels.toolsList, () => toToolInfos(registry));

  ipcMain.handle(IpcChannels.toolsReload, async () => {
    await registry.reload();
    return toToolInfos(registry);
  });

  ipcMain.handle(IpcChannels.toolsExecute, async (_e, name: unknown, inputJson: unknown) => {
    assertString(name, 'name');
    assertString(inputJson, 'inputJson');
    let input: unknown;
    try {
      input = inputJson.trim() === '' ? {} : JSON.parse(inputJson);
    } catch {
      return { content: '入力がJSONとして不正', isError: true };
    }
    const ac = new AbortController();
    const result = await executeToolWithApproval(
      { registry, broker, getAutoApprove: () => config.get().autoApprove },
      name,
      input,
      { cwd: app.getAppPath(), signal: ac.signal, log: () => {} },
    );
    return { content: result.content, isError: result.isError === true };
  });

  // ---- 設定 ----
  ipcMain.handle(IpcChannels.settingsGet, () => config.get());
  ipcMain.handle(IpcChannels.settingsSet, (_e, next: unknown) => {
    assertConfig(next);
    return config.set(next);
  });

  // ---- シークレット ----
  const secretsStatus = (): SecretsStatus => ({
    anthropic: secrets.has('anthropic'),
    openai: secrets.has('openai'),
  });
  ipcMain.handle(IpcChannels.secretsStatus, () => secretsStatus());
  ipcMain.handle(IpcChannels.secretsSet, (_e, provider: unknown, apiKey: unknown) => {
    assertProvider(provider);
    assertString(apiKey, 'apiKey');
    secrets.set(provider, apiKey.trim());
    return secretsStatus();
  });

  return { registry, broker, config, secrets };
}
