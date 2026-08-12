/**
 * M199: 成長実録の記録係(デタッチ常駐)
 * ①リングバッファ: 実行係に5分刻みで常時録画させ、直近4時間分だけ保持(古いwebmは削除)
 * ②瞬間検知: daemon.log / world-server.log を尾行し、面白い瞬間のマーカーを moments.jsonl に刻む
 *    (発見・あいさつ・テラ会話・知覚のつぶやき・訪問者入場・未来語系)
 * 抜粋・動画化・公開は人間+Claudeの仕事(公開は必ずオーナー承認)。
 * 起動: node scripts/moment-recorder.mjs (scripts/moment-start.mjs でデタッチ)
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync, watchFile } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8788';
const KEY = 'b711c9a8a2e00836dbee21429dd8f3cf1a83f14f2b18ba85';
const REC_DIR = 'C:/Users/haru-/AppData/Roaming/amateras/recordings';
const MOMENTS = join(REC_DIR, 'moments.jsonl');
const DAEMON_LOG = 'C:/dev/mycodex/lifeform/memory/daemon.log';
const WORLD_LOG = 'C:/Users/haru-/AppData/Roaming/amateras/world-server.log';
const SEGMENT_MS = 5 * 60 * 1000; // 5分刻み
const KEEP_MS = 4 * 60 * 60 * 1000; // 直近4時間だけ保持(3Mbps≒110MB/5分→約5GB上限)
const BPS = 3_000_000;

mkdirSync(REC_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function act(cmds) {
  const r = await fetch(`${BASE}/api/world/act?k=${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmds }), signal: AbortSignal.timeout(30_000),
  });
  return r.json();
}

// ---- ①リングバッファ ----
let running = true;
async function ringLoop() {
  // 実行係の再起動直後などで録画が残留していたら一度止める(エラーは無視)
  await act([{ type: 'record', op: 'stop' }]).catch(() => {});
  while (running) {
    try {
      const st = await act([{ type: 'record', op: 'start', bps: BPS }]);
      if (st.ok !== true) { log('録画開始できず:', st.detail ?? ''); await sleep(30_000); continue; }
      await sleep(SEGMENT_MS);
      const sp = await act([{ type: 'record', op: 'stop' }]);
      if (sp.ok !== true) log('録画停止できず:', sp.detail ?? '');
    } catch (e) {
      log('リング異常(30秒後に再開):', String(e).slice(0, 80));
      await sleep(30_000);
      await act([{ type: 'record', op: 'stop' }]).catch(() => {});
    }
    prune();
  }
}
function prune() {
  try {
    const now = Date.now();
    for (const f of readdirSync(REC_DIR)) {
      if (!f.startsWith('rec-') || !f.endsWith('.webm')) continue;
      const p = join(REC_DIR, f);
      if (now - statSync(p).mtimeMs > KEEP_MS) { unlinkSync(p); log('古い録画を削除:', f); }
    }
  } catch { /* noop */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ②瞬間検知(ログ尾行) ----
// 理由ラベル: 何が面白いのかを一言で(後で人間+Claudeが抜粋の判断に使う)
const TRIGGERS = [
  [/発見: (.+)/, '初発見'],
  [/行動\[あいさつ:(.+?)\]/, 'あいさつ'],
  [/テラに届いた: (.+?) →/, 'テラへの声'],
  [/行動\[知覚のつぶやき:(.+?)\]/, '知覚のつぶやき'],
  [/行動\[つかったつぶやき:(.+?)\]/, 'アプリで遊んだ'],
  [/訪問者が入場: (.+)/, '訪問者'],
  [/立ち見客が入場: (.+)/, '観客'],
  [/行動\[起床/, '起床'],
  [/行動\[就寝/, '就寝'],
  [/眠りの統合おわり/, '統合完了'],
];
function markMoment(reason, detail, src) {
  const rec = { ts: new Date().toISOString(), reason, detail: String(detail).slice(0, 120), src };
  appendFileSync(MOMENTS, JSON.stringify(rec) + '\n');
  log(`✦ 瞬間: [${reason}] ${rec.detail}`);
}
function tail(file, src) {
  let pos = 0;
  try { pos = statSync(file).size; } catch { /* まだ無い */ }
  watchFile(file, { interval: 2000 }, () => {
    try {
      const size = statSync(file).size;
      if (size < pos) pos = 0; // ローテート/作り直し
      if (size === pos) return;
      const buf = Buffer.alloc(size - pos);
      const fd = openSync(file, 'r');
      readSync(fd, buf, 0, buf.length, pos);
      closeSync(fd);
      pos = size;
      for (const line of buf.toString('utf8').split('\n')) {
        for (const [re, reason] of TRIGGERS) {
          const m = re.exec(line);
          if (m !== null) { markMoment(reason, m[1] ?? line.trim(), src); break; }
        }
      }
    } catch { /* 次のtickで */ }
  });
}

log('記録係 起動(リング5分×4時間・検知2秒毎)');
tail(DAEMON_LOG, 'daemon');
tail(WORLD_LOG, 'world');
void ringLoop();
process.on('SIGTERM', async () => { running = false; await act([{ type: 'record', op: 'stop' }]).catch(() => {}); process.exit(0); });
