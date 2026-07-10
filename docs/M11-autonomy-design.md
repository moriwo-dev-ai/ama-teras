# M11: 自律開発能力の強化(autonomy-comparison.md の改修5点)

費用対効果順。各ステップ独立コミット。**新規npm依存は追加しない**。進化ジョブ(restrictExec / writeAllowlist が注入されたコンテキスト)には M11 の新機能を一切波及させない。

## M11-1: maxTurns の設定化

- `AppConfig.maxTurns?: number`(未設定=30。1〜200にクランプ)
- ipc.ts → runAgentLoop の deps に配線
- Settings UI に数値入力(説明: 大きいほど長いタスクを自走できるがコスト増)
- 上限到達時のイベントは既存 `max_turns_reached` のまま
- テスト: クランプ、既定値、deps優先順位

## M11-2: bash のバックグラウンド実行

- `ProcessManager`(新規 `src/main/core/processes.ts`): spawn管理、id採番、リングバッファでstdout/stderr保持(上限256KB/proc)、kill(Windowsは `taskkill /pid <pid> /T /F`、他は process group kill)。アプリ終了・セッションキャンセル時に全kill
- プラグインは node 組み込みしか import できないため **ToolContext.processes 経由で注入**(evolution/subagent と同パターン)。進化ジョブには注入しない
- `bash` の inputSchema に `background?: boolean` を追加。true なら即 `{ id, note }` を返す
- 新規 safe ツール `bash_output`(`{ id, sinceByte? }` → 出力+実行状態)、exec ツール `bash_kill`(`{ id }`)
- risk は background でも 'exec' のまま(承認フローは従来どおり)
- テスト: 起動→出力取得→kill、リングバッファ境界、注入なしコンテキストでの明示エラー

## M11-3: 自動チェックポイント

- 新規 `src/main/core/checkpoints.ts`: workspace が git リポジトリの場合のみ有効
- 方式: HEAD・indexを汚さない。`GIT_INDEX_FILE=<一時index>` で `git add -A` → `write-tree` → `commit-tree`(parent=前チェックポイント or HEAD)→ `update-ref refs/amateras/checkpoints/<sessionId>`
- タイミング: write/exec リスクのツール実行が成功するたび(直近スナップショットから変更がなければskip)。エージェントループ完了時にも1回
- 復元: IPC `checkpoint:list` / `checkpoint:restore`(`git restore --source=<sha> --worktree -- .` 相当。復元前に現状態も自動スナップショット)。UI は Debugパネルに一覧+復元ボタン(最小限)
- workspace が AMA-teras リポジトリ自身でも安全(refs以外触らない)。git が無い workspace では無効(ログのみ)
- テスト: 実git(一時リポジトリ)でスナップショット→改変→復元、HEAD/index不変の検証、非gitでのnoop

## M11-4: 編集後フック(自動検証ループ)

- `AppConfig.postEditHook?: string`(空=無効。例: `npx vitest run --changed`)
- executor で write_file / edit_file が成功した直後にフックコマンドを実行(タイムアウト60s、出力は末尾4KBに切詰め)し、**tool_result の content 末尾に `[post-edit hook]` として追記** → 次ターンのLLMがエラーを見て自走修正する
- 承認不要(ユーザーが設定した固定コマンドのため)。ただし fullPc でも hook はworkspace内 cwd で実行
- 進化ジョブでは無効(restrictExec コンテキストはフックを実行しない)
- 失敗(non-zero)でもツール結果自体は成功のまま(情報として付与するだけ)
- Settings UI に入力欄+説明
- テスト: フック出力の追記、タイムアウト、無効時の非実行、進化コンテキスト非実行

## M11-5: 既定モデルを claude-fable-5 へ

- `src/shared/models.ts` の Anthropic 既定を `claude-fable-5` に変更(既知モデル一覧にも追加)
- prompt caching の cache_control 配置は既存実装のまま適用されることをテストで確認
- **実API検証はAnthropicキー登録待ち**(帰宅後確認事項へ)

## 帰宅後確認(docs/M11-manual-test.md に詳細を書く)

- Windows実機: バックグラウンドprocのkill(taskkill /T)、チェックポイント復元、Settings新項目、postEditHook の体感
- Anthropicキー登録 → claude-fable-5 で「TODO管理CLIを作ってテストまで通す」を1本走らせ、autonomy-comparison.md のベンチ3課題を実測
