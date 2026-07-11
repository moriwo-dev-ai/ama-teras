/**
 * M13-0: リモート接続URLの組み立て(QR・表示・コピーで共用)。
 * トークンはURLフラグメント(#t=)に載せる — サーバーへ送信されず、remote-ui が
 * localStorage へ取り込む(M10の設計)。
 */
export function buildRemoteUrl(host: string, port: number, token?: string | null): string {
  const h = host.trim();
  if (h === '') return '';
  return `http://${h}:${port}/${token ? `#t=${token}` : ''}`;
}

/**
 * M32-8: ホスト名の初期解決(表示バグ回帰防止のため純関数)。
 * config優先 → localStorage新キー(amateras-remote-host)→ 旧キー(mycodex-remote-host)。
 * M27-3でlocalStorageキーは amateras-* にリネームされたが、フォールバックが旧キーのみを
 * 参照していたため、config未保存の環境でホスト名が空に戻りQRが黙って消えていた。
 * localStorageから見つけた場合は heal=true(呼び出し側がconfigへ自己修復保存する)
 */
export function resolveInitialHost(
  configHost: string | null | undefined,
  readKey: (key: string) => string | null,
): { host: string; heal: boolean } {
  if (configHost !== null && configHost !== undefined && configHost.trim() !== '') {
    return { host: configHost, heal: false };
  }
  for (const key of ['amateras-remote-host', 'mycodex-remote-host']) {
    const stored = readKey(key);
    if (stored !== null && stored.trim() !== '') return { host: stored, heal: true };
  }
  return { host: '', heal: false };
}

/**
 * M21-3: QR脇の案内文とアクションの決定(表示分岐を回帰テストで固定するため純関数)。
 * 平文トークンは有効化/再生成の直後しかメモリに無い(M13-0の平文非保存設計)ため、
 * 再起動後は「トークン無しQR+再生成ボタン」の案内になる
 */
export function qrGuidance(
  tokenSet: boolean,
  hasPlainToken: boolean,
): { withToken: boolean; message: string; offerRegenerate: boolean } {
  if (hasPlainToken) {
    return {
      withToken: true,
      message: 'トークン込みの接続QR。スマホのカメラで読むだけで接続できる(この画面にいる間だけ表示)',
      offerRegenerate: false,
    };
  }
  if (tokenSet) {
    return {
      withToken: false,
      message:
        'トークン無しのURL(接続にはトークン入力が必要)。スマホを新しくつなぐ場合は' +
        '「トークン込みQRを出す」で再生成する(接続済みのスマホは再設定が必要になる)',
      offerRegenerate: true,
    };
  }
  return {
    withToken: false,
    message: 'トークン未発行。「有効にする」で発行されたトークン込みQRが表示される',
    offerRegenerate: false,
  };
}
