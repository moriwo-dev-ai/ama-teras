# PROGRESS

## 現在の状態

- **M1〜M25まで実装**。テスト668件・typecheck(node/web/remote)全合格。
- **M25-4追加(2026-07-08)**: **①進化パイプラインの安全な迂回バグを修正 ②OpenAIモデルを現行世代へ更新 ③ライトテーマの未完成部分を完成**。
  経緯: request_capability(scope:renderer)のジョブ#10がインフラ側エラーで異常終了 →
  M25-2の自動フィードバック文言「既存ツールでの代替手段を検討して続行せよ」を受け、モデルが
  worktree隔離・検証ゲート・人間承認を経ずに**本体の生きたソースを直接edit_file**して実装を
  代替してしまった(承認済み設計自体は正しかったが、安全な進化パイプラインを迂回した点が問題)。
  ①**根本修正**: feedEvolutionResultToModel をscope対応に分岐 — scope=renderer/coreの失敗では
  「既存ツールでの代替」を提案せず、直接編集を明示的に禁止し、再申請かユーザーへの相談のみを促す
  文言へ変更(scope=toolは従来通り)。②**OpenAIモデル更新**: gpt-5.1は2026-07時点で公式カタログ
  落ち(現行は gpt-5.5 flagship・gpt-5.4・gpt-5.4-mini/nano・gpt-5.3-codex)。KNOWN_MODELS/
  DEFAULT_MODELS/CONTEXT_LIMITSをgpt-5.5既定へ更新、usage.tsに単価表追加(gpt-5.4系はmini/nano
  を汎用gpt-5.4より先に照合する順序に注意)。旧gpt-5.1は非推奨ラベル付きで選択肢に残置。
  ③**ライトテーマ完成**: デスクトップは生のTailwind zincクラス直書きのため、コンポーネント無改修で
  [data-theme='light']スコープの一括CSS上書きで対応(themePref.ts新設・main.tsxで起動時適用・
  SettingsPanelは共通関数経由に統一)。remote-uiは theme.ts/CSSは既にあったが**トグルUI自体が
  存在せず**(App.tsxにimportのみ残る死んだコード)ライトテーマを選ぶ手段が皆無だったため、
  SettingsViewに「表示」カード(サーバ設定を経由しない端末ローカルのトグル)を追加。
  死んだimport(App.tsxのopenTab/RightPaneTab、remote-ui App.tsxのtheme関連)も削除。
  実機Electron(CDP)でダーク/ライト両方を計6画面スクリーンショット確認(メイン・進化タブ・
  設定パネル)、gpt-5.5既定表示も実機確認。テスト4件追加、全668件・typecheck・build合格。
  未検証: remote-ui(スマホ版)のトグルは実際の画面では未確認(typecheck/buildのみ、リモート
  トークン発行の手間を省略)。theme-mock/(検討用ダミーHTML)とAMATERAS_PLAN.mdは削除保留
  (自動削除がブロックされたため未追跡のまま残置。手動削除して問題ない)。
- **M25-3追加(2026-07-07)**: **コア/UI自己書き換え(evolve/job-9)でも意味のある要約が出るように修正**。
  ジョブ#9(AMA-teras自身がscope:coreで申請・renderer側のみ改修)は聖域(src/main/evolution/)を
  触れないため、要約はマージコミットの定型文(subject)止まりだった。人間(Claude Code)が聖域側を
  直接修正: `promoteBranch` に `description` 引数を追加し、マージコミット本文(2行目以降)へ
  ジョブの説明を埋め込む(subject=1行目は従来どおり定型文で互換維持)。`listEvolveTags` は
  ASCII制御文字(0x1e/0x1f)区切りで `%(contents:body)` を取得し `body` フィールドを追加
  (execFile経由でシェル解釈を挟まないため本文中の改行・タブと衝突しない)。
  renderer の `capabilitySummary` は renderer/core 種別で body を優先表示(無ければ subject
  にフォールバック=旧evolveタグとの後方互換)。テスト6件追加(promote 3件+renderer 3件)。
  副次的に、job-9の作業で workspace=C:\dev\mycodex 実行時に残った検証済み完了済みの
  AMATERAS_PLAN.md(全項目チェック済み)がユニットテスト(process.cwd()をworkspaceに使う
  service.switch.test.ts)へ「要約」の文字列で誤混入していたため削除して解消。
- **M25-2追加(2026-07-07)**: **進化結果での会話の自動再開** — 「進化の通知が来ても
  メインエージェントが動かない/『待ってください』と言って止まる」対策。待機中の依頼元会話に
  終端結果(done/failed/rolled_back)が届いたら、履歴注入だけでなく chatSend(内部targetConv)で
  ランを自動再開しモデルに続きをやらせる。安全弁: 人間が却下した rejected は再開しない(却下の
  意思尊重+再申請ループ防止)、ユーザー送信なしの自動再開はConvState.autoResumeCountで3連鎖まで
  (人間の送信でリセット。上限到達は履歴注入+上限infoに縮退)。request_capability の応答文言も
  「完了時に自動で再開される。待つ間は既存ツールで作業続行」に変更。テスト3件追加+1件更新。
- **M25追加(2026-07-07)**: **育成レイヤー(ユーザー方針)+完了前動作確認の規範化**。
  ①全プロジェクト共通の AMATERAS-USER.md(userData)を新設 — memory ツールに scope:"user" を追加し、
  「今後こうして」という恒久方針をAMA-teras自身が保存できる(=チャットからの育成)。毎ターン
  system prompt へ「# ユーザー方針」として注入(優先順: プロジェクト固有 > ユーザー方針 > 一般規範)。
  進化ジョブには userMemoryDir 非注入で書けない。Settings に編集欄(userMemoryGet/Set IPC)。
  ②SYSTEM_PROMPT 規範に「ユーザーが体験する成果物は完了報告の前に必ずツールで実際に動かして確認
  (screenshot/http_screenshot/bash実行)。『書けたはず』で完了としない」を追加。
  テスト8件追加(compose/read-write往復・scope書き分け・未注入エラー・system注入)。
- **evolve/8(2026-07-07)**: **workspace無言移住バグをAMA-teras自身がcore進化で修正**(人間監視付き)。
  バグ: chatSendのラン開始時に常にグローバル設定のworkspaceを束縛し conv.workspace を無言上書き
  → sessionOpen(別セッションを開くとグローバル追従)が引き金で、古い会話へ戻って送信すると
  別プロジェクトへ無言で移住(実害: 「初めまして」会話が Documents\AMA-teras→C:\dev\3DCAD へ)。
  修正: 会話記録のworkspace優先(新規会話のみグローバル束縛)・既存記録は上書きしない・
  食い違い時は警告infoカード。回帰テスト2件(記録A/設定B→Aのまま+警告+永続化もA、新規→B)。
  フロー: Claude Codeが診断検証→チャット指示→AMA-terasがrequest_capability(scope:core)→
  全ゲート合格→Claude Codeがdiff先行レビュー→ユーザー承認→再ビルド+健全性チェック→自動再起動。
  残課題: 既存会話のworkspaceを意図的に変更する明示操作(「この会話を移動」)は未実装。
- **M24-2追加(2026-07-07)**: 計画時の**能力ギャップ評価**をプロンプト規範化 —
  「既存ツールの遠回りな組み合わせで妥協せず、専用ツールがあれば効率よく・自動でできると
  判断したら request_capability で積極提案(名前案+期待入出力を明記)」を SYSTEM_PROMPT 規範と
  PLAN_SUFFIX(プランモードでは提案の明記のみ・実行は承認後)に追加。request_capability の
  description も「対応できない時だけ」から「効率化判断でも積極的に」へ拡張。
  失敗時は evolution_jobs で失敗ゲート確認→修正して再申請する導線も規範に含めた。
  service.plan.test で規範文言の存在を固定(能力ギャップ/request_capability)。
- **M24追加(2026-07-07・スマホからの追加指示)**: チャットモデルが**進化パイプラインの内部ログ**を
  自分で確認できる読み取り専用ツール `evolution_jobs` を追加。id省略=現行プロセスの全ジョブ一覧
  (id/status/scope/tool/失敗ゲート/説明)、id指定=ゲート合否詳細+ログ末尾(logTailで行数調整)。
  ctx.evolution に `list()` を追加(service.evolutionContextで注入、chatSend/toolsExecute両経路)。
  進化ジョブの状態はメモリ上のみで再起動で揮発する旨をツール説明に明記(過去の昇格済み能力は
  EvolutionPanelの「獲得した能力」を参照)。ユニット7件。
  なお「再起動でツールが消えるかも」の懸念は調査の結果**実体は全て健在**(devは
  src/main/tools/plugins/をソースから起動時ロード、evolve/7のhttp_screenshot含む16プラグイン。
  git clean)。消えて見える場合はロードエラー(Debugパネルのregistry.errorsに表示)であり削除ではない。
- **M23-6追加(2026-07-06 夜間・スマホからの追加指示)**: 進化パネルの昇格履歴を
  **「獲得した能力」リスト**へ拡張 — evolveタグごとにマージ第1親との差分から
  kind(🔧ツール追加/🎨UI自己書き換え/⚙コア自己書き換え)・追加ツール名・変更ファイル
  一覧を導出して表示(実データ: evolve/1=csv_to_markdown・evolve/2=text_stats・
  evolve/4=UI自己書き換え)。あわせて remote:set-enabled が remote.host を落とすバグを修正
