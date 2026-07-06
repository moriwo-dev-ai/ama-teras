# M17: リブランド(→ AMA-teras)+ 自律モード + 左ペインのソート修正

3件をまとめて実施。各ステップ独立コミット。既存テスト(446件)を壊さないこと。

## 名称(確定 2026-07-07)

- 表示名・ロゴ: **AMA-teras**(文中プロセスでは "Amateras" 表記も可)
- 技術識別子: `amateras`(package name / userDataフォルダ / appId)
- 記憶ファイル: `AMATERAS.md` / 計画ファイル: `AMATERAS_PLAN.md`
- 由来: 天照(天を照らす=terasu、八百万=複数のモデル・スキルを統べる)。
  他社・他モデル名(Codex=OpenAI / Fable・Mythos=Anthropicモデル)を名前に含めない
- 既知の同名先行: Eclipseプラグイン集「Project Amateras」(休眠OSS・別分野)。
  個人利用範囲では実害少と判断。公開前に商標(J-PlatPat/USPTO)は要確認

---

## M17-1: リネーム(MyCodex → AMA-teras)

**影響が広いので最初に単独で実施し、全テスト通過を完了条件とする。**

置換対象:

| 現在 | 変更後 | 備考 |
|---|---|---|
| MyCodex(表示名) | AMA-teras | ウィンドウタイトル・UI見出し・README・USER-GUIDE |
| mycodex(package name) | amateras | package.json name、electron-builder appId/productName |
| `MYCODEX.md`(記憶) | `AMATERAS.md` | memory.ts。後方互換: 旧ファイルがあれば読込+初回に新名へ移行 |
| `MYCODEX_PLAN.md`(計画) | `AMATERAS_PLAN.md` | plan ツール。同上の後方互換 |
| userData `mycodex/` | `amateras/` | config/secrets/sessions/audit/mcp.json。**移行必須**(下記) |
| CLAUDE.md 内の記述 | AMA-teras | プロジェクト名の言及 |

**userData移行(最優先・忘れると事故)**:
- 起動時、新 userData(`amateras/`)が無く旧(`mycodex/`)があれば、旧→新へディレクトリコピー
- secrets は electron safeStorage(マシン鍵)なので同一PCなら移行後も復号可
- 移行後、旧ディレクトリは消さず残す(ロールバック用。ログに移行済みと記録)
- テスト: 旧userDataあり→新へ移行されキー・履歴が引き継がれる / 新のみ→何もしない / 両方あり→新を優先

注意:
- リポジトリフォルダ `C:\dev\mycodex` 自体は変えない(パス据え置き)
- 進化タグ `evolve/N` は据え置き
- ソースの識別子(`MyCodexApi` 等)の改名は任意。ユーザーに見える文字列を優先
- アイコンは保留中(build/candidates/ はそのまま・不変)

## M17-2: 自律モード(フルアクセス・スイッチ)

チャット入力欄付近に、承認なしで連続実行する「自律モード」トグルを置く(参考: Cowork の「フルアクセス」)。

配置・UX:
- 送信欄の左に `🔓 自律モード` トグル(OFF時は `🔒 通常`)
- **ONにする瞬間に危険警告モーダル**:
  - 文面: 「自律モードでは、ファイル変更・コマンド実行・システム領域の操作を**確認なしで実行**します。AIが誤った操作をしても止まりません。自己責任で有効化しますか?」
  - チェックボックス「リスクを理解しました」を入れないと「有効化」ボタンを押せない
- ON中はチャット上部に警告バー(色つき)常時表示。OFF はワンクリック

挙動(**自己責任・原則すべて自動実行**):
- safe/write/exec を自動承認、`scopeMode:'fullPc'` の system スコープ操作も自動承認
- **システム領域の操作は許可する**(読み取り・通常の書き込み・コマンド実行)
- **ただし「破壊的操作」だけはハード拒否**(自律モードでも維持):
  1. secrets.json への読み書き(APIキー鍵素材の保護。自分の認証情報を壊さない/漏らさない)
  2. アプリ自身の userData(config/sessions/audit 等)の破壊的変更
  3. Windowsシステム領域の**破壊的操作**: 既存システムファイルの削除・上書き、
     `C:\Windows` `Program Files` 配下の削除/改変、ドライブフォーマット等
  - 判定方針: ファイル系は「既存の保護対象パスへの delete/overwrite」を破壊と定義し拒否、
    新規作成・読み取りは許可。bash 系は静的判定不能のため、**カタストロフィックな
    コマンドパターン**(`format`, `del/rmdir /s` on system, `diskpart`, `rd /s C:\Windows` 等)を
    denylist トリップワイヤで拒否。それ以外の system コマンドは通す
  - この denylist は「自分と OS を再起不能にしない」最小限。残余リスクはユーザー了承済み(自己責任)
- 実行された操作は**すべて audit.jsonl に `autonomous:true` で記録**
- 状態は**セッション単位**(SessionStore 保持)。アプリ再起動時は必ず OFF に戻す(事故防止)
- リモート(スマホ)からもトグル可。ただしON操作は危険モーダル同等の確認を必須

進化ジョブへの非波及: 自律モードのフラグは進化ジョブの ToolContext に注入しない(restrictExec 維持)。guardrails でテスト固定。

テスト: ON時に承認要求が出ない / secrets・システム破壊は拒否される / 通常のsystem操作は通る / bash denylist / audit記録 / 再起動でOFF / モーダル未チェックで有効化不可 / 進化ジョブ非波及。

## M17-3: 左ペインのソート修正

「セッションを選択するとそのプロジェクトが最上部へ移動」する挙動をやめる。

- ソートキーを**プロジェクト配下セッションの最新 updatedAt の降順**に固定(安定ソート)
- = セッションに書き込み(新メッセージ・ツール実行)があって updatedAt が更新された
  プロジェクトだけが上に来る。単なる選択(閲覧)では並びは変わらない
- 選択中プロジェクトはハイライトで示すだけ。下にあっても上へ飛ばさない
- 実装: LeftPane のプロジェクト一覧ソートと選択状態を分離
- テスト: 選択のみでは順序不変 / セッション更新でそのプロジェクトが先頭へ / 同時刻の安定性

## 完了時

- 全テスト合格 / typecheck 3構成 / `npm run build`
- docs/M17-manual-test.md(リネーム後のキー・履歴引き継ぎ、自律モードON/OFF体感と破壊拒否、ソート挙動)
- USER-GUIDE.md 更新(名称 AMA-teras・自律モードの節と注意書き)
- PROGRESS.md 更新
