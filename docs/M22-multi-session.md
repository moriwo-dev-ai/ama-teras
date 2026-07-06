# M22: 複数プロジェクト同時実行 (2026-07-06 夜間自走)

## 目的

実行中でも左ペインで別プロジェクトのセッションを開き、**止めずに並行して**指示を出せるようにする。
「3DCADのビルドを回しながら、別プロジェクトのバグ調査を頼む」が1ウィンドウで成立する。

## コア設計: AgentService の複数ラン化

### ConvState(会話ごとの独立状態)

従来 service に1つだった `history / conversation / activeRun / lastPromptTokens /
persistChain / pendingInstructions / fallbackUsedFor / autonomousMode` を、
**会話(conversationId)ごとの `ConvState`** に集約する:

```
ConvState {
  id, title, createdAt, lastLLM?
  history: ChatMessage[]          // ランと参照共有
  lastPromptTokens: number
  persistChain: Promise<void>     // 保存の直列化は会話単位(=セッション永続化の排他)
  fallbackUsed: boolean           // M16: 1会話1回
  autonomous: boolean             // M17: 自律モードを会話単位に(下記)
  workspace: string               // 会話に束縛された作業ディレクトリ
  run: RunState | null
}
RunState {
  sessionId, ac: AbortController, startedAt
  workspace: string               // ラン開始時に固定(視聴切替でconfigが変わっても不変)
  processes: ProcessManager       // バックグラウンドプロセスも会話単位(他会話のcancelで死なない)
  pendingInstructions: [...]      // M21-1キューもラン単位
}
```

- `conversations: Map<id, ConvState>` + `current: ConvState`(いま見ている会話)
- **実行中の切替ブロックを撤廃**: sessionLoad/sessionOpen/sessionNew はランに触らない。
  実行中の会話を開き直すと「生きている history」にそのまま接続する
- **workspaceの束縛**: ランは開始時のworkspaceを保持し、ツールcwd・スコープ判定・
  チェックポイント・記憶/計画の読み書きすべてに使う(視聴切替でconfig.workspaceが
  変わっても実行中ランは影響を受けない)
- **自律モード(M17)を会話単位へ**: setAutonomous は現在の会話のフラグを切り替える。
  別会話へ切り替えても、実行中の会話の自律モードは維持される(新規/未設定の会話は常にOFF。
  再起動で全OFFは従来どおり。M20不変条件3=昇格承認の人間必須は不変)

### イベントの多重化

- `AgentEvent` 全体に `conversationId?` を付与(ランのemitクロージャで一括注入)。
  renderer/remote は「表示中の会話のイベントだけ」チャットへ反映する
- 新イベント `runs:changed`(EventBus/IPC/SSE): 実行中ラン一覧
  `{conversationId, title, workspace, sessionId, startedAt}[]`。左ペインの実行中
  インジケータ・軟性しきい値の判定・切替後の状態復元に使う
- `SubAgentUpdate` に `conversationId?` を追加(エージェントパネルで出所を表示)

### 承認のセッション帰属

- `ApprovalRequestPayload.origin?: { conversationId, title, workspace }` を追加。
  executor(executeToolWithApproval)がラン注入の getOrigin から載せる
- 承認ダイアログ/スマホの承認カードに「どのプロジェクト(会話)の承認か」を明示。
  複数同時でも id で応答するため取り違えは構造的に起きない(従来どおり)

### 同時実行数

- **ハード上限なし**。実質制限はAPIレート(429はM16リトライが吸収)とコスト
- 軟性しきい値: 同時5ラン超で警告の infoカードを出す(止めない)

### 後方互換

- 1会話しか使わない場合の挙動は完全に従来どおり(イベントに conversationId が
  付くだけ)。既存IPCの形は不変(SessionLoadResult に running? を追加)
- チャットの表示・キャンセル・M21-1追加指示・M21-4可視化は「表示中の会話」に対して
  従来どおり動く

## 制約・割り切り(PROGRESSにも記録)

- スマホ(remote-ui)は従来どおり「デスクトップと同じ current 会話」を見る。
  並行ランの存在は表示されるが、リモートからの同時多重操作UIはM22では作らない
- checkpointRestore は「現在のworkspaceで実行中のランがある」間は拒否(復元が
  実行中の書き込みと衝突するため)。実行中セッションの削除も拒否
- 進化ジョブ(EvolutionManager)は従来どおり直列キュー(並行化しない)

## テスト方針(並行レースを厚めに)

- 2会話同時実行: 独立history・独立status・イベントのconversationId分離
- 実行中の別会話開始・切替(ブロックされない・historyが交錯しない)
- 会話Aのcancelが会話Bを殺さない(AbortController/ProcessManager分離)
- 並行persist: 同一会話は直列・別会話は互いをブロックしない(ファイル内容の整合)
- 承認origin: 2会話から同時に承認要求→それぞれ正しいoriginを持ち、応答で取り違えない
- workspace束縛: 実行中に視聴切替でconfig.workspaceが変わってもランのcwd/スコープ不変
- 自律モード: 会話単位(Aで ON→Bへ切替→BはOFF・Aのランは自動承認継続)
- 軟性しきい値: 6ラン目で警告infoカード
- 後方互換: 単一会話の一連の既存テストが全て緑のまま
