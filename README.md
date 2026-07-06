# AMA-teras(旧称 MyCodex)

自己進化型デスクトップAIエージェント(Electron + React + TypeScript)。
ユーザーと対話しながら 計画→実装→デバッグ→テスト をほぼ自動で行い、
足りない機能は自分でツールプラグインを生成して取り込む(自己進化)。

## セットアップ

```bash
npm install
npm run dev        # 開発起動
npm run typecheck  # tsc(node / web / remote-ui)
npm run test       # vitest
npm run build      # 本体 + remote-ui(スマホUI)のビルド
```

- APIキーはアプリの「設定」から登録する(OS暗号化ストレージに保存。平文保存なし)
- 詳細な設計は `ARCHITECTURE.md` / `docs/`、進捗と判断記録は `PROGRESS.md`

## スマホ(iPhone)からのリモートアクセス(M10)

main プロセス内蔵のHTTPサーバ(REST + SSE)がモバイルSPAを配信する。
**ネットワーク境界は Tailscale に任せる**(tailnet 内のみ到達可能)。その上で
アプリ側のペアリングトークン認証(sha256ハッシュ保存・timingSafeEqual・失敗バン)を重ねる。

### 手順

1. **ビルド**: `npm run build` を一度実行(`out/remote-ui` にスマホUIが出力される)
2. **Tailscale**: PC と iPhone に [Tailscale](https://tailscale.com/) をインストールし、
   同一アカウントでログイン(MagicDNS を有効にしておくとホスト名でアクセスできる)
3. **有効化**: AMA-teras → 設定 → 「リモートアクセス(スマホ・Tailscale経由)」→ 有効にする
   - 初回有効化時に**ペアリングトークン**(64文字)が一度だけ表示される
   - ホスト名欄に PC の MagicDNS 名(例 `mypc.tailxxxx.ts.net`)を入力すると
     接続URL `http://mypc.tailxxxx.ts.net:8787/#t=<トークン>` が表示される
4. **iPhoneで開く**: 接続URLを AirDrop / メモ等で iPhone に渡し、Safari で開く
   (QRコード表示は後続タスク。現状はURL手渡し)
   - `#t=` 付きURLならトークンは自動設定される。手入力の場合はトークンだけ貼り付け
5. **ホーム画面に追加**: Safari の共有メニューから追加すると全画面アプリとして使える
6. スマホからできること: チャット送受信・キャンセル・プランモード、ツール承認
   (diff・警告表示つき)、自己進化ジョブの投入と昇格承認、監査ログ閲覧。
   デスクトップと**同一セッションを共有**し、承認はどちらが先に応答しても両画面が閉じる

### セキュリティの前提と注意

- サーバは `0.0.0.0:8787` で listen する。**tailnet 外からの到達は Tailscale /
  OSファイアウォールが遮断する前提**。ポート開放やインターネット公開はしないこと
- トークンは平文保存されない(configには sha256 ハッシュのみ)。忘れたら「トークン再生成」
  (旧トークンは即失効)
- リモートAPIには **secrets / settings変更 / workspace変更 / scopeMode変更 を公開していない**。
  これらはデスクトップUI専用
- リモートからの承認は「このセッションでは常に許可」が使えない(自動的に単発の許可に降格)
- 認証失敗が続いた接続元は60秒ブロックされる
- `remote.enabled` の既定は false(無効時は一切 listen しない)

## テスト・検証

- `npm run test`(vitest)— エージェントループ / プロバイダ層 / 進化マネージャ /
  スコープ制御 / リモートサーバ(認証・SSE・パストラバーサル)をカバー
- 手動確認手順: `docs/M9-manual-test.md`(PC全体スコープ)、`docs/M10-manual-test.md`(スマホ)
