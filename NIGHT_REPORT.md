# NIGHT REPORT — 無人夜間作業ログ

開始: 2026-07-04 深夜 / ブランチ: main / ベースライン: typecheck OK, vitest 78件合格

このファイルは作業の進捗・判断・朝の引き継ぎを随時更新する。

## サマリ(随時更新)

- **レビュー指摘 全10件 + cleanup 主要分 修正完了**(1a/1b/1c)。
- **再検証(#2)**: 全vitest 121件合格・build成功・スモークE2E(素/パッケージ版とも)合格、回帰ゼロ。
- **PLAN.md に M8 追加(#3)完了**。
- **M7(#4)完了**: モデルUXドロップダウン / ワークスペース選択 / electron-builder。
  ※NSISインストーラ生成のみ環境ブロック(下記・朝タスク)。パッケージ版のプラグイン
  ロードはパッケージexeのスモークで動作確認済み。
- 進行中: **M8(#5)** を優先順 M8-1→ で実施

## 完了

（まだなし）

## 未完了 / 保留

- **NSISインストーラ生成**: 環境ブロック(上記・朝タスク1)。config は完成済み。
- **残りcleanup(低優先・任意)**: isRecord→util/guards.ts集約、config/secretsのJSON永続化
  共通化(util/jsonFile.ts)、AppConfig検証の一元化(parseAppConfig)、モーダル骨格の
  共通コンポーネント化、テスト用ToolContextファクトリ集約。いずれも動作に影響せず、
  時間の都合でM7/M8を優先し見送り。
- **M8-2/3/4**: 進捗は下記(時間の許す範囲で実施)。

## 自分で下した判断

- **Node PATH**: 開発環境のPATHにnpmが無いため、各コマンドで `export PATH="/c/Program Files/nodejs:$PATH"` を前置して実行(メモリ既知)。
- **ブランチ**: セッション開始時のgit snapshotは `master` だったが、実際の稼働ブランチは `main`(クリーン)。レビュー指摘#6(promote baseRef=main vs master)は現状mainなので不一致は解消済み。ただし「dirtyツリーで昇格失敗」「merge衝突時の--abort回復なし」は依然有効なので、その2点を修正対象とする。

## 朝一番にやるべきこと（引き継ぎ）

1. **NSISインストーラ生成**(M7cの残り): 現環境ではブロック。原因は electron-builder が
   winCodeSign(コード署名ツール)を展開する際、アーカイブ内のmacOSシンボリックリンク
   (darwin/*.dylib)を作成できずに失敗(Windowsのシンボリックリンク作成権限が無い)。
   **対処**: 「設定 → プライバシーとセキュリティ → 開発者向け → 開発者モード」をONにするか、
   ターミナルを管理者として起動してから `npm run dist` を実行 → インストーラが release/ に出る。
   コード署名は不要(CSC_IDENTITY_AUTO_DISCOVERY=false 済)。パッケージ構成・プラグイン同梱・
   esbuild展開パスは検証済みなので、権限さえ通れば完走する見込み。
2. M8の続き(下の進捗参照)。
3. (任意)残りのcleanup(下の「保留」)を気が向いたら。

## 各指摘の対応状況

| # | 指摘 | 状態 | コミット |
|---|------|------|---------|
| 1 | 履歴破損(tool_use/tool_result) | ✅完了 | loop合成tool_result+回帰3件 |
| 2 | 承認ハング(AbortSignal) | ✅完了 | broker signal対応+回帰7件 |
| 3 | 昇格前コマンドインジェクション | ✅完了 | tools/name.ts検証+攻撃再現 |
| 4 | bash保護領域バイパス | ✅完了 | restrictExec+攻撃再現12種 |
| 5 | activeSessionId恒久ロック | ✅完了 | earlyFinished+store回帰3件 |
| 6 | 昇格の構造的失敗 | ✅完了 | assertPromotable+--abort+回帰5件 |
| 7 | ツール引数JSON握りつぶし | ✅完了 | parseToolArguments+inputError |
| 8 | read_fileサイズ無制限OOM | ✅完了 | 10MB上限+回帰2件 |
| 9 | grep ReDoSハング | ✅完了 | looksCatastrophic+行長cap |
| 10 | request_capabilityデバッグパネル失敗 | ✅完了 | ctx.evolution注入+契約3件 |
| cleanup | echo削除・loaderリーク・二重リトライ・csv整形 | ✅主要分完了 | 4コミット |

## M7 / M8 進捗

| 項目 | 状態 | メモ |
|------|------|------|
| M7 モデルUX | ✅完了 | ドロップダウン+shared/models.ts |
| M7 ワークスペース選択 | ✅完了 | config.workspace+dialog |
| M7 electron-builder | ⚠️構成完了/インストーラ生成のみ環境ブロック | 朝タスク1 |
| M8-1 コンテキスト自動圧縮 | 着手 | - |
| M8-2 プロジェクト記憶 | 未 | - |
| M8-3 プランモード | 未 | - |
| M8-4 サブエージェント | 未 | - |

### #9 ReDoSの残余リスク(要認識)
looksCatastrophic はヒューリスティックで、ネスト量指定子の典型形のみ検出。
バックリファレンス由来の破滅パターンや非自明な形は素通りしうる。行長capも
短い(~40字)壊滅入力には無力。完全対策には worker_thread + タイムアウト or
safe-regex 依存が必要。現状は「典型形の即時拒否+入力サイズ抑制」の多層緩和。
