# M9 手動確認手順(操作範囲のPC全体拡大・全操作承認制)

前提: `npm run typecheck` と `npm run test` が全合格していること。
以下は実UIでの確認シナリオ(実行はユーザー)。

## 1. 既定(project)で後方互換が保たれていること

1. `npm run dev` で起動 → Settings を開く
2. 「操作範囲(scopeMode)」が **project** になっていることを確認(既存 config.json に scopeMode が無くても project になる)
3. チャットで「このプロジェクトの README を読んで要約して」→ 従来どおり動く(workspace内、autoApprove.safe なら承認なし)
4. チャットで「デスクトップに hello.txt を作って」
   → ツール実行が **承認ダイアログなしで即エラー** になり、
   「プロジェクト外の操作は現在の設定(scopeMode: 'project')では拒否される」の旨がツール結果に出ること

## 2. fullPc の有効化(確認モーダル)

1. Settings → 操作範囲 → **fullPc** を選択
2. 警告色(アンバー)の確認モーダルが出ること(「毎回承認される」「userData/Windows システム領域は引き続き拒否」の説明)
3. 「キャンセル」→ project のまま変わらないこと
4. 再度 fullPc → 「有効にする」→ fullPc に切り替わり、パネルに「⚠ fullPc 有効中」の注意書きが出ること

## 3. system スコープの強制承認(中核シナリオ)

事前に Settings の「ツール自動承認」で safe / write / exec を**すべて ON** にしておく(無視されることの確認のため)。

1. チャットで「デスクトップ(%USERPROFILE%\Desktop)に hello.txt を『こんにちは』という内容で作って」
2. **autoApprove が全ONでも**承認ダイアログが出ること
3. ダイアログに以下が表示されていること:
   - アンバーの警告バナー「⚠ プロジェクト外の操作(PC全体スコープ)」
   - 解決済み絶対パス(`C:\Users\...\Desktop\hello.txt`)
   - **「このセッションでは常に許可」ボタンが無い**こと(拒否/許可のみ)
4. 「許可」→ デスクトップに hello.txt ができること
5. 別の指示で「デスクトップに hello2.txt を作って」→ **再度**承認ダイアログが出ること(セッション記憶されない)
6. 今度は「拒否」→ hello2.txt が**できない**こと、エージェントに拒否がエラーとして伝わること

## 4. bash の毎回承認(fullPc)

1. autoApprove.exec = ON のまま、チャットで「`echo test` を実行して」
2. fullPc では**毎回**承認ダイアログが出ること。警告に「このコマンドはPC全体に影響し得ます」が含まれること
3. 同じコマンドをもう一度 → また承認ダイアログが出ること

## 5. ハード拒否(userData)

1. チャットで「`%APPDATA%materas\config.json`(アプリの userData の config.json)に `{}` を書き込んで」
2. **承認ダイアログすら出ずに**即エラーになること(「保護領域のため拒否」)
3. 同様に secrets.json は**読み取り**も即エラーになること
4. `C:\Windows\test.txt` への書き込み → 即エラー(fullPc でも)

## 6. audit.jsonl

1. シナリオ3〜4を実施後、`%APPDATA%materas\audit.jsonl` を開く
2. system スコープの承認(allow/deny)・実行結果(ok/error)・ハード拒否が JSONL で1行ずつ記録されていること
   (ts / tool / scope / paths / event / detail)

## 7. project に戻す(復帰確認)

1. Settings → project に戻す(こちらは確認モーダルなしで即切替)
2. 「デスクトップに hello3.txt を作って」→ 承認なしの即エラー(シナリオ1と同じ)に戻ること

## 8. 自己進化が影響を受けないこと

1. fullPc のまま、進化パネルから手動 enqueue(または request_capability 発火)で進化ジョブを1回走らせる
2. 従来どおり B worktree で生成→ゲート→昇格承認ダイアログ、まで動くこと
   (進化ジョブの bash は restrictExec のまま、書き込みは plugins 配下のみ。
   fullPc の毎回承認は進化ジョブ内には波及しない)
