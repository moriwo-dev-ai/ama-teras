# MyCodex — 自己進化型・Codexライクなデスクトップエージェント

Electron + React + TypeScript製のAIコーディングエージェントアプリ。
ユーザーと対話しながら計画→実装→デバッグ→テストをほぼ自動で行い、
**足りない機能を自分でコード生成して取り込む(自己進化)**。

## アーキテクチャ(変更するな。変更が必要なら理由をPROGRESS.mdに書いてから)

- **main process** (`src/main/`): エージェントループ、ツール実行、APIクライアント、進化マネージャ
- **renderer** (`src/renderer/`): React UI(チャット、diffビュー、承認ダイアログ、進捗、進化ジョブの状態表示)
- **IPC**: contextBridge経由の型付きIPCのみ。rendererからnode APIを直接触らない
- **プロバイダ抽象層** (`src/main/providers/`): Anthropic APIとOpenAI APIを共通インターフェース `LLMProvider` で切替
- **ツール = プラグイン** (`src/main/tools/plugins/`): 1ツール=1モジュール。共通インターフェース
  `ToolPlugin { name, description, inputSchema, execute() }` を実装し、起動時+実行中に動的ロード。
  組み込み: read_file / write_file / edit_file / list_dir / grep / bash。bash・書き込み系は承認UI必須(自動承認モードあり)
- エージェントループは自作: 応答→tool_use→実行→結果→ループ。max turns制限とキャンセル必須

## 自己進化サブシステム (`src/main/evolution/`)

エージェントが対応できない要求に遭遇したら、専用ツール `request_capability(説明, 期待する入出力)` を呼ぶ。
進化マネージャが以下を実行する:

1. **B環境を用意**: `git worktree` で進化ブランチのworktree(= B)を作成。A(稼働中)には触らない
2. **進化ジョブ**: B内で子エージェントセッションを起動し、新ツールプラグイン+ユニットテストを生成させる
3. **検証ゲート**(全部合格が昇格条件): `typecheck` → `vitest` → スモークテスト(Bをheadless起動し新ツールを実際に1回実行)
4. **昇格(B→A)**: ユーザー承認ダイアログ → mainブランチへマージ → gitタグ `evolve/N` → Aがプラグインを動的リロード
   (コア変更を伴う場合のみアプリ再起動。再起動と健全性チェックはスーパーバイザーが担当)
5. **ロールバック**: 昇格後の健全性チェック失敗時は直前タグへ自動revert

### 進化の鉄則

- 進化ジョブが書き換えてよいのは `src/main/tools/plugins/` と対応するテストのみが原則。
  コア変更が必要な場合は理由を提示してユーザー承認を得る
- **保護領域(進化ジョブによる変更禁止)**: `src/main/evolution/`、スーパーバイザー、承認UI、この CLAUDE.md
- 昇格は必ずユーザー承認制(設定で自動化可能にしてよいが、デフォルトは承認制)
- 生成ツールに `child_process` / ネットワークアクセスが含まれる場合は承認ダイアログで明示警告

## 技術スタック

- Electron + Vite + React 18 + TypeScript(strict) / zustand / Tailwind
- `@anthropic-ai/sdk` と `openai`。**Anthropicではprompt caching必須**(system+ツール定義にcache_control)
- APIキーはOSキーチェーン(keytar等)。平文保存禁止
- テスト: vitest(エージェントループ・プロバイダ層・進化マネージャは必ずユニットテスト)

## 作業ルール(自律稼働用・厳守)

1. **PROGRESS.md を常に更新**: 完了項目、現在の作業、次のタスク、既知のバグ
2. **こまめにコミット**: 機能単位。動かない状態でコミットしない
3. **動作確認してから次へ**: 実装→ `npm run typecheck` →テスト→コミット
4. ユーザー確認は本当に判断が必要な時だけ。些細な選択は自分で決めてPROGRESS.mdに記録
5. 同じ手法を3回以上繰り返さない。アプローチを変えるか最小再現を作る
6. 外部ライブラリ追加は最小限。追加時は理由をPROGRESS.mdへ

## コーディング規約

- TypeScript strict、`any`禁止(やむを得ない場合はコメントで理由)
- エラーは握りつぶさない。ユーザーに見えるエラー表示をUIに用意
- コメントは「なぜ」だけ
