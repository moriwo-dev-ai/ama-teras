/**
 * M203: PC起動時の全系統自動立ち上げ(冪等=既に動いているものはスキップ)
 * 順序: VOICEVOX → world-server → アプリ → ヒナタのデーモン → 記録係 → トンネル
 * トンネル: ~/.cloudflared/config.yml があれば恒久トンネル(world.ama-teras.dev)、
 *           無ければquick tunnel(URLは tools/tunnel-url.txt に書き出す)
 * 登録: スタートアップフォルダの ama-teras-startup.vbs から起動される(コンソール非表示)
 * 手動実行: node scripts/startup-all.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import net from 'node:net';

const KEY = 'b711c9a8a2e00836dbee21429dd8f3cf1a83f14f2b18ba85';
const LOG = 'C:/dev/mycodex/tools/startup.log';
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); try { appendFileSync(LOG, line + '\n'); } catch { /* noop */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1', timeout: 1500 });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.on('timeout', () => { s.destroy(); resolve(false); });
});

const processRunning = (pattern) => {
  try {
    const out = execSync(
      `powershell -Command "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' } | Measure-Object).Count"`,
      { encoding: 'utf8' },
    ).trim();
    return Number(out) > 0;
  } catch { return false; }
};

const detach = (cmd, args, logPath, cwd) => {
  const fd = openSync(logPath, 'a');
  const p = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd], ...(cwd ? { cwd } : {}) });
  p.unref();
  return p.pid;
};

log('=== 起動シーケンス開始 ===');

// ① VOICEVOX(ヒナタの声)
if (await portOpen(50021)) log('VOICEVOX: 稼働中(スキップ)');
else log(`VOICEVOX: 起動 pid=${detach('C:/Users/haru-/AppData/Local/Programs/voicevox-engine/windows-cpu/run.exe', [], 'C:/dev/mycodex/tools/voicevox.log', 'C:/Users/haru-/AppData/Local/Programs/voicevox-engine/windows-cpu')}`);

// ② world-server(世界の心臓+実行係)
if (await portOpen(8788)) log('world-server: 稼働中(スキップ)');
else {
  log(`world-server: 起動 pid=${detach(process.execPath, [
    'C:/dev/mycodex/out/main/world-server.js',
    '--state', 'C:/Users/haru-/AppData/Roaming/amateras/world-state.json',
    '--apps', 'C:/Users/haru-/AppData/Roaming/amateras/world-apps',
    '--static', 'C:/dev/mycodex/out/remote-ui',
    '--port', '8788', '--cdp', '9226',
    '--proxy-key', KEY,
    '--app-job', `http://127.0.0.1:8787/api/world/job?k=${KEY}`,
    '--public-port', '8790',
    '--visitors', 'C:/Users/haru-/AppData/Roaming/amateras/world-visitors.json',
  ], 'C:/Users/haru-/AppData/Roaming/amateras/world-server.log')}`);
  await sleep(6000);
}

// ③ アプリ(テラの頭脳・リモートUI)
if (await portOpen(8787)) log('アプリ: 稼働中(スキップ)');
else { log(`アプリ: 起動 pid=${detach('C:/dev/mycodex/node_modules/electron/dist/electron.exe', ['.', '--remote-debugging-port=9225'], 'C:/dev/mycodex/tools/app.log', 'C:/dev/mycodex')}`); await sleep(8000); }

// ④ ヒナタのデーモン(単独性ロックあり=二重起動しても安全)
if (processRunning('hinata-daemon')) log('デーモン: 稼働中(スキップ)');
else log(`デーモン: 起動 pid=${detach(process.execPath, ['C:/dev/mycodex/lifeform/hinata-daemon.mjs'], 'C:/dev/mycodex/lifeform/memory/daemon.log')}`);

// ⑤ 記録係(リング録画+瞬間検知)
if (processRunning('moment-recorder')) log('記録係: 稼働中(スキップ)');
else log(`記録係: 起動 pid=${detach(process.execPath, ['C:/dev/mycodex/scripts/moment-recorder.mjs'], 'C:/Users/haru-/AppData/Roaming/amateras/recordings/recorder.log')}`);

// ⑥ トンネル(恒久 or 仮)
if (processRunning('cloudflared.exe.*tunnel')) log('トンネル: 稼働中(スキップ)');
else if (existsSync('C:/Users/haru-/.cloudflared/config.yml')) {
  log(`トンネル: 恒久(world.ama-teras.dev)起動 pid=${detach('C:/dev/mycodex/tools/cloudflared.exe', ['tunnel', 'run', 'ama-world'], 'C:/dev/mycodex/tools/cloudflared.log')}`);
} else {
  log(`トンネル: 仮(quick)起動 pid=${detach('C:/dev/mycodex/tools/cloudflared.exe', ['tunnel', '--url', 'http://127.0.0.1:8790'], 'C:/dev/mycodex/tools/cloudflared.log')}`);
  await sleep(12_000);
  try {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(readFileSync('C:/dev/mycodex/tools/cloudflared.log', 'utf8'));
    if (m !== null) {
      appendFileSync('C:/dev/mycodex/tools/tunnel-url.txt', `${new Date().toISOString()} ${m[0]}\n`);
      log(`トンネルURL: ${m[0]} (仮URL=変わったのでYouTube概要欄の差し替えが必要)`);
    }
  } catch { /* noop */ }
}

log('=== 起動シーケンス完了 ===');
