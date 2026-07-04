import { app, dialog, ipcMain, safeStorage, type WebContents } from 'electron';
import { join } from 'node:path';
import { IpcChannels } from '../shared/ipc';
import type {
  AppConfig,
  ApprovalDecision,
  ProviderId,
  RemoteConfig,
  RemoteStatusPayload,
  SecretsStatus,
} from '../shared/types';
import { AuditLog } from './audit';
import { ConfigStore } from './config';
import { CheckpointManager } from './core/checkpoints';
import { EventBus } from './core/events';
import { AgentService } from './core/service';
import { SessionStore } from './core/sessions';
import { readProjectMemory, writeProjectMemory } from './memory';
import { AgentJobRunner } from './evolution/job';
import { EvolutionManager } from './evolution/manager';
import { healthCheckAfterPromotion } from './evolution/supervisor';
import { generateToken, RemoteAuth } from './remote/auth';
import { RemoteServer } from './remote/server';
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
    (rec['scopeMode'] === 'project' || rec['scopeMode'] === 'fullPc') &&
    (rec['maxTurns'] === undefined ||
      (typeof rec['maxTurns'] === 'number' && Number.isFinite(rec['maxTurns']))) &&
    (rec['postEditHook'] === undefined || typeof rec['postEditHook'] === 'string');
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

/**
 * remote-ui のビルド出力。開発時はリポジトリの out/remote-ui、パッケージ版は
 * asar 内の out/remote-ui(electron-builder の files に out/** が含まれ、
 * electron の fs は asar 内パスを透過的に読める)。
 */
export function getRemoteUiDir(): string {
  return join(app.getAppPath(), 'out', 'remote-ui');
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
    // M11-3: 自動チェックポイント(git の無い workspace では manager 側で noop)
    createCheckpoints: (workspace) =>
      new CheckpointManager(workspace, (line) => console.log(`[checkpoint] ${line}`)),
    // M12-1: セッション永続化(userData/sessions/)
    sessions: new SessionStore(join(app.getPath('userData'), 'sessions')),
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
    // remote 設定(tokenHash 含む)は専用IPCでのみ変更する。settings:set 経由の
    // 上書き・消去を防ぐため常に現在値を維持する(M10-2)
    return config.set({ ...next, remote: config.get().remote });
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

  // ---- チェックポイント(M11-3) ----
  ipcMain.handle(IpcChannels.checkpointList, () => service.checkpointList());
  ipcMain.handle(IpcChannels.checkpointRestore, (_e, sha: unknown) => {
    assertString(sha, 'sha');
    return service.checkpointRestore(sha);
  });

  // ---- セッション永続化(M12-1) ----
  ipcMain.handle(IpcChannels.sessionsList, () => service.sessionsList());
  ipcMain.handle(IpcChannels.sessionsLoad, (_e, id: unknown) => {
    assertString(id, 'id');
    return service.sessionLoad(id);
  });
  ipcMain.handle(IpcChannels.sessionsDelete, (_e, id: unknown) => {
    assertString(id, 'id');
    return service.sessionDelete(id);
  });
  ipcMain.handle(IpcChannels.sessionsNew, () => service.sessionNew());

  // ---- リモートアクセス(M10-5。管理はデスクトップ専用、トークン平文は保存しない) ----
  const remoteAuth = new RemoteAuth({ getTokenHash: () => config.get().remote?.tokenHash });
  let remoteServer: RemoteServer | null = null;
  let remoteLastError: string | undefined;

  const getRemoteConfig = (): RemoteConfig => config.get().remote ?? { enabled: false, port: 8787 };
  const setRemoteConfig = (remote: RemoteConfig): void => {
    config.set({ ...config.get(), remote });
  };
  const remoteStatus = (): RemoteStatusPayload => {
    const rc = getRemoteConfig();
    const status: RemoteStatusPayload = {
      enabled: rc.enabled,
      port: rc.port,
      running: remoteServer?.isRunning() ?? false,
      tokenSet: rc.tokenHash !== undefined,
    };
    if (remoteLastError !== undefined) status.lastError = remoteLastError;
    return status;
  };

  /** config.remote と実際の listen 状態を一致させる。失敗は lastError に記録(起動は止めない) */
  const applyRemoteState = async (): Promise<void> => {
    if (remoteServer) {
      await remoteServer.stop();
      remoteServer = null;
    }
    remoteLastError = undefined;
    const rc = getRemoteConfig();
    if (!rc.enabled) return; // 無効時は一切 listen しない
    const server = new RemoteServer({
      facade: service,
      bus,
      auth: remoteAuth,
      staticDir: getRemoteUiDir(),
      auditTail: (limit) => audit.tail(limit),
    });
    try {
      await server.start(rc.port);
      remoteServer = server;
    } catch (err) {
      remoteLastError = err instanceof Error ? err.message : String(err);
    }
  };

  ipcMain.handle(IpcChannels.remoteStatus, () => remoteStatus());

  ipcMain.handle(IpcChannels.remoteSetEnabled, async (_e, enabled: unknown, port: unknown) => {
    if (
      typeof enabled !== 'boolean' ||
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error('IPC payload remote:set-enabled が不正');
    }
    const rc = getRemoteConfig();
    // 初回有効化時にトークンを発行する。平文は戻り値でUIに一度だけ渡す
    let token: string | undefined;
    let tokenHash = rc.tokenHash;
    if (enabled && tokenHash === undefined) {
      const pair = generateToken();
      token = pair.token;
      tokenHash = pair.tokenHash;
    }
    const next: RemoteConfig = { enabled, port };
    if (tokenHash !== undefined) next.tokenHash = tokenHash;
    setRemoteConfig(next);
    await applyRemoteState();
    const result: { status: RemoteStatusPayload; token?: string } = { status: remoteStatus() };
    if (token !== undefined) result.token = token;
    return result;
  });

  ipcMain.handle(IpcChannels.remoteRegenerateToken, () => {
    // ハッシュ差し替えのみで旧トークンは即失効する(RemoteAuth は config を毎回参照)
    const pair = generateToken();
    setRemoteConfig({ ...getRemoteConfig(), tokenHash: pair.tokenHash });
    return { status: remoteStatus(), token: pair.token };
  });

  // 起動時: 設定が有効ならサーバを立てる(失敗しても起動は続行、状態はUIで見える)
  await applyRemoteState();

  return { registry, broker: service.broker, config, secrets, service, bus };
}
