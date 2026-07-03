import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpcHandlers } from './ipc';

const dirname = fileURLToPath(new URL('.', import.meta.url));

// スモークモード: ウィンドウを開かずツールを1回実行して終了する(進化ゲートが使う)。
// M1では分岐だけ用意し、プラグイン基盤(M2)導入後に実行本体を実装する。
async function runSmokeMode(): Promise<never> {
  console.log(JSON.stringify({ smoke: true, ok: false, reason: 'tools not implemented yet (M2)' }));
  app.exit(1);
  throw new Error('unreachable');
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

void app.whenReady().then(() => {
  if (process.env['MYCODEX_SMOKE'] === '1') {
    void runSmokeMode();
    return;
  }
  registerIpcHandlers(() => mainWindow?.webContents ?? null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
