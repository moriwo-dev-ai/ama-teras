#!/usr/bin/env node
/**
 * AI生命体デーモン v0.1 (b案 P1: 生きてる感 — LLM不要層)
 *
 * 別プロセスとして世界に「もう一人の意思」を宿す。
 *  - 知覚: 観戦SSE /api/world/spectate (ループバック・読み取り専用)
 *  - 行動: POST /api/world/command?k=実行キー (say/motion/move_to/face のみ許可)
 *  - 欲求: {好奇心, 退屈, 社交欲, 元気} が時間と出来事で変動し、行動を選ぶ
 *  - 調停: エージェント(思考層)が稼働中は身体を譲る = 世界が静かな時だけ動く
 *
 * 起動: node lifeform/hinata-daemon.mjs [--port 8787] [--key XXXX]
 *  省略時は CDP(127.0.0.1:9225) から実行係ページのURLを見つけて port/key を自動発見。
 * 依存ゼロ(素のNode 18+)。c案で独立パッケージ化する際の核になる。
 */

const ARGS = process.argv.slice(2);
function arg(name) {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 ? ARGS[i + 1] : undefined;
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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

// ---------- 欲求システム(コードで実装 = 意思の土台。LLMはまだ使わない) ----------
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

  // 調停状態: 思考層(エージェント)や人間の気配があるあいだは身体を譲る
  let lastAgentBusyAt = 0;   // chat:event(tool実行など) = エージェント稼働中
  let lastWorldCmdAt = 0;    // world:event = 誰かがいま世界を動かした(自分の分も含む)
  let lastOwnActAt = 0;      // 自分が出したコマンド(world:eventの自分エコーを区別する近似)
  let lastMurmurAt = 0;
  let lastReflexAt = 0;
  let sentThisMinute = 0;
  setInterval(() => { sentThisMinute = 0; }, 60_000);

  async function act(cmds, label) {
    if (sentThisMinute >= 6) return; // 暴走防止の上限
    sentThisMinute++;
    lastOwnActAt = Date.now();
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
    if (event !== 'world:event') return;
    const own = now - lastOwnActAt < 3000; // 直近の自分の行動エコーは「他者の気配」に数えない
    if (!own) lastWorldCmdAt = now;
    for (const c of data.cmds ?? []) {
      // 反射層: 視聴者コメント = 社交欲スパイク + 即時リアクション(モーションのみ・30秒に1回)
      if (c.type === 'live_comment') {
        drives.social = clamp(drives.social + 0.4);
        drives.curiosity = clamp(drives.curiosity + 0.1);
        if (now - lastReflexAt > 30_000) {
          lastReflexAt = now;
          setTimeout(() => act([{ type: 'motion', name: 'clap' }], '反射:コメント歓迎'), 600);
        }
      }
      // 世界に何か生えた → 好奇心
      if (c.type === 'spawn' || c.type === 'app_add') drives.curiosity = clamp(drives.curiosity + 0.25);
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

  const heartbeat = () => {
    const now = Date.now();
    const agentQuiet = now - lastAgentBusyAt > 90_000; // 思考層が90秒静かなら身体は空いている
    const worldQuiet = now - lastWorldCmdAt > 20_000;
    if (agentQuiet && worldQuiet) {
      const cmds = chooseBehavior();
      if (cmds !== null) {
        // 独り言はさらに間引く(10分に1回まで)
        const isSay = cmds.some((c) => c.type === 'say');
        if (!isSay || now - lastMurmurAt > 600_000) {
          if (isSay) lastMurmurAt = now;
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

  log('生命体デーモン起動(P1: 反射層+欲求+アイドル行動)。Ctrl+Cで停止');
}

main().catch((e) => { console.error('起動失敗:', e.message); process.exit(1); });
