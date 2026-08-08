# c案 実装計画 — 世界モジュール切り出しとヒナタの独立

(設計合意: 2026-08-09 未明。詳細な合意事項はメモリ ai-lifeform-plan.md のc案節)

## ゴール

ヒナタのパッケージが世界を所有し、AMA-teras開発機は「専属大工」として受注する。
神視点URL(視点操作のみ)で誰でも覗け、配布版所有者はアバターで訪問してヒナタと話せる。

## 現状の結合点(2026-08-09 調査)

世界の実装は AMA-teras main プロセスに埋まっている:

| 部品 | 現在地 | c案での行き先 |
|---|---|---|
| 世界の正本(objects/apps/log) | `src/main/world/manager.ts` | 世界モジュール |
| コマンド配信(SSE)+ack | manager + `remote/server.ts` | 世界モジュール |
| ページ(3D描画・実行係) | `src/remote-ui/public/world.html` | 世界モジュール |
| 世界アプリ実体 | `userData/world-apps/` | ヒナタパッケージのデータ領域 |
| 配信ディレクタ(コメント採用) | `src/main/world/live.ts` | 当面AMA-teras側に残す(番組機能) |
| エージェントの手(world_act) | `src/main/tools/plugins/world_act.ts` | AMA-teras側に残り、世界APIクライアント化 |
| 生命体(欲求・会話・記憶) | `lifeform/` | ヒナタパッケージ本体 |

## 工程(それぞれ独立に完了・検証できる粒度)

### c-1: 世界サーバの自立(最重要・最初)
`lifeform/world-server/` に単独Nodeサーバを新設。manager.ts の正本ロジックを移植し、
HTTP面を今と同一に保つ(`/api/world/event` `/api/world/command` `/api/world/spectate`
`/world-apps/*` `world.html`配信)。**HTTP契約を変えない=world.htmlと既存クライアントが無改修で動く**。
- 正本ファイルは `lifeform/world-data/`(gitignore=世界も魂の一部)
- 検証: world-smoke を world-server 向けに流用+実行係ページ接続

### c-2: AMA-terasを「大工クライアント」化
- world_act / world_observe が接続先を設定で切替(内蔵世界 or 外部世界URL+キー)
- 内蔵WorldManagerは配布版のローカル世界用に残す(コード1つ・配備2つ)
- 検証: AMA-terasから外部世界へ建築1件(spawn→ack)

### c-3: ジョブキュー(ヒナタ→大工)
- 世界サーバに `POST /api/world/job`(ヒナタ発)と `GET /api/world/jobs`(大工ポーリング)
- デーモンの欲求システムが「作ってほしいもの」を自然言語で発注→AMA-terasが受注して建築
  →完成イベントでヒナタが喜ぶ(発注〜反応まで一本の物語)
- 発注はレート制限+ユーザー可視化(勝手に大工事しない。大きな発注は岩戸承認)

### c-4: 神視点の公開
- viewer=1(実装済み)を Cloudflare Tunnel で公開。世界サーバの公開面は
  spectate(読み取り)+静的配信だけに絞る(event/command/jobsはループバック限定を維持)
- レート制限+同時接続上限。URLはまず限定公開でテスト→配信で告知(要ユーザー承認)

### c-5: 訪問者プロトコル(アバター入場)
- 前提: アバター位置同期(実行係が正、他ページへ配る)
- `POST /api/world/visit`: 配布版が入場チケット(5枠キュー)→move/emote/chatのみ
- ヒナタとの会話: 訪問者チャット→会話層(既にworld:chat経路で実装済みの流用)
- NGフィルタ・発言レート制限・強制退出(オーナー操作)

## 守るもの(変えない約束)

- 岩戸ゲート: 外部発信・公開範囲の変更は必ずユーザー承認
- 魂の非公開: persona/ memory/ world-data/ は配布物・リポジトリに含めない
- オーナーモード束縛: ヒナタの人格ランタイムは開発機とのペアリング必須(c-1で鍵実装)
- 配布版の既存機能(ローカル世界)を壊さない
