# 帰宅後検証の自動実施(Claude Code向け指示書)

あなた(Claude Code)はWindows実機上で、サンドボックス環境では検証できなかった項目を自動確認する。結果は `VERIFICATION_REPORT.md` にまとめてコミットすること。コード修正が必要な軽微な問題(テスト落ち・ビルドエラー)は CLAUDE.md の作業ルールに従い修正→検証→コミットしてよい。アーキテクチャに関わる問題は修正せずレポートに記載。

## 1. 基本検証(必須・順に)

1. `npm run typecheck` — node/web/remote 3構成すべて合格すること
2. `npm run test` — **281件全合格**が期待値(Linux検証済み。Windows固有の落ちがあれば原因を調査)
3. `npm run build` — 完走し、`out/remote-ui/index.html` が生成されること(M10以降未実施の初のWindowsビルド)

## 2. M11 Windows固有(必須)

4. `npx vitest run src/main/core/processes.test.ts` — Windows上で実行し、taskkill 経路を含め合格すること
5. 追加スモーク: 小さなnodeスクリプトで ProcessManager 相当の動作を直接確認 —
   子プロセスツリー(cmd /c で孫を持つもの)を background 起動→出力取得→kill→**孫まで死んでいること**を `tasklist` で確認

## 3. アプリ実機確認(CDP経由で自動化。M1〜M8の検証と同じ手法)

6. `npm run dev` でアプリ起動 → CDP接続
7. Settings: maxTurns数値入力・postEditHook入力欄・scopeModeトグル・リモートアクセス節が表示され、保存が config.json に反映されること
8. チェックポイント: 適当なgitワークスペースを workspace に設定→チャットで write_file を1回実行(承認)→Debugパネルに checkpoint が現れ、復元ボタンで戻ること。`git -C <workspace> log` と index が汚れていないこと
9. リモートアクセス: Settingsで有効化→トークン取得→`curl http://localhost:8787/api/status -H "Authorization: Bearer <token>"` が200、トークン無しが401、`/api/events` がSSEで snapshot を返すこと。ブラウザで `http://localhost:8787/#t=<token>` を開き remote-ui が表示されること(CDPでchrome起動可)
10. M9: workspace外(例 %TEMP%)への write_file 指示 → system警告バナー付き承認ダイアログ(allow-sessionボタン非表示)→承認で書き込み、audit.jsonl に記録されること。secrets.json への書き込み指示→即エラー

## 4. Anthropicキーが登録済みの場合のみ(未登録ならスキップし、レポートに「キー登録待ち」と記載)

11. claude-fable-5 で「list_dir→read_file の連鎖」を1回実行し、2回目の呼び出しで usage の cache_read が非ゼロであること(prompt caching実測)
12. 小課題の自走: 「TODO管理CLI(add/list/done)を tmp ディレクトリに作り、vitestテストを書いて全部通して」を autoApprove + maxTurns=100 + postEditHook設定で投げ、完遂するか・所要ターン・介入回数を記録

## 5. レポート

- `VERIFICATION_REPORT.md`: 項目ごとに ✅/❌/⏭(スキップ理由)、発見した問題と対処、残る人間確認事項(iPhone実機+Tailscale、NSISインストーラは開発者モードONで `npm run dist`)
- PROGRESS.md の「ユーザーへの依頼事項」を実施済み内容に合わせて更新
- すべてコミット(メッセージ: "verify: 帰宅後検証 ..." 形式)

## 注意

- APIキーの登録・閲覧・出力はしない(キーはユーザーがSettingsから登録する)
- リモートアクセスの検証後は**無効に戻す**(トークンも再生成せず放置しない)
- 検証で作った一時ファイル・一時workspaceは掃除する
