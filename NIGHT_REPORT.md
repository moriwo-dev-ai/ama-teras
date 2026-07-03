# NIGHT REPORT — 無人夜間作業ログ

開始: 2026-07-04 深夜 / ブランチ: main / ベースライン: typecheck OK, vitest 78件合格

このファイルは作業の進捗・判断・朝の引き継ぎを随時更新する。

## サマリ（最終）

指示1〜6をすべて実施。**最終状態: typecheck通過・vitest 136件全合格・build成功・
スモークE2E(素/パッケージ版とも)合格・回帰ゼロ**。ベースライン78件→136件(+58)。
全作業を機能単位で個別コミット(計21コミット)。

- **#1 レビュー指摘修正**: 上位1〜4 + 中程度5〜10 の全10件完了。セキュリティ2件(#3/#4)は
  攻撃再現テストで「塞がったこと」を実証。cleanup主要分(echo削除・loaderリーク・二重リトライ等)も完了。
- **#2 再検証**: 全テスト+build+自己進化スモーク(headless electron / パッケージexe)で回帰ゼロ確認。
- **#3 PLAN.md M8追加**: M8-1〜M8-4 を完了条件付きで記載。
- **#4 M7**: モデルUXドロップダウン / ワークスペース選択 / electron-builder構成。
  ※NSISインストーラ生成のみ環境ブロック(朝タスク1)。パッケージ版のプラグインロードは検証済。
- **#5 M8**: M8-1 コンテキスト自動圧縮 / M8-2 プロジェクト記憶 / M8-3 プランモード /
  M8-4 サブエージェント — 全4項目を完了条件を満たす形で実装・テスト。
- **#6 本レポート**: 随時更新し最終化。

→ **残タスクは「NSISインストーラ生成(環境権限)」と「任意の低優先cleanup」のみ**(下記)。

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
| M8-1 コンテキスト自動圧縮 | ✅完了 | compaction.ts+回帰7件 |
| M8-2 プロジェクト記憶 | ✅完了 | memory.ts(MYCODEX.md)+回帰4件 |
| M8-3 プランモード | ✅完了 | loop.planMode(二重防御)+回帰 |
| M8-4 サブエージェント | ✅完了 | subagent.ts(親履歴非肥大)+回帰3件 |

### M8の完了条件 対応状況
- M8-1: 「送信トークンが減る」「直近文脈保持」→ compaction.test.ts で実証。閾値既定24k。
- M8-2: 「記憶の規約が応答に反映」→ composeSystemPromptがsystemへ注入する点をテスト+runAgentLoopに配線。
  実LLMでの反映確認は要APIキー(セッション実行)。
- M8-3: 「承認前にツール実行が起きない」→ planMode時にexecuteToolが呼ばれないことをテストで担保(二重防御)。
- M8-4: 「親履歴が肥大しない」→ 子が何往復しても親履歴はdispatchの1往復のみ、をテストで実証。

### #9 ReDoSの残余リスク(要認識)
looksCatastrophic はヒューリスティックで、ネスト量指定子の典型形のみ検出。
バックリファレンス由来の破滅パターンや非自明な形は素通りしうる。行長capも
短い(~40字)壊滅入力には無力。完全対策には worker_thread + タイムアウト or
safe-regex 依存が必要。現状は「典型形の即時拒否+入力サイズ抑制」の多層緩和。
