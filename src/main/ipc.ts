import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type WebContents } from 'electron';
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
import { validateChatImages } from './core/chatImages';
import { workspaceGitStatus } from './core/gitStatus';
import { McpManager } from './mcp/manager';
import { CheckpointManager } from './core/checkpoints';
import { EventBus } from './core/events';
import { AgentService } from './core/service';
import { UsageMeter } from './core/usage';
import { SessionStore } from './core/sessions';
import { readProjectMemory, readProjectPlan, readUserMemory, writeProjectMemory, writeUserMemory } from './memory';
import { AgentJobRunner } from './evolution/job';
import { EvolutionManager } from './evolution/manager';
import { listEvolvedCapabilities, listEvolveTags, rollbackLastEvolve } from './evolution/promote';
import { readAndClearPendingQueue, writePendingQueue } from './evolution/pendingQueue';
import { clearSentinel, writeSentinel } from './evolution/sentinel';
import { healthCheckAfterPromotion, rebuildAndHealthBoot } from './evolution/supervisor';
import { defaultRunCommand } from './evolution/gates';
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

function isBandLike(v: unknown): boolean {
  const b = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  return (
    b !== null &&
    (b['provider'] === 'anthropic' || b['provider'] === 'openai') &&
    typeof b['model'] === 'string'
  );
}

/** M19: reviewGate の形チェック(undefined は許可=無効) */
function isReviewGateLike(v: unknown): boolean {
  if (v === undefined) return true;
  const r = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  const axes = r?.['axes'];
  return (
    r !== null &&
    typeof r['enabled'] === 'boolean' &&
    typeof r['threshold'] === 'number' &&
    Number.isFinite(r['threshold']) &&
    typeof r['maxRoundsPerMilestone'] === 'number' &&
    Number.isFinite(r['maxRoundsPerMilestone']) &&
    typeof axes === 'object' &&
    axes !== null &&
    (['code', 'ux', 'requirements', 'tests'] as const).every(
      (k) => typeof (axes as Record<string, unknown>)[k] === 'boolean',
    )
  );
}

/** M18: modelPolicy の形チェック(undefined は許可=無効) */
function isModelPolicyLike(v: unknown): boolean {
  if (v === undefined) return true;
  const p = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  return (
    p !== null &&
    typeof p['enabled'] === 'boolean' &&
    isBandLike(p['planner']) &&
    isBandLike(p['worker']) &&
    (p['escalation'] === undefined || isBandLike(p['escalation'])) &&
    (p['maxEscalationsPerTask'] === undefined ||
      (typeof p['maxEscalationsPerTask'] === 'number' && Number.isFinite(p['maxEscalationsPerTask'])))
  );
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
    (rec['postEditHook'] === undefined || typeof rec['postEditHook'] === 'string') &&
    (rec['subAgentMaxTurns'] === undefined ||
      (typeof rec['subAgentMaxTurns'] === 'number' && Number.isFinite(rec['subAgentMaxTurns']))) &&
    (rec['fullPcAllowSession'] === undefined || typeof rec['fullPcAllowSession'] === 'boolean') &&
    (rec['fallback'] === undefined ||
      (typeof rec['fallback'] === 'object' &&
        rec['fallback'] !== null &&
        typeof (rec['fallback'] as Record<string, unknown>)['enabled'] === 'boolean' &&
        ((rec['fallback'] as Record<string, unknown>)['provider'] === 'anthropic' ||
          (rec['fallback'] as Record<string, unknown>)['provider'] === 'openai') &&
        typeof (rec['fallback'] as Record<string, unknown>)['model'] === 'string')) &&
    isModelPolicyLike(rec['modelPolicy']) &&
    isReviewGateLike(rec['reviewGate']);
  if (!ok) throw new Error('IPC payload config が不正');
}

/**
 * M14-2: URLスクリーンショット。非表示 BrowserWindow でページを開き PNG を返す。
 * URLのスキーム/承認は executor+screenshot プラグイン側で検証済みの前提だが、
 * 二重防御でここでも http/https 以外を拒否する。
 */
async function captureUrl(
  url: string,
  width = 1280,
  height = 800,
): Promise<{ data: string; mediaType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`http/https 以外は撮影不可: ${parsed.protocol}`);
  }
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ページ読み込みタイムアウト(20s)')), 20_000),
      ),
    ]);
    // 描画完了を少し待つ(SPAの初期レンダリング)
    await new Promise((r) => setTimeout(r, 700));
    const image = await win.webContents.capturePage();
    return { data: image.toPNG().toString('base64'), mediaType: 'image/png' };
  } finally {
    win.destroy();
  }
}

