import { app, dialog, ipcMain, safeStorage, type WebContents } from 'electron';
import { join } from 'node:path';
import { IpcChannels } from '../shared/ipc';
import type {
  AppConfig,
  ApprovalDecision,
  ProviderId,
  SecretsStatus,
} from '../shared/types';
import { AuditLog } from './audit';
import { ConfigStore } from './config';
import { EventBus } from './core/events';
import { AgentService } from './core/service';
import { readProjectMemory, writeProjectMemory } from './memory';
import { AgentJobRunner } from './evolution/job';
import { EvolutionManager } from './evolution/manager';
import { healthCheckAfterPromotion } from './evolution/supervisor';
import { SecretStore, type SecretCipher } from './secrets';
import { ToolRegistry } from './tools/registry';
import type { ApprovalBroker } from './agent/approval';

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
    typeof rec['model'] === 'string' &&
    (rec['workspace'] === undefined || typeof rec['workspace'] === 'string') &&
    (rec['scopeMode'] === 'project' || rec['scopeMode'] === 'fullPc');
  if (!ok) throw new Error('IPC payload config が不正');
}

/**
 * プラグインソースの場所。開発時はリポジトリ内、パッケージ版は extraResources に
 * 同梱した plugins/ を読む(asar 内の src は実行時に解決できないため)。
 * ※進化(worktree/git/昇格)はソースツリー前提のため、パッケージ版では基本ツールのみ。
 */
export function getPluginsDir(): string {
  if (process.env['MYCODEX_PLUGINS_DIR']) return process.env['MYCODEX_PLUGINS_DIR'];
  if (app.isPackaged) return join(process.resourcesPath, 'plugins');
  return join(app.getAppPath(), 'src/main/tools/plugins');
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

export interface MainServices {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  config: ConfigStore;
  secrets: SecretStore;
  service: AgentService;
  bus: EventBus;
}

/**
 * M10-1 以降、ロジックの実体は core/service.ts(AgentService)にあり、
 * ここは「IPCチャネル ⇔ サービス呼び出し」の薄い写像だけを持つ。
 * IPCチャネル名・payload 型は M10 以前から不変(挙動変更ゼロが条件)。
 */
export async function registerIpcHandlers(
  getWebContents: () => WebContents | null,
): Promise<MainServices> {
  const push = <T>(channel: string, payload: T): void => {
    const wc = getWebContents();
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  };

  const registry = new ToolRegistry(getPluginsDir(), getPluginCacheDir());
  await registry.reload();
  const config = new ConfigStore(join(app.getPath('userData'), 'config.json'));
  const secrets = new SecretStore(
    join(app.getPath('userData'), 'secrets.json'),
    electronSafeStorageCipher(),
  );
  const audit = new AuditLog(join(app.getPath('userData'), 'audit.jsonl'));
  const bus = new EventBus();
  const repoDir = app.getAppPath();

  const service: AgentService = new AgentService({
    bus,
    registry,
    config,
    secrets,
    audit,
    defaultWorkspace: () => app.getAppPath(),
    denyPaths: {
      userDataDir: app.getPath('userData'),
      repoGitDir: join(app.getAppPath(), '.git'),
    },
    createEvolution: (hooks) =>
      new EvolutionManager({
        repoDir,
        worktreeBase: join(repoDir, '..', 'mycodex-evolve'),
        runner: new AgentJobRunner(() => service.createProviderOrThrow()),
        requestPromotionApproval: hooks.requestPromotionApproval,
        reloadPlugins: () => registry.reload(),
        healthCheck: (toolName, smokeInput) =>
          healthCheckAfterPromotion(repoDir, toolName, smokeInput),
        onEvent: hooks.onEvent,
      }),
  });

  // bus → renderer(webContents.send)。チャネル名はバスとIPCで同一
  bus.subscribe('chat:event', (e) => push(IpcChannels.chatEvent, e));
  bus.subscribe('approval:request', (r) => push(IpcChannels.approvalRequest, r));
  bus.subscribe('approval:resolved', (r) => push(IpcChannels.approvalResolved, r));
  bus.subscribe('evolution:event', (e) => push(IpcChannels.evolutionEvent, e));

  // ---- chat ----
  ipcMain.handle(IpcChannels.chatSend, (_e, text: unknown, mode: unknown) => {
    assertString(text, 'text');
    return service.chatSend(text, mode === 'plan' ? 'plan' : 'normal');
  });

  ipcMain.handle(IpcChannels.chatCancel, (_e, sessionId: unknown) => {
    assertString(sessionId, 'sessionId');
    service.chatCancel(sessionId);
  });

  // ---- 承認 ----
  ipcMain.handle(IpcChannels.approvalRespond, (_e, id: unknown, decision: unknown) => {
    assertString(id, 'id');
    assertDecision(decision);
    service.approvalRespond(id, decision);
  });

  // ---- ツール ----
  ipcMain.handle(IpcChannels.toolsList, () => service.toolsList());
  ipcMain.handle(IpcChannels.toolsReload, () => service.toolsReload());
  ipcMain.handle(IpcChannels.toolsExecute, (_e, name: unknown, inputJson: unknown) => {
    assertString(name, 'name');
    assertString(inputJson, 'inputJson');
    return service.toolsExecute(name, inputJson);
  });

  // ---- 設定(デスクトップ専用。リモートAPIへは公開しない) ----
  ipcMain.handle(IpcChannels.settingsGet, () => config.get());
  ipcMain.handle(IpcChannels.settingsSet, (_e, next: unknown) => {
    assertConfig(next);
    return config.set(next);
  });
  ipcMain.handle(IpcChannels.memoryGet, () => readProjectMemory(service.getWorkspace()));
  ipcMain.handle(IpcChannels.memorySet, (_e, content: unknown) => {
    assertString(content, 'content');
    writeProjectMemory(service.getWorkspace(), content);
  });
  ipcMain.handle(IpcChannels.workspacePick, async () => {
    const result = await dialog.showOpenDialog({
      title: '作業ディレクトリを選択',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: service.getWorkspace(),
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // ---- シークレット(デスクトップ専用。リモートAPIへは公開しない) ----
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

  // ---- 進化 ----
  ipcMain.handle(IpcChannels.evolutionPromoteRespond, (_e, jobId: unknown, approved: unknown) => {
    if (typeof jobId !== 'number' || typeof approved !== 'boolean') {
      throw new Error('IPC payload evolution:promote-respond が不正');
    }
    service.evolutionPromoteRespond(jobId, approved);
  });

  ipcMain.handle(IpcChannels.evolutionEnqueue, (_e, description: unknown, expectedIo: unknown) => {
    assertString(description, 'description');
    assertString(expectedIo, 'expectedIo');
    return service.evolutionEnqueue(description, expectedIo);
  });

  ipcMain.handle(IpcChannels.evolutionList, () => service.evolutionList());

  return { registry, broker: service.broker, config, secrets, service, bus };
}
