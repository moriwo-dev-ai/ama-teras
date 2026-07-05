import { app, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginCacheDir, getPluginsDir, registerIpcHandlers } from './ipc';
import { ToolRegistry } from './tools/registry';

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

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    show: false,
    autoHideMenuBar: true,
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
      await runSmokeMode();
      return;
    }
    const services = await registerIpcHandlers(() => mainWindow?.webContents ?? null);
    // M11-2: アプリ終了時にバックグラウンドプロセスを残さない。
    // M13-2: MCPサーバーの子プロセスも transport ごと全切断する
    app.on('will-quit', () => {
      services.service.shutdown();
      void services.mcp.closeAll();
    });
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
