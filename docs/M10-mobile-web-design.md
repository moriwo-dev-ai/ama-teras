# M10: スマホ(iPhone)Webアクセス — Tailscale経由・フル操作

## 方針

main プロセスに HTTP サーバを内蔵し、モバイル向けSPAを配信する。イベント配信は **SSE(Server-Sent Events)**(Node標準 `http` のみで実装可、Safari対応良好、**新規依存ゼロ**)。ネットワーク境界は **Tailscale**(tailnet 内のみ到達可能)に任せ、アプリ側は**ペアリングトークン認証**を重ねる。デスクトップとスマホは**同一セッションを共有**し、どちらからでも送信・キャンセル・承認できる。

```
iPhone Safari ── Tailscale ──> PC :8787
                                ├─ GET /            remote-ui (静的SPA)
                                ├─ POST /api/*      操作系 (Bearer token)
                                └─ GET  /api/events SSE イベントstream (token)
```

**制約: 新規npmパッケージは追加しない。** サーバは Node 標準 `http`+`crypto`、remote-ui は既存依存(vite/react)のみでビルドする。

## 前提リファクタ: コアの transport 非依存化

現状 `src/main/ipc.ts` にロジックが直結している。IPC と SSE/REST の両方から同じ操作を呼べるよう:

- 新規 `src/main/core/service.ts` — `AgentService` クラスに集約:
  `chatSend / chatCancel / approvalRespond / toolsList / evolutionList / evolutionEnqueue / evolutionPromoteRespond / getStatus`
- 新規 `src/main/core/events.ts` — `EventBus`(Node `EventEmitter` ラッパ)。
  `AgentEvent` / `ApprovalRequestPayload` / `EvolutionEvent` をここに publish し、
  IPC(webContents.send)と SSE broadcast の両方が subscribe する
- `ipc.ts` は AgentService への薄い委譲に書き換える(**IPCチャネル名・型は変更しない**。既存テストが通ることが完了条件)

## リモートAPI

REST(すべて `Authorization: Bearer <token>` 必須):

| Method | Path | 対応 |
|--------|------|------|
| GET | /api/status | AgentStatus + 進行中セッション + scopeMode |
| POST | /api/chat | { text, mode? } → chatSend |
| POST | /api/chat/cancel | chatCancel |
| POST | /api/approval/respond | { id, decision }(remote からの allow-session は allow に降格) |
| GET | /api/tools | toolsList |
| GET | /api/evolution | evolutionList |
| POST | /api/evolution/enqueue | { description, expectedIO } |
| POST | /api/evolution/promote-respond | { jobId, approved } |
| GET | /api/audit?limit=100 | audit.jsonl 末尾(M9成果物) |
| GET | /api/history | 現在の会話履歴(表示用に整形) |

SSE `GET /api/events?token=...`(EventSource はヘッダ不可のためクエリトークン許可): EventBus の全イベントを `event: <channel>` + `data: <JSON>` で push(channel = `chat:event` / `approval:request` / `evolution:event`)。接続直後に `event: snapshot` で現在状態(history / pending approvals / jobs / status)を送る。SSE は自動再接続が組み込みなので再接続ロジック不要(`Last-Event-ID` は初版では未対応でよい。再接続時は snapshot で回復)。

**リモートに絶対に出さないもの:** secrets(set/status とも)、settings 変更、workspace 変更、scopeMode 変更。これらはデスクトップ専用。

## サーバ実装

- 新規 `src/main/remote/server.ts`: Node 標準 `http` のみ(SSE も同サーバ)。静的配信は自前実装(パストラバーサル対策込み・content-type最小マップ)
- 新規 `src/main/remote/auth.ts`:
  - トークンは初回有効化時に `crypto.randomBytes(32)` で生成、**ハッシュ(sha256)を config に保存**、平文はデスクトップUIにのみ表示
  - 比較は `timingSafeEqual`
  - 認証失敗は 401、一定回数失敗で 60秒バン(念のため)
- バインドは `0.0.0.0:8787`(Tailscale IP 固定にすると再取得時に壊れるため)。tailnet 外からの到達は Tailscale/OSファイアウォールが遮断する前提を README に明記
- `AppConfig` に追加: `remote: { enabled: boolean; port: number; tokenHash?: string }`(default: disabled)

## remote-ui(モバイルSPA)

- 新規 `src/remote-ui/` — Vite + React + TS(**既存の devDependencies のみ使用**。renderer とは別ビルド。`window.api` に依存しない)
- ビルド出力 `out/remote-ui` をサーバが配信。ルートの `npm run build` に組み込む
- 画面(モバイルファースト、1カラム):
  1. **Chat**: ストリーミング表示、送信、キャンセル、plan/normal切替
  2. **Approvals**: 承認待ちを最上部に固定バッジ表示。diff・警告・systemスコープバナーは Desktop の ApprovalDialog と同等情報
  3. **Evolution**: ジョブ一覧・状態・昇格承認/却下(diff表示)
  4. **Audit**: M9 の audit log 閲覧
- 初回アクセス時にトークン入力(またはURLフラグメント `#t=<token>` から取得)→ `localStorage` 保存
- SSE 切断時は EventSource の自動再接続に任せ、`open` イベントごとに snapshot で状態回復

## デスクトップ側 UI

Settings に「リモートアクセス」セクション:

- 有効/無効トグル、ポート設定
- トークン再生成ボタン(旧トークン即失効)
- 接続URL + トークンをコピー可能なテキストで表示(URL例 `http://<pc名>.<tailnet>.ts.net:8787/#t=...`)。Tailscale の MagicDNS 名は自動検出せずユーザー入力欄でよい(初版)
- **QRコード表示は初版では見送り**(`qrcode` 依存追加が必要なため。追加後に実装する後続タスクとして PROGRESS.md に記録)

## 承認の競合

ApprovalBroker は first-response-wins(既存の resolve 済み id への応答は無視する挙動を確認し、なければ追加)。デスクトップ/リモート双方に承認要求を配信し、片方が応答したらもう片方へ `approval:resolved` イベントで閉じる通知を送る。

## セットアップ手順(README追記用)

1. PC と iPhone に Tailscale をインストールし同一アカウントでログイン
2. MyCodex Settings → リモートアクセス有効化 → 接続URL(トークン付き)を表示
3. URL を iPhone へ共有(AirDrop / メモ等)→ Safari で開く → ホーム画面に追加(PWA的に使う。`manifest.json` + `apple-mobile-web-app-capable` メタタグを remote-ui に入れる)

## 実装ステップ

- M10-1: core/service.ts + core/events.ts 抽出、ipc.ts 委譲化(既存テスト全通過)
- M10-2: remote/server.ts + auth.ts + REST/SSE(vitest: node標準 http/fetch クライアントで結合テスト)
- M10-3: remote-ui 骨格(Chat + EventSource 接続)
- M10-4: Approvals / Evolution / Audit 画面
- M10-5: デスクトップ Settings(トグル・URL表示)+ config 拡張
- M10-6: README セットアップ手順 + 手動E2E(iPhone実機)

## 非対象(やらないこと)

- HTTPS(必要なら `tailscale serve` を後付けできる構成にしておく)
- マルチユーザー・複数同時セッション
- プッシュ通知(承認待ちバッジはSSE接続中のみ。将来 ntfy 等で拡張可)
- QRコード表示(依存追加後の後続タスク)
