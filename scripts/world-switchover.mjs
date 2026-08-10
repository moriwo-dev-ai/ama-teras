#!/usr/bin/env node
/**
 * M173(C工事3/3): 世界の引っ越しスクリプト — 内蔵世界 → world-server(分離世界)への切替。
 *
 * やること:
 *  1. 合鍵(proxy key)を生成し userData/world-server.json に書く(アプリが次回起動で分離モードに入る)
 *  2. world-server を独立プロセスとして起動(現行の world-state.json / world-apps をそのまま所有)
 *  3. 案内を表示(アプリとデーモンの再起動は人間/Claudeが行う=断絶はこの1回だけ)
 *
 * 戻し方: userData/world-server.json を消してアプリ再起動(内蔵世界に戻る)
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

const USERDATA = process.env.AMATERAS_USERDATA ?? join(process.env.APPDATA ?? '', 'amateras');
const REPO = resolve(import.meta.dirname, '..');
const PORT = 8788;
const CDP = 9226;

if (!existsSync(join(USERDATA, 'world-state.json'))) {
  console.error(`world-state.json が見つからない: ${USERDATA}`);
  process.exit(1);
}

// 1. 合鍵(既存があれば再利用=アプリ再起動不要で再実行できる)
const cfgPath = join(USERDATA, 'world-server.json');
let key;
try {
  key = JSON.parse(readFileSync(cfgPath, 'utf8')).key;
  if (typeof key !== 'string' || key === '') throw new Error('bad');
  console.log('合鍵: 既存を再利用');
} catch {
  key = randomBytes(24).toString('hex');
  console.log('合鍵: 新規生成');
}
writeFileSync(cfgPath, JSON.stringify({ url: `http://127.0.0.1:${PORT}`, key }, null, 1));
console.log(`書込: ${cfgPath}`);

// 2. world-server 起動(detached=このスクリプトやClaudeセッションが死んでも生き続ける)
const args = [
  join(REPO, 'out', 'main', 'world-server.js'),
  '--state', join(USERDATA, 'world-state.json'),
  '--apps', join(USERDATA, 'world-apps'),
  '--static', join(REPO, 'out', 'remote-ui'),
  '--port', String(PORT),
  '--cdp', String(CDP),
  '--proxy-key', key,
  '--app-job', `http://127.0.0.1:8787/api/world/job?k=${key}`,
  '--public-port', '8790', // M174: 公開観戦面(トンネルの向け先。URL公開はオーナー承認制)
  '--visitors', join(USERDATA, 'world-visitors.json'), // M175: 招待名簿(world-invite.mjsで追加)
];
const logPath = join(USERDATA, 'world-server.log');
const { openSync } = await import('node:fs');
const out = openSync(logPath, 'a');
const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] });
child.unref();
console.log(`world-server起動 pid=${child.pid} port=${PORT} cdp=${CDP}`);
console.log(`ログ: ${logPath}`);
console.log('\n次の手順(断絶はこの1回だけ):');
console.log(' 1. アプリを再起動 → [world] 分離世界モード のログを確認');
console.log(' 2. ヒナタデーモンを再起動 → 接続先が world-server(8788) になる');
console.log(' 3. スマホの世界ページをリロード');