- **M23完了(2026-07-06 夜間自走・第2ラウンド)**:
  ①**使用中モデルの表示** — メイン応答バッジ(policy有効時はPLANNER・model)・実行中ステータスに
  RunInfo.model(フォールバックで更新)・サブエージェントにworker/escalation帯のモデル名
  ②**使用量メーター(残高に準ずるもの)** — 残高取得APIは両プロバイダとも存在しないため、
  track()デコレータで全LLM呼び出しの実測トークンを日別×モデル別集計(userData/usage.json)。
  Settings/スマホ設定タブに今日・累計トークン+概算$、残高ダッシュボードを開くボタン
  ③**スマホ強化** — +新規チャット(POST /api/sessions/new)・設定タブ
  (ホワイトリスト限定のGET/POST /api/settings: provider/model/maxTurns/subAgent*/
  autoApprove/modelPolicy/fallbackのみ。workspace/scopeMode/postEditHook/キーは不可)・
  使用量表示。実行中の割り込み入力はM21-1で実装済み
  ④**実LLM複数同時ランテスト合格**(Anthropic課金補充後・設定初期化済み) —
  会話A(bash sleep 25)実行中に会話Bが並行完了・↩追加指示がAの最終応答に反映・
  2ラン同時表示(スピナー/モデルラベル)・切替復帰・混線なし・使用量メーター実測動作
- **M22完了(2026-07-06 夜間自走・v0.3.0-M22タグ)**: 複数プロジェクト同時実行 —
  AgentServiceを会話(ConvState)単位の独立状態へ再構成(history/永続化排他/フォールバック
  1回制限/自律モード=会話単位化/RunState: 開始時固定workspace・会話別ProcessManager)。
  実行中のセッション切替・新規のブロック撤廃(実行中会話を開くと生きたhistoryへ接続し
  実行状態に復帰)。全chat:eventへconversationId付与+runs:changed/runs:list(IPC/SSE)で
  左ペイン実行中◌表示。承認要求にorigin(会話/タイトル/workspace)を付与しダイアログ・
  スマホカードに出所表示。cancel/バックグラウンドプロセスは会話単位(他会話へ波及しない)。
  ハード上限なし・同時5超で注意カード。レーステスト5件+実機E2E(イベント帰属・混線なし・
  切替往復・エラー表示経路)。体感確認は `docs/M22-manual-test.md`
- **M21完了(2026-07-06 夜間自走)**: 実行中の対話性と可視化+修正 —
  ①実行中の追加指示(キュー→ターン境界でtool_result対を壊さず注入・応答完了時の残指示は
  新userメッセージで継続・↩バッジ・remote対応) ②subAgentMaxParallel(既定3・1〜8)
  ③QR根治(原因=M17移行でlocalStorage消失→config永続化は7cce924で対応済み。
  平文トークン非保持設計の「📱トークン込みQRを出す(再生成)」導線+回帰テスト)
  ④生存と考えの可視化(現在の状況ライン=状態/経過/最新思考、ツールカード経過+bash
  stdoutライブ+30s無応答⏳、サブエージェント💭narration+経過。APIコスト追加なし)。
  体感確認は `docs/M21-manual-test.md`
- **整理タスク4件完了(2026-07-06)**:
  ①右クリック「フォルダで開く」(左ペインのプロジェクト項目+チャット内ファイル参照。
  file:reveal再利用、resolveRevealTargetでディレクトリ対応・deny判定のみ維持)
  ②テスト用セッション23件削除(ユーザー確認済み・実作業のAICAD 2件は保持)
  ③アイコン適用(icon-source.png→角丸icon.ico/icon-512+PWAフルブリード180/192/512、
  electron-builder.yml win.icon・manifest icons・apple-touch-icon/favicon配線、
  ショートカットにも適用、稼働サーバで200実測)
  ④副題を「自己進化型AIエージェント」へ統一(ヘッダ・README・package.json。CLAUDE.mdは聖域のため不変)
- **M20完了(2026-07-06・実機3実証済み)**: コア自己進化(提案制・保護領域つき) —
  進化scopeを **tool / renderer / core** に段階化(`src/main/evolution/scopes.ts`)。
  **聖域=保護トリップワイヤ**(`protected.ts` の PROTECTED_PATHS: 承認機構・evolution配下・
  スーパーバイザー・secrets・IPC/preload・CLAUDE.md/PROTECTED.md)は scope問わず
  **A側(稼働中)のメモリ上リストのみで判定**し、該当差分は承認ダイアログにも出さず即reject
  (protectedReject)。B側protected.tsを空にしても捕捉されることをテストで実証。symlink差分も拒否。
  ゲートは7段固定順: 聖域→危険検出→差分allowlist→typecheck→vitest→build→スモーク起動
  (renderer/coreは `--smoke-boot`: userData隔離mkdtemp+単一インスタンスロック非取得で
  本体と同時起動可・React mount確認・60s watchdog)。昇格(renderer/core)は
  **常に人間の二段確認**(赤枠+理解チェック必須。自律モードONでも自動化されない=不変条件テスト)
  → mainへマージ+evolveタグ → A再ビルド+健全性ブート → 失敗なら自動revert+旧ビルド復元
  (rolled_back・再起動しない)→ 成功なら5秒予告後に自動再起動。再起動はセンチネル
  (restart-sentinel.json)で見守り、2回連続クラッシュで**セーフモード起動**
  (赤バナー+復旧コマンド+進化無効化+解除ボタン)。進化パネル: scopeバッジ・🛡拒否表示・
  昇格履歴+「⏪1つ前へ戻す」。スマホ承認も二段確認対応。
  **実証: (a)renderer scope「設定ボタンにツールチップ」全線通過(AI差分1行→7ゲート→二段確認→
  再ビルド→健全性→自動再起動→完了バナー+反映、evolve/4) (b)ApprovalDialog.tsx変更を指示厳守で
  強制→protectedゲートのみ実行で即reject・ダイアログ非表示 (c)センチネルbootAttempts=2→
  セーフモード起動・enqueue拒否・解除でセンチネル消滅**。体感確認は `docs/M20-manual-test.md`
- **M19完了(2026-07-06・実機実測済み)**: 品質レビュー・ゲート —
  AppConfig.reviewGate(**既定undefined=無効・従来挙動完全維持**)。有効時:
  マイルストーン(AMATERAS_PLAN.mdの項目 - [ ]→- [x])ごとにplanner帯の辛口レビュアーが
  4軸採点(code/ux/requirements/tests、UI無しはux自動スキップ・localhost限定screenshot可)。
  閾値未満→file/location/problem/fixの具体指摘つきでworker帯へ差し戻し(1〜2回worker、
  3回目以降escalation帯=M18連動)→再レビュー。上限到達: 自律ON=警告のみ/OFF=承認ダイアログ。
  計画未使用タスクは完了時1回に縮退(write/exec成功なしは対象外)。レビュー要約をplanの
  tool_resultへ追記(メインモデルも合否認識)。🧪レビューカード(緑/琥珀/赤)+audit記録+
  Settings節(プリセット3種)。進化ジョブ非波及guardrail。
  **実測: バグ入りコードを「修正禁止」指示下で 2.33不合格→worker修正→4.33合格(3.9分・
  独立検証9/9)。ベンチ②ONは3.5分・12/12・追加コスト$0.15(+78%)**(docs/autonomy-comparison.md)。
  体感確認は `docs/M19-manual-test.md`
- **M18完了(2026-07-06・実機ベンチ実測済み)**: モデル自動切替(役割ベース割当) —
  AppConfig.modelPolicy(**既定undefined=無効・従来挙動完全維持**)。有効時:
  メイン会話=planner帯 / dispatch_agentサブ=worker帯 / 詰まったらescalation帯へ自動格上げ
  (error・maxTurns到達・ツール失敗3連続で発火、子履歴をcompaction経由で引き継ぎ、
  上限maxEscalationsPerTask、infoカード+audit `model-escalation`)。プロバイダ横断可・
  帯ごとキー未登録警告(workerはplanner代行で続行)・M16フォールバックは子ループにも配線
  (1会話1回の制限共有)・進化ジョブ非波及(guardrail固定)。Settings節(プリセット2種・
  帯別選択・現在の割り当て一覧)+plannerバッジ+⤴格上げバッジ。
  **ベンチ②実測: planner=Fable5/worker=Sonnet5 で2.3分完遂・介入0・vitest10/10、
  実行の手数(23コール中18)をworkerが担いコスト約半減**(docs/autonomy-comparison.md)。
  体感確認は `docs/M18-manual-test.md`
