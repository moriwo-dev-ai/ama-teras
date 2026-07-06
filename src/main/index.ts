import { app, BrowserWindow } from 'electron';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname as pathDirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginBootWithSentinel, markBootHealthy } from './evolution/sentinel';
import { getPluginCacheDir, getPluginsDir, registerIpcHandlers, type RuntimeFlags } from './ipc';
import { ToolRegistry } from './tools/registry';
import { migrateUserData } from './userDataMigration';

const dirname = fileURLToPath(new URL('.', import.meta.url));

// パッケージ版では esbuild のネイティブバイナリが asar 外(app.asar.unpacked)に
// 展開されるが、esbuild 本体は asar 内パスを見に行き ENOENT になる。
// ESBUILD_BINARY_PATH で展開先を明示する(プラグインの実行時トランスパイルに必須)。
if (app.isPackaged && !process.env['ESBUILD_BINARY_PATH']) {
  const binName = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  process.env['ESBUILD_BINARY_PATH'] = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    binName,
  );
}

/**
 * スモークモード: ウィンドウを開かずツールを1回実行して終了する。
 * 進化の検証ゲートが `MYCODEX_SMOKE=1 electron . --tool <name> --input <sample.json>` で使う。
 * ゲート内の実行はジョブ承認フローの一部なので、ここでは承認ダイアログを通さない。
 */
async function runSmokeMode(): Promise<void> {
  const finish = (ok: boolean, detail: Record<string, string>): void => {
    console.log(JSON.stringify({ smoke: true, ok, ...detail }));
    app.exit(ok ? 0 : 1);
  };

  try {
    const argv = process.argv;
    const toolIdx = argv.indexOf('--tool');
    const inputIdx = argv.indexOf('--input');
    const toolName = toolIdx >= 0 ? argv[toolIdx + 1] : undefined;
    const inputPath = inputIdx >= 0 ? argv[inputIdx + 1] : undefined;
    if (!toolName) return finish(false, { reason: '--tool <name> が必要' });

    const registry = new ToolRegistry(getPluginsDir(), getPluginCacheDir());
    await registry.reload();
    if (registry.errors.length > 0) {
      return finish(false, { reason: `プラグインロード失敗: ${JSON.stringify(registry.errors)}` });
    }
    const plugin = registry.get(toolName);
    if (!plugin) return finish(false, { reason: `ツールが見つからない: ${toolName}` });

    const input: unknown = inputPath ? JSON.parse(await readFile(inputPath, 'utf8')) : {};
    const result = await plugin.execute(input, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      log: () => {},
    });
    if (result.isError === true) {
      return finish(false, { reason: `ツールがエラーを返した: ${result.content.slice(0, 500)}` });
    }
    finish(true, { content: result.content.slice(0, 500) });
  } catch (err) {
    finish(false, { reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * M20: フルアプリ・スモーク起動(`MYCODEX_SMOKE=1 electron . --smoke-boot`)。
 * renderer/core 進化のゲート7(B worktree内)と昇格後の健全性チェック(A内)が使う。
 * 不変条件(ユーザー確定・2026-07-06):
 * - 単一インスタンスロックを取得しない(MYCODEX_SMOKE 配下の既存スキップに乗る。
 *   取得すると稼働中Aと衝突し、2つ目のインスタンスが即quitして偽の合否になる)
 * - userData は mkdtemp で隔離(下の smokeBoot 分岐で setPath 済み)。
 *   稼働中Aの config/secrets/リモートポートと一切衝突しない(新規configはremote無効が既定)
 * 検証内容: main配線(registerIpcHandlers)完走 → renderer読込 → Reactマウント確認 → exit 0
 */
async function runSmokeBoot(): Promise<void> {
  const finish = (ok: boolean, detail: Record<string, string>): void => {
    console.log(JSON.stringify({ smokeBoot: true, ok, ...detail }));
    app.exit(ok ? 0 : 1);
  };
  const watchdog = setTimeout(() => finish(false, { reason: 'タイムアウト(60s)' }), 60_000);
  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const services = await registerIpcHandlers(() => win.webContents);
    await win.loadFile(join(dirname, '../renderer/index.html'));
    // Reactマウント(#rootに子要素)を最大15秒ポーリング
    let mounted = false;
    for (let i = 0; i < 30; i++) {
      mounted = (await win.webContents.executeJavaScript(
        `document.getElementById('root') !== null && document.getElementById('root').children.length > 0`,
      )) as boolean;
      if (mounted) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    services.service.shutdown();
    await services.mcp.closeAll().catch(() => {});
    clearTimeout(watchdog);
    if (!mounted) return finish(false, { reason: 'rendererがマウントされない' });
    finish(true, { detail: 'main配線+rendererマウント成功' });
  } catch (err) {
    clearTimeout(watchdog);
    finish(false, { reason: err instanceof Error ? err.message : String(err) });
  }
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  // 整理3補: 非パッケージ実行(electron .)でもウィンドウ/タスクバーに自前アイコンを出す。
  // パッケージ版はexe埋め込み(electron-builder win.icon)が使われるため無くてもよい
  const appIcon = join(app.getAppPath(), 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    show: false,
    autoHideMenuBar: true,
    ...(existsSync(appIcon) ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));

  // electron-vite: devはdevサーバURL、本番はビルド済みhtml
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(dirname, '../renderer/index.html'));
  }
}

// M12-0: 多重起動ガード。同一userDataの多重起動はdisk cache競合を起こす。
// スモークモード(MYCODEX_SMOKE=1)では絶対にロックを取らない: 進化ゲートのスモークは
// 稼働中のAと並行してheadless起動するため、ロックすると進化パイプラインが壊れる
// (この不変条件は index.guard.test.ts で固定。変更時はそちらも見ること)。
const smokeMode = process.env['MYCODEX_SMOKE'] === '1';
// M20: フルアプリ・スモーク起動。MYCODEX_SMOKE 配下なので単一インスタンスロックは取得しない
const smokeBoot = smokeMode && process.argv.includes('--smoke-boot');

// M20: --smoke-boot は userData を一時ディレクトリへ隔離する(config/secrets/lock/ポート非干渉)。
// あらゆる読み書きより前(whenReady前)に setPath する必要がある
if (smokeBoot) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'amateras-smokeboot-')));
}

