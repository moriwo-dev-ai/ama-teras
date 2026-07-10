# 配布版(packaged)での自己進化 — 机上トレースと設計メモ(M28-2)

作成: 2026-07-11 夜間自律作業その3 T2。
結論: **配布版のプラグイン専用進化パスは今夜は見送り**(工数と「検証3段の同等性」の両面で大きすぎる)。
配布版では進化機能を理由つきで明示的に無効化し(実装済み)、将来の導入経路は
「コミュニティレジストリからの導入(レジストリCIが検証を担う)」を本線とする。

## 1. 机上トレース: packaged で request_capability はどこで死ぬか

前提: `app.isPackaged` 時、`app.getAppPath()` = `<install>\resources\app.asar`(仮想パス)。
ソースツリー・`.git`・`node_modules`(devDependencies)・npm/npx は存在しない。

| 段階 | 処理 | packaged での結末 |
|---|---|---|
| 1 | `request_capability` → `evolution.enqueue()` | — |
| 2 | `enqueue` → `nextJobId(repoDir)` = `git tag -l 'evolve/*'` を repoDir で実行 | **最初の死点**。cwd が asar 仮想パスのため spawn が ENOENT/ENOTDIR、または実ディレクトリでも `.git` 不在で `fatal: not a git repository`。enqueue が reject し、ツール結果は生のgitエラー(ユーザーには意味不明) |
| 3 | (仮に通っても)`WorktreeManager.create` = `git worktree add` | `.git` 不在で失敗 |
| 4 | 検証ゲート `npm run typecheck` / `npx vitest run` | npm/npx・devDependencies・tsconfig が無く失敗 |
| 5 | スモーク `AMATERAS_SMOKE=1 npx electron .` | npx/electron(dev) が無く失敗 |
| 6 | 昇格 `git merge` + タグ / ホットリロード | `.git` 不在で失敗。さらに導入先 `resources/plugins` は Program Files 配下で通常ユーザー権限では書き込み不可 |

インポート(`pluginImportStart`)も同じ EvolutionManager 経路のため同様に死ぬ。
→ 実装した対処: `createEvolution` が packaged を検出したら safeMode と同じスタブを返し、
`enqueue` は平易な理由文で throw。EvolutionPanel にバナー表示+起動/インポートボタン無効化。
`runtimeFlags.packaged` を新設(renderer への伝搬)。

## 2. リポジトリ不要のプラグイン専用進化パスの評価(見送りの根拠)

構想: 一時ディレクトリで生成 → 検証 → `userData/plugins` へ導入(コア進化はやらない)。

必要になる改修:

1. **導入先の変更**: `resources/plugins`(読み取り専用)ではなく `userData/plugins` を新設し、
   ToolRegistry/loader を複数ディレクトリ対応にする(名前衝突・優先順位の設計も必要)
2. **検証ゲートの代替**:
   - typecheck: tsc が無い。esbuild transform(同梱済み)では**構文チェックのみで型検査不可**
   - vitest: 実行系が無い。テスト同梱の意味が消える
   - スモーク: packaged 実行ファイルの `--tool` 起動で代替可能(唯一まともに残る段)
   → 「B環境で3段検証」と**同等の保証が構造的に作れない**。縮退ゲートで導入を許すのは
   「自分のコードも他人のコードも同じ扉を通る」ブランドの毀損
3. **ロールバック**: git タグ基盤が使えないため、userData/plugins の世代管理を別途自作
4. **キルスイッチ・pluginApiVersion** は流用可(M27-4/5 は loader 側で動く)

見積り: ローダ複数ディレクトリ化+導入先+代替ゲート+世代管理で中規模(数晩級)。
検証保証の低下という設計問題が工数以前にあるため、**見送り**。

## 3. 将来の本線(フェーズ3)

- 配布版のプラグイン獲得は**レジストリからの導入**に限定する:
  検証(typecheck/vitest/静的解析/レビュー)は**レジストリCIが実施済み**(検証済みバッジ+署名)で、
  ローカルは「署名検証+承認ダイアログ+キルスイッチ」を通す
  (= 検証の場所をローカルB環境からCIへ移すことで、devツール不在でも保証水準を維持する)
- 導入先は `userData/plugins`(ローダ複数ディレクトリ対応)。この改修はレジストリ導入
  実装時に一緒に行う(上記1のみが必要になり、2〜3はCI側の責務になる)
- 生成(自己進化)そのものはソース版限定のまま(BRAND_STRATEGY「配布版はコア自己進化不可」)
