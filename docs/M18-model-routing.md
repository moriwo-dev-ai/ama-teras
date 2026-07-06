# M18: モデル自動切替(役割ベース割当 + エスカレーション・プロバイダ横断)

目的: 完成度とコスパの両立。高性能モデルは「計画・意思決定・監視」に集中させ、
実行の手数は安いモデルに任せる。詰まった箇所だけ自動で上位モデルに格上げする。

M16(プロバイダ切替 / 切替時compaction / エラー分類 classifyLLMError)と
M12-3(work サブエージェント)を再利用する。プロバイダ横断(Anthropic⇔OpenAI)対応。

## 設計の核: 役割 = モデル帯

`AppConfig.modelPolicy`(既定 disabled=従来どおり単一モデル):

```ts
modelPolicy?: {
  enabled: boolean;
  planner: { provider: ProviderId; model: string }; // 計画・監視・意思決定・最終応答(高)
  worker:  { provider: ProviderId; model: string }; // 実行役サブエージェント(安)
  escalation?: { provider: ProviderId; model: string }; // 格上げ先(未指定なら planner を使う)
  maxEscalationsPerTask?: number; // 既定 1
}
```

- 既定推奨(UIのプリセット): planner = Fable 5、worker = Sonnet 5(または Haiku 4.5)、
  escalation = Fable 5。各帯は**独立にプロバイダ+モデル指定可**(例: worker=gpt-5.1、planner=fable でも可)
- enabled=false のときは既存挙動(cfg.model 単一)を完全維持

## 役割の割り当て

- **メイン会話ループ = planner 帯**: 計画(plan)、次アクション決定、サブエージェント結果のレビュー、
  ユーザーへの最終応答。ここに高モデルを使う
- **dispatch_agent のサブエージェント = worker 帯**(read/work とも既定で worker)。
  実行の手数(ファイル編集・コマンド・テスト回し)は安モデルが担う
- 「計画→実行を分業」を促すため、system prompt に運用ヒントを追加:
  「実装の手数が多い工程は dispatch_agent(work)へ委譲し、あなた(planner)は計画・レビュー・
  統合に集中する」。ただし強制はしない(小さいタスクは main が直接やってよい)

## エスカレーション(詰まったら格上げ)

worker サブエージェントが以下を満たしたら、その1タスクを escalation 帯で自動リトライ(最大 maxEscalationsPerTask 回):
- 自己検証(postEditHook / vitest)が N 回連続失敗、または
- ツールエラー・例外が連続、または
- 子の maxTurns 到達で未完

- 格上げは「その worker タスクのみ」。会話全体のモデルは変えない
- 格上げ時は M16-1 の compaction を経由(キャッシュ前提が変わるため)
- 発動をチャットに情報カード表示(「実行が難航→上位モデルへ格上げ」)+ audit.jsonl 記録
- planner 自身も、レビュー時に「この worker 結果は品質不十分」と判断したら再委譲を選べる
  (プロンプト運用。強制ロジックにはしない)
- 無限格上げ防止: escalation 帯でも失敗したら通常のエラー処理へ(それ以上上げない)

## M16 フォールバックとの関係

- M16 の残高・課金フォールバックは「プロバイダ丸ごと切替」、M18 は「役割ごとの通常運用切替」。
  併存させる: 各帯の呼び出しが課金エラーを出したら、その帯に対して M16 フォールバックを適用
- リトライ(429/5xx)は各帯の呼び出しで従来どおり有効

## UI(Settings「モデル自動切替」節)

- enabled トグル + planner / worker / escalation それぞれの provider+model 選択
- プリセットボタン: 「高品質重視(Fable/Sonnet/Fable)」「コスパ重視(Sonnet/Haiku/Fable)」
- 現在どの帯がどのモデルかを一覧表示
- 各帯に必要なAPIキーが未登録なら警告(横断構成の取りこぼし防止)
- 会話中は、ツールカード/メッセージにどの帯で処理したかの小さなバッジ(planner/worker)を表示

## テスト

- enabled=false で完全に従来挙動(既存テスト不変)
- モックプロバイダで: main=planner帯・sub=worker帯で呼ばれること
- エスカレーション発火(worker N回失敗→escalation帯で再実行)/ 上限で停止 / 格上げ時compaction経由
- プロバイダ横断(planner=anthropic, worker=openai)でブロック変換が正しいこと
- 帯ごとのキー未登録時の警告・エラー処理
- 進化ジョブは modelPolicy の影響を受けない(進化のモデル選択は従来どおり)ことを guardrails で固定

## 受け入れ基準

- 既存全テスト+新規合格 / typecheck 3構成
- 「計画を立てて大きめのアプリを作って」で、mainがFable・実行サブがSonnet(等)で動き、
  難所だけFableに格上げされることが実測できる(ベンチ②REST APIで planner/worker のトークン内訳と
  コストを autonomy-comparison.md に追記)
- enabled=false のユーザーは何も変わらない
