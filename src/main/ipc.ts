import { app, ipcMain, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { IpcChannels } from '../shared/ipc';
import type {
  AgentEvent,
  ApprovalDecision,
  AppConfig,
  PluginErrorInfo,
  ToolInfo,
} from '../shared/types';
import { ApprovalBroker } from './agent/approval';
import { streamEcho } from './agent/echo';
import { ConfigStore } from './config';
import { executeToolWithApproval } from './tools/executor';
import { ToolRegistry } from './tools/registry';

// セッションごとのキャンセル用。M3でセッション管理(agent/session.ts)へ移す。
const controllers = new Map<string, AbortController>();

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`IPC payload ${name} must be a string`);
}

const DECISIONS: ApprovalDecision[] = ['allow', 'allow-session', 'deny'];

function assertDecision(value: unknown): asserts value is ApprovalDecision {
  if (typeof value !== 'string' || !DECISIONS.includes(value as ApprovalDecision)) {
    throw new Error('IPC payload decision が不正');
  }
}

function assertConfig(value: unknown): asserts value is AppConfig {
  const auto =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['autoApprove']
      : null;
  const ok =
    typeof auto === 'object' &&
    auto !== null &&
    (['safe', 'write', 'exec'] as const).every(
      (k) => typeof (auto as Record<string, unknown>)[k] === 'boolean',
    );
  if (!ok) throw new Error('IPC payload config が不正');
}

/** 稼働リポジトリ直上のプラグインソースを直接ロードする(進化昇格後のホットリロードも同経路) */
export function getPluginsDir(): string {
  return process.env['MYCODEX_PLUGINS_DIR'] ?? join(app.getAppPath(), 'src/main/tools/plugins');
}

export function getPluginCacheDir(): string {
  return join(app.getPath('userData'), 'plugin-cache');
}

export interface MainServices {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  config: ConfigStore;
}

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

  // ---- chat(M1のエコー。M3で本物のループに差し替え) ----
  ipcMain.handle(IpcChannels.chatSend, (_e, text: unknown) => {
    assertString(text, 'text');
    const sessionId = randomUUID();
    const ac = new AbortController();
    controllers.set(sessionId, ac);
    const pushEvent = (event: AgentEvent): void => push(IpcChannels.chatEvent, event);

    pushEvent({ kind: 'status', sessionId, status: 'calling_llm' });
    void streamEcho(text, ac.signal, {
      onDelta: (t) => pushEvent({ kind: 'text_delta', sessionId, text: t }),
      onDone: () => {
        controllers.delete(sessionId);
        pushEvent({ kind: 'message_done', sessionId });
        pushEvent({ kind: 'status', sessionId, status: 'done' });
      },
      onCancelled: () => {
        controllers.delete(sessionId);
        pushEvent({ kind: 'message_done', sessionId });
        pushEvent({ kind: 'status', sessionId, status: 'cancelled' });
      },
    }).catch((err: unknown) => {
      controllers.delete(sessionId);
      pushEvent({ kind: 'error', sessionId, message: err instanceof Error ? err.message : String(err) });
      pushEvent({ kind: 'status', sessionId, status: 'error' });
    });

    return { sessionId };
  });

  ipcMain.handle(IpcChannels.chatCancel, (_e, sessionId: unknown) => {
    assertString(sessionId, 'sessionId');
    controllers.get(sessionId)?.abort();
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

  return { registry, broker, config };
}
