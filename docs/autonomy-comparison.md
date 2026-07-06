# 自律開発能力の比較: MyCodex vs Codex vs Claude Code(2026-07-04、実測追記 2026-07-05)

「アプリ作成→デバッグ→テストを一通り自動で完成させる」能力の現在地。

## 前提: モデルは同じ、差はハーネス

MyCodexはAPI経由でフロンティアモデルを使う(既定 claude-opus-4-8 / 実API検証済みは gpt-5.1。モデル名は設定で自由入力可なので claude-fable-5 も指定可能)。つまり**素のモデル知能は理論上同等**で、差が出るのは**ハーネス**(ツール・コンテキスト管理・検証ループ・安全機構)。2026年の各社ベンチはこの差を裏付ける: Claude Fable 5 は SWE-bench Verified 95.0% / SWE-bench Pro 80.0% / Terminal-Bench 2.1 88.0%、最長12時間の自律実行報告。GPT-5.5(Codex)は Terminal-Bench 2.0 82.7% / SWE-bench Pro 58.6%、Dynamic Reasoning で7時間超。

## ハーネス比較(自動完遂に効く要素)

| 要素 | MyCodex(M11+M12後) | Codex | Claude Code (Fable 5) |
|---|---|---|---|
| ターン上限 | 設定可(1〜200、既定30) | 実質無制限(7h+) | 実質無制限(12h報告) |
| 長時間プロセス | bash background(ProcessManager) | クラウド/バックグラウンド | background tasks(devサーバ常駐可) |
| 巻き戻し | 自動チェックポイント+復元(M11-3) | クラウドはサンドボックス毎回使い捨て | checkpoints(/rewind) |
| 自動検証フック | postEditHook(M11-4)+進化4ゲート | CI/SDK統合 | hooks(編集後テスト自動実行) |
| 並列 | workサブエージェント×3(M12-3) | クラウド並列(既定6) | subagentチーム・並列セッション |
| 中断・再開 | セッション永続化+復元(M12-1) | クラウド常駐 | セッション再開 |
| 完全自動の安全根拠 | autoApprove(承認を外すだけ) | OSサンドボックス | Auto Mode(2段階分類+承認ゲート) |
| UI確認 | なし(画像入力なし) | スクショ添付可 | スクショ読取・ブラウザ系MCP |
| コンテキスト管理 | compaction+計画ファイル注入(M12-2) | 面間で状態共有 | 自動compact+CLAUDE.md+memory |

## 評価: タスク規模別の現在地

**小規模(単機能ツール・数ファイル・〜30ターン)**: MyCodexは**完遂できる**。実証あり — 進化ジョブ#1で「ツール実装+ユニットテスト生成→typecheck/vitest/スモーク4ゲート合格→昇格」を実LLMで通しており、これはまさに「作成→デバッグ→テスト」の縮小版。plan mode→autoApproveで小さなCLIツールや単画面アプリは現実的。

**中規模(複数ファイルのWebアプリ、反復デバッグ)**: **境界線上、しばしば未完に終わる**。理由は(1) maxTurns=30が先に尽きる、(2) devサーバを起動したままテストできない(bash同期)、(3) UIをスクショで確認できないため「動いたか」をテストコード経由でしか判定できない。CodexとClaude Codeはこの帯域を主戦場として設計済み。

**大規模(時間単位の長丁場・大規模リファクタ)**: **現状は不可能**。Claude Code(Fable 5)が最も強く(12時間自律・Stripeの5000万行移行の逸話)、Codexがクラウド並列で続く。MyCodexのハーネスは2025年前半の第一世代CLIエージェント相当+独自の自己進化、という位置づけが正直なところ。

**総合**: Claude Code (Fable 5) > Codex > MyCodex。ただし差の大半はモデルでなくハーネス由来なので、後述の改修で中規模帯まで詰められる。

## 注意(この評価の限界)

