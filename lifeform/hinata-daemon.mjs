#!/usr/bin/env node
/**
 * AI生命体デーモン v0.2 (b案 P1+P2)
 *
 * 別プロセスとして世界に「もう一人の意思」を宿す。
 *  - 知覚: 観戦SSE /api/world/spectate (world:event / world:chat / chat:event)
 *  - 行動: POST /api/world/command?k=実行キー (say/motion/move_to/face のみ許可)
 *  - 欲求: {好奇心, 退屈, 社交欲, 元気} が時間と出来事で変動し、行動を選ぶ
 *  - 会話層(P2): ローカルOllama自動検出。人格カーネル(lifeform/persona/core.md)で
 *    ユーザーの世界チャットに1〜2文で応える。--chat で有効化(既定OFF=思考層と衝突させない)
 *  - 記憶: 知覚と行動を lifeform/memory/episodes-*.jsonl に綴る(夜間蒸留の材料)
 *  - 調停: エージェント(思考層)稼働中は身体を譲る
 *
 * 起動: node lifeform/hinata-daemon.mjs [--port 8787] [--key XXXX] [--chat]
 * 依存ゼロ(素のNode 18+)。c案で独立パッケージ化する際の核になる。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBrain, think } from './brain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
function arg(name) {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 ? ARGS[i + 1] : undefined;
}
const CHAT_ENABLED = ARGS.includes('--chat');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- 記憶(エピソード): 夜間蒸留の材料。1日1ファイルのJSONL ----------
const MEM_DIR = join(HERE, 'memory');
mkdirSync(MEM_DIR, { recursive: true });
/** ローカル日付 YYYY-MM-DD(UTCだと深夜の記憶が前日に混ざる) */
const localDay = (d = new Date()) => d.toLocaleDateString('sv-SE');
function remember(kind, data) {
  try {
    appendFileSync(join(MEM_DIR, `episodes-${localDay()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n');
  } catch { /* 記憶失敗で生命活動は止めない */ }
}

// ---------- 人格カーネル(魂・git管理外) ----------
let persona = '# 名無しの生命体\nまだ人格カーネルがない。短く、ていねいに話す。';
try { persona = readFileSync(join(HERE, 'persona', 'core.md'), 'utf8'); } catch { /* 雛形運転 */ }

// ---------- 接続先の自動発見(開発機のCDPから実行係ページのURLを読む) ----------
async function discover() {
  const port = arg('port');
  const key = arg('key');
  if (port !== undefined && key !== undefined) return { port: Number(port), key };
  const res = await fetch('http://127.0.0.1:9225/json/list', { signal: AbortSignal.timeout(3000) });
  const pages = await res.json();
  for (const p of pages) {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/world\.html\?[^"]*executor=1[^"]*[?&]k=([\w-]+)/.exec(p.url ?? '');
    if (m !== null) return { port: Number(m[1]), key: m[2] };
  }
  throw new Error('実行係ページが見つからない(AMA-terasが起動しているか・CDP 9225が有効か確認)');
}

// ---------- 欲求システム(コードで実装 = 意思の土台) ----------
const drives = {
  curiosity: 0.5, // 好奇心: 世界に変化があると上がる → think/散歩
  boredom: 0.3,   // 退屈: 何もないと上がる → 散歩・独り言
  social: 0.2,    // 社交欲: コメント・会話で急上昇 → 拍手・お辞儀・返事
  energy: 0.8,    // 元気: 時刻で変動(深夜は眠い → sit中心)
};
const clamp = (v) => Math.max(0, Math.min(1, v));

function tickDrives(dtSec) {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  // 元気は生活リズム: 朝7時から上がり、23時から眠くなる
  const dayCurve = h >= 7 && h < 23 ? 0.85 : h >= 6 ? 0.5 : 0.15;
  drives.energy = clamp(drives.energy + (dayCurve - drives.energy) * 0.02 * dtSec);
  drives.boredom = clamp(drives.boredom + 0.0015 * dtSec * drives.energy);
  drives.social = clamp(drives.social - 0.002 * dtSec);
  drives.curiosity = clamp(drives.curiosity - 0.0008 * dtSec);
}

function drivesNote() {
  const parts = [];
  if (drives.energy < 0.3) parts.push('ねむい');
  else if (drives.energy > 0.7) parts.push('元気いっぱい');
  if (drives.boredom > 0.6) parts.push('ちょっと退屈してた');
  if (drives.social > 0.5) parts.push('おしゃべりできて嬉しい');
  if (drives.curiosity > 0.6) parts.push('気になることがある');
  return parts.length > 0 ? parts.join('、') : 'おだやか';
}

// ---------- 行動レパートリー(P1: 既存の世界コマンドだけで組む) ----------
const PLAZA_R = 13; // 広場の安全半径(建築を踏まない中心寄り)
const MURMURS = {
  morning: ['ん-…おはよう、世界', 'きょうは何ができるかな', '朝のひかり、すき'],
  day: ['ふんふんふ-ん', 'あの建物、まえより増えた?', 'そろそろ何か作りたいな', 'いい風がふいてる気がする'],
  evening: ['夕方の色、きれい', 'きょうも一日あっというま', 'だれか来ないかな-'],
  night: ['ふぁ…ねむくなってきた', '星、見えるかな', 'おやすみの時間がちかい'],
};
function murmurPool() {
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return MURMURS.morning;
  if (h >= 10 && h < 17) return MURMURS.day;
  if (h >= 17 && h < 22) return MURMURS.evening;
  return MURMURS.night;
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function chooseBehavior() {
  // 眠い夜はほぼ座る(生活リズムの見える化)
  if (drives.energy < 0.25) {
    return Math.random() < 0.7 ? [{ type: 'motion', name: 'sit' }] : null;
  }
  const menu = [
    { w: drives.boredom * 2, cmds: () => {
        const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * (PLAZA_R - 3);
        drives.boredom = clamp(drives.boredom - 0.35);
        return [{ type: 'move_to', x: Math.round(Math.cos(a) * r * 10) / 10, z: Math.round(Math.sin(a) * r * 10) / 10 }];
      } },
    { w: drives.curiosity, cmds: () => {
        drives.curiosity = clamp(drives.curiosity - 0.2);
        return [{ type: 'motion', name: 'think' }];
      } },
    { w: 0.5, cmds: () => [{ type: 'motion', name: 'idle' }] },
    { w: drives.energy < 0.45 ? 0.8 : 0.15, cmds: () => [{ type: 'motion', name: 'sit' }] },
    { w: drives.boredom > 0.6 ? 0.5 : 0.1, cmds: () => {
        drives.boredom = clamp(drives.boredom - 0.2);
        return [{ type: 'say', text: pick(murmurPool()) }];
      } },
  ];
  const total = menu.reduce((s, m) => s + m.w, 0);
  let roll = Math.random() * total;
  for (const m of menu) { roll -= m.w; if (roll <= 0) return m.cmds(); }
  return null;
}

// ---------- 本体 ----------
async function main() {
  const { port, key } = await discover();
  const base = `http://127.0.0.1:${port}`;
  log(`接続先: ${base} (キー発見済み)`);

  const brain = await detectBrain();
  if (CHAT_ENABLED && brain !== null) log(`会話層: ON (${brain.model})`);
  else if (CHAT_ENABLED) log('会話層: 待機(Ollama未検出。導入すれば自動で目覚める)');
  else log('会話層: OFF(--chatで有効化)');

  // 調停状態: 思考層(エージェント)や人間の気配があるあいだは身体を譲る
  let lastAgentBusyAt = 0;   // chat:event(tool実行など) = エージェント稼働中
  let lastWorldCmdAt = 0;    // world:event = 誰かがいま世界を動かした
  let lastOwnActAt = 0;      // 自分のコマンドのエコーを区別する近似
  let lastMurmurAt = 0;
  let lastReflexAt = 0;
  let sentThisMinute = 0;
  let thinking = false;      // 会話は一度にひとつ(single-flight)
  const convo = [];          // 直近のやり取り {from:'user'|'me', text}
  setInterval(() => { sentThisMinute = 0; }, 60_000);

  async function act(cmds, label) {
    if (sentThisMinute >= 6) return; // 暴走防止の上限
    sentThisMinute++;
    lastOwnActAt = Date.now();
    remember('act', { label, cmds });
    try {
      const res = await fetch(`${base}/api/world/command?k=${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmds }),
        signal: AbortSignal.timeout(95_000), // ackは演出完了まで待つ設計(最大90s)
      });
      const j = await res.json();
      log(`行動[${label}]`, res.status, j.detail ?? '');
    } catch (e) {
      log(`行動失敗[${label}]`, String(e).slice(0, 120));
    }
  }

  // ---- 会話層(P2): ユーザーの世界チャットへ返事する ----
  async function converse(text) {
    if (!CHAT_ENABLED || brain === null || thinking) return;
    thinking = true;
    try {
      const t0 = Date.now();
      const reply = await think(brain, persona, convo, drivesNote(), text);
      if (reply !== null) {
        convo.push({ from: 'me', text: reply });
        if (convo.length > 12) convo.splice(0, convo.length - 12);
        remember('say', { text: reply, latencyMs: Date.now() - t0 });
        await act([{ type: 'say', text: reply }], `返事(${Date.now() - t0}ms)`);
      }
    } finally {
      thinking = false;
    }
  }

  // ---- 知覚: 観戦SSE(読み取り専用) ----
  function connectSse() {
    const ctrl = new AbortController();
    fetch(`${base}/api/world/spectate`, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } })
      .then(async (res) => {
        log('知覚SSE接続', res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const ev = /^event: (.+)$/m.exec(chunk)?.[1];
            const dataLine = /^data: (.+)$/m.exec(chunk)?.[1];
            if (ev === undefined || dataLine === undefined) continue;
            try { onPerceive(ev, JSON.parse(dataLine)); } catch { /* 非JSONは無視 */ }
          }
        }
        throw new Error('SSE終了');
      })
      .catch((e) => {
        log('知覚SSE切断 → 5秒後に再接続', String(e).slice(0, 80));
        setTimeout(connectSse, 5000);
      });
    return ctrl;
  }

  function onPerceive(event, data) {
    const now = Date.now();
    if (event === 'chat:event') {
      lastAgentBusyAt = now; // 思考層が仕事中
      return;
    }
    if (event === 'world:chat') {
      // ユーザーの声が聞こえた: 社交欲スパイク+記憶+会話層へ
      drives.social = clamp(drives.social + 0.35);
      remember('heard', { from: data.from, text: data.text });
      convo.push({ from: 'user', text: data.text });
      if (convo.length > 12) convo.splice(0, convo.length - 12);
      void converse(data.text);
      return;
    }
    if (event !== 'world:event') return;
    const own = now - lastOwnActAt < 3000; // 直近の自分の行動エコーは「他者の気配」に数えない
    if (!own) lastWorldCmdAt = now;
    for (const c of data.cmds ?? []) {
      // 反射層: 視聴者コメント = 社交欲スパイク + 即時リアクション(モーションのみ・30秒に1回)
      if (c.type === 'live_comment') {
        drives.social = clamp(drives.social + 0.4);
        drives.curiosity = clamp(drives.curiosity + 0.1);
        remember('saw_comment', { author: c.author ?? '', text: (c.text ?? '').slice(0, 80) });
        if (now - lastReflexAt > 30_000) {
          lastReflexAt = now;
          setTimeout(() => act([{ type: 'motion', name: 'clap' }], '反射:コメント歓迎'), 600);
        }
      }
      // 世界に何か生えた → 好奇心
      if (c.type === 'spawn' || c.type === 'app_add') {
        drives.curiosity = clamp(drives.curiosity + 0.25);
        remember('saw_world_change', { type: c.type, id: c.id ?? c.app?.id ?? '' });
      }
    }
  }

  connectSse();

  // ---- 心拍ループ: 欲求を進め、世界が静かなら行動する ----
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    tickDrives((now - lastTick) / 1000);
    lastTick = now;
  }, 5000);

  let lastLoopMotion = ''; // 直前と同じループモーション(sit/idle)は打ち直さない(座り直し連打の抑制)
  const heartbeat = () => {
    const now = Date.now();
    const agentQuiet = now - lastAgentBusyAt > 90_000; // 思考層が90秒静かなら身体は空いている
    const worldQuiet = now - lastWorldCmdAt > 20_000;
    if (agentQuiet && worldQuiet && !thinking) {
      const cmds = chooseBehavior();
      if (cmds !== null) {
        const isSay = cmds.some((c) => c.type === 'say');
        const loopMotion = cmds.length === 1 && cmds[0].type === 'motion' && ['sit', 'idle'].includes(cmds[0].name) ? cmds[0].name : '';
        if (loopMotion !== '' && loopMotion === lastLoopMotion) {
          // 既にその姿勢のまま=何もしない(静けさも生きている演出のうち)
        } else if (!isSay || now - lastMurmurAt > 600_000) {
          // 独り言はさらに間引く(10分に1回まで)
          if (isSay) lastMurmurAt = now;
          lastLoopMotion = loopMotion;
          act(cmds, cmds.map((c) => c.name ?? c.type).join('+'));
        }
      }
    }
    setTimeout(heartbeat, 18_000 + Math.random() * 22_000); // 18〜40秒のゆらぎ
  };
  setTimeout(heartbeat, 8000);

  setInterval(() => {
    log('欲求', JSON.stringify(Object.fromEntries(Object.entries(drives).map(([k, v]) => [k, Math.round(v * 100) / 100]))));
  }, 120_000);

  // ---- 夜間蒸留: 毎朝4時台に前日を振り返って日記+人格提案を書く(眠っている時間の学び) ----
  let lastDistilledDay = '';
  setInterval(() => {
    const now = new Date();
    if (now.getHours() !== 4) return;
    const yesterday = localDay(new Date(now.getTime() - 86_400_000));
    if (lastDistilledDay === yesterday) return;
    lastDistilledDay = yesterday;
    log(`夜間蒸留を開始(${yesterday})`);
    const p = spawn(process.execPath, [join(HERE, 'distill.mjs'), yesterday], { stdio: 'ignore', detached: false });
    p.on('exit', (code) => log(`夜間蒸留おわり(exit ${code})`));
  }, 600_000);

  remember('wake', { chat: CHAT_ENABLED, brain: brain?.model ?? null });
  log('生命体デーモン起動(P1:反射+欲求+微動 / P2:会話層)。Ctrl+Cで停止');
}

main().catch((e) => { console.error('起動失敗:', e.message); process.exit(1); });