function assertMcpConfig(value: unknown): asserts value is import('../shared/types').McpConfig {
  const rec = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  const servers = rec?.['servers'];
  const ok =
    servers !== null &&
    typeof servers === 'object' &&
    Object.values(servers as Record<string, unknown>).every((s) => {
      const sc = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : null;
      return (
        sc !== null &&
        typeof sc['command'] === 'string' &&
        (sc['args'] === undefined || (Array.isArray(sc['args']) && sc['args'].every((a) => typeof a === 'string'))) &&
        (sc['env'] === undefined ||
          (typeof sc['env'] === 'object' && sc['env'] !== null &&
            Object.values(sc['env'] as Record<string, unknown>).every((v) => typeof v === 'string'))) &&
        (sc['enabled'] === undefined || typeof sc['enabled'] === 'boolean') &&
        (sc['trusted'] === undefined || typeof sc['trusted'] === 'boolean')
      );
    });
  if (!ok) throw new Error('IPC payload mcp config が不正');
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
  /** M13-2: MCPクライアント(will-quit で closeAll を呼ぶこと) */
  mcp: McpManager;
}

/** M20: 起動時フラグ(センチネル由来)。renderer のバナー表示用 */
export interface RuntimeFlags {
  /** 進化再起動の2回連続クラッシュを検知し、進化機能を止めて起動した */
  safeMode: boolean;
  safeModeInfo?: { tag: string; prevCommit: string };
  /** この起動が進化(evolve/N)の再起動として完走した */
  restartedFrom?: string;
}

/**
 * M10-1 以降、ロジックの実体は core/service.ts(AgentService)にあり、
 * ここは「IPCチャネル ⇔ サービス呼び出し」の薄い写像だけを持つ。
 * IPCチャネル名・payload 型は M10 以前から不変(挙動変更ゼロが条件)。
 */
