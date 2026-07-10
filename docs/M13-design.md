# M13: QRコード・コンテキスト管理強化・MCPクライアント

実装順は小→大(QR → 記憶/compaction → MCP)。依存追加が解禁されたため npm パッケージ追加可(ただし最小限・理由をPROGRESSへ)。

## M13-0: QRコード表示(小)

- 依存追加: `qrcode`(renderer側でDataURL生成)
- Settings「リモートアクセス」節: 有効化直後/トークン再生成直後(=平文トークンが手元にある瞬間)のみ、
  トークン込みURL(`#t=...`)のQRを表示。それ以外の時はトークン無しURL(ホスト:ポートのみ)のQR+
  「トークン込みQRは再生成時のみ表示されます」の注記
- remote-ui 側は変更なし
- テスト: URL組み立てのユニットテスト(QR描画自体は目視)

## M13-1: コンテキスト管理の強化(長期記憶+compaction改良)

大規模タスクの最後のピース。方針: 「記憶はエージェント自身に管理させ、要約は構造化する」。

### 記憶ツール

- 新規ツール `memory`(planツールと同型):
  - `{ action: 'read' }` → AMATERAS.md の内容
  - `{ action: 'append', content }` → 「## 学習メモ」節へ追記(タイムスタンプ付き)
  - `{ action: 'rewrite', content }` → 全置換(整理用)
  - risk: 'safe'(書き込み先が AMATERAS.md 固定・ユーザーが目視可能)。進化ジョブでは使用不可(guardrails)
- system prompt に運用指示を追加: 「今後も使う知見(ビルド方法、規約、ハマりどころ)を発見したら
  memory に短く追記すること。会話固有の内容は書かないこと」
- 既存の memoryGet/Set IPC・Settings の編集UIはそのまま(人間とエージェントの共同編集になる)

### compaction改良

- **トリガーを実測トークンに変更**: M11で追加した usage(input_tokens + cache_read)を
  ループ内で保持し、モデルのコンテキスト上限の閾値(既定70%)で発火。文字数推定は廃止
  (モデル別上限は models.ts に定義、未知モデルは保守的な既定値)
- **2段階圧縮**:
  1. 第1段(軽量・要約より先に実施): 古いターンの tool_result 本文を切り詰め
     (各4KB→先頭1KB+`…[切詰め]`)。tool_use/resultのペア構造は壊さない
  2. 第2段(従来の要約): それでも閾値超過なら実施
- **構造化要約**: 要約プロンプトを自由文から固定セクションへ:
  `## 依頼の目的 / ## 完了したこと / ## 触ったファイル / ## 決定事項と理由 / ## 未解決・次にやること`
  (計画=AMATERAS_PLAN.md と記憶=AMATERAS.md は system prompt 側にあるため要約対象から除外のまま)
- **compaction直前フック**: 要約で消える範囲に重要な決定があれば memory へ退避するよう
  要約プロンプトに指示(1回のLLM呼び出しで要約+退避メモ抽出を同時に)
- テスト: トークン閾値トリガー、切詰めのペア構造保持、構造化要約のセクション検証(モックprovider)、
  compaction跨ぎで計画・記憶が失われないこと(既存テストの拡張)

## M13-2: MCPクライアント対応(大)

### 概要

AMA-teras を MCP ホスト/クライアントにし、外部MCPサーバーのツールを組み込みツールと同列に使えるようにする。

- 依存追加: `@modelcontextprotocol/sdk`(公式SDK)
- 対応transport: **stdio のみ**(v1。ローカルでコマンド起動型。HTTP/SSEリモートサーバーはv2へ)

### 設定

- `userData/mcp.json`(手編集可)+ Settings に「MCPサーバー」節(追加/削除/有効無効/接続状態):
  ```json
  { "servers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {} } } }
  ```
- 起動時+設定変更時に接続。接続失敗はUIに表示して他は継続(起動をブロックしない)

### 実装

- 新規 `src/main/mcp/manager.ts` — `McpManager`:
  - サーバーごとに接続し `tools/list` を取得
  - 各MCPツールを `ToolPlugin` アダプタでラップし registry に登録。名前は `mcp__<server>__<tool>`
  - risk の写像: MCPツールの annotations を使う —
    `readOnlyHint: true` → 'safe' / `destructiveHint: true` → 'exec' / それ以外 → 'write'
    annotations が無いツールは **'exec' 扱い**(安全側に倒す)
  - 承認ダイアログに「MCP: <server>」の出所表示+
    初回接続時にサーバー単位の信頼確認(「このMCPサーバーのツールを許可しますか」)
- プロセス管理: サーバーの子プロセスは M11 の ProcessManager に登録(終了時に全kill)
- **進化ジョブへの非波及**: 進化ジョブのToolContextにはMCPツールを見せない(guardrailsテスト固定)
- **スコープとの関係**: MCPツールはパスベースのスコープ判定対象外(外部プロセスのため)。
  代わりに上記の risk 写像+サーバー単位信頼で制御する旨を設計上明記
- remote-ui / スマホ承認は既存の承認フローに乗るため追加実装なし(出所表示のみ確認)

### テスト

- モックMCPサーバー(テスト内でstdio起動する最小実装)で: 接続→ツール列挙→登録→実行→結果、
  切断・接続失敗の縮退、risk写像、名前衝突(既存プラグインと同名)の拒否
- 実サーバー1本(`@modelcontextprotocol/server-filesystem` 等)でのE2Eは手動確認へ

## M13-3: ドキュメント

- `docs/M13-manual-test.md`(QR読み取り、記憶の追記され方、compaction跨ぎ体感、実MCPサーバー接続)
- USER-GUIDE.md に「MCPサーバーをつなぐ」「AIの記憶」節を追記
- PROGRESS.md 更新

## 受け入れ基準

- 既存339+新規テスト全合格 / typecheck 3構成
- QR: スマホカメラで読んで接続できる
- 記憶: 長い作業後に AMATERAS.md に有用なメモが増えており、compaction後も文脈が保たれる
- MCP: filesystem サーバーを設定→チャットからそのツールが使え、承認に出所が表示される
- guardrails: memory/MCPが進化ジョブから見えないことがテストで固定されている
