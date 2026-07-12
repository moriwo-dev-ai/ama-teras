import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IpcChannels } from '../shared/ipc';
import type {
  AppConfig,
  ApprovalDecision,
  IwatoRequestPayload,
  ProviderId,
  ProvisionalInstall,
  SecretSlot,
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
import { OperationsManager } from './operations/manager';
import { DEFAULT_UPDATE_CHECK_URL } from '../shared/models';
import { checkForUpdate } from './update/check';
import { composeRunners, ImportJobRunner } from './registry/importRunner';
import { fetchRevocationList } from './registry/killswitch';
import { exportPlugin } from './registry/packager';
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

/** M27-1: APIキー保存スロット(プロバイダ+無料APIプリセット) */
function assertSecretSlot(value: unknown): asserts value is SecretSlot {
  if (
    value !== 'anthropic' &&
    value !== 'openai' &&
    value !== 'gemini' &&
    value !== 'groq' &&
    value !== 'openrouter' &&
    value !== 'custom' &&
    value !== 'bluesky'
  ) {
    throw new Error('IPC payload slot が不正');
  }
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
  if (process.env['AMATERAS_PLUGINS_DIR']) return process.env['AMATERAS_PLUGINS_DIR'];
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
  /**
   * M28-2: 配布版(app.isPackaged)。ソース+gitリポジトリが無く進化パイプラインは
   * 動作しないため、進化機能をきれいに無効化してUIで理由を説明する
   */
  packaged?: boolean;
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

  // M27-4: キルスイッチ(プラグイン失効リスト)。起動時に1回フェッチし、一致する
  // 導入済みプラグインを自動無効化する(理由はツール一覧のエラー表示でユーザーに見える)。
  // ネットワーク不達・不正応答は静かにスキップ(キルスイッチ不達でアプリを止めない)
  const revocationUrl = config.get().pluginRevocationUrl;
  if (revocationUrl !== undefined) {
    void fetchRevocationList(revocationUrl).then((entries) => {
      if (entries === null) return;
      for (const e of entries) {
        if (registry.revoke(e.name, e.reason)) {
          console.log(`[killswitch] プラグイン ${e.name} を無効化: ${e.reason}`);
        }
      }
    });
  }
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
    // M29-5: 仮導入(棚卸し待ち)の永続化。未応答なら次回起動時に再提示するため
    provisionalStore: {
      load: () => {
        try {
          const raw: unknown = JSON.parse(
            readFileSync(join(app.getPath('userData'), 'provisional.json'), 'utf8'),
          );
          if (!Array.isArray(raw)) return [];
          return raw.filter(
            (p): p is ProvisionalInstall =>
              typeof p === 'object' && p !== null &&
              typeof (p as Record<string, unknown>)['jobId'] === 'number' &&
              typeof (p as Record<string, unknown>)['toolName'] === 'string' &&
              typeof (p as Record<string, unknown>)['tag'] === 'string',
          );
        } catch {
          return [];
        }
      },
      save: (items) => {
        try {
          writeFileSync(
            join(app.getPath('userData'), 'provisional.json'),
            JSON.stringify(items, null, 2),
            'utf8',
          );
        } catch {
          /* 保存失敗で機能を止めない(次回起動での再提示が失われるだけ) */
        }
      },
    },
    // M14-2: URLスクリーンショット(offscreen BrowserWindow)。進化ジョブへは渡らない
    captureUrl,
    createEvolution: (hooks) => {
      // M28-2: 配布版は進化パイプラインの前提(ソースツリー+.git+devDependencies)が
      // 存在しない。git不在の生エラーで汚く落ちる前に、理由つきで明示的に無効化する
      if (app.isPackaged) {
        return {
          list: () => [],
          enqueue: async () => {
            throw new Error(
              '配布版ではコア自己進化(新ツールの生成・インポート)は動作しません' +
                '(ソースコードとgitリポジトリが必要です)。プラグインはコミュニティ' +
                'レジストリから導入できるようになる予定です(準備中)。' +
                '今すぐ使うには開発版(git clone → npm install → npm start)をご利用ください',
            );
          },
        };
      }
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
        worktreeBase: join(repoDir, '..', 'amateras-evolve'),
        // M27-4: importFrom 付きの依頼はLLM生成の代わりにファイルコピー(以降のゲートは同一)
        runner: composeRunners(
          new AgentJobRunner(() => service.createProviderOrThrow()),
          new ImportJobRunner(),
        ),
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
  // M28-2: packaged はここで動的に付与(index.ts からの注入漏れに依存しない)
  ipcMain.handle(IpcChannels.runtimeFlags, () => ({ ...runtimeFlags, packaged: app.isPackaged }));
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
  ipcMain.handle(IpcChannels.autonomousSet, (_e, on: unknown, registryScope: unknown) => {
    if (typeof on !== 'boolean') throw new Error('IPC payload autonomous:set が不正');
    // M29-5: 包括承認範囲(省略可・不正値は未指定扱い=設定の既定値)
    const scope =
      registryScope === 'none' || registryScope === 'verified' || registryScope === 'verified-generate'
        ? registryScope
        : undefined;
    return service.setAutonomous(on, scope);
  });

  // ---- M29-5: 仮導入の棚卸し ----
  ipcMain.handle(IpcChannels.inventoryList, () => service.inventoryList());
  ipcMain.handle(IpcChannels.inventoryResolve, (_e, jobId: unknown, keep: unknown) => {
    if (typeof jobId !== 'number' || !Number.isInteger(jobId) || typeof keep !== 'boolean') {
      throw new Error('IPC payload inventory:resolve が不正');
    }
    return service.inventoryResolve(jobId, keep);
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
    const saved = config.set({ ...next, remote: config.get().remote });
    // M32: オーナーモードや対象リポジトリの変更を反映(次回アクセスで再初期化)
    operations.reset();
    return saved;
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
    gemini: secrets.has('gemini'),
    groq: secrets.has('groq'),
    openrouter: secrets.has('openrouter'),
    custom: secrets.has('custom'),
    bluesky: secrets.has('bluesky'),
  });
  ipcMain.handle(IpcChannels.secretsStatus, () => secretsStatus());
  ipcMain.handle(IpcChannels.secretsSet, (_e, slot: unknown, apiKey: unknown) => {
    assertSecretSlot(slot);
    assertString(apiKey, 'apiKey');
    secrets.set(slot, apiKey.trim());
    // M35-4: 資格情報の変更をアダプタ宣言(Bluesky実行系の有効/無効)へ反映
    operations.reset();
    return secretsStatus();
  });
  // M27-1: 接続テスト(現在の設定で最小1リクエスト)
  ipcMain.handle(IpcChannels.connectionTest, () => service.connectionTest());

  // ---- M32: 運営(Project TAKAMA-gahara)。operations.enabled=オーナーモード時のみ実働 ----
  // 岩戸ゲートの承認: renderer の共通ダイアログ(何を・どこへ・全文プレビュー)へ橋渡しし、
  // 応答を待つ。10分無応答は拒否扱い(承認なし実行は protocol.ts がコードレベルで不可能にする)
  const iwatoPending = new Map<string, (approved: boolean) => void>();
  // M34-6: リモート表示用に承認待ちの内容も保持(応答時に除去+renderer側ダイアログも閉じる)
  const iwatoPendingList: IwatoRequestPayload[] = [];
  const iwatoRespond = (id: string, approved: boolean, viaRemote: boolean): boolean => {
    const resolver = iwatoPending.get(id);
    if (!resolver) return false;
    const idx = iwatoPendingList.findIndex((r) => r.id === id);
    if (idx >= 0) iwatoPendingList.splice(idx, 1);
    if (viaRemote) {
      audit.append({
        tool: 'operations:iwato',
        scope: 'system',
        paths: [],
        event: 'approval',
        detail: `[岩戸] リモート経由で${approved ? '承認' : '拒否'}: ${id}`,
      });
    }
    push(IpcChannels.operationsApprovalResolved, { id, approved });
    resolver(approved);
    return true;
  };
  const operations = new OperationsManager({
    userDataDir: app.getPath('userData'),
    getConfig: () => config.get(),
    // M46: リリースタグの自動採番と package.json との食い違い検出に使う
    appVersion: app.getVersion(),
    audit: (e) =>
      audit.append({
        tool: `operations:${e.adapterId}`,
        scope: 'system',
        paths: [],
        event: e.approved ? 'result' : 'hard-deny',
        detail: `[岩戸] ${e.action} → ${e.target}: ${e.detail}`,
      }),
    approvalPrompt: (req) =>
      new Promise<boolean>((resolve) => {
        iwatoPending.set(req.id, (approved) => {
          iwatoPending.delete(req.id);
          resolve(approved);
        });
        iwatoPendingList.push(req);
        push(IpcChannels.operationsApprovalRequest, req);
        setTimeout(() => iwatoRespond(req.id, false, false), 10 * 60_000);
      }),
    bandProvider: (band) => service.operationsBandProvider(band),
    // M34-7: 運営専用モデル帯(神議/神々。usage集計も区別される)
    roleProvider: (role) => service.operationsProvider(role),
    // M35-4: Bluesky実行系の資格情報(secretsのblueskyスロット。無ければ提案のみ)
    getBlueskySecret: () => secrets.get('bluesky'),
    // M38-2: 承認された能力ギャップ(evolve)を進化ジョブへ。昇格は従来どおり承認制
    enqueueEvolution: (description, expectedIO) => service.evolutionEnqueue(description, expectedIO).then((r) => r.jobId),
    // M42-2: 神議も「作る前に探す」— 探すのは自律、取り込むのは人間の承認後
    findRegistryPlugin: async (query) => {
      const e = await service.registryFindPlugin(query);
      return e === null
        ? null
        : {
            key: e.name,
            displayName: e.name,
            description: e.description,
            version: e.version,
            author: e.author,
            verified: e.verified,
          };
    },
    importRegistryPlugin: (name) => service.registryImportPlugin(name),
    // M42-3: 神定義もレジストリで配布する(神は「コード」ではなく定義データ)
    listRegistryGods: async (query) =>
      (await service.registryGodList(query)).map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        engine: g.engine,
        version: g.version,
        author: g.author,
        verified: g.verified,
      })),
    fetchRegistryGod: (id) => service.registryGodFetch(id),
    readHighlightSources: async () => {
      let progressExcerpt = '';
      try {
        progressExcerpt = readFileSync(join(repoDir, 'PROGRESS.md'), 'utf8').slice(0, 6000);
      } catch {
        // PROGRESS.md 無しでも下書き生成は可能(素材が減るだけ)
      }
      const recentCommits = await new Promise<string>((resolve) => {
        execFile('git', ['log', '--oneline', '-20'], { cwd: repoDir, timeout: 15_000 }, (err, stdout) =>
          resolve(err ? '' : stdout),
        );
      });
      return { progressExcerpt, recentCommits };
    },
  });
  ipcMain.handle(IpcChannels.operationsStatus, () => operations.status());
  ipcMain.handle(IpcChannels.operationsSnapshot, () => operations.collectSnapshot());
  ipcMain.handle(IpcChannels.operationsHistory, (_e, limit: unknown) =>
    operations.history(typeof limit === 'number' ? limit : 30),
  );
  ipcMain.handle(IpcChannels.operationsWeeklyReport, () => operations.weeklyReport());
  ipcMain.handle(IpcChannels.operationsDraftsGenerate, () => operations.generateDrafts());
  ipcMain.handle(IpcChannels.operationsDraftsList, () => operations.listDrafts());
  ipcMain.handle(IpcChannels.operationsDraftUpdate, (_e, id: unknown, patch: unknown) => {
    assertString(id, 'id');
    if (typeof patch !== 'object' || patch === null) throw new Error('IPC payload patch が不正');
    const p = patch as Record<string, unknown>;
    return operations.updateDraft(id, {
      ...(p['status'] === 'draft' || p['status'] === 'posted' || p['status'] === 'discarded'
        ? { status: p['status'] }
        : {}),
      ...(typeof p['body'] === 'string' ? { body: p['body'] } : {}),
      ...(typeof p['title'] === 'string' ? { title: p['title'] } : {}),
      ...(typeof p['media'] === 'string' ? { media: p['media'] } : {}),
    });
  });
  // M46: 次のリリース版の候補(読み取りのみ。発行は岩戸ゲート経由)
  ipcMain.handle(IpcChannels.operationsReleaseInfo, (_e, repo: unknown) => {
    assertString(repo, 'repo');
    return operations.releaseInfo(repo);
  });
  // M47: リリース前の version 上げ(承認ダイアログで差分を見せる)
  ipcMain.handle(IpcChannels.operationsBumpVersion, (_e, tag: unknown) => {
    assertString(tag, 'tag');
    return operations.bumpPackageVersion(tag);
  });
  // M48: 下書きリリースの公開(配布物の添付を manager が確認してから承認へ回す)
  ipcMain.handle(IpcChannels.operationsReleasePublish, (_e, repo: unknown, tag: unknown) => {
    assertString(repo, 'repo');
    assertString(tag, 'tag');
    return operations.requestReleasePublish(repo, tag);
  });
  // M37: 下書きの行き先。実行そのものは manager 内で岩戸ゲート(承認)を必ず通る
  ipcMain.handle(
    IpcChannels.operationsDraftRelease,
    (_e, draftId: unknown, repo: unknown, tag: unknown) => {
      assertString(draftId, 'draftId');
      assertString(repo, 'repo');
      assertString(tag, 'tag');
      return operations.requestRelease(draftId, repo, tag);
    },
  );
  ipcMain.handle(IpcChannels.operationsDraftZennArticle, (_e, draftId: unknown) => {
    assertString(draftId, 'draftId');
    return operations.requestZennArticle(draftId);
  });
  ipcMain.handle(IpcChannels.operationsImpacts, (_e, windowHours: unknown) =>
    operations.impacts(typeof windowHours === 'number' ? windowHours : 24),
  );
  ipcMain.handle(IpcChannels.operationsStrategyBoard, () => operations.strategyBoard());
  ipcMain.handle(IpcChannels.operationsDiscoverySearch, (_e, keywords: unknown) => {
    if (!Array.isArray(keywords) || keywords.some((k) => typeof k !== 'string')) {
      throw new Error('IPC payload keywords が不正');
    }
    return operations.discoverySearch(keywords as string[]);
  });
  ipcMain.handle(IpcChannels.operationsCandidateAnalyze, (_e, pastedText: unknown, source: unknown) => {
    assertString(pastedText, 'pastedText');
    assertString(source, 'source');
    return operations.analyzeCandidate(pastedText, source);
  });
  ipcMain.handle(IpcChannels.operationsCandidatesList, () => operations.listCandidates());
  ipcMain.handle(IpcChannels.operationsCandidateResolve, (_e, id: unknown, status: unknown) => {
    assertString(id, 'id');
    if (status !== 'kept' && status !== 'discarded') throw new Error('IPC payload status が不正');
    return operations.resolveCandidate(id, status);
  });
  ipcMain.handle(IpcChannels.operationsTriage, () => operations.triage());
  ipcMain.handle(
    IpcChannels.operationsExecute,
    (_e, adapterId: unknown, action: unknown, target: unknown, preview: unknown, params: unknown) => {
      assertString(adapterId, 'adapterId');
      assertString(action, 'action');
      assertString(target, 'target');
      assertString(preview, 'preview');
      const p = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
      return operations.execute(adapterId, action, target, preview, p);
    },
  );
  ipcMain.handle(IpcChannels.operationsApprovalRespond, (_e, id: unknown, approved: unknown) => {
    assertString(id, 'id');
    if (typeof approved !== 'boolean') throw new Error('IPC payload approved が不正');
    iwatoRespond(id, approved, false);
  });
  // M33: 神議アーキテクチャ(時計・受け箱・⛩運営スレッド・承認バッチ)
  ipcMain.handle(IpcChannels.operationsClocks, () => operations.clocks());
  ipcMain.handle(IpcChannels.operationsClockUpdate, (_e, id: unknown, patch: unknown) => {
    assertString(id, 'id');
    if (typeof patch !== 'object' || patch === null) throw new Error('IPC payload patch が不正');
    const p = patch as Record<string, unknown>;
    return operations.updateClock(id, {
      ...(typeof p['intervalMin'] === 'number' ? { intervalMin: p['intervalMin'] } : {}),
      ...(typeof p['enabled'] === 'boolean' ? { enabled: p['enabled'] } : {}),
      ...(typeof p['dailyTokenBudget'] === 'number' ? { dailyTokenBudget: p['dailyTokenBudget'] } : {}),
      // M38-1: 🔓解錠(神議へ調整権限を返す)。施錠は予算設定と同時に自動で立つ
      ...(p['budgetSetByUser'] === false ? { budgetSetByUser: false } : {}),
    });
  });
  ipcMain.handle(IpcChannels.operationsInboxList, (_e, limit: unknown) =>
    operations.inboxList(typeof limit === 'number' ? limit : 100),
  );
  ipcMain.handle(IpcChannels.operationsInboxMarkRead, (_e, ids: unknown) => {
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new Error('IPC payload ids が不正');
    operations.inboxMarkRead(ids as string[]);
  });
  ipcMain.handle(IpcChannels.operationsThreadList, () => operations.threadList());
  ipcMain.handle(IpcChannels.operationsThreadSend, (_e, text: unknown) => {
    assertString(text, 'text');
    return operations.threadSend(text);
  });
  ipcMain.handle(IpcChannels.operationsThreadBatches, () => operations.threadBatches());
  ipcMain.handle(IpcChannels.operationsThreadPending, () => operations.threadPendingCount());
  ipcMain.handle(IpcChannels.operationsBatchRespond, (_e, batchId: unknown, itemId: unknown, approved: unknown) => {
    assertString(batchId, 'batchId');
    assertString(itemId, 'itemId');
    if (typeof approved !== 'boolean') throw new Error('IPC payload approved が不正');
    return operations.batchRespond(batchId, itemId, approved);
  });
  // M39: 同種(媒体×アクション)の一括承認。実行は manager 内で岩戸ゲート(全件1ダイアログ)を通る
  ipcMain.handle(
    IpcChannels.operationsBulkRespond,
    (_e, batchId: unknown, itemIds: unknown, approved: unknown) => {
      assertString(batchId, 'batchId');
      if (!Array.isArray(itemIds) || itemIds.some((i) => typeof i !== 'string')) {
        throw new Error('IPC payload itemIds が不正');
      }
      if (typeof approved !== 'boolean') throw new Error('IPC payload approved が不正');
      return operations.bulkRespond(batchId, itemIds as string[], approved);
    },
  );
  ipcMain.handle(IpcChannels.operationsKamuhakariRun, async () => {
    const result = await operations.runKamuhakari();
    return { analysis: result.analysis, batchItems: result.batch?.items.length ?? 0, applied: result.appliedChanges.length };
  });
  // M33-5: 神の定義(一覧は自由・適用は岩戸ゲート承認必須)
  ipcMain.handle(IpcChannels.operationsGodDefs, () => operations.godDefinitions());
  ipcMain.handle(IpcChannels.operationsGodDefApply, (_e, definition: unknown) =>
    operations.requestGodDefinitionApply(definition),
  );
  // M42-3: 神定義のレジストリ配布(探す・迎える・書き出す)
  ipcMain.handle(IpcChannels.operationsGodRegistry, (_e, query: unknown) =>
    operations.godRegistryList(typeof query === 'string' && query !== '' ? query : undefined),
  );
  ipcMain.handle(IpcChannels.operationsGodInstall, (_e, id: unknown) => {
    assertString(id, 'id');
    return operations.installGodFromRegistry(id);
  });
  ipcMain.handle(IpcChannels.operationsGodExport, async (_e, id: unknown) => {
    assertString(id, 'id');
    const json = operations.godDefinitionExport(id);
    if (json === null) return { ok: false, message: `神「${id}」が見つからない` };
    const result = await dialog.showSaveDialog({
      title: '神の定義を書き出す(レジストリへPRするため)',
      defaultPath: `${id}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || result.filePath === undefined) return { ok: false, message: 'キャンセルした' };
    writeFileSync(result.filePath, json, 'utf8');
    return { ok: true, message: `書き出した: ${result.filePath}` };
  });

  // ---- M42-1: 更新確認(通知だけ。自動ダウンロード・自動インストールはしない) ----
  ipcMain.handle(IpcChannels.updateCheck, () =>
    checkForUpdate(app.getVersion(), config.get().updateCheckUrl ?? DEFAULT_UPDATE_CHECK_URL),
  );

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

  // ---- M27-4: プラグインのエクスポート/インポート ----
  ipcMain.handle(IpcChannels.pluginsExport, async (_e, toolName: unknown) => {
    assertString(toolName, 'toolName');
    const plugin = registry.get(toolName);
    if (!plugin) return { ok: false, message: `ツール「${toolName}」が見つからない` };
    const result = await dialog.showOpenDialog({
      title: 'エクスポート先の親フォルダを選択',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: 'キャンセルされた' };
    }
    return exportPlugin({
      pluginsDir: getPluginsDir(),
      toolName,
      description: plugin.description,
      destRoot: result.filePaths[0]!,
    });
  });

  ipcMain.handle(IpcChannels.pluginsImport, async () => {
    const result = await dialog.showOpenDialog({
      title: 'プラグインのフォルダを選択(manifest.json を含むディレクトリ)',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: 'キャンセルされた' };
    }
    return service.pluginImportStart(result.filePaths[0]!);
  });

  // M26-7: 表示中の会話の workspace 移動(実行中は service 側で拒否)
  ipcMain.handle(IpcChannels.conversationMoveWorkspace, (_e, newWorkspace: unknown) => {
    assertString(newWorkspace, 'newWorkspace');
    return service.conversationMoveWorkspace(newWorkspace);
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
      // M27-1: 無料APIプリセットはAPIキー取得ページ(「無料で始める」導線)
      gemini: 'https://aistudio.google.com/apikey',
      groq: 'https://console.groq.com/keys',
      openrouter: 'https://openrouter.ai/settings/keys',
    };
    const url = typeof provider === 'string' ? urls[provider] : undefined;
    if (!url) throw new Error('不明なプロバイダ');
    void shell.openExternal(url);
  });
  // M41-2: 外部URLを既定ブラウザで開く(X投稿画面・はてブ等)。
  // renderer の window.open はアプリ内ウィンドウを開いてしまい、ログインセッションが無く使えない
  ipcMain.handle(IpcChannels.openExternal, (_e, url: unknown) => {
    assertString(url, 'url');
    if (!/^https?:\/\//.test(url)) throw new Error('http/https 以外は開けない');
    return shell.openExternal(url);
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
      // M34-6: 運営のリモートフル対応(既存トークン認証配下。オーナーモードOFF時は空を返す)
      operations: {
        summary: async () => ({
          enabled: (await operations.status()).enabled,
          clocks: operations.clocks(),
          inbox: operations.inboxList(30),
          latest: operations.history(1)[0] ?? null,
          pendingIwato: [...iwatoPendingList],
        }),
        threadList: () => operations.threadList(),
        threadSend: (text) => operations.threadSend(text),
        batches: () => operations.threadBatches(),
        batchRespond: (batchId, itemId, approved) => operations.batchRespond(batchId, itemId, approved),
        iwatoRespond: (id, approved) => iwatoRespond(id, approved, true),
        // M40: スマホからデスクトップ同等の操作(ドラフト・時計・神の手動実行・一括承認)。
        // 実行系は従来どおり岩戸ゲートを通り、承認ダイアログはスマホにも出る
        bulkRespond: (batchId, itemIds, approved) => operations.bulkRespond(batchId, itemIds, approved),
        drafts: async () => ({
          drafts: operations.listDrafts(),
          impacts: operations.impacts(),
          repos: (await operations.status()).repos,
        }),
        draftUpdate: (id, patch) => operations.updateDraft(id, patch),
        draftRelease: (draftId, repo, tag) => operations.requestRelease(draftId, repo, tag),
        draftZennArticle: (draftId) => operations.requestZennArticle(draftId),
        clockUpdate: (id, patch) => operations.updateClock(id, patch),
        godRun: (godId) => operations.runGodNow(godId),
      },
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
