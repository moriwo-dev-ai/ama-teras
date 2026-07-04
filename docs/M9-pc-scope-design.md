# M9: 操作範囲のPC全体拡大(全操作承認制)

## 方針

ワークスペース外の操作を「systemスコープ」と定義し、**systemスコープは risk や autoApprove 設定に関係なく毎回承認必須**とする。プロジェクト内(workspaceスコープ)の挙動は現状維持。自己進化ジョブの制限(writeAllowlist / restrictExec)は本機能の影響を一切受けない。

## スコープ分類

- `workspace`: 解決後の絶対パスが `config.workspace` 配下
- `system`: それ以外すべて

ハード拒否(承認ダイアログすら出さず即エラー):

- アプリ自身の userData ディレクトリ(config.json / secrets.json / plugin-cache)
- `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)` への書き込み
- MyCodex リポジトリ自身の `.git` への書き込み(進化パイプライン以外から)

## 設定

`AppConfig` に追加:

```ts
/** 'project' = 従来どおりworkspace内のみ / 'fullPc' = system スコープを承認制で許可 */
scopeMode: 'project' | 'fullPc';   // default: 'project'
```

`scopeMode: 'project'` では system スコープ操作は従来どおり拒否(後方互換)。

## 実装ステップ

### M9-1: スコープ判定モジュール

新規 `src/main/tools/scope.ts`:

```ts
export type OperationScope = 'workspace' | 'system';
export function classifyPath(absPath: string, workspaceRoot: string): OperationScope;
export function isDenied(absPath: string, kind: 'read' | 'write'): string | null; // 拒否理由 or null
```

- パス正規化は `path.resolve` + 大文字小文字非依存比較(Windows)
- `..` やシンボリックリンク経由の迂回を `fs.realpathSync` でケア(存在しないパスは親を辿る)
- `src/shared/types.ts` に `OperationScope` を追加
- テスト: 境界ケース(workspace直下 / 兄弟ディレクトリ / `..`遡り / UNCパス / 大文字小文字違い / denylist)

### M9-2: プラグインのパス宣言と executor 統合

`ToolPlugin` に追加(`src/main/tools/types.ts`):

```ts
/** input のうちファイルパスを表すフィールド名。executor がスコープ判定に使う */
pathParams?: string[];
```

- `read_file` / `write_file` / `edit_file` / `list_dir` / `grep` に `pathParams` を宣言
- `executeToolWithApproval`(`src/main/tools/executor.ts`)で実行前に:
  1. `pathParams` の各値を `ctx.cwd` 基準で解決し `classifyPath`
  2. `isDenied` に該当 → 即エラー(ツール実行しない)
  3. いずれかが `system` かつ `scopeMode === 'fullPc'` → **強制承認**(autoApprove / sessionAllowed を無視)
  4. いずれかが `system` かつ `scopeMode === 'project'` → 従来どおり拒否
- `ApprovalDecision` の `allow-session` は system スコープでは受理しても記憶しない(毎回確認)
- `write_file` / `edit_file` 内の `writeAllowed()` の `rel.startsWith('..') → false` は、
  **`ctx.writeAllowlist` が指定されている場合(=進化ジョブ)のみ従来どおり適用**。
  通常セッションのスコープ制御は executor 側に一元化する

### M9-3: bash の扱い

bash は触るパスを静的に判定できないため:

- `scopeMode === 'fullPc'` のとき bash は**常に承認必須**(autoApprove.exec / allow-session 無効)
- 承認ダイアログに「このコマンドはPC全体に影響し得ます」警告を追加
- 進化ジョブの `restrictExec: true` は無条件で維持

### M9-4: 承認UIとaudit log

- `ApprovalRequestPayload` に `scope?: OperationScope` と `resolvedPaths?: string[]` を追加
- `ApprovalDialog`: system スコープ時は警告色バナー「⚠ プロジェクト外の操作」+ 解決済み絶対パスを表示。allow-session ボタンを非表示
- 新規 `src/main/audit.ts`: system スコープの承認/拒否/実行結果を `userData/audit.jsonl` に追記(時刻・ツール名・パス・decision)。M10のスマホUIから閲覧する
- Settings UI に scopeMode トグル(fullPc 有効化時に確認モーダル)

### M9-5: テスト・検証

- executor のスコープ強制承認のユニットテスト(autoApprove=true でも system は承認要求が出る、など)
- 進化ジョブに影響がないこと(EVOLUTION_WRITE_ALLOWLIST + restrictExec が維持される)の回帰テスト
- 手動確認シナリオ: デスクトップの `%USERPROFILE%\Desktop` にファイル作成 → 承認ダイアログ → 承認 → 作成される / 拒否 → されない / secrets.json への書き込み → 即エラー

## 非対象(やらないこと)

- allowlist の事前登録UI(全操作承認制のため不要)
- レジストリ操作・プロセス管理などの新ツール(必要になれば自己進化で追加)
