# 公開前セキュリティ総点検(SECURITY_AUDIT)

実施: 2026-07-10 夜間自律作業その2 T3(M27-3)。
対象: リポジトリ公開(AGPL-3.0・フェーズ1)前の機械的点検。**push・公開設定変更は未実施**(方針どおりユーザーが行う)。

## チェックリスト

### 1. git履歴の秘密情報スキャン — ✅ 検出なし

`git log --all -p`(全249コミット・全ブランチ)への機械的パターン走査:

| パターン | 対象 | 結果 |
|---|---|---|
| `sk-ant-…` / `sk-proj-…` | Anthropic / OpenAI キー | 検出なし |
| `AIza…` / `gsk_…` / `sk-or-v1-…` | Gemini / Groq / OpenRouter キー | 検出なし |
| `ghp_…` / `github_pat_…` / `AKIA…` / `tskey-…` | GitHub / AWS / Tailscale | 検出なし |
| `(api_key|secret|token|password)=<長い値>` 汎用代入 | 汎用シークレット | 検出なし(tokenHash等の設計上の語のみ) |
| `C:\Users\haru-` 等の個人パス | 個人情報 | 検出なし |
| Tailscale ホスト名(tailb1fb66) | 個人ネットワーク情報 | 検出なし |

**⚠ 要判断(未解決)**: 全コミットの Author が個人メールアドレス
(`haru-akane.morikawa@outlook.com`)。公開時にこれを許容するか、公開前に
`git filter-repo` 等で noreply アドレスへ書き換えるかはユーザー判断
(pushしていない今なら書き換え可能。指示どおり夜間作業では書き換えを行っていない)。

### 2. .gitignore と未追跡物の扱い — ✅ 決定・適用済み

| 対象 | 決定 | 理由 |
|---|---|---|
| `.claude/settings.local.json` | ignore追加 | ローカル権限設定(個人パス・運用詳細を含む)。`settings.json`(汎用許可リスト)は追跡のまま |
| `downloads/` | ignore追加 | エージェントのダウンロード作業領域 |
| `build/candidates/`(アイコン候補PNG 744KB) | ignore追加 | 検討時の生成物。採用分のみコミット |
| `build/icon.svg` | **コミット** | 採用アプリアイコンのソース(icon.ico 等の既追跡物と同列) |
| `BRAND_STRATEGY.md` / `REGISTRY_DESIGN.md` | **コミット** | README/NOTICE から参照する恒久文書。※内容は公開前提で書かれているが、公開直前にもう一度目視推奨 |
| `NIGHT_TASKS*.md` | ignore追加 | 個人向け夜間指示書。公開リポジトリに含めない |

### 3. APIキーの保存・読み出し経路 — ✅ 問題なし

- 保存は `SecretStore`(`src/main/secrets.ts`)のみ。**Electron safeStorage(Windows=DPAPI)**
  で暗号化し、ファイル(userData/secrets.json)には base64(暗号化バイト列) のみ。
  暗号化が使えない環境では保存自体を拒否(平文保存経路なし)。
  ※CLAUDE.md の「keytar等」は safeStorage 実装で充足(OSキーチェーン相当)。
- 読み出しは main プロセスの `secrets.get()` のみ。renderer へは boolean の
  `SecretsStatus`(設定済みか否か)だけを返す(キー本体を渡すIPCなし)。
- ログ・audit.jsonl・セッション保存(sessions.ts)にキーが混入する経路なし
  (機械的grepで確認。sessions は設計上 secrets を参照しない)。
- エージェント自身も secrets.json を読めない(executor の denyPaths が userData を拒否)。
- M27-1 の追加スロット(gemini/groq/openrouter)も同一経路(SecretStore/暗号化)を通る。

### 4. リモートアクセスのトークン強度 — ✅ 問題なし

`src/main/remote/auth.ts` / `server.ts`:

- 生成: `randomBytes(32)`(hex 64文字)= 256bit エントロピー
- 保存: config には **sha256 ハッシュのみ**(平文トークンは初回表示の一度きり)
- 照合: `timingSafeEqual`(タイミング攻撃対策)+ 長さ検証で例外安全
- 連続失敗5回で接続元IPを60秒バン
- リモートAPIの公開範囲: secrets / settings変更 / workspace変更 / scopeMode変更は**非公開**
  (デスクトップUI専用)。承認の「セッション中常に許可」も単発許可へ降格
- URL の `#t=` はフラグメント(サーバへ送信されない)。ネットワーク境界は
  Tailscale + OSファイアウォール前提(詳細: docs/REMOTE-SECURITY.md)

## 未解決・公開前にユーザーの判断/作業が必要な項目

1. **コミットAuthorの個人メール**(上記1)— 許容 or 履歴書き換えの判断
2. **`C:\Users\haru-\AppData\Roaming\Electron` の削除**(前夜の連絡事項の再掲。
   実設定の複製=暗号化済みキー素材のコピーが残っている。リポジトリ外だが早期削除推奨)
3. **BRAND_STRATEGY.md / REGISTRY_DESIGN.md の公開可否の最終目視**(戦略文書として
   公開に耐える内容か。「非公開=レジストリサーバー側」の線引きに矛盾はない認識)
4. **公開後のCI**: シークレットスキャン(gitleaks等)と `npm audit` をCIに組むのは
   フェーズ1残課題として推奨(今回は手動走査のみ)
5. 無料APIモード(M27-1)の互換エンドポイント実疎通は実キーがないため未検証
   (設定画面の「接続テスト」で初回確認できる)

## 再点検の手順(公開直前用)

```bash
# 秘密情報の再走査(公開直前にもう一度)
git log --all -p --no-color | grep -nE "sk-ant-|sk-proj-|AIza|gsk_|sk-or-v1-|ghp_|github_pat_|AKIA|tskey-"
# 未追跡物の確認
git status --short
```