- **M17完了(2026-07-06・Windows実機CDP検証済み)**: リブランド+自律モード+UX修正 —
  ①**リネーム MyCodex → AMA-teras**(package name/appId/productName=amateras、
  userData自動移行: 旧`%APPDATA%\mycodex`→新`amateras`へ実データ+**Local State(safeStorage鍵素材)**を
  コピー・実データ有無で判定・マーカー冪等・旧dir温存。記憶/計画は AMATERAS.md / AMATERAS_PLAN.md へ
  旧名読み込み互換+初回書き込みrename移行。実機でキー復号・セッション19件引き継ぎ確認)
  ②**自律モード**(送信欄🔓トグル+チェック必須の危険モーダル+常時警告バー。
  safe/write/exec/systemスコープ/動的承認を全自動承認、全操作をautonomous:trueでaudit記録。
  ハード拒否維持: secrets読み書き・userData書き込み・システム領域の既存上書き。
  新規作成は許可。exec系はformat/diskpart等のカタストロフィックdenylistで即拒否。
  セッション単位・再起動/切替/新規でOFF。remote-uiからも切替可=ONはconfirmed:true必須。
  進化ジョブ非波及をguardrailで固定)
  ③**左ペインソート修正**(プロジェクト順=配下セッションの最新updatedAt降順に固定。
  選択では動かさずハイライトのみ)。体感確認は `docs/M17-manual-test.md`
- **M16完了(2026-07-06・Windows実機CDP検証済み)**: 一晩自走テスト(AICAD)の知見反映 —
- **M16完了(2026-07-06・Windows実機CDP検証済み)**: 一晩自走テスト(AICAD)の知見反映 —
  ①モデル切替時の自動compaction(SessionData.lastLLM記録・切替検知→閾値超過なら圧縮+infoカード)
  ②一時APIエラーの自動リトライ(指数バックオフ最大3回・AbortSignal尊重)と
  課金/残高エラーのプロバイダフォールバック(AppConfig.fallback・既定OFF・1会話1回・
  本体設定不変・警告カード+audit記録・切替前compaction)
  ※M16の記載中「MYCODEX.md/MYCODEX_PLAN.md」等の旧名はM17で AMATERAS.md/AMATERAS_PLAN.md へ改称
  ③アシスタント本文のmarkdown表示+コードブロックにコピーボタン(desktop=react-markdown、
  remote-ui=共有フェンススプリッタの軽量実装、パスリンク維持)
  ④控えめマイクロアニメーション(CSSのみ・transform/opacity限定・prefers-reduced-motion優先・
  Settingsトグル)。体感確認は `docs/M16-manual-test.md`
- **M15完了(2026-07-06)**: 3ペインUIリニューアル — 左ペイン(プロジェクト×セッションツリー・
  検索・rename/削除・workspace自動追従)/右ペイン(環境ウィジェット+📄プレビュー・計画・
  エージェント・進化・Debugタブ集約+バッジ)/リサイズ・折りたたみ・狭幅オーバーレイ・
  Ctrl+B/J/K。新IPCは追加のみ4本+file:reveal(sessions:search / sessions:rename /
  file:preview / workspace:gitStatus)。体感確認は `docs/M15-manual-test.md`
- **M14完了(2026-07-06・Windows実機で実装/検証・ベンチ④合格)**: 画像入力対応 —
  プロバイダ画像写像(Anthropicネイティブ/OpenAI互換レイヤ)/D&D・ペースト・スマホ📷添付/
  screenshotツール(localhost自動・外部URLはドメイン単位セッション許可+全件audit・非httpスキーム拒否)/
  画像blob外出し(sessions/blobs・50MB上限)/compaction画像テキスト化(ペア構造不変)/
  fullPcセッション中許可(M14-5・既定OFF・ツール×ディレクトリ粒度)。
  **ベンチ④(React→devサーバ→スクショ自己確認→見た目修正)を1.3分・介入0で完遂** —
  「UI確認不可」ギャップ解消(docs/autonomy-comparison.md)。体感確認は `docs/M14-manual-test.md`
- **M13完了(2026-07-05・Windows実機で実装/検証)**: QRコード接続/長期記憶+compaction強化/
  MCPクライアント(stdio)。実機確認済み(QR表示・memory追記・MCP filesystem 14ツール接続→
  承認バナー→実行)。残る体感確認は `docs/M13-manual-test.md`
- **M12完了(2026-07-05・Windows実機で実装/検証)**: 長丁場対応 —
  多重起動ガード(smoke非ロック)/セッション永続化+再開(強制終了→復元→文脈保持を実機確認)/
  計画ファイル(planツール+system prompt注入+パネル)/並列サブエージェント
  (mode:'work'・最大3並列・executor経由承認・write衝突拒否・出所バナー)。
  手動確認の残りは `docs/M12-manual-test.md`、ベンチ実測は `docs/autonomy-comparison.md`
- **M11完了(コード・5点全部)**: 自律開発能力の強化 — maxTurns設定化/バックグラウンドbash/
  自動チェックポイント/編集後フック/既定モデル claude-fable-5。
  Windows実機確認(taskkill・復元・フック体感・Fable実測)は `docs/M11-manual-test.md`
- **M10完了(コード)**: スマホ(iPhone)Webアクセス。main内蔵HTTPサーバ(REST+SSE、
  Node標準httpのみ・新規依存ゼロ)+独立ビルドのモバイルSPA(src/remote-ui)+
  トークン認証(sha256ハッシュ保存・timingSafeEqual・失敗バン)。
  ※**remote-ui の Vite ビルドのみ未実行**(サンドボックス制約)。Windows側で
  `npm run build` を一度実行すると out/remote-ui が生成され配信可能になる
- **M9完了**: 操作範囲のPC全体拡大(scopeMode: project / fullPc、全操作承認制)
- 進化ジョブ#1が成功済み: `csv_to_markdown` ツールが evolve/1 として昇格・稼働中

## ユーザーへの依頼事項

- **iPhone実機 + Tailscale の確認のみ残**(`docs/M10-manual-test.md` B節)。
  リモートアクセスは有効化済み・PC側検証(401/200/SSE/remote-ui描画/履歴同期)は完了。
  Tailscale はオンライン(morikawa.tailb1fb66.ts.net)
- **NSISインストーラ**: 開発者モードON または管理者ターミナルで `npm run dist`
- 済: Windowsビルド(out/remote-ui生成)、M9/M10(PC側)/M11 のWindows実機確認、
  Anthropicキー登録と実API検証(claude-fable-5 ツール連鎖・cache_read非ゼロ実測)。
  詳細は `VERIFICATION_REPORT.md`(2026-07-04〜05 帰宅後検証)

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

- 2026-07-03: M3 — LLMProvider抽象+Anthropic実装(messages.streamのイベント正規化、
  cache_controlをsystem/ツール末尾/履歴末尾に配置、AbortSignal対応)、
  エージェントループ(tool_use連鎖・maxTurns=30・キャンセル・refusal/max_tokens処理)、
  SecretStore(safeStorage暗号化、平文保存禁止)、設定UI(プロバイダ/モデル/APIキー/自動承認)、
  チャットUIにツール実行カード表示。
  検証: typecheck / vitest 58件 / ビルド / CDP E2E(設定パネル・キー未設定エラー・idle復帰)。
  実APIでのtool_use連鎖確認はユーザーのキー登録待ち

- 2026-07-03: M4 — 自己進化基盤。WorktreeManager(B作成/破棄、node_modulesジャンクション共有)、
  EvolutionJobRunner(実LLM用AgentJobRunner+モック差し替え可能なインターフェース)、
  検証ゲート(差分検査→typecheck→vitest→build+スモーク)、EvolutionManager(直列キュー、
  承認付き昇格 merge --no-ff + evolve/Nタグ + ホットリロード、健全性チェック失敗時の自動revert)、
  request_capabilityツール(ToolContext.evolution経由で注入)、進化パネル+昇格承認ダイアログ(diff・危険警告表示)。
  検証: typecheck / vitest 64件(実gitでの正常系・保護領域fail・却下・ロールバック・連番ID)/
  CDP E2E(進化パネル→手動enqueue→job_update反映→failed表示→worktree掃除確認)

- 2026-07-03: M5(部分)— ゲート不合格時のフィードバック付き再生成(1回)と生成例外リトライ(1回)。
  残りの実LLM通しE2Eはキー登録待ち
- 2026-07-03: M6 — OpenAIプロバイダ実装。tool_use⇔tool_calls / tool_result⇔role:tool の相互変換、
  ストリームチャンク正規化(分割arguments組み立て、finish_reason写像、usage/cached_tokens)、
  設定UIでの切替。既定モデル gpt-5.1。
  検証: typecheck / vitest 70件。実APIでの疎通確認はキー登録待ち

- 2026-07-04: M3/M5/M6 実API確認(OpenAIプロバイダ・gpt-5.1)—
  - M3: チャット指示で list_dir→read_file のツール連鎖が完遂、ストリーミング最中のキャンセルが
    即時に効きエラー扱いにならないことをCDP E2Eで確認
  - M5: request_capability発火(チャット経由)→B worktreeで実LLM生成(自己検証ループ込み)→
    4ゲート全合格→昇格ダイアログ(diff確認)→承認→merge+evolve/1タグ→ホットリロード→
    同一アプリで csv_to_markdown を実使用しMarkdown表を出力、まで通しで成功。
    ロールバック動作はM4の実git統合テストで検証済み
  - M6: 上記すべてがOpenAIプロバイダ上で動作(=M6完了条件のシナリオを包含)
  - 初回失敗と対策: 生成コードが noUncheckedIndexedAccess で2回typecheck失格
    → ジョブプロンプトにstrict規約と「完了前にtypecheck/vitest自走」を必須化して解消

