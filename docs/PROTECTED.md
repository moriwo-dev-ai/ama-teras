# 保護領域(聖域)— 自己進化ジョブによる変更を絶対に許さない領域

このリストは AMA-teras の corrigibility(是正可能性=常に人間が止められる性質)を守るための正本。
進化パイプラインは、diff がこのリストのいずれかに1行でも触れたら、検証以前に無条件で reject する。
承認ダイアログにすら出さない。

**このファイル自身と、下記の判定ロジックも保護対象**(自分で保護を外せないようにするため)。
実装上の正本は `src/main/evolution/protected.ts` の PROTECTED_PATHS 配列とし、本ファイルと一致させる。

## 聖域リスト(2026-07-07 ユーザー確定)

1. **承認機構**: 承認ブローカー(`src/main/agent/approval.ts`)、承認UI
   (`src/renderer/**` のうち ApprovalDialog および承認関連コンポーネント)、承認関連IPC
2. **進化マネージャ**: `src/main/evolution/` 配下すべて
   (manager / job / worktree / git / gates / promote / supervisor / protected.ts)
3. **スーパーバイザー**: 再起動・健全性チェック・セーフモード復旧のロジック
4. **secrets(鍵素材)**: `src/main/secrets.ts`、safeStorage / Local State 移行に関わるコード
5. **CLAUDE.md**: プロジェクト規約
6. **このファイル自身**: `docs/PROTECTED.md` と `src/main/evolution/protected.ts`

## 不変条件

- 上記への差分を含む進化ジョブは、scope(tool / renderer / core)に関わらず即 reject
- PROTECTED_PATHS を減らす・空にする・判定を無効化する差分も当然 reject(自己参照ガード)
- この不変条件は guardrails テストで固定し、テスト自体も保護対象に含める
