# README追記の下書き(Project TAKAMA-gahara)

> M32-6: 次のZenn記事(「岩戸開き=運営自動化」)と同時に公開するため、
> README本体への追記は保留し、この下書きだけ置いておく(NIGHT_TASKS6 T6)。
> 公開時は「特徴」セクションの3項目の後に追加する想定。

---

### ⛩ 自分の運営も自分でやる(Project TAKAMA-gahara)

AMA-terasは自分自身のOSS運営も手伝います。メトリクス観測・週報・発信下書き・
Issue/PRトリアージを自動化し、**外部への発信だけは必ず承認ゲート(岩戸)を通る**:

- 🧠 **OMOI-kami**: Star/流入元/いいねを時系列観測、「何が効いたか」を週報に
- 💃 **AMENO-uzume**: 開発記録から見せ場を抽出して投稿を下書き(投稿ボタンは無い。押すのは人間)
- 💪 **TEDIKA-rao**: PR/Issueをseverity方式でレビューし、返信下書き付きでトリアージ

自動投稿・自動フォロー・bot偽装はしません(各媒体の規約に従う設計)。
詳細は [docs/USER-GUIDE.md](docs/USER-GUIDE.md) の「Project TAKAMA-gahara」章へ。

---

## English draft (README.en.md 用)

### ⛩ It runs its own ops, too (Project TAKAMA-gahara)

AMA-teras helps run its own OSS presence: metrics tracking, weekly reports,
post drafting, and PR/issue triage — and **every outbound action must pass a
human-approval gate ("the Iwato")**:

- 🧠 **OMOI-kami**: tracks stars / referrers / likes over time and drafts "what worked" reports
- 💃 **AMENO-uzume**: extracts highlights from dev logs into post drafts (there is no Post button — a human posts)
- 💪 **TEDIKA-rao**: severity-based triage of PRs/issues with reply drafts

No auto-posting, no auto-following, no bot impersonation (designed to respect each platform's ToS).
