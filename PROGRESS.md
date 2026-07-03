# PROGRESS

## 現在の状態

- M2完了。次は M3(エージェントループ+Anthropicプロバイダ+APIキー管理)

## 完了項目

- 2026-07-03: フェーズ0 — 設計ドキュメント作成
- 2026-07-03: M1 — electron-vite 骨組み、型付きIPC(chat:send/cancel/event)、
  チャットUI(zustand、ストリーミング表示、キャンセル)、エコー応答、スモークモード起動分岐。
  検証: typecheck / vitest 6件 / ビルド / スモーク起動 / CDP経由E2E(UI入力→エコー表示)すべて成功

- 2026-07-03: M2 — ツールプラグイン基盤(esbuild動的ローダー+内容ハッシュでimportキャッシュ迂回、
  registry.reload()でホットリロード)、組み込み6ツール、承認ブローカー+承認ダイアログ(diff表示・
  risk別警告・自動承認設定)、ツールデバッグパネル、スモークモード実装
  (`MYCODEX_SMOKE=1 electron . --tool <name> --input <json>`)。
  検証: typecheck / vitest 40件 / スモーク実行 / CDP経由E2E(承認ダイアログ・diff・許可・拒否)すべて成功

## 次のタスク

- M3: LLMProvider型+Anthropic実装(ストリーミング、prompt caching、AbortSignal)
- M3: APIキー保管(safeStorage)+設定UI
- M3: エージェントループ本体(tool_use連鎖、maxTurns、キャンセル)

## 既知のバグ

(なし)

## 決定事項ログ

- 2026-07-03: 開発マシンに Node.js が無かったため winget で LTS (v24.18.0) を導入
- 2026-07-03: APIキー保管は keytar でなく Electron 組み込みの safeStorage を採用
  (keytar が非メンテのため。CLAUDE.md「keytar等」の範囲内と判断)
- 2026-07-03: IPC payload の実行時検証は手書きガード(zod 不採用 — 外部依存最小方針)
- 2026-07-03: 進化ジョブの B worktree は `../mycodex-evolve/job-<N>`、node_modules は
  ジャンクションで A と共有。依存追加を要するジョブは fail 扱い(依存最小方針)
