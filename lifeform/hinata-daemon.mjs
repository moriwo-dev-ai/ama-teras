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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBrain, think } from './brain.mjs';
import { lookAtWorld } from './eyes.mjs';

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
// M148: 世界地理の知識(世界の端・目印・空のイベント)。会話とつぶやきの背景知識になる
try { persona += '\n\n' + readFileSync(join(HERE, 'persona', 'world-map.md'), 'utf8'); } catch { /* 地理なしでも生きられる */ }

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

let sleeping = false; // 就寝状態(深夜に元気が尽きると寝る。話しかけられたら寝ぼけて答える)

// M148(空間感覚): 直近の世界観察のキャッシュ。自分の位置と物の距離が「感覚」になる
const sense = { self: null, spots: [], at: 0 };

// M149(視野と発見): 人間らしさは「全知」ではなく「制限」から生まれる。
// 見えるのは半径8mだけ。見たものは記憶地図(known-world.json=人生をまたいで持続)に刻まれ、
// 探検の行き先は「知っている場所」だけになる。知らない物は歩き回って発見する(霧の晴れる世界)
const SIGHT_R = 8;
const KNOWN_PATH = join(MEM_DIR, 'known-world.json');
let known = {}; // name -> {x, z, seenAt}
try { known = JSON.parse(readFileSync(KNOWN_PATH, 'utf8')); } catch { /* 無知から始まる人生 */ }
function saveKnown() {
  try { writeFileSync(KNOWN_PATH, JSON.stringify(known, null, 1)); } catch { /* 保存失敗でも生きる */ }
}
function nearestSpot() {
  if (sense.self === null || sense.spots.length === 0) return null;
  let best = null, bd = Infinity;
  for (const s of sense.spots) {
    const d = Math.hypot(s.x - sense.self.x, s.z - sense.self.z);
    if (d < bd) { bd = d; best = s; }
  }
  return best !== null ? { ...best, d: bd } : null;
}

