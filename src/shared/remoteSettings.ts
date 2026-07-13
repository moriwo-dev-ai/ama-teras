/**
 * M53: リモート(スマホ)に見せてよい設定キー。**読み書きの両方**がこの1つのリストに従う。
 *
 * 実害: 書き込みは許可リスト(REMOTE_SETTABLE)だったのに、**読み取りは `remote` を落とすだけの
 * 拒否リスト**だった。結果 `GET /api/settings` が AppConfig をほぼ丸ごと返しており、
 * 月読(tsukuyomi)の設定一式 — camera / ears / micDeviceId / wakeWords / quietHours まで —、
 * workspace の絶対パス、postEditHook(実行コマンド)、operations の観測対象が
 * スマホのネットワークレスポンスに平文で載っていた。
 *
 * 資格情報の漏洩ではない(APIキーは safeStorage 側、remote.tokenHash は除去済み)。
 * それでも直すのは、月読が「**鍵の無い機体では存在を匂わせない**」設計だからだ。
 * PC の設定画面は ownerKeyPresent が false ならトグルごと描画しないのに、
 * 同じ機体のスマホの API レスポンスには全設定が載る — UIで隠してAPIで出すのは、隠していない。
 *
 * 拒否リストは「新しく足したキーが**既定で漏れる**」。許可リストは「新しく足したキーが
 * **既定で漏れない**」。設定は今後も増えるので、既定を安全側に倒す。
 */
export const REMOTE_SETTABLE_KEYS = [
  'provider',
  'model',
  'maxTurns',
  'subAgentMaxTurns',
  'subAgentMaxParallel',
  'autoApprove',
  'modelPolicy',
  'fallback',
] as const;

export function isRemoteSettable(key: string): boolean {
  return (REMOTE_SETTABLE_KEYS as readonly string[]).includes(key);
}

/**
 * リモートへ返す設定。許可リストにあるキーだけを通す。
 * 「何を隠すか」ではなく「何を見せるか」を書く(隠し忘れが起きない側)
 */
export function pickRemoteSettings(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of REMOTE_SETTABLE_KEYS) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  return out;
}
