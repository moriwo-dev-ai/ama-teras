# 帰宅後検証レポート(Windows実機)

実施日: 2026-07-04〜05 / 実施者: Claude Code(`docs/post-return-check-prompt.md` に基づく自動実施)
環境: Windows 11 Home 10.0.26200 / Node v24.18.0 / ビルド済み `out/` を `npx electron .` で起動し CDP(9222)で自動操作

## 結果サマリ

| # | 項目 | 結果 |
|---|------|------|
| 1 | `npm run typecheck`(node/web/remote) | ✅ |
| 2 | `npm run test` 281件 | ✅(1件Windowsでタイムアウト → テスト側修正) |
| 3 | `npm run build` + `out/remote-ui/index.html` 生成 | ✅(初のWindowsビルド完走) |
| 4 | `processes.test.ts` Windows実行 | ✅ 7件合格 |
| 5 | ProcessManager 実プロセスツリー kill | ✅ 孫(PING.EXE)まで死亡確認 |
| 6 | アプリ起動 + CDP接続 | ✅ |
| 7 | Settings UI(maxTurns/postEditHook/scopeMode/リモート節) | ✅ 保存・クランプ(0→1, 999→200)含む |
| 8 | 自動チェックポイント(作成・復元・git不変・往復) | ✅ |
| 9 | リモートアクセス(401/200/SSE/remote-ui) | ✅(検証後も**有効のまま**=ユーザー要望) |
| 10 | M9(system承認・audit.jsonl・ハード拒否) | ✅ |
| 11 | claude-fable-5 prompt caching 実測 | ✅ cache_read 非ゼロ |
| 12 | TODO CLI 自走ベンチ | ✅ 1.3分・5ターン・介入0回・テスト11/11 |

## 詳細

### 1〜3. 基本検証

- typecheck: 3構成すべて合格。
- test: 初回 280/281。`checkpoints.test.ts`「pre-restore 往復」だけが既定5秒でタイムアウト。
  原因は Windows の git プロセス起動コスト(このテストは restore 2回で git 呼び出しが最多)。
  タイムアウトを 20s に延長して修正(コミット dc60ea2)。修正後 **281/281 合格**。
- build: 完走。`out/remote-ui/index.html` + assets + `manifest.webmanifest` 生成を確認。

### 4〜5. M11 Windows固有(taskkill 経路)

- `processes.test.ts` 7件合格(Windows 上で taskkill 組み立て経路を含む)。
- 実プロセススモーク: 実物の `ProcessManager` を esbuild でバンドルし、
  `cmd /c "echo & ping -n 60"`(node → cmd → cmd → PING.EXE の3段ツリー)を background 起動 →
  出力取得 → `kill()` → **root/conhost/cmd/PING.EXE 全て死亡**を tasklist で確認。
  `taskkill /pid <pid> /T /F` が孫まで殺すことを実機で確認できた。

### 7. Settings(CDP経由でUI操作)

- 「最大ターン数」「編集後フック」「操作範囲(project/fullPc)」「リモートアクセス」「作業ディレクトリ」
  すべて表示を確認。APIキー欄は「設定済み」表示。
- maxTurns を UI 入力→blur で保存: 60→60、999→**200にクランプ**、0→**1にクランプ**が
  config.json に反映されることを確認。
- 注意(E2E手法): ウィンドウが非フォーカスだと Chromium が focus/blur イベントを発火させないため、
  CDP の `Emulation.setFocusEmulationEnabled` が必須だった(アプリのバグではない)。

### 8. 自動チェックポイント(実チャット経由)

一時 git リポジトリを workspace に設定し、チャット(claude-fable-5)で write_file を1回実行(承認ダイアログ→許可):

- Debugパネルに `write_file 実行後` のチェックポイントが出現 ✅
- ファイルを手動で破壊 → UI「復元」→ 内容が戻る ✅
- **HEAD 不変・index 汚れなし・`refs/mycodex/` 以外の ref 増加なし** ✅
- 復元時に `pre-restore` 退避が作られ、そこから復元し直すと破壊状態に戻る(往復) ✅

### 9. リモートアクセス(M10)

- Settings から有効化 → 64文字トークンが画面表示(config.json には sha256 ハッシュのみ)
- `GET /api/status` トークンあり **200** / なし **401** ✅
- `GET /api/events` が SSE で `event: snapshot` を即時返す ✅
- `GET /` が remote-ui SPA を配信、Chrome(headless+CDP)で実レンダリング確認:
  「接続中」バッジ、チャット/承認/進化/監査タブ、デスクトップとのチャット履歴同期 ✅
