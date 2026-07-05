# PROGRESS

## 現在の状態

- **M1〜M15まで実装**。テスト411件・typecheck(node/web/remote)全合格。
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