function drivesNote() {
  const h = new Date().getHours();
  const tod = h < 5 ? 'まよなか' : h < 10 ? 'あさ' : h < 17 ? 'おひる' : h < 22 ? 'ゆうがた' : 'よる';
  if (sleeping) return `いまは${tod}。ぐっすり寝ていたところを起こされた。寝ぼけていて、とてもねむい`;
  const parts = [];
  if (drives.energy < 0.3) parts.push('ねむい');
  else if (drives.energy > 0.7) parts.push('元気いっぱい');
  if (drives.boredom > 0.6) parts.push('ちょっと退屈してた');
  if (drives.social > 0.5) parts.push('おしゃべりできて嬉しい');
  if (drives.curiosity > 0.6) parts.push('気になることがある');
  // M148: 自己位置感覚(近くの目印)。「どこにいるの?」に実際の場所で答えられる
  const ns = nearestSpot();
  if (ns !== null && ns.d < 7) parts.push(`いま「${ns.name}」のちかくにいる`);
  return `いまは${tod}。` + (parts.length > 0 ? parts.join('、') : 'おだやか');
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
  let lastHearAt = 0;
  let sentThisMinute = 0;
  let thinking = false;      // 会話は一度にひとつ(single-flight)
  const convo = [];          // 直近のやり取り {from:'user'|'me', text}
  setInterval(() => { sentThisMinute = 0; }, 60_000);

  let walkedToday = 0; // M149(身体性): 歩けば疲れる。今日歩いた距離(m)
  async function act(cmds, label) {
    if (sentThisMinute >= 6) return; // 暴走防止の上限
    sentThisMinute++;
    lastOwnActAt = Date.now();
    // M149: 移動の身体コスト=距離に応じて元気が減る(遠出は「体力を使う判断」になる)
    for (const c of cmds) {
      if (c.type === 'move_to' && sense.self !== null && typeof c.x === 'number' && typeof c.z === 'number') {
        const d = Math.hypot(c.x - sense.self.x, c.z - sense.self.z);
        drives.energy = clamp(drives.energy - d * 0.004);
        walkedToday += d;
        sense.self = { ...sense.self, x: c.x, z: c.z }; // 歩いた先を自己位置感覚に即反映
      }
    }
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

  // ---- 探検(P3知覚拡張): 世界を「見て」、気になるものに会いに行く ----
  // チャットや反射(受け身の刺激)だけでなく、世界そのものが刺激になる=観察→興味→接近→感想。
  // 好奇心/退屈が高い時だけ発動。対象は実在の社・造形(ランダム地点の散歩とは別物)
  // M148/M149: 世界を「見る」— ただし全知ではない。視界(8m)に入った物だけ知覚し、
  // 記憶地図との差分(新発見・消失・移動)が「驚き」のイベントになる
  let lastSurpriseAt = 0;
  let lastGazeAt = 0;
  async function senseWorld() {
    try {
      const res = await fetch(`${base}/api/world/state?k=${key}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const obs = await res.json();
      const trueSpots = [];
      for (const a of obs.apps ?? []) trueSpots.push({ name: a.name, x: a.x, z: a.z });
      // 名前はラベル>ID>「名前の分からない何か」の順(customだけ渡すと頭脳が意味を取れない)
      for (const o of obs.state?.objects ?? []) {
        if (typeof o.x !== 'number' || typeof o.z !== 'number') continue;
        const nm = o.label ?? (typeof o.id === 'string' && !/^obj\d+$/.test(o.id) ? o.id : null);
        trueSpots.push({ name: nm ?? '名前の分からない何か', x: o.x, z: o.z });
      }
      sense.self = obs.state?.avatar ?? sense.self;
      sense.at = Date.now();
      const me = sense.self;
      if (me !== null) {
        const now = Date.now();
        const inSight = trueSpots.filter((s) => Math.hypot(s.x - me.x, s.z - me.z) <= SIGHT_R);
        const seenNames = new Set(trueSpots.map((s) => s.name));
        for (const s of inSight) {
          const k = known[s.name];
          if (k === undefined) {
            // 新発見! 好奇心スパイク+その場のリアクション(連発防止2分)
            known[s.name] = { x: s.x, z: s.z, seenAt: now };
            drives.curiosity = clamp(drives.curiosity + 0.3);
            remember('discovered', { name: s.name, x: s.x, z: s.z });
            log(`発見: ${s.name}`);
            if (!sleeping && now - lastSurpriseAt > 120_000) {
              lastSurpriseAt = now;
              void reactToDiscovery(s);
            }
          } else if (Math.hypot(s.x - k.x, s.z - k.z) > 2.5) {
            // 知っている物が動いてる!?
            known[s.name] = { x: s.x, z: s.z, seenAt: now };
            remember('saw_moved', { name: s.name });
            if (!sleeping && now - lastSurpriseAt > 120_000) {
              lastSurpriseAt = now;
              void act([{ type: 'say', text: `あれ?「${s.name}」、うごいてない?` }], '驚き:移動');
            }
          } else {
            known[s.name].seenAt = now;
          }
        }
        // 消失の目撃: 「あった場所」が視界内なのに世界から無くなっている時だけ気づく
        // (視界の外の消失には気づかない=いない物を信じ続け、行ってみて驚く。人間と同じ勘違い)
        for (const [name, k] of Object.entries(known)) {
          if (!seenNames.has(name) && Math.hypot(k.x - me.x, k.z - me.z) <= SIGHT_R) {
            delete known[name];
            remember('saw_gone', { name });
            if (!sleeping && now - lastSurpriseAt > 120_000) {
              lastSurpriseAt = now;
              void act([{ type: 'say', text: `えっ、ここにあった「${name}」が…ない!` }], '驚き:消失');
            }
          }
        }
        saveKnown();
      }
      // 探検の行き先=知っている場所だけ(全知リストではなく、自分の足で作った地図)
      sense.spots = Object.entries(known).map(([name, k]) => ({ name, x: k.x, z: k.z }));
      return true;
    } catch { return false; /* 見えない時もある(サーバ再起動中など) */ }
  }
  // M149: 発見のリアクション。名前の分からない物には「じっと見る」(視覚=30分に1回まで)
  async function reactToDiscovery(s) {
    await act([{ type: 'face', x: s.x, z: s.z }, { type: 'say', text: `あっ、なにかある!「${s.name}」だ!` }], `発見:${s.name}`);
    if (s.name === '名前の分からない何か' && Date.now() - lastGazeAt > 1_800_000) {
      lastGazeAt = Date.now();
      await act([{ type: 'motion', name: 'think' }], 'じっと見る');
      const seen = await lookAtWorld('この3D世界の画面に写っている一番目立つ物の見た目を、6歳の子どもが言うみたいに日本語で短く一言だけ。');
      if (seen !== null) {
        remember('gazed', { about: s.name, seen });
        const line = await think(brain, persona, [], drivesNote(), `(じっと見たら、こう見えた:「${seen}」。それを自分の言葉でひとことつぶやいて)`);
        if (line !== null) await act([{ type: 'say', text: line }], '視覚のつぶやき');
      }
    }
  }
  setInterval(() => { void senseWorld(); }, 60_000); // 1分ごとに見回す(会話の場所感覚も新鮮に保つ)
  void senseWorld();

  let lastExploreAt = 0;
  let lastExploreSayAt = 0;
  async function explore() {
    const now = Date.now();
    if (sleeping || thinking) return;
    if (now - lastAgentBusyAt < 90_000 || now - lastWorldCmdAt < 20_000) return;
    if (drives.curiosity < 0.35 && drives.boredom < 0.5) return;
    if (now - lastExploreAt < 180_000) return;
    if (!(await senseWorld())) return;
    const reachable = sense.spots.filter((s) => Math.hypot(s.x, s.z) < 16.5);
    if (reachable.length === 0) return;
    // M148: 近いものほど気になる(重み=1/(1+距離))。ただし時々は遠出もする(重みの裾)
    const me = sense.self ?? { x: 0, z: 0 };
    const weighted = reachable.map((s) => ({ s, d: Math.hypot(s.x - me.x, s.z - me.z) }))
      .map((e) => ({ ...e, w: 1 / (1 + e.d * 0.35) }));
    const total = weighted.reduce((a, e) => a + e.w, 0);
    let roll = Math.random() * total;
    let pick = weighted[0];
    for (const e of weighted) { roll -= e.w; if (roll <= 0) { pick = e; break; } }
    const s = pick.s;
    lastExploreAt = now;
    drives.curiosity = clamp(drives.curiosity - 0.25);
    drives.boredom = clamp(drives.boredom - 0.3);
    remember('explore', { name: s.name, x: s.x, z: s.z, dist: +pick.d.toFixed(1) });
    // 対象の少し手前(広場中心寄り)に立つ=めり込み防止
    const d = Math.hypot(s.x, s.z) || 1;
    const tx = +(s.x - (s.x / d) * 1.6).toFixed(1);
    const tz = +(s.z - (s.z / d) * 1.6).toFixed(1);
    await act([{ type: 'move_to', x: tx, z: tz }], `探検:${s.name}(${pick.d.toFixed(0)}m先)`);
    if (sense.self !== null) { sense.self.x = tx; sense.self.z = tz; } // 歩いた分の自己位置感覚を即更新
    // 目の前のものへの感想(15分に1回まで。頭脳がない日は黙って眺める)
    if (brain !== null && Date.now() - lastExploreSayAt > 900_000) {
      const flavor = pick.d < 4 ? 'すぐそばにあった' : '少し歩いて見に来た';
      const line = await think(brain, persona, [], drivesNote(), `(${flavor}「${s.name}」の前にいる。それを見てのひとことだけつぶやいて)`);
      if (line !== null) {
        lastExploreSayAt = Date.now();
        remember('say', { text: line, about: s.name });
        await act([{ type: 'say', text: line }], '探検のつぶやき');
      }
    }
  }
  setInterval(() => { void explore(); }, 150_000 + Math.floor(Math.random() * 90_000));

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
      // M149(聴覚の空間化): 何かが建つ「音」には位置がある。近く(15m)なら音の方を振り向く
      // — 音が探索の入口になる(遠い音は気づかない=これも知覚の制限)
      if (c.type === 'spawn' || c.type === 'app_add') {
        drives.curiosity = clamp(drives.curiosity + 0.25);
        remember('saw_world_change', { type: c.type, id: c.id ?? c.app?.id ?? '' });
        const sx = c.x ?? c.app?.x, sz = c.z ?? c.app?.z;
        const me = sense.self;
        if (typeof sx === 'number' && typeof sz === 'number' && me !== null && !sleeping) {
          const d = Math.hypot(sx - me.x, sz - me.z);
          if (d < 15 && now - lastHearAt > 60_000) {
            lastHearAt = now;
            remember('heard_sound', { x: sx, z: sz, dist: +d.toFixed(1) });
            setTimeout(() => act([{ type: 'face', x: sx, z: sz }], '反射:音の方を見る'), 800);
          }
        }
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
    // 就寝/起床: 深夜(0〜6時)に元気が尽きたら寝る=行動が止まる(静けさそのものが睡眠の演出)。
    // 現アバターに寝転びモーションが無いため座り姿勢で眠る。専用モーション+目を閉じるはVRM後
    const h = new Date().getHours();
    const wantSleep = h < 6 && drives.energy < 0.22;
    if (!sleeping && wantSleep && agentQuiet && worldQuiet) {
      sleeping = true;
      remember('sleep', {});
      act([{ type: 'say', text: 'ふぁ…もうねむい…おやすみなさい…' }, { type: 'motion', name: 'sit' }], '就寝');
      lastLoopMotion = 'sit';
    } else if (sleeping && (h >= 6 || drives.energy > 0.5)) {
      sleeping = false;
      remember('wake_up', {});
      act([{ type: 'motion', name: 'idle' }, { type: 'say', text: 'ん…ふぁ…おはよう…' }], '起床');
      lastLoopMotion = '';
    }
    if (!sleeping && agentQuiet && worldQuiet && !thinking) {
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
    log('欲求', JSON.stringify(Object.fromEntries(Object.entries(drives).map(([k, v]) => [k, Math.round(v * 100) / 100]))),
      `記憶地図:${Object.keys(known).length}件 今日の歩行:${Math.round(walkedToday)}m`);
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
