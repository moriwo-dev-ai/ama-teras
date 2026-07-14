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

export function systemFetch(): FetchLike {
  if (cached !== undefined) return cached;
  cached = loadElectronFetch() ?? fetch;
  return cached;
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
