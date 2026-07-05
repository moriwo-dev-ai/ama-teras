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
