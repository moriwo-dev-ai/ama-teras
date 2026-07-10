# M11 手動確認(帰宅後・Windows実機)

自動テスト(vitest 281件・typecheck node/web/remote)はサンドボックスで全合格済み。
以下は **Linuxサンドボックスでは検証できなかった項目** と体感確認。

## 事前

- [ ] `npm run typecheck` / `npx vitest run`(281件)/ `npm run build` がWindowsでも通る
- [ ] アプリが通常起動する(設定画面に「最大ターン数」「編集後フック」が増えている)

## M11-1: maxTurns

- [ ] 設定「最大ターン数」: 空欄=既定30。`0` や `999` を入れると 1〜200 にクランプされて保存される
- [ ] 小さい値(2など)で複数ツールを要するタスクを投げると `max_turns_reached` で止まり、UIにその状態が出る

## M11-2: バックグラウンドbash(最重要・Windows固有)

- [ ] チャットで「`npm run dev` をバックグラウンドで起動して」→ bash(background:true) の承認ダイアログ → `id=N` が即返る
- [ ] `bash_output {"id": N}` で出力が取れる。`since_byte` に前回の total_bytes を渡すと増分だけ返る
- [ ] `bash_kill {"id": N}` で停止する
- [ ] **taskkill /pid <pid> /T /F が孫プロセスまで殺すこと**(タスクマネージャで node.exe / cmd.exe が残らないこと)。
      サンドボックスではコマンド組み立ての単体テストのみ(processes.test.ts)。実行経路は未検証
- [ ] セッションキャンセル(停止ボタン)で実行中のバックグラウンドprocが全て死ぬ
- [ ] アプリ終了(ウィンドウを閉じる)で残プロセスが無い(will-quit → killAll)
- [ ] 出力が256KBを超える長時間プロセスで、bash_output に「先頭Nバイトはバッファ上限で切り捨て済み」が出て動き続ける

## M11-3: 自動チェックポイント

- [ ] git 管理下の workspace で write_file / edit_file / bash を成功させる → Debugパネル
      「チェックポイント」→「一覧を更新」に `<tool> 実行後` と `セッション終了(done)` が並ぶ
- [ ] 「復元」→ 作業ツリーだけが戻る。`git status` / `git log` で **HEAD と index(ステージ)が
      一切動いていない** こと、ブランチ・タグが増えていないことを確認
- [ ] 復元時に `pre-restore` への自動退避が作られ、そこから復元し直すと元に戻る(往復)
- [ ] 非gitフォルダを workspace にした場合、エラーなく無効(コンソールに `[checkpoint] ... 無効` ログのみ)
- [ ] AMA-teras リポジトリ自身を workspace にしても `refs/amateras/` 以外に痕跡が無い
- 既知の制約(仕様):
  - 復元は「上書き」。チェックポイント作成後に **新規作成されたファイルは削除されない**
  - `refs/amateras/checkpoints/*` は自動掃除しない。不要になったら
    `git for-each-ref refs/amateras/ --format='%(refname)' | ForEach-Object { git update-ref -d $_ }`

## M11-4: 編集後フック(postEditHook)

- [ ] 設定「編集後フック」に `npx vitest run --changed`(または `npm run typecheck`)を設定
- [ ] edit_file を伴う指示を出すと、ツール結果末尾に `[post-edit hook]` ブロックが付く
- [ ] わざと壊れる編集をさせると、フックの失敗出力を見て **次ターンでモデルが自走修正する**(体感)
- [ ] 長時間かかるフックが60秒+0.5秒で打ち切られ、ループが固まらない
- [ ] 進化ジョブ(request_capability)を1本流し、ジョブ内の write_file でフックが **実行されない** こと
      (guardrails + executor.hook.test.ts で機械的には固定済み。実動作の目視)
- 既知の制約: タイムアウト打ち切り時、フックの孫プロセスが残る可能性(メッセージに明示される)

## M11-5: claude-fable-5(Anthropicキー登録後)

- [ ] APIキー登録 → プロバイダ Anthropic・モデル空欄(既定)でチャット → claude-fable-5 で応答する
- [ ] 2回目以降のリクエストで cache_read_input_tokens が増える(prompt caching が効いている)
- [ ] 「TODO管理CLIを作ってテストまで通す」を maxTurns 50 程度で1本自走させる
      (postEditHook = `npx vitest run --changed` を併用すると自走修正まで見られる)
- [ ] docs/autonomy-comparison.md のベンチ3課題を実測して結果を記録

## 実装中に見つかった注意点

- spawn の `timeout` オプションはシェルだけを殺し、孫プロセスが stdio を握っていると
  `close` イベントが発火しない(postEditHook はフォールバックタイマーで対処済み。
  bash 通常実行の timeout も同条件では `close` 待ちになり得る — 気になる場合は要観察)
- Windows の ProcessManager は `detached: false`(taskkill /T が子孫を辿るため)。
  コンソールウィンドウがちらつく場合は windowsHide の効きを確認
- チェックポイントの committer は `amateras-checkpoint <checkpoint@amateras.local>` に固定
  (ユーザーの git identity 未設定でも動く)
