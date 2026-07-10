# MCPスターターパック(おすすめサーバーと設定例)

M13で対応したMCPクライアント向けの、2026年時点の定番サーバー導入ガイド。
すべて stdio / npx 起動型(AMA-teras v1の対応範囲)。Settings → MCPサーバー から追加するか、
`%APPDATA%materas\mcp.json` に直接書く。

## まずこの3つ(コード・ドキュメント・ブラウザで日常の8割をカバー)

### 1. Playwright(ブラウザ操作)— 一番のおすすめ

**AMA-terasの弱点だった「UI確認」を今すぐ部分的に解消できる。**
このサーバーはスクリーンショットではなく**構造化テキスト(アクセシビリティスナップショット)**で
ページ内容を返すため、画像入力に未対応の現AMA-terasでもそのまま使える。
「Reactアプリを作って→devサーバをbackgroundで起動→Playwrightで開いて→ボタンが表示されてるか確認して」が通る。

```json
"playwright": { "command": "npx", "args": ["-y", "@playwright/mcp"] }
```

- risk: ブラウザ操作系はwrite/exec相当で承認が出る。放置作業ではセッション許可か自動承認で
- 初回は Chromium のダウンロードが走る(数分)

### 2. GitHub(公式)

PR作成・issue・Actionsログの取得までチャットから。codex-comparison.md の「git/PR統合」ギャップの
かなりの部分をこれだけで埋められる。

```json
"github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." } }
```

- トークンは Fine-grained PAT で対象リポジトリ・権限を絞るのを推奨
- **注意**: mcp.json に平文で入る。リポジトリ内でなく userData 配下なのでコミットには乗らないが、
  PCを共有しているなら権限を最小に

### 3. Context7(ライブラリの最新ドキュメント)

「このライブラリの今のAPI」をモデルの学習データではなく実ドキュメントから引く。
古いAPIで書いてしまう事故が減る。

```json
"context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
```

## 必要に応じて

### Filesystem(公式・指定フォルダの読み書き)

AMA-terasには組み込みのファイルツールがあるため通常は不要。
**workspace外の特定フォルダだけ**を安全に触らせたい時の代替として有用
(fullPcにせず、対象フォルダだけMCP経由で開放する使い方)。

```json
"fs-docs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\<you>\\Documents\\notes"] }
```

### Brave Search(Web検索)

エージェントに検索させたい場合。APIキー(無料枠あり)が必要。

```json
"brave": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-brave-search"],
           "env": { "BRAVE_API_KEY": "..." } }
```

## mcp.json 全体例

```json
{
  "servers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp"] },
    "github":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
                    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." } },
    "context7":   { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  }
}
```

## 運用の注意

- 追加時に**サーバー単位の信頼確認**が出る(M13の安全設計)。心当たりのないサーバーは許可しない
- annotationsの無いツールはexec扱い=毎回承認。うるさければ Settings → 自動承認(exec)だが、
  ブラウザ・GitHubは実世界に影響するので**放置作業中の自動承認は対象を考えてから**
- MCPサーバーは子プロセスとして起動し、アプリ終了時に全部killされる(M11のProcessManager管理)
- つながらない時: Settings のMCP節にエラーが出る。だいたいは (a) npxの初回ダウンロード待ち、
  (b) envのキー未設定、(c) プロキシ。アプリ本体は影響を受けない

## 動作確認の一言テスト(帰宅後どうぞ)

- Playwright: 「example.com を開いてページの見出しを教えて」
- GitHub: 「amateras リポジトリの直近のコミット5件を要約して」
- Context7: 「zustand v5 の persist の正しい使い方をContext7で調べて」

## 情報源

- https://github.com/microsoft/playwright-mcp (公式。スナップショット方式の説明)
- https://techsy.io/en/blog/best-mcp-servers-2026
- https://www.totalum.app/blog/best-mcp-servers-2026
- https://saascity.io/blog/best-mcp-servers-claude-code-2026
