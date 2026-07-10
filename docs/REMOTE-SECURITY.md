# リモートアクセスのセキュリティ前提(旧README から移設・M27-2)

main プロセス内蔵のHTTPサーバ(REST + SSE)がモバイルSPAを配信する。
**ネットワーク境界は Tailscale に任せる**(tailnet 内のみ到達可能)。その上で
アプリ側のペアリングトークン認証(sha256ハッシュ保存・timingSafeEqual・失敗バン)を重ねる。

- サーバは `0.0.0.0:8787` で listen する。**tailnet 外からの到達は Tailscale /
  OSファイアウォールが遮断する前提**。ポート開放やインターネット公開はしないこと
- トークンは平文保存されない(configには sha256 ハッシュのみ)。忘れたら「トークン再生成」
  (旧トークンは即失効)
- リモートAPIには **secrets / settings変更 / workspace変更 / scopeMode変更 を公開していない**。
  これらはデスクトップUI専用
- リモートからの承認は「このセッションでは常に許可」が使えない(自動的に単発の許可に降格)
- 認証失敗が続いた接続元は60秒ブロックされる
- `remote.enabled` の既定は false(無効時は一切 listen しない)

ユーザー向けのセットアップ手順は `docs/USER-GUIDE.md` のスマホ操作章を参照。
手動確認手順: `docs/M9-manual-test.md`(PC全体スコープ)、`docs/M10-manual-test.md`(スマホ)。