// M17-1: リネーム(mycodex → amateras)の userData 移行。config/secrets/sessions を読む
// あらゆる処理より前に、同期で1回だけ実行する(スモークは userData を使わないため対象外)
if (!smokeMode) {
  const newUserData = app.getPath('userData');
  const oldUserData = join(pathDirname(newUserData), 'mycodex');
  const result = migrateUserData(oldUserData, newUserData);
  if (result.migrated || result.reason === 'error') {
    console.log(`[migration] userData ${oldUserData} → ${newUserData}: ${result.reason} ${result.detail ?? ''}`);
  }
}

// タスクバーのグループ化IDを固定(未設定だと非パッケージ実行はElectron扱いでアイコンも既定になる)
app.setAppUserModelId('local.amateras.app');

const gotSingleInstanceLock = smokeMode ? true : app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  if (!smokeMode) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  void app.whenReady().then(async () => {
    if (smokeMode) {
      if (smokeBoot) await runSmokeBoot();
      else await runSmokeMode();
      return;
    }
    // M20: 再起動センチネル(進化の再起動後クラッシュ検知)。IPC配線より前に判定する。
    // 2回連続で完走前に死んでいたらセーフモード=進化機能を無効化して起動する
    const bootState = beginBootWithSentinel(app.getPath('userData'));
    const runtimeFlags: RuntimeFlags = {
      safeMode: bootState.safeMode,
      ...(bootState.safeMode && bootState.sentinel
        ? { safeModeInfo: { tag: bootState.sentinel.tag, prevCommit: bootState.sentinel.prevCommit } }
        : {}),
    };
    if (bootState.safeMode) {
      console.error(
        `[sentinel] セーフモード起動: ${bootState.sentinel?.tag} の再起動が2回連続で完走せず。` +
          `復旧: git reset --hard ${bootState.sentinel?.prevCommit} && npm run build`,
      );
    }
    const services = await registerIpcHandlers(() => mainWindow?.webContents ?? null, runtimeFlags);
    // M11-2: アプリ終了時にバックグラウンドプロセスを残さない。
    // M13-2: MCPサーバーの子プロセスも transport ごと全切断する
    app.on('will-quit', () => {
      services.service.shutdown();
      void services.mcp.closeAll();
    });
    createWindow();
    // M20: 起動完走(ウィンドウ表示)でセンチネルを消す=健全。ここに到達しない起動がクラッシュ扱い
    if (!bootState.safeMode) {
      mainWindow?.once('ready-to-show', () => {
        const done = markBootHealthy(app.getPath('userData'));
        if (done) {
          console.log(`[sentinel] 進化 ${done.tag} の再起動が完了`);
          runtimeFlags.restartedFrom = done.tag;
        }
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
