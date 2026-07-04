# 自律開発能力の比較: MyCodex vs Codex vs Claude Code(2026-07-04)

「アプリ作成→デバッグ→テストを一通り自動で完成させる」能力の現在地。

## 前提: モデルは同じ、差はハーネス

MyCodexはAPI経由でフロンティアモデルを使う(既定 claude-opus-4-8 / 実API検証済みは gpt-5.1。モデル名は設定で自由入力可なので claude-fable-5 も指定可能)。つまり**素のモデル知能は理論上同等**で、差が出るのは**ハーネス**(ツール・コンテキスト管理・検証ループ・安全機構)。2026年の各社ベンチはこの差を裏付ける: Claude Fable 5 は SWE-bench Verified 95.0% / SWE-bench Pro 80.0% / Terminal-Bench 2.1 88.0%、最長12時間の自律実行報告。GPT-5.5(Codex)は Terminal-Bench 2.0 82.7% / SWE-bench Pro 58.6%、Dynamic Reasoning で7時間超。

## ハーネス比較(自動完遂に効く要素)

| 要素 | MyCodex | Codex | Claude Code (Fable 5) |
|---|---|---|---|
| ターン上限 | **既定30(loop.tsの定数。設定UIなし)** | 実質無制限(7h+) | 実質無制限(12h報告) |
| 長時間プロセス | なし(bashは同期実行) | クラウド/バックグラウンド | background tasks(devサーバ常駐可) |
| 巻き戻し | なし | クラウドはサンドボックス毎回使い捨て | checkpoints(/rewind) |
| 自動検証フック | 進化ジョブのみ(4ゲート) | CI/SDK統合 | hooks(編集後テスト自動実行) |
| 並列 | 読み取り専用サブエージェント×1 | クラウド並列(既定6) | subagentチーム・並列セッション |
| 完全自動の安全根拠 | autoApprove(承認を外すだけ) | OSサンドボックス | Auto Mode(2段階分類+承認ゲート) |
| UI確認 | なし(画像入力なし) | スクショ添付可 | スクショ読取・ブラウザ系MCP |
| コンテキスト管理 | 履歴要約(compaction)のみ | 面間で状態共有 | 自動compact+CLAUDE.md+memory |

## 評価: タスク規模別の現在地

**小規模(単機能ツール・数ファイル・〜30ターン)**: MyCodexは**完遂できる**。実証あり — 進化ジョブ#1で「ツール実装+ユニットテスト生成→typecheck/vitest/スモーク4ゲート合格→昇格」を実LLMで通しており、これはまさに「作成→デバッグ→テスト」の縮小版。plan mode→autoApproveで小さなCLIツールや単画面アプリは現実的。

**中規模(複数ファイルのWebアプリ、反復デバッグ)**: **境界線上、しばしば未完に終わる**。理由は(1) maxTurns=30が先に尽きる、(2) devサーバを起動したままテストできない(bash同期)、(3) UIをスクショで確認できないため「動いたか」をテストコード経由でしか判定できない。CodexとClaude Codeはこの帯域を主戦場として設計済み。

**大規模(時間単位の長丁場・大規模リファクタ)**: **現状は不可能**。Claude Code(Fable 5)が最も強く(12時間自律・Stripeの5000万行移行の逸話)、Codexがクラウド並列で続く。MyCodexのハーネスは2025年前半の第一世代CLIエージェント相当+独自の自己進化、という位置づけが正直なところ。

**総合**: Claude Code (Fable 5) > Codex > MyCodex。ただし差の大半はモデルでなくハーネス由来なので、後述の改修で中規模帯まで詰められる。

## 注意(この評価の限界)

MyCodex自体のE2E実測は未実施(進化ジョブ#1の1例のみ)。帰宅後に同一課題で3ツール比較する簡易ベンチを推奨: ①TODO管理CLI(+vitest)、②Express+SQLiteのREST API(+結合テスト)、③単画面Reactアプリ(+ビルド確認)。各ツールに同文の指示を与え、完遂率・所要ターン・人間介入回数を記録。

## ギャップを詰める改修(費用対効果順)

1. **maxTurnsの設定化+タスク別予算**(数行の変更で中規模の壁を1つ除去)
2. **bashのバックグラウンド実行**(devサーバ+テストの並走。M10のEventBusでログ中継可)
3. **自動チェックポイント**(ツール実行N回ごとに git stash/commit スナップショット — 自己進化のgit基盤を流用)
4. **編集後フック**(write/edit後に対象テストを自動実行してエラーを次ターンに注入 — 進化ジョブの自走検証をメインループへ移植)
5. Anthropicキー登録後、既定モデルを claude-fable-5 へ(ベンチ上ハーネス以前にモデル差でも上積みが見込める)

## 情報源

- https://www.anthropic.com/news/claude-fable-5-mythos-5 (Fable 5ベンチ)
- https://www.vellum.ai/blog/claude-fable-5-and-mythos-5-benchmarks-explained
- https://www.mindstudio.ai/blog/claude-fable-5-agentic-coding-real-world-results (12時間自律・Stripe事例)
- https://openai.com/index/introducing-gpt-5-5/ (GPT-5.5ベンチ・Dynamic Reasoning)
- https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously (Auto Mode)
- https://www.infoq.com/news/2026/05/anthropic-claude-code-auto-mode/
- https://www.marktechpost.com/2026/06/14/claude-code-guide-2026-25-features-with-examples-demo/ (checkpoints/hooks/background)
- https://developers.openai.com/codex/cloud (クラウド並列)
