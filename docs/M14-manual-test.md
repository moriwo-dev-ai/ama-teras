# M14 手動確認(画像入力・screenshot・fullPcセッション許可)

自動テスト(vitest 403件・typecheck 3構成)と、Claude Code による実機確認
(画像添付→内容認識・blob外出し・ベンチ④)は 2026-07-06 に実施済み。以下は体感確認用。

## M14-1/2/3: 画像入力

- [x] 添付画像がモデルに渡り内容を答えられる(自動確認済み: 赤い正方形→「赤」)
- [ ] エクスプローラから画像をチャット欄へ**ドラッグ&ドロップ** → サムネイル表示 → 送信
- [ ] スクリーンショットを撮って(Win+Shift+S)チャット欄に**ペースト** → 送信
- [ ] 「このモックどおりに作って」で画像+指示が通る(モックのUI再現)
- [ ] スマホ(remote-ui)の📷ボタンから写真を添付して送信できる
- [ ] セッションを閉じて復元しても画像付き履歴が壊れない
      (`%APPDATA%\mycodex\sessions\blobs\` に画像本体が外出しされている)

## M14-2: screenshot ツール

- [ ] devサーバ起動中に「http://localhost:5173 のスクショを撮って」→ 承認なしで撮影され
      ツールカードに画像が出る(autoApprove.safe ON時)
- [ ] 「https://example.com のスクショを撮って」→ **autoApprove全ONでも承認ダイアログ**が出て、
      「セッション中許可(example.com)」ボタンがある
- [ ] セッション中許可後、同じドメインの再スクショは自動・**別ドメインは再承認**
- [ ] 外部URLのスクショが(自動許可分も含め)`audit.jsonl` に記録されている
- [ ] 「file:///C:/Windows/win.ini のスクショ」→ ダイアログなしで拒否される

## M14-5: fullPcの「セッション中許可(このフォルダ)」

- [ ] 既定OFF: 従来どおり system スコープは毎回承認(ボタン自体が出ない)
- [ ] Settings → 操作範囲 → 「fullPc時のセッション中許可」をON →
      workspace外への write_file 承認に「このセッションでは常に許可(このフォルダ: …)」が出る
- [ ] 許可したフォルダへの2回目は自動通過し、`audit.jsonl` に allow(session-auto) が残る
- [ ] 別フォルダ・別ツール・bash(exec)は従来どおり毎回承認
- [ ] `%APPDATA%\mycodex\` 等の保護領域はONでも即拒否のまま

## M14-4: ベンチ④

- docs/autonomy-comparison.md の実測表参照(React作成→devサーバbackground→
  screenshot自己確認→見た目修正、を無介入完遂が合格条件)

## 既知の制約(仕様)

- 画像はセッションあたり合計50MBまで。超えると古い画像から「[画像: 説明]」テキストに置換
- compaction(要約)対象になった古い画像もテキスト化される(直近ターンの画像は保持)
- sessions/blobs/ は content-addressed(共有)のため自動GCしない(セッション削除でも残る。
  肥大したら手動削除可 — 参照が切れた分はロード時に置換テキスト化されるだけで壊れない)
- OpenAIプロバイダでは tool_result 内画像を直後の user メッセージとして注入する
  (API制約の互換レイヤ。Anthropicはネイティブ)
- screenshot は http/https のみ。LAN内IP(192.168.x.x等)も「外部」扱いで承認制