- **逸脱(ユーザー指示)**: 手順書は検証後に無効化する指定だが、スマホから承認したいとの
  要望によりリモートアクセスは**有効のまま**残した。トークンは Settings から「トークン再生成」
  すればいつでも失効できる。
- 備考: 最初の headless Chrome 検証(`--dump-dom --virtual-time-budget`)は SSE 常時接続で
  仮想時間が尽きずハング。CDP接続方式に切替えて解決(アプリ側の問題ではない)。

### 10. M9(PC全体スコープ)

- fullPc 切替時に警告モーダル表示 → 有効化 ✅
- workspace 外(%TEMP%)への write_file: autoApprove.write=ON でも承認ダイアログが出て、
  **system警告バナーあり・解決済み絶対パス表示・allow-session ボタン非表示** ✅ → 許可で書き込み成功
- `audit.jsonl` に `approval` / `result`(scope=system)が追記 ✅
- `secrets.json` への書き込み指示: **承認ダイアログなしで即エラー**、audit に `hard-deny` 記録 ✅
- 検証後 project へ復帰、一時ファイル削除済み

### 11. claude-fable-5 / prompt caching 実測

usage は従来 main で捨てられ観測手段がなかったため、`loop.ts` の message_done に
`[usage]` ログ1行を追加(恒久的な可観測性として妥当と判断)。実測(list_dir→read_file 連鎖):

```
turn=0 in=2 out=27 cache_read=2970
turn=1 in=2 out=51 cache_read=3162   ← 2回目呼び出しで cache_read 非ゼロ
turn=2 in=2 out=96 cache_read=3209
```

別セッション初回でも cache_read=2691(system+ツール定義がセッション跨ぎでもヒット)。
**cache_control の配置は実APIで有効に機能している。** ツール連鎖(list_dir→read_file)も
claude-fable-5 で正しく完遂した。

### 12. TODO CLI 自走ベンチ

設定: autoApprove 全ON / maxTurns=100 / postEditHook=`npm run -s test --if-present` /
一時 git リポジトリを workspace に。課題「TODO管理CLI(add/list/done、todos.json 保存)を作り、
vitest テストを書いて全部通して」を1メッセージで投入。

- **完遂**: 所要 **1.3分・5ターン・介入0回**(claude-fable-5)
- 生成物: `todo.mjs` / `todo.test.mjs`(11テスト)/ `package.json` / npm install 込み
- 独立検証: 別プロセスで `npx vitest run` → **11/11 合格**。
  CLI 実操作(`add`→`list`→`done`→`list`)も正常動作
- cache_read はターンを追うごとに増加(3274→7455)し、キャッシュがループ全体で機能

### postEditHook の実発火確認(M11-4)

ベンチ中はフックが `-s --if-present` で無出力だったため、決定的テストを別途実施:
hook=`cmd /c echo HOOK_RAN_12345` で write_file を1回 → tool_result 末尾に
`[post-edit hook]` ブロックが付き、**モデルがその内容を一字一句引用できた**
(= フック出力がモデルに見えている)。

## 発見した問題と対処

1. **checkpoints.test.ts の Windows タイムアウト**(軽微): 上記のとおりテスト側で修正・コミット済み。
2. **usage の非可観測**(軽微・改善): cache_read を確認する手段が UI にもログにも無かった。
   main ログに `[usage]` 1行を追加(`src/main/agent/loop.ts`)。
3. **多重起動ガードなし**(観察・未対処): 検証中に誤って2インスタンス同時起動になった際、
   同じ userData を共有して両方起動し、Chromium の disk cache エラーが多発した
   (クラッシュはせず)。`app.requestSingleInstanceLock()` の導入を検討する価値あり。
   アーキテクチャ判断のためコード変更はせず記録のみ。
4. アプリ本体のバグは発見なし。E2E 手法上のつまずき(フォーカスイベント抑止、
   headless Chrome の SSE ハング、Git Bash の `/pid` パス変換)はレポート内に記録。

## 残る人間確認事項

- **iPhone 実機 + Tailscale**(`docs/M10-manual-test.md` B節): リモートアクセスは有効化済み・
  Tailscale はオンライン(`morikawa.tailb1fb66.ts.net`)。接続URLでの実機確認のみ残
- **NSISインストーラ**: 開発者モードONまたは管理者ターミナルで `npm run dist`(winCodeSign の
  シンボリックリンク問題。`--dir` は成功実績あり)
- M10 の承認競合(first-response-wins)・進化タブ等のスマホ実機シナリオ
- `docs/autonomy-comparison.md` のベンチ3課題の実測(任意)