- 2026-07-04: **M9 — 操作範囲のPC全体拡大(全操作承認制)**。テスト136→175件(新規39件)。
  - M9-1: `src/main/tools/scope.ts` — classifyPath(workspace/system)/ isDenied(ハード拒否)。
    realpathでシンボリックリンク・`..` 迂回をケア、Windowsパスは大文字小文字非依存。
    `AppConfig.scopeMode`('project'|'fullPc'、既定 'project')を追加
  - M9-2: `ToolPlugin.pathParams` 宣言(read_file/write_file/edit_file/list_dir/grep)と
    executor統合 — ハード拒否→即エラー、system×project→拒否、system×fullPc→強制承認
    (autoApprove / allow-session を無視。allow-sessionは受理しても記憶しない)
  - M9-3: bash(risk:'exec')は fullPc で常に毎回承認+「PC全体に影響し得ます」警告。
    進化ジョブの restrictExec は無条件で維持
  - M9-4: `src/main/audit.ts` — systemスコープの承認/拒否/実行結果を userData/audit.jsonl へ追記。
    ApprovalDialog にsystem警告バナー+解決済みパス表示+allow-sessionボタン非表示。
    Settings に scopeMode トグル(fullPc有効化時は確認モーダル)
  - M9-5: 回帰テスト(進化ガードレール guardrails.test.ts / executor.scope.test.ts)と
    `docs/M9-manual-test.md`(手動確認はユーザー実施待ち)

- 2026-07-04: **M10 — スマホ(iPhone)Webアクセス(SSE方式・新規依存ゼロ)**。
  テスト175→235件(新規60件)。設計書 `docs/M10-mobile-web-design.md`。
  - M10-1: コア抽出リファクタ(挙動変更ゼロ・単独コミット)。`src/main/core/service.ts`
    (AgentService: chatSend/chatCancel/approvalRespond/toolsList/evolution*/getStatus/
    getHistoryView/承認・昇格のpending追跡)+ `src/main/core/events.ts`(EventBus)。
    ipc.ts はIPCチャネル⇔サービスの薄い写像へ。ApprovalBroker に onSettled フック追加
  - M10-2: `src/main/remote/auth.ts` — トークン生成(randomBytes 32)/sha256ハッシュのみ
    config保存/timingSafeEqual比較/失敗5回で60秒IPバン。`AppConfig.remote`
    (enabled/port/tokenHash、既定 disabled・8787)。settings:set は remote を常に保持
    (専用IPCでのみ変更可)
  - M10-3: `src/main/remote/server.ts` — Node標準httpのみ。REST
    (/api/status|chat|chat/cancel|approval/respond|tools|evolution|evolution/enqueue|
    evolution/promote-respond|audit|history)+ SSE /api/events(接続直後にsnapshot、
    EventBus全チャネル中継、25sハートビート)+静的配信(パストラバーサル対策、
    ../ %2e%2e ..%5c を全て遮断するテスト付き)。audit.tail(limit) 追加
  - M10-4: `src/remote-ui/` — Vite+React+TSの独立SPA(window.api非依存・既存devDeps
    のみ・Tailwind不使用の素CSS)。Chat(ストリーミング/キャンセル/plan切替)、
    承認(diff・警告・systemバナー・昇格承認)、進化(一覧+enqueue)、監査タブ。
    トークンは #t= フラグメント→localStorage。`npm run build` に組み込み
    (`build:remote-ui`)。typecheck は tsconfig.remote.json を追加
  - M10-5: ipc.ts にサーバ起動配線(起動時 enabled なら listen、失敗は lastError で
    UI表示)+ remote:status/set-enabled/regenerate-token IPC + Settings
    「リモートアクセス」節(トークンは応答で一度だけ表示・URL組み立て・再生成確認)。
    承認競合: approval:resolved / job_update で両画面のダイアログを閉じる
    (first-response-wins。store単位の回帰テスト付き)
  - M10-6: README(セットアップ+Tailscale手順+セキュリティ前提)、
    docs/M10-manual-test.md、PROGRESS更新

- 2026-07-04: **M11 — 自律開発能力の強化(5点)**。テスト235→281件(新規46件)。
  設計書 `docs/M11-autonomy-design.md`。全ステップで進化ジョブへの非波及を
  guardrails.test.ts のソース・トリップワイヤ+挙動テストで機械的に固定
  - M11-1: `AppConfig.maxTurns`(未設定=30、1〜200クランプ、読込/保存の両方で正規化)を
    service 経由で runAgentLoop へ配線。Settings に数値入力
  - M11-2: `src/main/core/processes.ts` ProcessManager(出力リングバッファ256KB/proc、
    kill: Windows=`taskkill /pid <pid> /T /F`・他OS=detachedプロセスグループへSIGKILL、killAll)。
    bash に `background:true`、新ツール bash_output(safe)/ bash_kill(exec)。
    ToolContext.processes はメインセッションのみ注入。セッションキャンセルと
    アプリ終了(will-quit)で全kill
  - M11-3: `src/main/core/checkpoints.ts` CheckpointManager。一時 GIT_INDEX_FILE 上で
    add -A → write-tree → commit-tree(親=前チェックポイント or HEAD)→
    `refs/mycodex/checkpoints/<sessionId>` のみ更新。HEAD/index/他refs不変を実gitテストで固定。
    write/exec 成功後+ループ完了時に自動snapshot(変更なしskip)。
    checkpoint:list / checkpoint:restore IPC + Debugパネル復元UI(復元前に pre-restore へ自動退避)。
    非gitワークスペースでは完全noop
  - M11-4: `AppConfig.postEditHook`(空=無効)。executor で write_file / edit_file 成功直後に
    実行し、出力末尾4KBを `[post-edit hook]` として tool_result に追記(non-zeroでも成功のまま)。
    タイムアウト60s+フォールバックタイマー。restrictExec では注入されていても実行しない(二重防御)
  - M11-5: 既定モデルを claude-fable-5 へ(shared/models.ts / providers/anthropic.ts)。
    既定モデルでの cache_control 配置をテストで確認。実API検証はキー登録後

- 2026-07-05: **M12 — 長丁場対応(セッション永続化・計画ファイル・並列サブエージェント)**。
  テスト281→337件。設計書 `docs/M12-longrun-design.md`。Windows実機で実装・E2E確認
  - M12-0: 多重起動ガード。`requestSingleInstanceLock`(スモークモードでは取得しない —
    進化ゲートのheadless並行起動を壊さない。index.guard.test.ts+guardrailsで固定)。
    実機確認: A稼働中の二重起動は即quit・A稼働中の MYCODEX_SMOKE=1 は成功
  - M12-1: `src/main/core/sessions.ts` SessionStore(userData/sessions/<会話ID>.json、
    tmp→renameアトミック書き込み、8MB超は既存compactionで畳んでから保存、ロード時に
    未完了tool_useを合成tool_resultで修復=API 400対策)。会話IDを新設し
    ユーザー送信直後+各ターン完了+終了時に随時保存。sessions:list/load/delete/new IPC+
    セッション切替ドロップダウン。実機確認: 強制終了→再起動→復元→文脈保持(合言葉)
  - M12-2: planツール(workspace直下 MYCODEX_PLAN.md 固定・path入力なし・risk safe)。
    system promptへ「## 現在の計画」を毎ターン注入(compactionで失われない)+plan運用規範。
    計画パネル(checkbox進捗・自動更新)。進化ジョブではwrite拒否・読み取り専用サブエージェント非公開
  - M12-3: dispatch_agent拡張 `{task?, mode?: 'read'|'work', parallel?: {task}[]}`
    (未指定=完全従来挙動)。work子は全ツールを親のexecutor経由で実行(承認・スコープ・監査・
    フックがそのまま効く)、最大3並列・子maxTurns設定可(subAgentMaxTurns、既定30)。
    WriteLockTable(同一パスwriteは最初の子が所有)、fan-out直前チェックポイント、
    agent:sub_updateイベント+エージェントパネル、承認ダイアログ/remote-uiに出所バナー。
    ネスト1段・進化非注入をguardrailsで固定。
    実機確認: 2体並列で別ファイル同時生成・出所バナー・チェックポイント・git不変
  - 判断記録: セッション復元でworkspace設定は自動切替しない(メタ保存のみ)/
    work子にはprocesses(バックグラウンドbash)非注入(v1簡素化)/
    planはwork子から書けない(親が単独管理)
  - M12-4: ベンチ3課題を実測(docs/autonomy-comparison.md「実測」節)。
    ①TODO CLI 1.5分/7T ②Express+sqlite REST 2.9分/19T ③React 1.1分/6T、
    **全課題を介入ゼロで完遂・独立検証合格**。②初回試行で同期bashの
    キャンセル不能ハングが実害化 → bash修正(c8884a9: タイムアウト/キャンセル時に
    子孫ツリーtaskkill+フォールバック解決)

