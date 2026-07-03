# PROGRESS

## 現在の状態

- **M1〜M6完了**(M3/M5/M6の実API確認はOpenAIプロバイダで実施済み)。M7(磨き込み)は7/7以降
- 進化ジョブ#1が成功済み: `csv_to_markdown` ツールが evolve/1 として昇格・稼働中

## ユーザーへの依頼事項

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

## 次のタスク

- Anthropic固有部分の実API検証(キー登録待ち): prompt caching(cache_read_input_tokens)、
  claude系モデルでのツール連鎖・自己進化E2E
- M7: 磨き込み(7/7以降)。追加項目: 設定のモデル入力欄のUX改善
  (プレースホルダの説明文をそのまま入力してしまう事故があった。候補ドロップダウン化や
  入力値検証を検討)

## 既知のバグ

(なし)

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
