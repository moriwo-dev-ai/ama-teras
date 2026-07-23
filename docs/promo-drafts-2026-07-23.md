# 発信下書き(2026-07-23 サイクル1)— 未投稿・全文承認用

投稿は必ず人間が行う。この下書きはその素材。

---

## ① Show HN(英語・HN投稿用)

**Title**: Show HN: AMA-teras – a desktop AI agent that writes its own tools, behind verification gates

**URL**: https://github.com/moriwo-dev-ai/ama-teras

**本文(最初のコメントとして投稿)**:

I built a desktop AI agent (Electron/TypeScript, AGPL) that grows its own toolset: when it
hits a capability it lacks, it writes a new tool plugin for itself. Every generated tool goes
through the same pipeline before it can run — isolated git worktree, typecheck, real unit
tests, a smoke run, then explicit human approval, with automatic rollback after promotion
if health checks fail. Nothing ships unreviewed, including code it wrote for itself.

Why: I wanted an agent that isn't tied to one vendor's pricing plan. Models are swappable
(Anthropic / OpenAI / Moonshot, or free-tier OpenAI-compatible APIs), the tools it writes
stay on your machine as your assets, and there's a small community registry where shared
plugins carry their verification evidence (a signed record of which gates they passed) —
relevant now that audits report 12–20% of skills on some agent marketplaces are malicious.

Honest limitations: Windows-only installer today (source build elsewhere untested), the
installer is unsigned (SmartScreen warning), and self-evolution is deliberately scoped to
tool plugins — the agent cannot modify its own approval mechanism or core (protected paths
are enforced by a tripwire gate).

A large part of this app was built by the agent itself under the same gates, and the failure
stories are documented in the repo (in Japanese; README is in English). Feedback very welcome,
especially on the safety model.

**投稿時の注意**: コメントに即応できる時間帯に(US平日朝=日本の夜)。投稿後3時間は張り付き推奨。

---

## ② X投稿(日本語)

⛩ AMA-teras v1.6.0

「欲しいツールを言うと、アプリが自分で作る」デスクトップAIエージェント。

生成コードは 隔離worktree→型検査→テスト→スモーク→あなたの承認 を通らないと1行も動きません。

モデルはAnthropic/OpenAI/Kimiを切替可。無料枠APIでも動く。
企業に囚われないエージェントを、あなたのPCに。

AGPL: https://github.com/moriwo-dev-ai/ama-teras

(動画: demo.mp4 添付)

---

## ③ Bluesky投稿(日本語・動画は自動添付=demo.mp4)

自己進化するAIエージェント AMA-teras v1.6.0 を公開中。

足りないツールを自分で書き、検証ゲート(型検査→テスト→スモーク)と人間の承認を通ってから自分に組み込みます。スマホからも承認・公開まで操作可能に。

モデルは選べる部品(Anthropic/OpenAI/Kimi/無料枠)。囚われないエージェントを。

https://github.com/moriwo-dev-ai/ama-teras

---

## ④ Reddit r/LocalLLaMA(英語・Show HNの後日に)

**Title**: I built a desktop agent that writes its own tools — every one gated by typecheck/tests/smoke + human approval (AGPL)

**本文**: Show HN本文をベースに、r/LocalLLaMA向けに「vendor-independence / free-tier APIs /
Moonshot対応」を前に出す。Show HNの反応を見てから調整するため、詳細文面は次サイクルで。
