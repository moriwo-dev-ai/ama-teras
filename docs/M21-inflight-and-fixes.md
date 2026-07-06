# M21: 実行中の対話性と可視化+修正 (2026-07-06 夜間自走)

M20完了(v0.2.0-M20)からの続き。実行中のエージェントに対する操作性・可視性を上げる4件。

## M21-1 実行中の追加指示

**課題**: 実行中は入力欄が無効で、「あ、それも一緒にやって」が言えない。停止→再指示しかない。

**設計**:

- 実行中も入力欄を有効化。送信されたテキストは**追加指示キュー**へ積む(複数可)
- 注入タイミングは**次のターン境界(LLM呼び出しの前)**。エージェントループの各ターン先頭で
  キューをdrainし、直前の user メッセージ(tool_result群)の**末尾に text ブロックとして追記**する
  - Anthropic: tool_result が先頭・text が後ろの並びは仕様上有効(逆は無効)
  - OpenAI互換層: tool_result → role:'tool'、text → role:'user' に順で分解されるため安全
  - これにより **tool_use/tool_result の対を絶対に壊さない**(API 400 の恒久破損を回避)
- モデルが応答を完了(end_turn)した時点でキューに指示が残っていたら、
  **新しい user メッセージとして積んでループを継続**する(指示の取りこぼし禁止)
- UI: 送信即時に「↩追加指示」バッジ付きの吹き出しを表示(イベント `instruction_queued`)。
  注入前でも見える。実行の「停止」は従来どおり即キャンセル(キューも破棄)
- 画像添付も追加指示に載せられる(text と同じ規則で追記)

**イベント**: `AgentEvent` に `{ kind: 'instruction_queued', sessionId, text }` を追加。

## M21-2 サブエージェント同時数の設定化

- `AppConfig.subAgentMaxParallel`(省略=既定3)。Settings で 1〜8 のセレクタ
- 実質の制限はAPIレート/コスト(M16リトライが429を吸収)である旨を Settings に注記
- write 衝突拒否(WriteLockTable)・親キャンセル伝播は従来どおり
- 上限は dispatch_agent の parallel 呼び出しの tasks 切り詰めに適用

## M21-3 QRコード表示の根治

**原因特定(実測済み・2026-07-06夕方の fix 7cce924)**:
接続ホスト名が renderer の localStorage 保存で、M17 の userData 移行のコピー対象に
「Local Storage」(leveldb実体)が無かったため消失 → ホスト空 → URL が組めず QR 非表示。
QRの描画コード自体は無傷だった。→ ホスト名を config.json(remote.host)へ永続化+
移行対象へ「Local Storage」「Session Storage」を追加済み。

**M21-3 での追加対応(設計上の残ギャップ)**:
平文トークンは有効化/再生成の直後しかメモリに無い(M13-0 の平文非保存設計)ため、
アプリ再起動後は「トークン無しQR」になる。これは仕様だが UI が不親切だった:

- トークン無し表示時に「📱 トークン込みQRを出す(再生成)」ボタンを明示
  (押すと確認 → 再生成 → トークン込みQRを表示。既存接続は再設定になる旨を警告)
- 回帰テスト: buildRemoteUrl(トークンあり/なし)+ RemoteQr の表示分岐をユニットで固定

## M21-4 実行の生存と考えの可視化

**課題**: 長い自走中に「生きてるのか固まってるのか分からない」「今何を考えてるのか見えない」。

**設計**(APIの追加コストなし — 既に受信しているストリームの活用):

- **経過時間+スピナー**: 実行中のメイン(ステータスバー)・各サブ(エージェントタブ)・
  実行中ツールカードに、開始からの経過秒(mm:ss)とCSSスピナーを表示
- **現在の状況(narration)**: メインの最新 text_delta の連結テキスト末尾(=いま考えて
  書いていること)を、受領した指示の直下に1〜2行でライブ表示。ストリーミング中のみ更新
- **サブの思考**: `agent:sub_update` を拡張し `narration?`(最新思考の末尾200字)、
  `currentTool?`、`startedAt?` を追加。work サブの loop から onUpdate を細かく発火
- **長時間bash**: 実行中の bash ツールカードに stdout 末尾数行をライブ表示
  (ProcessManager のリングバッファを 1秒ポーリングして `tool_progress` イベントで配信)。
  30秒出力が無ければ「⏳無応答 Xs」注意(kill はしない)
- 追加イベント: `{ kind: 'tool_progress', sessionId, toolUseId, outputTail, silentMs }`

## テスト方針

- loop: 注入位置(tool_result対の後・LLM呼び出し前)/完了時残キューでの継続/キャンセル破棄
- service: 実行中 chatSend がエラーにならずキューに積まれ instruction_queued が出る
- subagent: maxParallel 配線(4本渡して3本/設定8で8本)
- remote/QR: buildRemoteUrl とトークン再生成UIの分岐
- 可視化: sub_update 拡張フィールド・tool_progress の発火をモックで固定
