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
