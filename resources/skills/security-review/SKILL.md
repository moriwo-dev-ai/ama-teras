---
name: security-review
description: Review a diff or feature for the vulnerabilities that actually ship — injection, authz gaps, SSRF, secrets, and unsafe deserialization — with concrete checks per class.
---

# Security Review

## When to use
Reviewing PRs/diffs touching input handling, auth, file/network access, or templates; before exposing any new endpoint; defensive audits of your own code.

## Instructions

Work class-by-class over the changed code. For each finding: file:line, the tainted data path (source → sink), a concrete exploit sketch, and the minimal fix.

1. **Injection (SQL/command/template).** Trace every string that reaches a query, shell, or template engine back to its source. User-influenced? Then: parameterized queries only; `execFile`+args instead of shell strings; autoescaping templates. Flag string concatenation into any interpreter even if "validated".
2. **XSS.** Any user data rendered into HTML: is it escaped *for that context* (element/attribute/URL/JS)? `dangerouslySetInnerHTML`/`v-html`/`innerHTML` are findings unless fed by a sanitizer. Check stored paths (DB → render) not just reflected ones.
3. **AuthZ (the one that ships most).** For every endpoint/handler in the diff: who may call it, and where is that enforced? Look for IDOR — object IDs from the client used without an ownership check. Role checks in the UI only = finding.
4. **SSRF.** Server-side fetches of user-supplied URLs: allowlist hosts/schemes, block private ranges & metadata IPs (169.254.169.254), and re-validate after redirects (redirect-to-internal is the classic bypass).
5. **Path traversal.** User input in file paths: normalize then verify the result stays under the intended root (`resolve` + prefix check). Rejecting `".."` by string match is insufficient (encodings, backslashes on Windows).
6. **Secrets.** Grep the diff for keys/tokens/passwords (including in tests, comments, and lockfile URLs). Check new logs: are tokens/PII being logged? Error responses: do they leak stack traces or internal paths?
7. **Deserialization & parsing.** `pickle`/`yaml.load`/`eval`-family on external data = finding. JSON schema-validate before use; reject unknown fields on privileged writes (mass assignment).
8. **Dependencies.** New/updated packages: known CVEs, install scripts, typo-squatting (author, weekly downloads, repo link). Pin versions.

## Output format
`[severity] class — file:line — source→sink — fix` per finding, then a one-line verdict: merge-blocking findings vs. hardening suggestions. No finding? Say what you checked and found clean — an empty report should still prove work.

## Pitfalls
- Reviewing only the diff hunk; the vulnerability is often in how existing code now receives new data.
- "It's internal-only" — internal services get SSRF'd into.
- Reporting theoretical severity without a reachable path; verify reachability before crying critical.
