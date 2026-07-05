# MyCodex vs OpenAI Codex 比較調査(2026-07-04時点)

## Codexの現状(2026年)

Codexは単一製品ではなく「面」の集合体: **CLI**(Rust製・オープンソース)、**IDE拡張**(VS Code/Cursor/JetBrains)、**クラウド実行**(隔離サンドボックスで並列タスク、既定6並列)、**GitHub統合**(PRレビューbot・コメントで修正指示→pushまで)、**ChatGPTモバイル連携**(2026年5月〜)。モデルはGPT-5-Codex/GPT-5.5系のコーディング特化版。

安全モデルは2層: **OSレベルサンドボックス**(workspace-write / danger-full-access等。既定はネットワーク遮断+workspace内書き込みのみ)+**承認ポリシー**(untrusted / on-request / never / カテゴリ別granular)。MCP対応、AGENTS.mdによるリポジトリ内指示、スキル(コミュニティに150+)。

モバイルは ChatGPT アプリから稼働中セッションの監視・承認・新規タスク投入が可能。ただし**ローカルホスト接続はmacOSのみ、Windowsは「coming soon」**。

## 比較表

| 領域 | MyCodex | Codex |
|---|---|---|
| 実行形態 | Electronデスクトップ単体 | CLI / IDE / クラウド / GitHub / モバイル |
| モデル | Anthropic・OpenAI切替可(プロバイダ抽象層) | OpenAIのみ(コーディング特化モデル) |
| **自己進化** | **◎ 独自機能**: 不足ツールを自分で生成→B worktreeで検証(typecheck/vitest/smoke)→承認→ホットリロード昇格、失敗時自動revert | なし(スキル/MCPは人が用意して追加) |
| ツール拡張 | 自己進化+プラグイン規約(動的ロード) | MCP・スキル・コミュニティエコシステム |
| サンドボックス | **承認レイヤーのみ**(プロセス内制御。進化ジョブはrestrictExec+writeAllowlist) | **OS強制サンドボックス**+承認の2層 |
| スコープ制御 | project / fullPc。fullPcはworkspace外を毎回承認+audit.jsonl監査ログ | workspace-write既定。full-accessは承認自体を外す方向 |
| 並列実行 | 1セッション直列+読み取り専用サブエージェント1 | クラウドで並列(既定6)、fan-out比較 |
| Git/PR統合 | コミットは自分で(アプリ機能なし) | PRレビューbot・修正push・Agent HQ |
| IDE統合 | なし | VS Code/JetBrains、インライン補完 |
| スマホ操作 | **◎ Windows PCで動作**(自前SSE+トークン認証+Tailscale。閲覧/送信/承認/進化承認/監査) | ChatGPTアプリ連携だが**ホストはmacOSのみ**(Windows未対応) |
| リポジトリ指示 | MYCODEX.md(system prompt注入) | AGENTS.md(階層配置対応) |
| 画像入力 | なし | CLIでスクショ・ワイヤーフレーム添付可 |
| MCP | クライアント機能なし | 対応(destructive注釈で承認強制) |
| 料金形態 | APIキー従量(BYOK) | ChatGPTプラン同梱+API |

## MyCodexができてCodexにないこと

1. **自己進化**が最大の差別化。稼働中アプリが自分のツールを生成→検証ゲート→人間承認→動的リロードまで自動。Codexのスキル/MCPは「人が足す」拡張
2. **Windows PCへのスマホ遠隔フル操作**(Codexは現状macOSホストのみ)
3. **プロバイダ中立**(Anthropic/OpenAIを設定で切替、prompt caching対応)
4. **全操作承認制のPC全体スコープ+改ざんしにくい監査ログ**(Codexのfull-accessは逆に承認を外す設計)

## CodexができてMyCodexにないこと

1. **OSレベルのサンドボックス強制**。MyCodexの安全はプロセス内の承認ロジック依存(bashは承認後なんでもできる)
2. **クラウド並列実行・タスクfan-out**(MyCodexは直列1セッション)
3. **GitHub統合**(PRレビュー・自動修正push)とIDE統合
4. **MCP・画像入力・スキルエコシステム**
5. **コーディング特化モデル**と複数面での状態共有(IDE→クラウド→GitHubへのハンドオフ)

## 示唆(次のマイルストーン候補)

短期で費用対効果が高い順: ①MCPクライアント対応(外部ツール接続がエコシステムごと手に入る)、②git/PR統合ツール(commit/branch/PR作成をプラグインで — 自己進化で作らせる好例)、③並列セッション(EventBus/AgentServiceがM10で整備済みなので土台はある)。OSサンドボックスはElectron+Windowsでは難度高(AppContainer/ジョブオブジェクト)、当面は承認制+監査で運用が現実的。

## 現状更新(2026-07-05、M9〜M13完了時点)

本文の比較表は M8 時点の評価。その後の実装で以下が変わった:

- 「CodexができてMyCodexにないこと」のうち解消済み: **MCP対応**(M13-2、stdio版。annotationsからrisk写像・サーバー単位信頼)/**並列実行**(M12-3、ローカル3並列 — Codexのクラウド6並列とは規模が異なるが用途は重なる)/クラウド並列の代替としての**中断・再開**(M12-1)
- 「示唆(次のマイルストーン候補)」の①MCPクライアントは完了。②git/PR統合は未着手(自己進化で作らせる好例のまま)。③並列セッションは M12-3 で実現
- 依然Codex優位: OSレベルサンドボックス/GitHub・IDE統合/**画像入力**(→ M14設計で対応予定)/クラウド実行
- 依然MyCodex優位: 自己進化/Windows対応スマホ遠隔(CodexのWindowsホスト対応は2026-07時点で未リリース)/プロバイダ中立/全操作承認+監査

## 情報源

- https://openai.com/codex/ / https://openai.com/index/introducing-upgrades-to-codex/
- https://developers.openai.com/codex/cli/features / https://developers.openai.com/codex/ide/features
- https://developers.openai.com/codex/agent-approvals-security / https://developers.openai.com/codex/concepts/sandboxing
- https://developers.openai.com/codex/cloud / https://developers.openai.com/codex/integrations/github
- https://openai.com/index/work-with-codex-from-anywhere/ (モバイル、macOSホスト限定の記載)
- https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/
- https://github.com/RoggeOhta/awesome-codex-cli
