/**
 * 目(視覚・M149)。実行係ページのスクリーンショットをCDP(9225)経由で撮り、
 * ローカルの視覚対応モデル(gemma3:4b)で「見た目」を言葉にする。
 * 数秒かかる+計算が重いので、常用せず「じっと見る」という特別な行為としてだけ使う。
 * 全てループバック内で完結(外部送信なし)。
 */

export async function lookAtWorld(question) {
  let img = null;
  try {
    const list = await (await fetch('http://127.0.0.1:9225/json/list', { signal: AbortSignal.timeout(3000) })).json();
    const page = list.find((p) => (p.url ?? '').includes('executor=1'));
    if (page === undefined) return null;
    img = await new Promise((resolve) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* 既に閉 */ } resolve(null); }, 15_000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 70 } })));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(timer); try { ws.close(); } catch { /* noop */ } resolve(m.result?.data ?? null); }
      });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
    });
  } catch { return null; }
  if (img === null) return null;
  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma3:4b',
        stream: false,
        keep_alive: '3h',
        options: { temperature: 0.7, num_predict: 80 },
        messages: [{ role: 'user', content: question, images: [img] }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const text = ((await res.json()).message?.content ?? '').trim();
    return text === '' ? null : text.slice(0, 120);
  } catch {
    return null;
  }
}
