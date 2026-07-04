# PROGRESS

## 現在の状態

- **M1〜M9まで実装**(M3/M5/M6の実API確認はOpenAIプロバイダで実施済み)。
  テスト175件・typecheck 全合格。
- **M9完了**: 操作範囲のPC全体拡大(scopeMode: project / fullPc、全操作承認制)。
  手動確認手順は `docs/M9-manual-test.md`(実行はユーザー)。
- 進化ジョブ#1が成功済み: `csv_to_markdown` ツールが evolve/1 として昇格・稼働中
- **コードレビュー指摘10件を全修正**(各回帰テスト付き)。セキュリティ2件は攻撃再現テストで実証。
- **M7磨き込み**: モデルUXドロップダウン / ワークスペース選択 / electron-builder構成。
  ※NSISインストーラ生成のみ現環境ブロック(winCodeSignのシンボリックリンク展開に権限要。
  開発者モード or 管理者実行で `npm run dist` 完走。構成・パッケージ版プラグインロードは検証済)。
- **M8ハーネス強化**: M8-1 コンテキスト自動圧縮 / M8-2 プロジェクト記憶(MYCODEX.md) /
  M8-3 プランモード / M8-4 サブエージェント。

## ユーザーへの依頼事項

- **M9の手動確認**: `docs/M9-manual-test.md` のシナリオ(特に fullPc の毎回承認と
  userData ハード拒否)を一度実施してほしい
- **Anthropic APIキーの登録(任意・時期が来たら)**: Anthropic固有部分の実API検証
  (prompt cachingのcache_read確認、Anthropicストリーム正規化の実挙動、claude系モデルでの
  ツール連鎖・自己進化)が未実施。キー登録後に指示いただければ検証します。
  ロジック自体はユニットテスト済みのため、リスクは低い想定

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

## 次のタスク

- M10: スマホWebアクセス(docs/M10-mobile-web-design.md)。M9のaudit.jsonlを閲覧UIで使う
- M9手動確認(ユーザー実施): docs/M9-manual-test.md
- Anthropic固有部分の実API検証(キー登録待ち): prompt caching(cache_read_input_tokens)、
  claude系モデルでのツール連鎖・自己進化E2E

## 既知のバグ・課題

- (M9) スコープ判定は `pathParams` を宣言したツールのみ対象。未宣言ツール
  (csv_to_markdown 等の生成ツール)がパスを受け取る場合は判定対象外
  (safe/writeのrisk承認は従来どおり効く)。進化ジョブの生成プロンプトへの
  pathParams 宣言の追加は M10 以降で検討
- (M9) dispatch_agent のサブエージェントは executor を通さず safe ツールを直接実行するため、
  workspace外の「読み取り」がスコープ判定を受けない(書き込み/実行は元々不可)。
  影響は読み取りのみだが、M10で executor 経由に統一することを検討
- (M9) audit.jsonl の閲覧UIは未実装(M10のスマホUIで提供予定)

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
