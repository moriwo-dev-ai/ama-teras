# MyCodex 実装計画

各マイルストーンは「完了条件」を満たし、typecheck+テストが通った状態でコミットして完了とする。

## M1: 骨組み + チャットUI

- electron-vite + React 18 + TS strict + Tailwind + zustand のプロジェクト骨組み
- `src/shared/ipc.ts` に型付きIPC定義、preload で `window.api` 公開
- チャットUI(メッセージ一覧・入力欄・ストリーミング表示領域)
- main側はエコー応答(ダミーストリーム)で IPC 往復を実証。`MYCODEX_SMOKE=1` の起動分岐だけ先に用意
- **完了条件**: `npm run dev` でウィンドウが開き、入力したメッセージがストリーミング風に
  エコーバック表示される。`npm run typecheck` と `npx vitest run` が成功。

## M2: ツールプラグイン基盤 + 組み込みツール + 承認UI

- ToolPlugin 型 / loader(esbuild動的ロード+リロード)/ registry — **最初から動的ロード**。静的import禁止
- 組み込み6ツール: read_file / write_file / edit_file / list_dir / grep / bash
- 承認UI(ダイアログ、diff表示、risk別警告、自動承認モード設定)
- loader と各ツールのユニットテスト
- **完了条件**: vitest で「plugins ディレクトリのファイルを実行時に追加→reload→新ツールが registry に載る」
  が通る。UIから手動でツール実行をトリガーするデバッグパネルで、write_file が diff付き承認ダイアログを出す。

## M3: エージェントループ完成

- LLMProvider 型 + Anthropic 実装(ストリーミング、prompt caching、AbortSignal)
- APIキー保管(safeStorage)+ 設定UI
- ループ本体: calling_llm → tool_use → 承認 → 実行 → tool_result → ループ。maxTurns、キャンセル
- 状態遷移・キャンセル・maxTurns のユニットテスト(プロバイダはモック)
- **完了条件**: 実APIキーで「このディレクトリのファイル一覧を出して README の1行目を読んで」の類の
  指示が list_dir → read_file の tool_use 連鎖で完遂し、UIに経過が出る。キャンセルボタンが即座に効く。

## M4: 自己進化基盤

- worktree.ts(B作成/破棄、node_modules ジャンクション共有)
- job.ts(B内の子エージェントセッション、writeAllowlist 強制)
- gates.ts(typecheck → vitest → スモーク → 差分検査による保護領域防衛)
- promote.ts(承認ダイアログ → merge → tag → ホットリロード)+ supervisor.ts(健全性チェック → 自動revert)
- request_capability ツール、進化ジョブ進捗UI
- manager / gates のユニットテスト(git操作は一時リポジトリで実テスト)
- **完了条件**: 手動で enqueue した擬似ジョブ(生成物を固定したモック子エージェント)が
  worktree作成→ゲート全通過→承認ダイアログ→merge→タグ→ホットリロードまで通る。
  保護領域に触る差分を仕込んだジョブがゲート4で fail することをテストで実証。

## M5: 自己進化E2E

- 実LLMで request_capability → ツール生成 → 検証 → 昇格 → 新ツールが同一セッション後続で使える、を通す
- 失敗パターンの整備(生成失敗リトライ1回、ゲートfail時のフィードバック付き再生成1回、それでもダメなら failed)
- **完了条件**: 「JSONファイルを整形するツールが欲しい」等の要求で、request_capability が発火し、
  昇格承認後に新ツールがホットロードされ、実際にそのツールで作業が完了する一部始終がUIで確認できる。
  ロールバック: 昇格直後の健全性チェックを人為的に失敗させ、自動revertが動くことを確認。

## M6: OpenAIプロバイダ追加

- openai.ts(function calling ⇔ ContentBlock 変換)、設定UIでプロバイダ切替
- 変換のユニットテスト(SDKモック)
- **完了条件**: OpenAIキーで M3 の完了条件と同じシナリオが通る。切替後も履歴表示が壊れない。

## M7: 磨き込み(7/7以降でも可)

- UI仕上げ(進化ジョブのログビュー、トークン使用量表示、セッション履歴の永続化)
- エッジケース(巨大ファイル、バイナリ、長時間bash、worktreeゴミ掃除)
- パッケージング(electron-builder)と配布物でのプラグインロード確認
- **完了条件**: 主要フロー(チャット/ツール/進化)がパッケージ版でも動く。

## リスクと先回り

- **プラグイン動的ロード**は M2 で確立しないと M4/M5 が作り直しになる → M2 の完了条件に明記済み
- スモークテスト(headless electron)は M1 で起動分岐だけ先に切っておく(M4で慌てない)
- Windows 前提(mklink /J、パス区切り)。POSIX対応は M7 以降