- 2026-07-05: **M13 — QR・コンテキスト管理強化・MCPクライアント**。テスト337→375件。
  設計書 `docs/M13-design.md`。依存追加: qrcode / @modelcontextprotocol/sdk(承認済みの2つのみ。
  @types/qrcode は追加せずローカル d.ts で対応)
  - M13-0: リモート接続URLのQR表示(buildRemoteUrl切り出し+テスト。トークン込みQRは
    有効化/再生成直後のみ・それ以外はトークン無しURL+注記)
  - M13-1: memoryツール(MYCODEX.md固定・学習メモ節へタイムスタンプ付き追記・rewrite整理)。
    compaction: 実測トークントリガー(usage input+cache_read、CONTEXT_LIMITSの70%、
    ループ内でも発火)/2段階圧縮(第1段: 古いtool_result切り詰め=ペア構造不変を
    テスト固定、第2段: 構造化要約5セクション)/「## 記憶へ退避」を学習メモへ自動退避
  - M13-2: McpManager(stdio・mcp.json・起動非ブロック・mcp__<server>__<tool>で外部登録・
    名前衝突拒否)。risk写像 readOnly→safe/destructive→exec/その他→write/annotationsなし→exec。
    サーバー単位信頼確認・承認/remote-uiに出所バナー。テストはInMemoryTransportのモックサーバー
  - 非波及: memory/MCPはguardrailsで固定(進化ジョブ=自前registryで構造上不可視+トリップワイヤ、
    読み取り専用サブエージェントから memory/mcp__ 除外)
  - 判断記録: MCP子プロセスはSDKのtransportが所有するため ProcessManager 登録ではなく
    will-quit で McpManager.closeAll()(ユーザー承認済み)/ CONTEXT_LIMITS は保守的既定
    (claude-*/gpt-5*: 200k、gpt-4.1: 1M、gpt-4o: 128k、未知: 200k)

- 2026-07-06: **M14 — 画像入力対応(UI検証の完成)**。テスト375→403件。設計書 `docs/M14-design.md`
  - M14-1: ContentBlock image / tool_result.images(テキストのみ履歴と後方互換)。
    Anthropicネイティブ写像・OpenAIは tool_result 画像を直後 user へ注入する互換レイヤ。
    compaction は画像を概算1600トークンで計上し古い画像を「[画像: 説明]」置換(ペア構造不変)。
    SessionStore は sha256 content-addressed で sessions/blobs/ へ外出し・50MB超過で古い画像から
    テキスト化・欠損blob耐性
  - M14-2: chat:send 任意images引数(1枚10MB・8枚)。screenshotツール(ToolContext注入方式・
    ToolPlugin.dynamicApproval 新設)。localhost=safe自動/外部URL=毎回承認+ドメイン単位
    セッション許可/自動許可含め全件audit/file://等拒否。進化ジョブ非波及をguardrails固定
  - M14-3: 添付サムネイル・ツールカード画像プレビュー・remote-ui📷添付(検証共通化)
  - M14-5: fullPcAllowSession(既定OFF)。ONでツール×ディレクトリ粒度のセッション許可、
    exec対象外・ハード拒否不変・自動通過も全件audit
  - M14-4: ベンチ④合格(1.3分・介入0・スクショ2枚・build独立検証・残プロセス0)。
    初回試行はscaffoldの対話プロンプトでモデルが質問し失格 → プロンプトに
    「質問せず自分で判断」を明示して再実行(手順は autonomy-comparison.md に記録)
  - 判断記録: 画像トークンは実データ長でなく定数概算(1600tok)/ blobs は content-addressed
    共有のため自動GCしない(欠損時はロードで置換テキスト化)/ LAN内IPも「外部」扱い

- 2026-07-06: **M15 — 3ペインUIリニューアル**。テスト403→411件。設計書 `docs/M15-ui-design.md`。
  依存追加: react-markdown / remark-gfm(許可済みの2つのみ)。既存IPCは不変(追加のみ)。
  各ステップでCDPスモーク(既存機能到達性込み)を実施し全通過
  - M15-1: SidePane(リサイズ・折りたたみ・localStorage・狭幅オーバーレイ)
  - M15-2: 左ペイン=workspace×セッションツリー+検索(sessions:search)+rename
    (sessions:rename)+削除。セッション切替でworkspace自動追従(M12制約解消)
  - M15-3: file:preview / file:reveal(M9スコープ判定・md/コード/画像・1MB/8MB上限・
    バイナリ拒否)。ツールカード・本文中パスのリンク化→右ペイン自動オープン
  - M15-4: workspace:gitStatus+環境ウィジェット、パネルタブ集約+実行中バッジ、
    ヘッダボタンのタブ化、Ctrl+B/J/K
  - 判断記録: 「フォルダで表示」用に file:reveal を追加(設計リスト外だが追加のみの制約内。
    表示可能判定を通したパスのみ開く)/ ChatViewのセッションドロップダウンは互換のため残置/
    本文パスのリンク化は正規表現マッチ(実在チェックはクリック時)

- 2026-07-06: **M15.1 — remote-uiバグ修正と小機能**。テスト411→424件
  - 【バグ】スマホ写真添付が無反応: 原因は remote サーバの body 上限 256KB(写真base64が413で
    破棄)。/api/chat のみ24MBへ拡大+remote-ui側で送信前に長辺1568px・JPEG(0.85)へ自動圧縮。
    実HTTPの結合テストで2.7MB受理・24MB超拒否・不正payload 400 を固定
  - 【機能】remote-uiにセッション切替: GET /api/sessions + POST /api/sessions/load を追加公開。
    service.sessionOpen が実行中ガードとworkspace追従をサーバ側で強制(追従は「既存セッションの
    記録値」限定のためリモート公開可と判断。settings:set自体は引き続き非公開)
  - 【バグ】PWA(ホーム画面)でトークン再入力: 原因は (a) manifest start_url が #t= を落とす
    (b) 初回ロードで replaceState がフラグメントを即削除 → 追加時URLに #t= が無い
    (c) PWAはSafariと保存領域が別。対処: start_url削除+**フラグメント削除をやめる**
    (ユーザー決定。トークンはURLフラグメントのままサーバへ送信されず端末内に留まる)+
    抽出を緩い正規表現に(extractTokenFromHash・テスト付き)+ゲートに説明文
  - ライブcurl検証は保持トークン失効(再生成済み)+認証失敗バンのため中止し、
    実HTTP+実認証の結合テスト(server.test.ts)を検証根拠とした。スマホ実機の
    再確認手順は docs/M15-manual-test.md「M15.1」節
- 2026-07-06: M16 — 一晩自走テスト(AICAD・計画27/27完遂・介入0)の知見反映
  - M16-0: 実測記録を docs/autonomy-comparison.md へ追記(所要時間・トークン・モデル切替2回・
    弱点3件=切替時compaction無し/残高切れで停止/コピー手段無し → M16-1/2/3の根拠)
  - M16-1: モデル切替検知compaction — SessionData.lastLLM、service.compactOnSwitch、
    loop.onUsage フック(単一ターンでも実測トークンを記録する実バグ修正込み)、infoカード
  - M16-2: llmErrors.classifyLLMError(billing判定を429より優先)、指数バックオフ最大3回、
    acquireFallback(発動audit `provider-fallback`・警告カード)、Settingsフォールバック節
  - M16-3: markdownBlocks共有スプリッタ+MarkdownMessage(コピー✓フィードバック・
    CDPスモークでOSクリップボード実測一致)
  - M16-4: styles.cssアニメ基盤+animPref(localStorage)+CDPスモーク
    (reduced-motionエミュレーションで無効化を実測)
- 2026-07-06: **M17 — リブランド(AMA-teras)+自律モード+左ペインソート修正**。テスト458→515件
  - M17-1: リネーム MyCodex → AMA-teras。userDataMigration.ts(実データ有無で移行判定・
    マーカー冪等・旧dir温存)。**実機で発覚した重要バグ**: safeStorage(DPAPI)の鍵素材は
    Chromiumの「Local State」(os_crypt.encrypted_key)にあり、これを移行しないと
    secrets.json が復号不能=キー消失に見える → コピー対象へ追加し実機で復号確認(M17-1fix)。
    AMATERAS.md / AMATERAS_PLAN.md へ改称(旧名読み込み互換+初回書き込みrename移行、
    プラグインは実行時トランスパイルのため互換ロジックを各ファイル内で自己完結)
  - M17-2: 自律モード。executor.getAutonomous(全リスク+system+動的承認を自動承認・
    全操作audit autonomous:true)、scope.ts autonomousオプション(システム領域=既存上書きのみ拒否・
    新規作成許可)、autonomy.ts denylist(format/diskpart/mkfs/dd physicaldrive/
    del・rd system/rm -rf/reg delete HKLM/cipher /w/bcdedit /delete/vssadmin delete shadows)、
    UIトグル+モーダル+警告バー、remote-ui(POST /api/autonomous・ONはconfirmed必須)、
    進化非波及guardrail。実機CDPでモーダルdisabled→ON→バー→OFFを確認
  - M17-3: sessionGroups.groupSessionsByProject(最新updatedAt降順・安定・選択非依存)+LeftPane適用
  - M17-4: docs/M17-manual-test.md、USER-GUIDE(自律モード節・名称)、本ファイル更新
