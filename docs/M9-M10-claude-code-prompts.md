# Claude Code に投げる指示(M9 / M10)

そのままコピペで使う。1マイルストーンずつ、新しいセッションで投げること。

---

## M9 キックオフ

```
docs/M9-pc-scope-design.md を読んで、M9(操作範囲のPC全体拡大・全操作承認制)を実装して。

進め方:
- M9-1 から M9-5 まで順に。各ステップ完了ごとに npm run typecheck と npm run test を通してからコミット(コミットメッセージは "M9-1: ..." 形式)
- 実装前に plan を提示して、私の承認を得てから着手
- 既存の規約に従う: ツールプラグインは src/main/tools/plugins/ の規約(types.ts のコメント参照)、IPCは shared/ipc.ts → preload → renderer の add-only、テストは実装ファイルと同階層の *.test.ts

絶対に守ること:
- 自己進化パイプラインの制限(EVOLUTION_WRITE_ALLOWLIST、restrictExec)を一切緩めない。回帰テストで担保する
- scopeMode のデフォルトは 'project'(後方互換。既存ユーザーの挙動が変わらない)
- system スコープでは autoApprove と allow-session を必ず無視する。これを検証するテストを最初に書く(TDD)
- userData(config.json / secrets.json)への書き込みはハード拒否。承認ダイアログも出さない

完了条件:
- 全テスト合格(既存136件 + 新規)
- 設計書の M9-5 手動確認シナリオの手順を docs/M9-manual-test.md に書き出す(実行は私がやる)
```

## M9 完了後の手動確認(自分でやる)

1. `npm run dev` → Settings で scopeMode を fullPc に変更
2. チャットで「デスクトップに hello.txt を作って」→ 警告色の承認ダイアログが出ること、allow-session ボタンが無いこと
3. 承認 → ファイルができる / 別の指示で拒否 → できない
4. 「config.json を書き換えて」系 → 即エラーになること
5. scopeMode を project に戻す → プロジェクト外が従来どおり拒否されること
6. 自己進化を1回走らせて従来どおり動くこと

---

## M10 キックオフ

```
docs/M10-mobile-web-design.md を読んで、M10(スマホWebアクセス)を実装して。M9 が完了済みであることが前提。

進め方:
- M10-1 から M10-6 まで順に。各ステップ完了ごとに npm run typecheck と npm run test を通してからコミット("M10-1: ..." 形式)
- 実装前に plan を提示して、私の承認を得てから着手
- M10-1(コア抽出リファクタ)は挙動変更ゼロが条件。IPCチャネル名・型・既存テストを一切変えずに全テストが通ること。ここだけ先に単独でレビューさせて

絶対に守ること:
- secrets / settings変更 / scopeMode変更 はリモートAPIに絶対に公開しない
- 全REST/WSにトークン認証。トークンは平文保存しない(sha256ハッシュのみ config へ)。比較は timingSafeEqual
- remote.enabled のデフォルトは false。無効時はサーバを一切 listen しない
- remote-ui は window.api に依存しない独立ビルド
- 静的配信のパストラバーサル対策(../ で out/remote-ui の外に出られないこと)のテストを書く

完了条件:
- 全テスト合格(ws クライアントでの結合テスト含む)
- npm run build で remote-ui も out/remote-ui に出力される
- 手動確認手順を docs/M10-manual-test.md に書き出す(PC の Chrome を iPhone サイズにして localhost:8787 で一通り触れる手順 + Tailscale 実機手順)
```

## M10 完了後の手動確認(自分でやる)

1. PC・iPhone に Tailscale 導入、同一アカウント
2. Settings → リモート有効化 → QR を iPhone で読む → Safari で開きホーム画面に追加
3. スマホからチャット送信 → デスクトップにも同じ会話が流れること
4. スマホ側に承認ダイアログ → 承認 → デスクトップ側の待ちも閉じること
5. 自己進化ジョブをスマホから enqueue → 昇格承認までスマホで完結すること
6. Wi-Fi を切って 4G/5G で再アクセス(Tailscale 経由で届くこと)
7. トークン無しでアクセス → 401 になること

---

## 補足

- M9 → M10 の順で。M10 の Audit 画面は M9 の audit.jsonl に依存する
- 各キックオフの前に git status がクリーンであることを確認
- Claude Code が設計と違う判断をしたい場合は「設計書と差分がある場合は理由を説明して確認を取ってから進めて」と一言添えると安全