export async function registerIpcHandlers(
  getWebContents: () => WebContents | null,
  runtimeFlags: RuntimeFlags = { safeMode: false },
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
  // M23-2: 使用量メーター(userData/usage.json)
  const usageMeter = new UsageMeter(join(app.getPath('userData'), 'usage.json'));
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
    usage: usageMeter,
    // M11-3: 自動チェックポイント(git の無い workspace では manager 側で noop)
    createCheckpoints: (workspace) =>
      new CheckpointManager(workspace, (line) => console.log(`[checkpoint] ${line}`)),
    // M12-1: セッション永続化(userData/sessions/)
    sessions: new SessionStore(join(app.getPath('userData'), 'sessions')),
    // M14-2: URLスクリーンショット(offscreen BrowserWindow)。進化ジョブへは渡らない
    captureUrl,
    createEvolution: (hooks) => {
      // M20: セーフモード中は進化機能を無効化して起動する(承認機構と復旧経路は生きたまま)
      if (runtimeFlags.safeMode) {
        return {
          list: () => [],
          enqueue: async () => {
            throw new Error(
              'セーフモード中のため進化は実行できない(進化再起動の連続失敗を検知)。' +
                'Settings から解除するか、手動復旧後に再起動してください',
            );
          },
        };
      }
      // M25-7: requestRestart(下のdeps内)はmanager.pendingRequests()を参照するが、
      // クロージャなので実際に呼ばれるのは new EvolutionManager(...) 完了後(=manager代入後)。
      const manager: EvolutionManager = new EvolutionManager({
        repoDir,
        worktreeBase: join(repoDir, '..', 'mycodex-evolve'),
        runner: new AgentJobRunner(() => service.createProviderOrThrow()),
        requestPromotionApproval: hooks.requestPromotionApproval,
        reloadPlugins: () => registry.reload(),
        // M25-8: 新規作成時の既存ツール名衝突チェック/既存修正時の実在確認に使う
        existingToolNames: () => registry.list().map((t) => t.name),
        healthCheck: (toolName, smokeInput) =>
          healthCheckAfterPromotion(repoDir, toolName, smokeInput),
        // M20: renderer/core 昇格後の再ビルド+フルアプリ健全性(失敗時はmanagerが自動revert)
        rebuildAndHealthBoot: (dir) => rebuildAndHealthBoot(dir),
        // M20: 健全性確定後の再起動(センチネル書き込み→5秒後にrelaunch)
        requestRestart: (tag, prevCommit) => {
          writeSentinel(app.getPath('userData'), tag, prevCommit);
          // M25-7: 直列キューでまだ着手していない依頼は、この再起動で強制終了されると
          // 何のエラーも履歴も残さず消えてしまうため、再enqueueできるよう退避しておく
          const pending = manager.pendingRequests();
          writePendingQueue(app.getPath('userData'), pending);
          audit.append({
            tool: 'evolution-restart',
            scope: 'system',
            paths: [],
            event: 'result',
            detail:
              `tag=${tag} prev=${prevCommit.slice(0, 8)} — 5秒後に再起動` +
              (pending.length > 0 ? `。キュー中の${pending.length}件は再起動後に再投入する` : ''),
          });
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 5000);
        },
        onEvent: hooks.onEvent,
      });
      // M25-7: 前回起動が進化再起動で強制終了され、まだ着手していなかった依頼が
      // 残っていれば読み戻して再投入する(セーフモード中はこの分岐自体に入らないため
      // ファイルは手つかずのまま残り、通常起動に戻ったときに拾われる)
      for (const req of readAndClearPendingQueue(app.getPath('userData'))) {
        void manager.enqueue(req);
      }
      return manager;
    },
  });

  // bus → renderer(webContents.send)。チャネル名はバスとIPCで同一
  bus.subscribe('chat:event', (e) => push(IpcChannels.chatEvent, e));
  bus.subscribe('approval:request', (r) => push(IpcChannels.approvalRequest, r));
  bus.subscribe('approval:resolved', (r) => push(IpcChannels.approvalResolved, r));
  bus.subscribe('evolution:event', (e) => push(IpcChannels.evolutionEvent, e));
  bus.subscribe('agent:sub_update', (u) => push(IpcChannels.subAgentUpdate, u));
  bus.subscribe('autonomous:changed', (p) => push(IpcChannels.autonomousChanged, p));
  bus.subscribe('runs:changed', (runs) => push(IpcChannels.runsChanged, runs));

  // ---- chat ----
  ipcMain.handle(IpcChannels.chatSend, (_e, text: unknown, mode: unknown, images: unknown) => {
    assertString(text, 'text');
    return service.chatSend(text, mode === 'plan' ? 'plan' : 'normal', validateChatImages(images));
  });

  ipcMain.handle(IpcChannels.chatCancel, (_e, sessionId: unknown) => {
    assertString(sessionId, 'sessionId');
    service.chatCancel(sessionId);
  });

  // ---- M20: 起動時フラグ(セーフモード/進化再起動完了のバナー用)+セーフモード解除 ----
  ipcMain.handle(IpcChannels.runtimeFlags, () => ({ ...runtimeFlags }));
  ipcMain.handle(IpcChannels.safeModeClear, () => {
    const cleared = clearSentinel(app.getPath('userData'));
    audit.append({
      tool: 'evolution-safemode',
      scope: 'system',
      paths: [],
      event: 'result',
      detail: cleared ? 'ユーザーがセーフモードを解除(要再起動)' : '解除対象なし',
    });
    return { cleared };
  });

  // ---- 自律モード(M17-2。状態はセッション単位・再起動でOFF) ----
  ipcMain.handle(IpcChannels.autonomousGet, () => ({ on: service.getAutonomous() }));
  ipcMain.handle(IpcChannels.autonomousSet, (_e, on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('IPC payload autonomous:set が不正');
    return service.setAutonomous(on);
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
  // M25: ユーザー方針(全プロジェクト共通の育成レイヤー)
  ipcMain.handle(IpcChannels.userMemoryGet, () => readUserMemory(app.getPath('userData')));
  ipcMain.handle(IpcChannels.userMemorySet, (_e, content: unknown) => {
    assertString(content, 'content');
    writeUserMemory(app.getPath('userData'), content);
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

  ipcMain.handle(
    IpcChannels.evolutionEnqueue,
    (_e, description: unknown, expectedIo: unknown, scope: unknown) => {
      assertString(description, 'description');
      assertString(expectedIo, 'expectedIo');
      // M20: scope 省略=tool(後方互換)。不正値は拒否
      if (scope !== undefined && scope !== 'tool' && scope !== 'renderer' && scope !== 'core') {
        throw new Error('IPC payload scope が不正');
      }
      return service.evolutionEnqueue(description, expectedIo, scope);
    },
  );

  ipcMain.handle(IpcChannels.evolutionList, () => service.evolutionList());

  // M26-6: ジョブのキャンセル(queued=キュー除去/実行中=abort)
  ipcMain.handle(IpcChannels.evolutionCancel, (_e, jobId: unknown) => {
    if (typeof jobId !== 'number' || !Number.isInteger(jobId)) {
      throw new Error('IPC payload jobId が不正');
    }
    return service.evolutionCancel(jobId);
  });

  // ---- M20: ロールバック履歴と「1つ前へ戻す」 ----
  ipcMain.handle(IpcChannels.evolutionHistory, () => listEvolveTags(repoDir));
  // M23-6: 進化で獲得した能力(スキル/自己書き換え)一覧
  ipcMain.handle(IpcChannels.evolutionCapabilities, () => listEvolvedCapabilities(app.getAppPath()));
  ipcMain.handle(IpcChannels.evolutionRollbackLast, async () => {
    const result = await rollbackLastEvolve(repoDir);
    audit.append({
      tool: 'evolution-rollback',
      scope: 'system',
      paths: [],
      event: 'result',
      detail: result.message.slice(0, 200),
    });
    if (!result.ok) return result;
    // revert後は再ビルド+プラグイン再読込(コア変更だった場合に旧コードへ戻すため)
    const rebuild = await defaultRunCommand('npm run build', repoDir);
    await registry.reload().catch(() => {});
    return {
      ok: true,
      message:
        `${result.message}。再ビルド${rebuild.code === 0 ? '完了' : '失敗(手動で npm run build を実行)'}。` +
        'コア/UI変更を戻した場合はアプリの再起動を推奨',
    };
  });

  // ---- チェックポイント(M11-3) ----
  ipcMain.handle(IpcChannels.checkpointList, () => service.checkpointList());
  ipcMain.handle(IpcChannels.checkpointRestore, (_e, sha: unknown) => {
    assertString(sha, 'sha');
    return service.checkpointRestore(sha);
  });

  // ---- セッション永続化(M12-1) ----
  ipcMain.handle(IpcChannels.sessionsList, () => service.sessionsList());
  // M22: 実行中ラン一覧(左ペインの実行中インジケータ初期化用)
  ipcMain.handle(IpcChannels.runsList, () => service.runsList());
  // M23-2: 使用量サマリと、プロバイダの残高ダッシュボードを開く(URLは固定allowlist)
  ipcMain.handle(IpcChannels.usageGet, () => usageMeter.summary());
  ipcMain.handle(IpcChannels.openBillingPage, (_e, provider: unknown) => {
    const urls: Record<string, string> = {
      anthropic: 'https://console.anthropic.com/settings/billing',
      openai: 'https://platform.openai.com/settings/organization/billing/overview',
    };
    const url = typeof provider === 'string' ? urls[provider] : undefined;
    if (!url) throw new Error('不明なプロバイダ');
    void shell.openExternal(url);
  });
  ipcMain.handle(IpcChannels.sessionsLoad, (_e, id: unknown) => {
    assertString(id, 'id');
    return service.sessionLoad(id);
  });
  ipcMain.handle(IpcChannels.sessionsDelete, (_e, id: unknown) => {
    assertString(id, 'id');
    return service.sessionDelete(id);
  });
  ipcMain.handle(IpcChannels.sessionsNew, () => service.sessionNew());
  ipcMain.handle(IpcChannels.sessionsSearch, (_e, query: unknown) => {
    assertString(query, 'query');
    return service.sessionsSearch(query);
  });
  ipcMain.handle(IpcChannels.sessionsRename, (_e, id: unknown, title: unknown) => {
    assertString(id, 'id');
    assertString(title, 'title');
    return service.sessionRename(id, title);
  });

  // ---- ファイルプレビュー(M15-3) ----
  ipcMain.handle(IpcChannels.filePreview, (_e, path: unknown) => {
    assertString(path, 'path');
    return service.filePreview(path);
  });
  ipcMain.handle(IpcChannels.fileReveal, async (_e, path: unknown) => {
    assertString(path, 'path');
    // 整理1: フォルダも開けるよう内容は読まずに解決(deny判定のみ通す)
    const result = await service.fileRevealTarget(path);
    if (result.ok) shell.showItemInFolder(result.path);
  });

  // ---- 環境ウィジェット(M15-4) ----
  ipcMain.handle(IpcChannels.workspaceGitStatus, () => workspaceGitStatus(service.getWorkspace()));

  // ---- 計画ファイル(M12-2) ----
  ipcMain.handle(IpcChannels.planGet, () => readProjectPlan(service.getWorkspace()));

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
    if (rc.host !== undefined && rc.host !== '') status.host = rc.host;
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
    // M23-3: スマホから変更してよい設定のホワイトリスト。workspace/scopeMode/
    // fullPcAllowSession/postEditHook(任意コマンド)/remote(自身)は変更不可
    const REMOTE_SETTABLE = new Set([
      'provider',
      'model',
      'maxTurns',
      'subAgentMaxTurns',
      'subAgentMaxParallel',
      'autoApprove',
      'modelPolicy',
      'fallback',
    ]);
    const sanitizedConfig = (): Record<string, unknown> => {
      const { remote: _remote, ...rest } = config.get();
      return rest;
    };
    const server = new RemoteServer({
      facade: service,
      bus,
      auth: remoteAuth,
      staticDir: getRemoteUiDir(),
      auditTail: (limit) => audit.tail(limit),
      usageSummary: () => usageMeter.summary(),
      remoteSettings: {
        get: sanitizedConfig,
        set: (patch) => {
          for (const key of Object.keys(patch)) {
            if (!REMOTE_SETTABLE.has(key)) throw new Error(`リモートから変更できない項目: ${key}`);
          }
          const next: Record<string, unknown> = { ...config.get() };
          for (const [key, value] of Object.entries(patch)) {
            // null は「項目の削除」(modelPolicy/fallback等の無効化・既定戻し)
            if (value === null) delete next[key];
            else next[key] = value;
          }
          assertConfig(next);
          config.set(next);
          audit.append({
            tool: 'remote-settings',
            scope: 'system',
            paths: [],
            event: 'result',
            detail: `変更: ${Object.keys(patch).join(', ')}`,
          });
          return sanitizedConfig();
        },
      },
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
    // M23fix: 再構成で host(QR用ホスト名)を落とさない
    const next: RemoteConfig = { enabled, port };
    if (tokenHash !== undefined) next.tokenHash = tokenHash;
    if (rc.host !== undefined) next.host = rc.host;
    setRemoteConfig(next);
    await applyRemoteState();
    const result: { status: RemoteStatusPayload; token?: string } = { status: remoteStatus() };
    if (token !== undefined) result.token = token;
    return result;
  });

  // ホスト名はURL/QR組み立て用の表示情報(listenには影響しない)。
  // localStorage保存はuserData移行で消えたためconfigへ永続化する
  ipcMain.handle(IpcChannels.remoteSetHost, (_e, host: unknown) => {
    assertString(host, 'host');
    const trimmed = host.trim();
    if (trimmed.length > 253) throw new Error('ホスト名が長すぎる');
    const rc = getRemoteConfig();
    const next: RemoteConfig = { ...rc };
    if (trimmed === '') delete next.host;
    else next.host = trimmed;
    setRemoteConfig(next);
    return remoteStatus();
  });

  ipcMain.handle(IpcChannels.remoteRegenerateToken, () => {
    // ハッシュ差し替えのみで旧トークンは即失効する(RemoteAuth は config を毎回参照)
    const pair = generateToken();
    setRemoteConfig({ ...getRemoteConfig(), tokenHash: pair.tokenHash });
    return { status: remoteStatus(), token: pair.token };
  });

  // 起動時: 設定が有効ならサーバを立てる(失敗しても起動は続行、状態はUIで見える)
  await applyRemoteState();

  // ---- MCPクライアント(M13-2。デスクトップ専用) ----
  const mcp = new McpManager({
    registry,
    configPath: join(app.getPath('userData'), 'mcp.json'),
    log: (line) => console.log(line),
  });
  ipcMain.handle(IpcChannels.mcpStatus, () => mcp.status());
  ipcMain.handle(IpcChannels.mcpSetConfig, async (_e, cfg: unknown) => {
    assertMcpConfig(cfg);
    await mcp.setConfig(cfg);
    return mcp.status();
  });
  // 起動をブロックしない(接続失敗は状態表示のみ)
  void mcp.syncAll();

  return { registry, broker: service.broker, config, secrets, service, bus, mcp };
}
