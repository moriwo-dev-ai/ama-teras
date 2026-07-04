# M12: 長丁場対応 — セッション永続化・計画ファイル・並列サブエージェント

目的: autonomy-comparison.md で特定した「大規模が厳しい4要因」のうち、②タスク分解、③並列化、④中断・再開を解消する(①コンテキスト管理は計画ファイルで間接的に緩和)。

前提: M11完了(チェックポイント・ProcessManager・postEditHook が利用可能)。実装・検証はWindows実機のClaude Codeで行う(サンドボックス制約なし)。

## M12-0: 多重起動ガード(小・最初に)

- `app.requestSingleInstanceLock()` を `src/main/index.ts` に導入。取れなければ即quit、`second-instance` イベントで既存ウィンドウをフォーカス
- **重要**: `MYCODEX_SMOKE=1`(スモークモード)ではロックを**取得しない**。進化ゲートのスモークテストは稼働中のAと並行してheadless起動するため、ロックすると進化パイプラインが壊れる。これを固定する回帰テストを書く(スモーク起動がA稼働中でも成功すること)

## M12-1: セッション永続化+再開

- 新規 `src/main/core/sessions.ts` — `SessionStore`:
  - 保存先 `userData/sessions/<sessionId>.json`(履歴・compaction状態・workspace・作成/更新時刻・タイトル=先頭ユーザーメッセージの要約)
  - 書き込みタイミング: 各ターン完了時(message_done / tool_result追記後)。アトミック書き込み(tmp→rename)
  - サイズ上限: 履歴JSONが8MBを超えたら古いターンを要約に畳んでから保存(既存compactionを流用)
- 再開:
  - 起動時に最新セッション一覧を返す IPC `sessions:list` / `sessions:load` / `sessions:delete`
  - renderer: チャット画面にセッション切替UI(最小限: ドロップダウン+新規ボタン)
  - **中断復元**: 履歴末尾が tool_use のまま tool_result が無い場合(クラッシュ・強制終了)、
    ロード時に合成 tool_result(`isError: true, content: "アプリ再起動により中断"`)を補って整合させる
    (API 400 対策。compaction境界の既存知見と同根)
  - 承認待ちだった操作は復元しない(pending approvalは揮発でよい。監査ログには残っている)
- secretsは履歴に入らない設計のまま(念のためテストで固定)
- テスト: 保存→ロード→同一性、tool_use欠損補完、8MB畳み込み、旧バージョンファイルの後方互換(スキーマにversionフィールド)

## M12-2: 計画ファイル(タスクリストの永続化)

- ワークスペース直下の `MYCODEX_PLAN.md` を「エージェント自身が管理する計画ファイル」とする
- 新規ツール `plan`(1ツールで read/update を兼ねる):
  - `{ action: 'read' }` → 現在の計画を返す
  - `{ action: 'write', content: string }` → MYCODEX_PLAN.md を全置換
  - **risk: 'safe' とする**(書き込み先がこの1ファイルに固定されており、ユーザーが目視できるため)。
    パスは executor のスコープ判定対象外でよいが、workspace直下固定をプラグイン内で強制
- system prompt への注入: MYCODEX.md(記憶)と同様に、MYCODEX_PLAN.md が存在すれば
  「## 現在の計画」として毎ターン注入。プロンプトに運用指示を追加:
  「複数ステップの作業では最初に plan で計画を書き、項目完了ごとに `- [x]` へ更新すること」
- renderer: チャット画面に計画パネル(checkbox形式のmarkdownをパースして進捗表示。読み取り専用)
- compaction時も計画は system prompt 側にあるため要約で失われない(=①コンテキスト管理の緩和)
- テスト: read/write、workspace外への書き込み不可、注入内容、checkbox進捗パース

## M12-3: 並列サブエージェント(書き込み可)

- `dispatch_agent` を拡張: `{ task, mode?: 'read' | 'work', parallel?: Task[] }`
  - `mode: 'read'`(既定): 従来どおり読み取り専用(後方互換)
  - `mode: 'work'`: write/exec 含む全ツールを使える子エージェント。**最大3並列・子のmaxTurns=30(設定可)**
- 実装は `src/main/agent/subagent.ts` を拡張し、AgentService/EventBus(M10)を流用:
  - 子は独立履歴・独立AbortSignal(親キャンセルで全子キャンセル)
  - 子のツール実行も**必ず executor 経由**(= M9スコープ判定・承認・M11チェックポイント/フックがそのまま効く)。
    承認ダイアログには「サブエージェント #N からの要求」を明示
  - **進化ジョブへの非波及**: 子エージェントから request_capability は呼べない(evolution非注入)。
    子からさらに dispatch_agent は不可(ネスト1段まで)。guardrails パターンでテスト固定
- 競合対策(v1は軽量に):
  - fan-out 直前に自動チェックポイント(M11-3を流用)を必ず作成
  - 親へのプロンプト規約: 「並列タスクは触るファイルが重ならないように分割すること」を
    dispatch_agent の description に明記
  - 同一ファイルへの write が複数の子から発生した場合は2件目以降を isError で拒否
    (ProcessManager 同様、進行中 write パスの簡易ロックテーブルを ToolContext 注入で共有)
- UI: 進化パネルと同様の「エージェント」ビュー(子ごとの status / 現在のツール / ログ末尾)。
  イベントは `agent:sub_update` を EventBus 経由で desktop / remote-ui 両方へ
- テスト: 並列実行と結果集約、キャンセル伝播、ネスト禁止、書き込み衝突拒否、read後方互換

## M12-4: ドキュメントと計測

- `docs/M12-manual-test.md`: 再開(アプリ強制終了→再起動→続きを指示)、計画パネル、
  並列サブエージェント(2子で別ファイル生成)、スマホ(remote-ui)からのサブエージェント承認
- PROGRESS.md 更新
- 仕上げに autonomy-comparison.md のベンチ3課題を実測し、結果を同ファイルに追記
  (M11+M12でどこまで来たかの記録。特に②REST API課題は計画ファイル+並列の効果が出るはず)

## 受け入れ基準

- 既存281+M12新規テスト全合格 / typecheck 3構成合格
- アプリを強制終了→再起動→セッション選択→「続けて」で作業が再開できる
- 「◯◯を作って。計画を立てて進めて」で MYCODEX_PLAN.md が生成・更新されていく
- 並列サブエージェントで2ファイルが同時生成され、承認・キャンセルが正しく動く
- 進化パイプライン(guardrails)への非波及がテストで固定されている
