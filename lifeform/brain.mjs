/**
 * 会話層の頭脳(b案P2)。ローカルOllama(http://127.0.0.1:11434)を自動検出して使う。
 * 未導入・未起動なら null を返し、デーモンは会話せず静かに暮らす(P1挙動のまま)。
 * ミッション整合: 企業APIに依存せず、自分の機体の上で人格が動く。
 */

const OLLAMA = 'http://127.0.0.1:11434';
/** 小型高速を優先(会話層は1〜3秒応答が命)。前方一致で先に見つかったものを使う */
// gemma3:4b が人格の一貫性で圧勝(2026-08-09 A/B実測: ため口維持・人格事実の正用・480〜590ms)
const PREFERRED = ['gemma3:4b', 'qwen3:4b', 'qwen2.5:3b', 'llama3.2:3b', 'gemma2:2b', 'qwen2.5:7b', 'gemma3', 'qwen', 'llama'];

export async function detectBrain() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const names = ((await res.json()).models ?? []).map((m) => m.name);
    if (names.length === 0) return null;
    for (const p of PREFERRED) {
      const hit = names.find((n) => n.startsWith(p));
      if (hit !== undefined) return { kind: 'ollama', model: hit };
    }
    return { kind: 'ollama', model: names[0] };
  } catch {
    return null;
  }
}

/**
 * 返事を考える。persona=人格カーネル本文、recent=直近のやり取り[{from,text}]、
 * drivesNote=いまの気分の一言。失敗(タイムアウト等)は null(=黙る。壊れた返事より沈黙)
 */
export async function think(brain, persona, recent, drivesNote, userText) {
  const history = recent.slice(-6).map((m) => ({
    role: m.from === 'me' ? 'assistant' : 'user',
    content: m.text,
  }));
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: brain.model,
        stream: false,
        keep_alive: '3h', // モデル常駐=毎回の再ロード(約4秒)を避けて300〜800msを維持する
        options: { temperature: 0.9, num_predict: 100 },
        messages: [
          {
            role: 'system',
            content:
              `${persona}\n\n# いまの気分\n${drivesNote}\n\n` +
              '# ルール\n上の人格になりきって、日本語で1〜2文だけ返す。' +
              '敬語(です・ます)は絶対に使わない=いつもため口。' +
              '説明・注釈・絵文字・括弧書きは書かない。声に出して読まれる文だけを書く。',
          },
          ...history,
          { role: 'user', content: userText },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const text = ((await res.json()).message?.content ?? '').trim()
      .replace(/<think>[\s\S]*?<\/think>/g, '') // 思考タグ付きモデル対策
      .replace(/^["「]|["」]$/g, '')
      .trim();
    if (text === '' || text.length > 120) return text.slice(0, 120) || null;
    return text;
  } catch {
    return null;
  }
}
