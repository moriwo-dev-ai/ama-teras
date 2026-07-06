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

## 実装パス一覧(PROTECTED_PATHS の写し。同期テストで機械照合される)

| パス | 対応する聖域項目 |
|---|---|
| `src/main/evolution` | 2. 進化マネージャ+3. スーパーバイザー(supervisor.ts)+6. protected.ts と guardrails テスト |
| `src/main/agent/approval.ts` | 1. 承認ブローカー |
| `src/renderer/src/components/Approval` | 1. 承認UI |
| `src/main/ipc.ts` | 1. 承認関連IPC(approval:respond の受け口。粒度はファイル全体 — 行単位保護はコード移動で迂回可能なため採らない) |
| `src/preload` | 1. 承認関連IPC(contextBridge=承認応答の経路) |
| `src/shared/ipc.ts` | 1. 承認関連IPC(チャネル名定義) |
| `src/main/secrets.ts` | 4. secrets |
| `src/main/userDataMigration.ts` | 4. secrets(Local State=safeStorage鍵素材の移行) |
| `CLAUDE.md` | 5. プロジェクト規約 |
| `docs/PROTECTED.md` | 6. このファイル自身 |

## 不変条件

- 上記への差分を含む進化ジョブは、scope(tool / renderer / core)に関わらず即 reject
- PROTECTED_PATHS を減らす・空にする・判定を無効化する差分も当然 reject(自己参照ガード)
- この不変条件は guardrails テストで固定し、テスト自体も保護対象に含める
- **判定は稼働中A側のメモリ上 PROTECTED_PATHS 定数のみで行う**(2026-07-06 ユーザー確定)。
  worktree B側の protected.ts を require/import して判定に使うことを絶対に禁止。
  Bの protected.ts を空にする改竄も、A側リストの `src/main/evolution` エントリで捕捉される
- 進化diffでのシンボリックリンク新規追加/変更(mode 120000)は、聖域外であっても無条件 reject
  (リンク経由でビルド時に聖域実体へ到達する迂回の禁止)