- 2026-07-06: **M18 — モデル自動切替(planner/worker/escalation)**。テスト515→532件
  - M18-1: AppConfig.modelPolicy + parseModelPolicy(壊れた形は無効へ・格上げ回数0〜3クランプ)
  - M18-2/3: 帯ルーティング(chatSend=planner、subagent=worker、currentLLM/compaction閾値も
    planner基準でM16-1と整合)、runWorkSubAgentのエスカレーションループ(compact経由・
    履歴引き継ぎ・プロバイダ横断でtool_use/resultペア不変をテスト固定)、
    acquireChildFallback(子ループ用M16フォールバック・メインのrunProvider/lastLLM非干渉)
  - M18-4: ModelPolicySection(Settings)+plannerバッジ+⤴格上げバッジ
  - M18-5: ベンチ②実測(2.3分・vitest10/10・worker委譲でコスト約半減)→autonomy-comparison.md、
    docs/M18-manual-test.md、USER-GUIDE「モデル自動切替」節
- 2026-07-06: **M19 — 品質レビュー・ゲート(planner採点→差し戻し)**。テスト532→566件
  - M19-1: AppConfig.reviewGate + parseReviewGate(クランプ・axes補完)+ AgentEvent 'review'
  - M19-2: review/gate.ts(レビュアーエージェント=読み取り専用+localhost限定screenshot、
    JSONパース=抽象指摘の機械排除、runReviewCycle、buildFixTask)+ planDiff.ts
  - M19-3: service配線(planツールdiffでマイルストーン検知→同期レビュー→tool_result追記、
    完了時縮退、fix=runParallelSubAgents(work)でM18/M16配線をそのまま利用、
    上限到達の承認/警告分岐)+ 進化非波及guardrail(発動箇所2箇所固定)
  - M19-4: ReviewCard(4軸表+指摘リスト)+ chat/remote-uiストア + Settings「品質レビュー」節
  - M19-5: 実測(バグ入りコード検出→改善 2.33→4.33、ベンチ②ON +$0.15/+78%)→
    autonomy-comparison.md、docs/M19-manual-test.md、USER-GUIDE「品質レビュー」節

## 次のタスク

- (ユーザー)iPhone実機+Tailscale(docs/M10-manual-test.md B節)、NSISインストーラ
  (開発者モードONで `npm run dist`)
- docs/M12-manual-test.md の残り体感確認(ツール実行中の強制終了→復元、キャンセル伝播、
  スマホからのサブエージェント承認)
- **QRコード表示**(設計書の後続タスク): `qrcode` 依存を追加し、Settingsの接続URLを
  QR表示する。依存追加を伴うためユーザー承認後に実施
- M9残: 進化ジョブ生成プロンプトへの pathParams 宣言の追加
- SSE の Last-Event-ID 対応(現状は再接続時 snapshot で全量回復。会話が長大化したら検討)
- 多重起動ガード導入済みだが、`second-instance` での引数引き継ぎ(ファイルを開く等)は未対応

## 既知のバグ・課題

- (M10) **remote-ui の Vite ビルドが未実行**(サンドボックスは rollup のネイティブ
  パーサ不可)。`npm run build` 実行までリモートUIは配信されない(サーバ自体・APIは稼働)。
  esbuildバンドル(構文・import解決)と typecheck・ユニットテスト235件は合格済み
