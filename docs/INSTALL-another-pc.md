# 別PCへAMA-terasを入れる(方法B: フォルダコピー・全機能版)

自己進化(M20)まで含めて全機能を別PCで使う手順。所要15〜30分(ダウンロード時間込み)。

---

## 全体の流れ

1. 新PCに前提ソフト(Node.js v24 + Git)を入れる
2. 今のPCのフォルダを新PCへコピー(node_modules等は除く)
3. 新PCで `npm install` → `npm run build`
4. 起動して APIキーを入れ直す

**大事な前提**: コピーするのは開発フォルダ(`C:\dev\mycodex`)です。
**あなたのチャット履歴・APIキーはこのフォルダには入っていません**(別の場所=`%APPDATA%\amateras`に暗号化保存)。
なので新PCでは会話ゼロ・キー未登録の状態から始まります(キーはPC固有の暗号化のため移せません)。

---

## ステップ1: 新PCに Node.js と Git を入れる(PowerShell)

新PCで **PowerShellを「管理者として実行」** し、次を順に貼り付け:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

- winget が「使用許諾に同意しますか」と聞いたら y。
- 入れ終わったら **PowerShellを一度閉じて開き直す**(PATH反映のため)。
- 確認:
  ```powershell
  node -v    # v24.x と出ればOK
  git --version
  ```

もし `winget` が無いと言われたら、Microsoft Store の「アプリ インストーラー」を更新してください(winget はそこに含まれます)。

---

## ステップ2: フォルダをコピーする

コピー対象は **`C:\dev\mycodex` フォルダまるごと**。ただし巨大で作り直せる3つ(`node_modules` / `out` / `release`)は除きます。
`node_modules` はPCごとに中身が違う(ネイティブ部品を含む)ので、コピーせず新PCで作り直します。
**`.git` フォルダは必ず含めてください**(git履歴・タグが自己進化とロールバックに必須)。

### 今のPCで — USB等へ書き出し

PowerShellで(`D:\transfer` は保存先。USBドライブ等に合わせて変更):

```powershell
robocopy C:\dev\mycodex D:\transfer\amateras /E /XD node_modules out release
```

- `/E` = サブフォルダごと、`/XD` = 除外フォルダ。`.git` は除外していないのでちゃんと入ります。
- 進化用の作業フォルダ `C:\dev\amateras-evolve`(もしあれば)は**コピー不要**(使い捨てのため)。

### 新PCへ — 置き場所を作って展開

USBを新PCに挿し、PowerShellで:

```powershell
mkdir C:\dev
robocopy D:\transfer\amateras C:\dev\mycodex /E
```

> 置き場所は `C:\dev\mycodex` にしておくと今のPCと同じで混乱しません。別の場所でも動きますが、パスは読み替えてください。

---

## ステップ3: 新PCで組み立てる

新PCのPowerShellで:

```powershell
cd C:\dev\mycodex
npm install
npm run build
```

- `npm install` は数分かかります(ここで node_modules を新PC用に作り直します)。
- `npm run build` は remote-ui(スマホ画面)などを生成します。

---

## ステップ4: 起動して使えるようにする

開発版として起動:

```powershell
npm run dev
```

- 初回、Settings(⚙)で **APIキーを入れ直し**てください(Anthropic または OpenAom)。キーは新PC固有に暗号化保存されます。
- 作業ディレクトリ(AIに触らせるフォルダ)も新PCのパスで設定し直してください。
- スマホ連携を使うなら、新PCにも Tailscale を入れて同じアカウントでログイン。

**普段使いのアイコン付きアプリにしたい**なら、代わりにインストーラを作れます:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist
```

→ `C:\dev\mycodex\release\AMA-teras Setup 0.2.0.exe` ができるので実行してインストール。
(この方法でも自己進化を使うにはソースフォルダを残しておく必要があります)

---

## よくある質問

**Q. 今のPCのチャット履歴も持っていける?**
A. 履歴は `%APPDATA%\amateras\sessions` にあります。ファイルはコピーできますが、**APIキーは新PCでは復号できません**(暗号鍵がPC固有)。履歴だけ移したいなら sessions フォルダをコピー→新PCの同じ場所へ。キーは入れ直し。

**Q. GitHub経由の方が楽?**
A. はい。今のPCで private リポジトリにpushしておけば、新PCは `git clone <URL>` の1行で済みます(USB不要・タグ履歴も自動で付いてくる)。その後は同じく `npm install` → `npm run build`。**public にする場合は中身を確認**(APIキー自体はリポジトリに入っていませんが、念のため)。

**Q. 2台目は1台目と同じAMA-teras?**
A. コピー直後は同じですが、**自己進化はそのPCのフォルダを書き換える**ので、以後それぞれ別々に育ちます(evolve/N が各PCで独立)。将来「進化を共有する」構想は、この2台目以降が前提になります。

**Q. 除外した node_modules をコピーしてしまった/動かない**
A. 新PCで `Remove-Item -Recurse -Force C:\dev\mycodex\node_modules` してから `npm install` し直せば直ります(ネイティブ部品のPC差が原因)。
