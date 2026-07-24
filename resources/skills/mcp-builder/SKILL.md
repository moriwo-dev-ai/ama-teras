---
name: mcp-builder
description: Design and scaffold a Model Context Protocol (MCP) server — tool naming, schema design, transport choice, and the mistakes that make agents misuse your tools.
---

# MCP Builder

## When to use
Exposing an API, database, or internal system to AI agents via MCP; reviewing an existing MCP server that agents keep misusing.

## Instructions

1. **Design tools around agent tasks, not API endpoints.** An agent wants `search_orders(query)`, not `GET /orders?filter=…` mirrored 1:1. Merge chatty endpoint pairs into one intention-sized tool; split god-endpoints by use case.
2. **Names and descriptions are the UX.** The model chooses tools by reading them:
   - Name: verb_noun, unambiguous (`create_invoice`, not `invoice` or `handle_invoice`).
   - Description: what it does + when to use it + when NOT to ("read-only; use update_invoice to modify").
3. **Schemas: strict and small.**
   - Mark truly-required fields required; give every property a description and an example value in the description.
   - Enums over free strings wherever values are finite.
   - Reject unknown fields (`additionalProperties: false`) so typos fail loudly.
4. **Returns: text the model can reason about.** Compact JSON or labeled lines; include stable IDs for follow-up calls; paginate anything unbounded (return `next_cursor`, never dump 10k rows into context).
5. **Errors must teach.** `"date must be YYYY-MM-DD, got '3/4/26'"` lets the agent self-correct; `"400 Bad Request"` guarantees a retry loop. Include which field failed and a valid example.
6. **Safety tiers.** Separate read tools from write tools; destructive operations get an explicit `confirm: true` parameter and their descriptions say so. Never hide a delete inside an "update".
7. **Transport:** stdio for local/desktop integrations (simplest, no auth surface); HTTP+SSE for shared/remote servers (then: auth tokens, rate limits, per-client logging).
8. **Test with a real agent before shipping:** give it 5 realistic tasks and watch the transcript. Every misuse is a naming/description bug on your side, not the model's.

## Pitfalls
- 40 tools when 8 would do — selection accuracy drops as the toolbox grows.
- Descriptions written for humans who already know the system ("standard CRUD for FooEntity").
- Secrets in tool output; the transcript is not a secure channel.