- (M10) パッケージ(NSIS)版では out/remote-ui が asar 内に含まれる想定
  (electron-builder files: out/**)だが、パッケージ版での配信動作は未検証
- (M10) SSE snapshot の履歴はテキスト+ツール名のみ(実行中のツールカードの生死は
  復元しない)。リモート接続中のライブイベントでは完全表示される
- (M10) 認証バンは接続元IP単位。Tailscale内(=同一tailnetの少数端末)前提の簡易実装
- (M11) チェックポイント復元は「上書き」方式。復元先チェックポイント作成後に新規作成された
  ファイルは削除されない(pre-restore 退避で往復は可能)
- (M11) `refs/mycodex/checkpoints/*` の自動掃除(世代上限・GC)は未実装。手動削除手順は
  docs/M11-manual-test.md に記載
- (M11) postEditHook タイムアウト打ち切り時、フックの孫プロセスが残る可能性
  (メッセージで明示。spawn timeout はシェルしか殺さないため)
- (M11) postEditHook の発火はツール名 write_file / edit_file 固定。生成ツール(csv_to_markdown等)
  の書き込みには発火しない(M9のpathParams未宣言問題と同系)
- (M11) ~~taskkill /T /F の実動作は Windows 実機未確認~~ → 2026-07-05 実機確認済み
  (孫プロセスまで死亡。VERIFICATION_REPORT.md)
- (M12) セッション復元は履歴のみ。実行中だったバックグラウンドproc・承認待ちは復元しない(仕様)
- (M12) work サブエージェントに processes 非注入(バックグラウンドbash不可)。必要になったら注入検討
- (M12) WriteLockTable は pathParams 宣言済みツールの write のみ対象(bash 経由の書き込みは対象外。
  restrictExec と同根の制約)
- (M12) **チェックポイントが .gitignore の無い workspace で node_modules ごと snapshot する**:
  `git add -A` が数十秒かかり、その間 UI は idle 表示でも activeRun が未クリアで
  次の送信が「別の実行が進行中」になる。対策候補: 一時 index への add 時に
  node_modules/dist を既定除外、または activeRun クリアを終端イベント直後へ移す
- (M11) セッションキャンセルでバックグラウンドprocも全kill(設計どおり)。セッションを跨いで
  dev server を維持したい場合は再起動が必要
- (M9) スコープ判定は `pathParams` を宣言したツールのみ対象。未宣言ツール
  (csv_to_markdown 等の生成ツール)がパスを受け取る場合は判定対象外
  (safe/writeのrisk承認は従来どおり効く)
- (M9) dispatch_agent のサブエージェントは executor を通さず safe ツールを直接実行するため、
  workspace外の「読み取り」がスコープ判定を受けない(書き込み/実行は元々不可)
- ~~(M9) audit.jsonl の閲覧UIは未実装~~ → M10 のスマホUI監査タブで提供済み

## 決定事項ログ

### M21/M22での判断(2026-07-06 夜間自走)

- **追加指示の注入は「直前のuserメッセージ末尾へのtextブロック追記」**: Anthropicは
  tool_result先頭規約に適合し、OpenAI互換層は順に分解されるため両プロバイダで安全。
  独立したuserメッセージ挿入は連続userの扱いがプロバイダ依存になるため避けた
- **応答完了時に残っていた追加指示は新userメッセージでループ継続**(取りこぼし禁止)
- **narrationはtext_deltaの再利用**(APIコスト追加なし)。500ms/1sスロットルでIPC負荷を抑制
- **⏳無応答の判定はrenderer側タイマー**(main側にタイマーを持たない=クリーンアップ不要)
- **M22はイベントへのconversationId一括付与で多重化**(emitクロージャ1箇所で注入。
  イベント型の破壊的変更なし=後方互換)。renderer側は「表示中の会話だけ反映」+
  conversationId未確定間のイベントはバッファし、chatSendの戻り値で確定後に再生
  (先着runsList照合方式は自ランを誤除外するバグになった→実機スモークで検出し方式変更)
- **ランのworkspaceは開始時に固定**: 視聴切替でconfig.workspaceが変わっても実行中ランの
  cwd/スコープ/チェックポイント/記憶計画の読み書きは元プロジェクトに束縛される
- **自律モード(M17)を会話単位へ再定義**: 切替で他会話の自律ランを壊さない。
  新規/ディスクからのロードは常にOFF・再起動で全OFF・昇格承認の人間必須(M20不変条件3)は不変
- **バックグラウンドプロセス(M11-2)を会話単位のProcessManagerへ**: 会話Aのcancelが
  Bのdevサーバを殺さない
- **checkpointRestoreは同一workspaceにランがある間だけ拒否**(全体ブロックから緩和)
- **進化ジョブは引き続き直列キュー**(並行化しない。B worktreeの競合を避ける)

### QR非表示バグ修正での判断(2026-07-06)

- **リモート接続ホスト名はconfig.json(remote.host)へ永続化**: 旧実装はrendererのlocalStorage
  保存で、M17のuserData移行に「Local Storage」(leveldb実体)が含まれず消失→ホスト空→URL組めず
  →QR非表示、が原因だった。UI側は旧localStorage値からの自己修復(読み取り→config保存)つき
- **userData移行のCOPY_ENTRIESに「Local Storage」「Session Storage」を追加**(再発防止・
  将来の移行向け。テストで固定)


### 整理タスクでの判断(2026-07-06)

- **「フォルダで開く」はworkspace外制限を課さない**: エクスプローラーに場所を見せるだけで
  内容は読まずrendererにも返さないため。左ペインには現在以外のプロジェクトも並ぶので必須。
  保護領域denyは多層防御として維持
- **service.ts の SYSTEM_PROMPT内「コーディングエージェント」は据え置き**: ユーザー向け表記の
  統一(副題・README・package.json)とは別物で、モデルへの機能定義。変えると挙動に影響し得る
- **アイコン生成は依存追加なし**(稼働中ChromiumのcanvasをCDP経由で使用・段階縮小+角丸クリップ)。
  icoはPNG圧縮エントリのマルチサイズ(Vista+標準)。build/candidates と icon.svg は旧検討の
  残骸なので未追跡のまま

### M20での判断(2026-07-06 自律作業。planはユーザー承認済み+不変条件3件指定)

- **聖域判定はA側のメモリ上PROTECTED_PATHSのみ**(ユーザー指定の不変条件1):
  worktree B側のprotected.tsをrequire/importして判定に使うことを構造的に禁止
  (ソーストリップワイヤテスト+「Bで無力化しても捕捉」実証テストで固定)
- **IPC聖域の粒度は ipc.ts + preload + shared/ipc.ts の丸ごと保護**: チャネル単位の
  細分化は「安全な追加」と「承認バイパスの追加」を機械で区別できないため、太く守る
- **`src/shared` はrenderer scopeに含めない(=core扱い)**: 型定義経由でmain側挙動に
  影響し得るため、UI変更の名目でshared改変されるのを防ぐ
- **--smoke-boot は単一インスタンスロックを取らずuserData隔離(mkdtemp)**(不変条件2):
  稼働中Aと並走して健全性チェックできる。MYCODEX_SMOKE既存スキップに乗せ、
  配線をソーストリップワイヤテストで固定
- **昇格承認は自律モードでも絶対に自動化しない**(不変条件3): 挙動テスト
  (autonomous ON+全自動承認ONでもrespondまで未解決)+承認フローにautonomousMode参照が
  ないことのソース検査で二重固定
- **健全性は「再起動前」に判定**: B側スモーク+A側再ビルド後スモークの二重ゲートで
  合格したときだけ再起動する。センチネル/セーフモードは「それでも起動後に壊れた」ときの二次防衛
- **rollbackLastEvolve はHEAD==最新evolveマージのときだけ自動revert**: それ以外は
  手動手順を提示(履歴が進んだ後の自動revertはコンフリクトで中途半端に壊すリスクの方が大きい)
- **M19品質レビューの進化ジョブ適用は見送り**(ユーザー承認済み): ゲート7段+人間承認が
  既にあり、レビュー追加はコスト増に見合わない。必要になれば後続で
- **symlink差分(mode 120000)は聖域チェックで一律拒否**: 聖域外パスからのリンクで
  実体を聖域に向ける迂回を塞ぐ
- **コミット順を3(スーパーバイザー)→4(配線)に入替**: 未完成のrenderer/core昇格経路が
  一瞬でも露出しないように、受け側を先にコミット

### M19での判断(2026-07-06 自律作業。planはユーザー承認済み)

- **マイルストーンレビューはツール実行内で同期実行し、要約をplanのtool_resultへ追記**:
  メインモデル自身が合否を認識して次の行動(残課題対応など)に反映できる
- **レビュアーは会話履歴を見ない**(userRequest+計画+実ファイルのみ): 「自分が書いた前提を
  持たない第三者」を構造的に強制。メインが「修正するな」と縛られていても検出できる(実測済み)
- **レビュー自体の失敗(JSON不出力・キャンセル)は素通し+警告**: レビュアーの不調で
  本体タスクを壊さない。再レビュー失敗時は「未解決」扱い(素通しにしない)
- **抽象指摘はパーサで機械排除**: findingsはfile/location/problem/fixの4フィールド必須。
  欠けた指摘は捨てる(プロンプト指示だけに頼らない)
- **レビュアーのscreenshotはlocalhost限定**: executor承認フローを経由しないため、
  外部URLは機械拒否(プラグインのdynamicApprovalと同等の制約を直接実装)
- **完了時縮退レビューはwrite/exec成功があった会話のみ**: 質問・調査だけの会話に
  レビューコストをかけない
- **上限到達の承認deny=そのまま終了+指示待ち案内**(追加ラウンドは回さない): 無限ループ防止を
  優先し、続きはユーザーの明示指示で
- **fix実行はrunParallelSubAgents(work)を単タスクで再利用**: 承認・スコープ・監査・
  M18エスカレーション・M16子フォールバック・サブエージェントUIが自動で効く

### M18での判断(2026-07-06 自律作業。planはユーザー承認済み)

- **createProvider()(進化ジョブの経路)はmodelPolicyを一切参照しない**: 帯選択はchatSend側の
  createBandProviderに分離。「進化はpolicyの影響を受けない」をコード構造で保証+guardrailテスト
- **帯プロバイダのキー判定はfactory差し替えより先**: キー未登録の警告経路もテスト可能にするため
- **worker帯キー未登録は停止でなくplanner代行+警告カード**: 横断構成の取りこぼしで作業が
  止まるより、高い方のモデルで続行する方が自走の趣旨に合う
- **エスカレーションのトリガー(c)は「ツール失敗3連続」**(isError または 編集後フック失敗を
  本文パターンで検出)。成功で連続カウントはリセット
- **子ループのフォールバックは専用のacquireChildFallback**: メインのacquireFallbackを共用すると
  メインのrunProvider/lastLLMが子の課金エラーで書き換わるため分離。1会話1回の制限
  (fallbackUsedFor)は共有。子履歴は小さいので切替前compactionは省略
- **チャットのバッジは「メイン応答=planner・サブパネル=worker/⤴格上げ」の最小実装**:
  ツールカード単位のバッジは情報過多と判断(必要になれば追加)
- **ベンチ後の設定復元でmodelPolicyはenabled:false+帯設定保存**: ユーザーがSettingsで
  ワンクリック有効化できる状態にした(既定は無効の絶対条件は維持)

### M17での判断(2026-07-06 自律作業。planはユーザー承認済み)

- **userDataの移行判定は「ディレクトリ存在」でなく実データ(config.json等)の有無**:
  electronがキャッシュ用に新dirを先に作るため、存在判定だと移行がスキップされる(実機で確認)
- **「Local State」を移行対象に追加**(M17-1fix): safeStorageの鍵素材。実データ判定には使わない
- **自律モードでもuserDataへの新規ファイル作成は拒否のまま**(設計書の「新規作成許可」は
  Windowsシステム領域にのみ適用): plugin-cacheへの新規.mjs設置=次回ロードでのコード注入経路になるため
- **denylistは自律モード限定**: 通常モードは人間の目視承認が防波堤であり、機械判定の
  誤検出で正当な承認済みコマンドを塞がない
- **自律モード状態はメモリ内のみ**(configに保存しない): 再起動OFFの要件を構造的に満たす。
  セッション切替・新規でも setAutonomous(false)
- **リネームで変えないもの**: リポジトリパス・`refs/mycodex`(既存チェックポイント互換)・
  localStorageキー`mycodex-*`(**変えるとスマホのremote-tokenが消えて再ログインになる**)・
  `MYCODEX_SMOKE`等の内部識別子・進化タグ`evolve/N`・worktreeBase `../mycodex-evolve`
- **旧ショートカット「MyCodex.lnk」はそのまま動く**(electron.exe . を指すため)。リネームは任意

### M16での判断(2026-07-06 自律作業・ユーザー確認なしで決定)

- **フォールバックは本体provider設定を書き換えない**(計画承認済み)。実行中の会話の
  LLMProvider インスタンスだけ差し替え、次の新規会話は本体設定で開始する
- **billing判定はHTTPステータスより優先**: OpenAIのinsufficient_quotaは429(通常transient)、
  Anthropicの残高枯渇は400(通常fatal)で来るため、メッセージ正規表現を先に評価する
- **フォールバックの往復ループ禁止**: 1会話(conversation.id)につき1回・切替先=現行と同一なら拒否
- **remote-uiのmarkdownは全レンダリングせずフェンス分割のみ**(コードブロック+コピーだけ提供)。
  依存追加なし方針とモバイルの表示崩れリスクを優先。スプリッタは src/shared で共有しユニット固定
- **未クローズフェンス(ストリーミング途中)は「そこまでをコード」として表示**
  (閉じフェンス到着で自然に確定する。チラつき防止で判定を遅らせるより単純)
- **アニメ設定はlocalStorage**(承認済み)。AppConfigに入れない=mainプロセス・進化ジョブに不波及。
  `<html data-anim>` 属性 + CSSセレクタで一括制御し、コンポーネント側はクラス付与のみ
- **prefers-reduced-motion はSettingsトグルより優先して無効化**(OSのアクセシビリティ設定を尊重)
- **loop.onUsage フックを追加**(M16-1): lastPromptTokens が compact コールバック(turn>0)でしか
  更新されず単一ターン会話で常に0だった実バグの修正。テスト側を曲げずに本体を直した

- 2026-07-03: 開発マシンに Node.js が無かったため winget で LTS (v24.18.0) を導入
- 2026-07-03: APIキー保管は keytar でなく Electron 組み込みの safeStorage を採用
  (keytar が非メンテのため。CLAUDE.md「keytar等」の範囲内と判断)
- 2026-07-03: IPC payload の実行時検証は手書きガード(zod 不採用 — 外部依存最小方針)
- 2026-07-03: 進化ジョブの B worktree は `../mycodex-evolve/job-<N>`、node_modules は
  ジャンクションで A と共有。依存追加を要するジョブは fail 扱い(依存最小方針)
- 2026-07-03: 既定モデルは claude-opus-4-8(設定で変更可)。thinkingは未使用
  (tool_use連鎖でthinkingブロックのエコーバック管理が必要になるため、M7以降で検討)
- 2026-07-03: M3のエージェント作業ディレクトリは暫定でアプリのルート(app.getAppPath())。
  ワークスペース選択UIはM7で追加予定
- 2026-07-03: 検証ゲートの順序をARCHITECTURE.md原案(typecheck→vitest→smoke→差分検査)から
  「差分検査を最初」に変更。保護領域を書き換えた生成コードを、コード実行を伴う後続ゲート
  (vitest等)で走らせる前に落とすため(ARCHITECTURE.md §6.2も更新済み)
- 2026-07-03: 進化ジョブ内のツール実行は自動承認(昇格時に人間の承認+diff全文表示があるため)。
  昇格承認ダイアログでは child_process/ネットワークをdiffから機械検出して明示警告
- 2026-07-04: bashの保護領域バイパス対策は、executor層でのパス強制が不可能(shellをパースできない)
  ため、進化ジョブでは実行できるコマンド自体を検証系(npm run/npx vitest/npx tsc)に限定する方式を採用
  (ToolContext.restrictExec)。判定はプラグイン規約によりbash.ts内に持つ。残余リスク: npm scriptsの
  範囲内。node_modulesジャンクション経由の改変はbashからの任意コマンドを塞いだことで大幅に縮小
- 2026-07-04: コンテキスト圧縮の境界はuserテキストターンの先頭。tool_use/tool_resultを分断すると
  API400になるため(指摘#1と同根)。要約は現行プロバイダのcompleteで実施(プロバイダ非依存)
- 2026-07-04: サブエージェントは ToolContext.subagent 経由で注入(evolutionと同パターン。プラグインは
  コアをimportできないため)。子は読み取り専用ツールのみ・別history・要約のみ親へ返す
- 2026-07-04: パッケージ版のプラグインは .ts を extraResources で resources/plugins へ同梱し、
  esbuildで実行時トランスパイル。esbuildネイティブバイナリはasarUnpack+ESBUILD_BINARY_PATHで解決。
  進化(git/worktree)はソースツリー前提のためパッケージ版では基本ツールのみ(既知の制約)
- 2026-07-04: electron-builderのNSISインストーラ生成は、winCodeSign展開時のmacOSシンボリックリンク
  作成にWindowsのシンボリックリンク権限が要り現環境でブロック。開発者モードON or 管理者実行で解消。
  コード署名は不要方針(CSC_IDENTITY_AUTO_DISCOVERY=false)

### M9での判断(2026-07-04 自律作業・ユーザー確認なしで決定)

- **projectモードのsystemスコープは「即拒否」**(設計書の挙動マトリクスどおり)。
  厳密には従来、workspace外パスも(承認さえ通れば)操作できたため挙動変更になるが、
  設計書の「'project' = 従来どおりworkspace内のみ」という意図を優先した。
  「後方互換」は「workspace内の操作・既存テスト・進化ジョブの挙動が不変」という解釈
- **userDataはwrite全面ハード拒否、secrets.jsonはreadもハード拒否**(暗号化済みでも
  鍵素材をLLMコンテキストへ晒さない)。config.jsonのreadは許可(現状の挙動を維持)
- **fullPcでのexec強制承認は bash に限らず risk:'exec' の全プラグインに適用**
  (どのパスに触るか静的に判定できない点はbashと同じため)
- **スコープ制御はexecutorに一元化**し、`ExecutorDeps.getScopePolicy` 未指定なら完全に従来挙動。
  進化ジョブ(AgentJobRunner)には注入しない=fullPc設定が進化ジョブへ波及しない。
  guardrails.test.ts のソース・トリップワイヤで「注入しないこと」自体もテストで固定
- **pathParamsはopt-in宣言**(inputSchemaからの自動推測はしない)。誤検知でツールが
  使えなくなるより、組み込みツールで確実に効くことを優先。未宣言ツールは既知の課題に記載
- **検証環境**: 今夜の検証はLinuxサンドボックスの /tmp クローンで実施。ネットワーク遮断のため
  npm installが不可能になり、Windows側 node_modules をコピーし esbuild(linux版に差替)+
  rollup(parseAstをacornに差替)のサンドボックス限定パッチで vitest を駆動した
  (リポジトリのコードには一切影響なし)。検証は最終ツリーで typecheck+vitest 175件一括合格を
  確認後にステップ単位でコミット分割(コミットごとの逐次検証は環境制約により省略)

### M11での判断(2026-07-04 深夜 自律作業・ユーザー確認なしで決定)

- **チェックポイントは `AgentServiceDeps.createCheckpoints` で注入する opt-in 構成**
  (service 内で CheckpointManager を直接 new しない)。理由: (1)ユニットテストが
  実行中リポジトリへ refs を書かない (2)進化ジョブ・テスト環境への非波及が構成レベルで
  保証される。実配線は ipc.ts のみ
- **チェックポイント復元は「上書き」**(`git restore --source=<sha> --worktree -- .` 相当)。
  チェックポイント後に増えたファイルは削除しない — 誤削除より安全側に倒した
  (pre-restore への自動退避で往復可能)
- **snapshot の skip 判定は「直近チェックポイント(無ければHEAD)との tree 比較」**。
  クリーンな作業ツリーでは ref を作らない。一覧はコミットメッセージ接頭辞
  `[mycodex-checkpoint]` でチェーンを打ち切る(親がHEAD以前の通常履歴に繋がるため)
- **一時indexは read-tree HEAD から開始**(空indexからの add -A だと tracked かつ
  .gitignore 対象のファイルを取りこぼすため)
- **postEditHook の発火対象はツール名 write_file / edit_file 固定**(risk:'write' 全般ではない。
  設計書の文言どおり。生成ツールへの適用は見送り=既知の課題へ)
- **postEditHook は spawn timeout + フォールバックタイマーの二段構え**。spawn の timeout は
  シェルのみを kill し、孫プロセスが stdio を握ると close イベントが発火せずループが固まる
  ことをテストで確認したため(タイムアウト+0.5秒で必ず戻る)
- **セッションキャンセルでバックグラウンドprocも全kill**(設計どおり)。ProcessManager の
  platform とバッファ上限はコンストラクタ注入にし、Windows kill コマンドの組み立て
  (`taskkill /pid <pid> /T /F`)を単体テストで固定(実動作は実機確認事項)
- **bash の background は restrictExec 判定の後**に処理(進化ジョブでは許可コマンド自体が
  検証系のみ+processes 未注入の明示エラーで二重に塞がる)
- **チェックポイントの committer は `mycodex-checkpoint` に固定**(`-c user.name/email`)。
  git identity 未設定の workspace でも snapshot が失敗しない
- **検証環境**: M9/M10 と同じ /tmp クローン+パッチ済み node_modules。mountキャッシュ不整合
  (host編集済みファイルが mount から古い/切詰め内容で見える)に複数回遭遇したため、
  「/tmp へスクリプトでパッチ→typecheck+vitest→cp+rename(.fresh→mv)で mount へ配置→
  git diff --cached 確認→コミット」の手順に固定した

### M10での判断(2026-07-04 自律作業・ユーザー確認なしで決定)

- **設計書のM10-1〜M10-6のステップ定義が文書末尾の欠損で読めなかった**
  (docs/M10-mobile-web-design.md が「apple-mobile-we」で途切れている)ため、
  文書の構成に沿って自分でステップを再構成した:
  M10-1=コア抽出 / M10-2=認証+config / M10-3=HTTP+SSEサーバ / M10-4=remote-ui /
  M10-5=配線+デスクトップUI+承認競合 / M10-6=ドキュメント
- **EventBus のチャネル名は既存IPCチャネル名と同一**('chat:event' 等)にして
  IPC・SSE双方への写像を単純化。SSE の event 名もそのまま使う
- **静的配信(UI本体)は認証不要**とした。SPAシェルは秘匿情報を含まず、トークン入力前に
  ブラウザがページを読めないと成立しないため。/api/* は全て認証必須
- **リモートからの allow-session はサーバ側で allow に降格**(UI側でもボタンを出さない)。
  セッション永続の許可は端末を目視しているデスクトップ操作に限る
- **remote設定はsettings:setから変更不可**(専用IPCのみ)。renderer全体を信頼はしているが、
  tokenHash の誤消去・改変経路を機械的に塞ぐため
- **トークン平文は remoteSetEnabled / remoteRegenerateToken の戻り値でのみ返し、
  どこにも保存しない**。UIを閉じたら再表示不可(再生成で対応)
- **remote-ui は Tailwind 不使用の素CSS**。既存devDepsのみ制約下でビルド構成を最小化し、
  サンドボックスでのビルド失敗要因を減らすため
- **snapshot方式の状態回復**(Last-Event-ID なし)。再接続時は全量snapshotで十分小さい
- **サンドボックスでは vite build(rollupネイティブparseAsync)が動かない**ことを確認
  (acornパッチはparseAst系のみ有効。バイナリASTを返すparseAsyncは代替不能)。
  代替として esbuild で remote-ui をバンドルして構文・依存解決を検証し、
  Vite実ビルドは「Windows側で npm run build」に委ねた
- **out/remote-ui はパッケージ版では asar 内から配信**(electron-builder files に out/**
  が既に含まれ、electronのfsはasarを透過的に読めるため extraResources 追加は不要と判断)
