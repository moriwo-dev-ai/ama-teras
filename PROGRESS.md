# PROGRESS

## 現在の状態

- フェーズ0完了: ARCHITECTURE.md / PLAN.md / PROGRESS.md 作成
- 作業中: M1(骨組み+チャットUI)

## 完了項目

- 2026-07-03: フェーズ0 — 設計ドキュメント作成

## 次のタスク

- M1: electron-vite 骨組み、型付きIPC、チャットUI(エコー応答)
- M2: プラグインローダー+組み込みツール+承認UI

## 既知のバグ

(なし)

## 決定事項ログ

- 2026-07-03: 開発マシンに Node.js が無かったため winget で LTS (v24.18.0) を導入
- 2026-07-03: APIキー保管は keytar でなく Electron 組み込みの safeStorage を採用
  (keytar が非メンテのため。CLAUDE.md「keytar等」の範囲内と判断)
- 2026-07-03: IPC payload の実行時検証は手書きガード(zod 不採用 — 外部依存最小方針)
- 2026-07-03: 進化ジョブの B worktree は `../mycodex-evolve/job-<N>`、node_modules は
  ジャンクションで A と共有。依存追加を要するジョブは fail 扱い(依存最小方針)