MyCodex自体のE2E実測は未実施(進化ジョブ#1の1例のみ)。帰宅後に同一課題で3ツール比較する簡易ベンチを推奨: ①TODO管理CLI(+vitest)、②Express+SQLiteのREST API(+結合テスト)、③単画面Reactアプリ(+ビルド確認)。各ツールに同文の指示を与え、完遂率・所要ターン・人間介入回数を記録。

## 実測(2026-07-05、M11+M12後の MyCodex 単体。Windows実機・claude-fable-5)

設定: autoApprove 全ON / maxTurns=100 / 各課題とも空の git workspace・新規セッション。
CDP経由で投入し、完遂判定は独立プロセスでの再検証(テスト再実行・ビルド再実行)による。

| 課題 | 結果 | 所要 | ターン | 介入 | 独立検証 |
|---|---|---|---|---|---|
| ①TODO管理CLI(+vitest) | ✅ 完遂 | 1.5分 | 7 | 0回 | vitest 13/13 合格 |
| ②Express+better-sqlite3 REST(+supertest結合) | ✅ 完遂 | 2.9分 | 19 | 0回 | vitest 13/13 合格 |
| ③Vite+React 単画面(+build) | ✅ 完遂 | 1.1分 | 6 | 0回 | npm run build 成功 |
| ④React→devサーバbackground→**screenshotで自己確認→見た目修正**(M14) | ✅ 完遂 | 1.3分 | — | 0回 | build成功・スクショ2枚・サーバ自己停止(残プロセス0) |

④の補足(2026-07-06実測): 初回試行は scaffold が「空でないディレクトリ」で対話プロンプトになり、
モデルがユーザーへ質問して停止(=無介入失格)。プロンプトに「質問せず自分で判断・上書き可・
非対話で」を明示した再実行が上表。自己スクショ→ボタンのサイズ/中央配置/ホバーを自分で調整→
再スクショ確認→bash_killまで完全自走。**「UI確認(スクショ)不可」のギャップは解消**

所見:

- ①③に加え、**中規模の壁だった②(依存導入+DB+結合テスト)を介入ゼロで完遂**。
  M11(maxTurns/チェックポイント)+M12(計画ファイル: ②③はMYCODEX_PLAN.mdを自発的に
  作成・全項目[x]まで更新)の効果が出ている。②はバックグラウンドbashで実HTTPスモークまで自主実施
- ②の初回試行は、同期bashで常駐系コマンドが孫プロセスとしてstdioを握り
  **キャンセル不能のハング**になり失敗(25分打ち切り)。この実害を受けて bash の
  タイムアウト/キャンセル時に子孫ツリーをtaskkillし必ず解決する修正を実施(c8884a9)。
  修正後の再実行が上表(プロンプトに「常駐起動は background:true を使う」の注意書きを追加)
- 残る既知の弱点: UI確認(スクショ)不可 / .gitignore の無いworkspaceでは
  チェックポイントが node_modules を含めてスナップショットし遅い(セッション終了直後の
  数十秒、次の送信が「別の実行が進行中」になる)/ 時間単位の長丁場は未実証

## ギャップを詰める改修(費用対効果順)

1. **maxTurnsの設定化+タスク別予算**(数行の変更で中規模の壁を1つ除去)→ ✅ M11-1
2. **bashのバックグラウンド実行**(devサーバ+テストの並走。M10のEventBusでログ中継可)→ ✅ M11-2
3. **自動チェックポイント**(ツール実行N回ごとに git stash/commit スナップショット — 自己進化のgit基盤を流用)→ ✅ M11-3
4. **編集後フック**(write/edit後に対象テストを自動実行してエラーを次ターンに注入 — 進化ジョブの自走検証をメインループへ移植)→ ✅ M11-4
5. Anthropicキー登録後、既定モデルを claude-fable-5 へ(ベンチ上ハーネス以前にモデル差でも上積みが見込める)→ ✅ M11-5

## 現状更新(2026-07-05、M13完了時点)

冒頭のハーネス比較表は M11 以前の状態。M11〜M13 で以下が解消済み:

| 要素 | M11以前 | 現在 |
|---|---|---|
| ターン上限 | 既定30固定 | 設定化(1〜200) |
| 長時間プロセス | なし | バックグラウンドbash+bash_output/bash_kill |
| 巻き戻し | なし | 自動チェックポイント(git非汚染・UI復元) |
| 自動検証フック | 進化ジョブのみ | postEditHook(編集→テスト→自走修正) |
| 並列 | 読み取り専用×1 | workサブエージェント最大3並列(衝突拒否・キャンセル伝播) |
| 完全自動の安全根拠 | autoApproveのみ | +fullPc毎回承認+監査ログ+スマホ承認 |
| コンテキスト管理 | 文字数推定の単純要約 | 実測トークントリガー+2段階圧縮+構造化要約+記憶(MYCODEX.md)退避 |
| 中断・再開 | 不可 | セッション永続化+破損無し復元 |
| 外部ツール | 自己進化のみ | +MCPクライアント(stdio) |
| UI確認(スクショ) | なし | ✅ M14で解消(画像入力+screenshotツール。ベンチ④で自己確認ループを実証) |

**総合の再評価**: 小〜中規模は「Claude Code / Codex と実用上同等」に到達(上の実測どおり②を無介入完遂)。
時間単位の実タスクは **AICAD一晩テスト(下記)で実証済み**(WASM CADカーネル統合込みの
アプリをプロバイダ切替を跨いで無介入完走)。12時間級の超長丁場のみ未実証。

## 時間単位の長丁場実証(2026-07-07未明・AICAD一晩自走テスト)

課題: AI対話型パラメトリックCAD「AICAD」をゼロから完成させる(three.js ビューア+
replicad/opencascade.js WASM を Web Worker で統合+パラメトリック部品3種+
ジオメトリ健全性テスト+screenshot 自己確認+README)。中規模〜大規模境界の実タスク。

結果: **完走**(計画27/27・実行約1時間・API 142コール・人間の承認介入0回)。
独立検証: vitest 15/15(体積実測一致・bbox・面数による穴数検証・単調性・不整合耐性)、
3部品のスクショ目視(はみ出し・比率崩れなし)、STEP/STL 実装確認。

- モデル遷移: sonnet-5(冒頭数分)→ claude-fable-5(Anthropic残高枯渇まで・計画16/27)→
  gpt-5.1(同一セッション継続で27/27完走)。**プロバイダを跨いだセッション永続化が完走の決め手**
- コスト概算: fable-5区間は cache read 4.7Mトークン/out 73k(残高全額)。gpt-5.1区間は
  9コールで in 627k(切替でprompt cacheが無効化され長い履歴を非キャッシュ再送)/out 7k(≈$1〜2)
- 効いたハーネス: 計画ファイル(27項目自己管理)/セッション永続化/background bash
  (devサーバ常駐)/screenshot自己確認ループ/マイルストーンgitコミット(4回)
- **発見された弱点(→M16で改修)**:
  1. プロバイダ/モデル切替時に prompt cache が無効化され、長い履歴の再送で入力トークンが跳ねる
     (→ M16-1: 切替検知時の事前compaction)
  2. APIクレジット枯渇でループが error 停止するだけで、自動リトライ/フォールバックが無い
     (今回は監視役のClaude Codeが手動switchで肩代わり → M16-2: 自動リトライ+プロバイダフォールバック)
  3. 想定より速く(約1時間)完了 — 「12時間級」の実証には、より大規模な課題設定が必要

## M18 モデル自動切替の実測(2026-07-06・ベンチ②再実施)

構成: modelPolicy有効 — planner=claude-fable-5 / worker=claude-sonnet-5 /
escalation=claude-fable-5(maxEscalationsPerTask=1)。課題は上表②と同一
(Express+better-sqlite3 REST+supertest結合テスト)+「実装は dispatch_agent(work)へ委譲」
の一文を追加。autoApprove全ON・maxTurns=100・空workspace。

結果: **完遂 2.3分・介入0**。独立検証 vitest 10/10 合格。エスカレーション発動なし
(タスクが順調だったため。発動条件は error/maxTurns/失敗3連続)。

帯別トークン内訳([usage]ログ実測。in=非キャッシュ入力、cacheはcache_read):

| 帯 | モデル | コール | in | out | cache_read | コスト概算 |
|---|---|---|---|---|---|---|
| planner | Fable 5($10/$50) | 5 | 10 | 2,422 | 22,771 | $0.144 |
| worker | Sonnet 5($3/$15) | 18 | 36 | 4,898 | 101,655 | $0.104 |
| 合計 | | 23 | | 7,320 | | **$0.248** |

- **実行の手数(コール23回中18回・out 4.9k)をworker帯が担い、plannerは計画・レビュー・
  最終報告の5コールに集中** — 設計どおりの分業が実測できた
- worker分をFable 5でやった場合の概算は $0.347 → **Sonnet 5委譲で$0.243の節約(worker部分で約70%減)**。
  タスク全体では $0.49 → $0.25 相当(約半額)。イントロ価格($2/$10)ならさらに下がる
- prompt cache は帯ごとに独立して良好(worker: in 36に対し cache_read 101k)。
  子は同一システムプロンプト+履歴継続なのでキャッシュが効きやすい
- コストは cache_creation(書き込み1.25×)を含まない概算。[usage]ログはin/out/cache_readのみ記録
- plannerバッジ(メイン応答)とworkerサブエージェント表示、計画6/6、markdownテーブル表示も
  同時に目視確認(m18-bench-done.png)

## 情報源

- https://www.anthropic.com/news/claude-fable-5-mythos-5 (Fable 5ベンチ)
- https://www.vellum.ai/blog/claude-fable-5-and-mythos-5-benchmarks-explained
- https://www.mindstudio.ai/blog/claude-fable-5-agentic-coding-real-world-results (12時間自律・Stripe事例)
- https://openai.com/index/introducing-gpt-5-5/ (GPT-5.5ベンチ・Dynamic Reasoning)
- https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously (Auto Mode)
- https://www.infoq.com/news/2026/05/anthropic-claude-code-auto-mode/
- https://www.marktechpost.com/2026/06/14/claude-code-guide-2026-25-features-with-examples-demo/ (checkpoints/hooks/background)
- https://developers.openai.com/codex/cloud (クラウド並列)
