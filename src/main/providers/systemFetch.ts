/**
 * M88: **curl は通るのに、アプリだけ「Connection error.」で繋がらないPCがあった**。
 *
 * curl.exe は Windows の証明書ストア(=セキュリティソフトが入れたルート証明書も含む)と
 * システムのプロキシ設定を使う。一方 Node の fetch(undici)は **Nodeにバンドルされた
 * 証明書リストしか見ず、システムプロキシも読まない**。だから HTTPS を傍受する
 * セキュリティソフト(法人PCによくある)や社内プロキシがいると、curl は通るのに
 * アプリだけ TLS 検証で落ちる。SDKはその理由を伏せて "Connection error." としか言わない。
 *
 * Electron の net.fetch は Chromium のネットワークスタックを使う = **OSの証明書ストアと
 * システムプロキシに従う**。ブラウザで開けるものは、このアプリでも開ける。そこへ寄せる。
 *
 * (Electron が無い文脈 — ユニットテスト等 — では素の fetch に落ちる)
 */
import { createRequire } from 'node:module';

type FetchLike = typeof fetch;

let cached: FetchLike | undefined;
let usingElectron = false;

export function systemFetch(): FetchLike {
  if (cached !== undefined) return cached;
  const viaElectron = loadElectronFetch();
  usingElectron = viaElectron !== undefined;
  cached = viaElectron ?? fetch;
  return cached;
}

/**
 * どの経路で喋っているのかを名乗る。**繋がったからといって net.fetch を使えているとは限らない**
 * (読み込みに失敗しても素の fetch に落ちて繋がってしまうため、こちらの環境では区別できない)。
 * 接続テストに出して、配布版で実際にOSのネットワークスタックに乗っているかを確かめられるようにする
 */
export function fetchTransportName(): string {
  systemFetch();
  return usingElectron
    ? 'OSのネットワークスタック(Electron net.fetch — 証明書ストア/システムプロキシに従う)'
    : 'Node標準のfetch(バンドル証明書のみ。TLS傍受や社内プロキシで落ちうる)';
}

function loadElectronFetch(): FetchLike | undefined {
  try {
    // electron は main プロセスにしか無い。テスト(node)からは解決できないので動的に読む。
    // ESM(type: module)なので require は createRequire 経由で作る
    const require = createRequire(import.meta.url);
    const electron = require('electron') as { net?: { fetch?: FetchLike } };
    return electron.net?.fetch?.bind(electron.net);
  } catch {
    return undefined;
  }
}
