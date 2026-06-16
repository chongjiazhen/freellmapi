# Fusion — multi-model synthesis responses

**Status:** design / pre-issue
**Date:** 2026-06-16
**Scope:** one implementation plan (single feature)

## Summary

A virtual `fusion` model on the existing `/v1/chat/completions` endpoint. When a
client sends `model: "fusion"`, freellmapi selects K diverse free models, has them
answer the prompt in parallel, then a judge model blends their answers into one
final response. Goal: near-frontier answer quality from free-tier models, drop-in
for any OpenAI-compatible client.

Spiritual ancestors: OpenRouter's Fusion plugin (paid) and elder-plinius'
G0DM0D3 Consortium (needs an OpenRouter key). freellmapi is a better home than
either: it already manages ~30 distinct free models across 15 providers with
scoring + failover, so it can do multi-model synthesis for **$0** and pick
**deliberately diverse** models — the one thing a single router-per-call can't.

This is a clean, general-purpose ensemble feature. No jailbreak/godmode/
parseltongue heritage carries over.

## Motivation

- Free aggregators can offer a capability paid routers charge for: multi-model
  deliberation.
- freellmapi uniquely knows its catalog is diverse (different providers/families),
  so it can assemble a genuinely varied panel — routing N requests through a
  single auto-router instead collapses to ~one model and defeats the point.
- Honest tradeoff stated up front: fusion burns ~K+1× tokens per request. It is
  for occasional high-quality work, not the default path.

## Non-goals (v1)

- **Streaming.** The panel must complete before the judge runs, so only the
  judge's final answer could stream — deferred to v2.
- **Tools / function-calling.** Merging tool-calls across a panel + judge is out
  of scope. A fusion request carrying `tools` is rejected `422`.
- **Vision.** A fusion request carrying an image is rejected `422`.
- A standalone scorer for `best_of`: the judge cheaply picks; no separate model.

## API contract

### Request

```jsonc
POST /v1/chat/completions
{
  "model": "fusion",
  "messages": [ ... ],
  "temperature": 0.7,            // optional; applied to panel + judge
  "max_tokens": 4096,            // optional; applied to panel + judge
  "top_p": 1,                    // optional
  "fusion": {                    // all fields optional
    "k": 3,                      // panel size; clamped to 1..fusion_max_k
    "models": ["glm-4.5-air", "deepseek-v3.2"],  // explicit panel override (catalog ids)
    "judge": "qwen3-coder",      // judge model override; default = top-ranked available
    "strategy": "synthesize",    // "synthesize" (default) | "best_of" | "analyze_synthesize"
    "expose_panel": false        // default false
  }
}
```

- `fusion` is optional; an omitted `fusion` block uses all defaults.
- `fusion.k` is clamped to `[1, settings.fusion_max_k]`. `k <= 1` degenerates to a
  single normal completion (no judge) — allowed, documented.
- `fusion.models` overrides auto-selection. Unknown/disabled ids are dropped with
  a warning; if fewer than 1 valid model remains, `400`.
- Tools or images present → `422` (`code: "fusion_unsupported_modality"`).

### Response — default

A normal OpenAI `chat.completion`:

```jsonc
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "fusion",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "<synthesized answer>" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": <sum>, "completion_tokens": <sum>, "total_tokens": <sum> }
}
```

- `usage` is the honest sum across every panel + judge call.
- Header `X-Fusion-Panel: google/gemini-2.5-flash,groq/llama-3.3-70b-versatile,...`
- Header `X-Fusion-Degraded: true` when a fallback path was taken (see Failure).

### Response — `expose_panel: true`

Same as above plus a top-level non-standard `x_fusion` block (strict OpenAI
clients ignore unknown top-level fields):

```jsonc
"x_fusion": {
  "strategy": "synthesize",
  "panel": [
    { "model": "gemini-2.5-flash", "platform": "google", "ok": true, "latency_ms": 1840, "content": "..." },
    { "model": "llama-3.3-70b-versatile", "platform": "groq", "ok": true, "latency_ms": 1120, "content": "..." },
    { "model": "deepseek-v3.2", "platform": "sambanova", "ok": false, "error": "rate limited" }
  ],
  "judge": { "model": "qwen3-coder", "platform": "openrouter" },
  "analysis": { "consensus": [...], "contradictions": [...], "blind_spots": [...] },
  "usage_breakdown": [
    { "role": "panel", "model": "gemini-2.5-flash", "input": 320, "output": 510 },
    { "role": "judge", "model": "qwen3-coder", "input": 1450, "output": 640 }
  ]
}
```

## Components

| File | Responsibility |
|---|---|
| `services/dispatch.ts` (new, refactor) | Extract the per-attempt "route → call provider → on retryable error cooldown+skip+next" retry loop (the `for (let attempt ...)` block at `routes/proxy.ts:718ff` as of `origin/main` `7f86131`) into `dispatchOnce(messages, opts, { preferredModel?, pinModel? })`. Returns `{ result, route }`. Used by **both** the normal `/chat/completions` handler and each fusion panel slot. De-duplicates and makes failover unit-testable in isolation. NOTE: `routeRequest(...)` now takes a trailing `resolvedChain?.chain` arg (named fallback-chain feature); fusion slots pin a single model and pass `chain = undefined`. **HARD-PIN CAVEAT (confirmed by spike 2026-06-16):** `routeRequest`'s `preferredModelDbId` is a *soft* preference — if the pinned model is rate-limited/cooled it falls through to the next chain entry (`router.ts:538–563`/`565+`). A live spike collapsed 3 distinct panel slots onto 1 local ollama backend this way. So `dispatchOnce` must offer a `pinModel: true` mode that key-rotates **within the pinned model only** and FAILS the slot rather than substituting a different model — otherwise panel diversity silently collapses. |
| `services/fusion-select.ts` (new) | `selectPanel(k, explicitModels?)` → up to K **distinct-platform** models ordered by the existing router score, skipping cooled-down ones (reads `router.ts` scoring + the `rate_limit_cooldowns` table). |
| `services/fusion.ts` (new) | Orchestrator `runFusion(messages, opts, fusionParams)`; judge prompt template; judge-JSON parsing + retry; assembles the OpenAI response and optional `x_fusion`. |
| `routes/proxy.ts` (edit) | Detect `model === "fusion"` immediately after auth/validation (beside the existing `isAutoModel` handling at `proxy.ts:660/685` on `7f86131`) and delegate to `runFusion`. Reject tools/images for fusion. |

> Code references are anchored to `origin/main` `7f86131` (2026-06-16). Line numbers
> drift; re-verify at implementation time (this branch was rebased forward 62 commits
> during design).

### Reused machinery (no reinvention)

- `routeRequest(...)` and the router scoring for panel selection.
- `route.provider.chatCompletion(...)` for each call.
- `recordRequest` / `recordTokens` / `recordSuccess` / `setCooldown` /
  `recordRateLimitHit` for quota + cooldown accounting.
- `logRequest(...)` for analytics (each sub-call logged with
  `requested_model = "fusion"` so the dashboard can group fusion traffic).
- `isRetryableError` / cooldown-duration helpers from `services/ratelimit.ts`.

## Data flow

1. Auth + validate (reuse existing). Reject `tools`/images → `422`.
2. `selectPanel(k, fusion.models?)` → panel of distinct-platform models.
3. **Fan out in parallel.** Each slot dispatches its **pinned** model with
   **key-rotation-only** failover: on a rate-limit/transient error the slot tries
   another *key of the same model*; if the model is exhausted the slot **drops**.
   A slot never substitutes a *different* model — substitution would collapse
   diversity or duplicate a sibling slot's model.
4. Collect survivors (slots that returned content).
5. **Judge** (default `strategy: "synthesize"`): pick the judge model
   (`fusion.judge` override, else top-ranked available, preferring a model not
   already in the panel). Build a prompt = original messages + the numbered panel
   answers + an instruction to return JSON `{ analysis: {consensus, contradictions,
   blind_spots}, final_answer }`. Dispatch via `dispatchOnce`. Parse JSON; on parse
   failure retry once with a stricter instruction; on second failure fall back to
   `best_of`.
6. Assemble the OpenAI response; attach `x_fusion` when `expose_panel`.

### Strategy variants

- `synthesize` (default): one judge call produces analysis + blended answer.
- `best_of`: judge makes one cheap call to pick the single best survivor verbatim
  (no rewrite). `x_fusion.analysis` omitted; panel scores reported.
- `analyze_synthesize`: two judge calls — analysis, then synthesis using it.
  Richest, highest burn. Opt-in only.

## Failure handling / quorum

- Panel slots are independent; a slot failure never aborts the request.
- **Quorum = 2** surviving panel answers to run synthesis.
- **1 survivor:** skip the judge, return that answer as a plain completion.
  Cheaper and honest. `X-Fusion-Degraded: true`.
- **0 survivors:** `429` (mirrors proxy's "All models rate-limited") or `502` for a
  non-rate-limit exhaustion, matching the existing handler's error shapes.
- **Judge failure** (its own key-failover exhausted, or JSON unparseable twice):
  fall back to `best_of` among survivors so the caller still gets an answer.
  `X-Fusion-Degraded: true`.

## Budget & accounting (token-burn honesty)

- Every panel + judge call flows through `dispatchOnce`, which already records
  requests/tokens/cooldowns and writes a request-log row. So quota tracking,
  per-provider cooldowns, and analytics **work without new code** — each sub-call
  is a normal accounted request tagged `requested_model = "fusion"`.
- Response `usage` is the summed honest total across all calls.
- README/docs and the dashboard note: **fusion costs ≈ K+1× a normal request.**
  It is opt-in (a distinct model id), defaults to K=3, and the operator controls
  the cap.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `settings.fusion_enabled` | `true` | Master toggle; `false` → `model:"fusion"` returns `400` "fusion disabled". |
| `settings.fusion_default_k` | `3` | Panel size when the client omits `fusion.k`. |
| `settings.fusion_max_k` | `5` | Hard cap; per-request `fusion.k` clamps to it. **Operator raises this to lift the ceiling (power-user override).** Env fallback `FUSION_MAX_K`. |
| `settings.fusion_judge_model` | unset | Default judge; unset → top-ranked available model. |

## Testing

- **Unit `selectPanel`:** prefers distinct platforms; skips cooled-down models;
  honors an explicit list; clamps/handles `k` (0/1, > max, > available).
- **Unit judge:** prompt assembly; JSON parse success; one-retry-then-fallback on
  malformed JSON.
- **Unit quorum:** 0 / 1 / 2 survivors take the documented paths.
- **Integration (mock providers):** fusion returns a synthesized answer;
  `expose_panel` attaches `x_fusion`; `usage` is summed; a tools/image fusion
  request returns `422`; `fusion_enabled=false` returns `400`. Reuses the existing
  proxy test harness.

## Risks / open questions

- **Maintainer appetite.** Unrequested substantial feature → open an issue first
  (drafted alongside this spec) to gauge scope/interest before a PR.
- **Free-quota burn vs the project's identity.** Mitigated by: opt-in model id,
  conservative default K=3, operator-controlled cap, honest `usage`, and docs.
- **Judge model strength on free tiers.** Synthesis quality tracks the judge;
  default = the top-ranked available model (currently a frontier-class free
  model). `fusion.judge` lets the operator pin a stronger one.
- **`dispatchOnce` extraction risk.** Refactoring the live failover loop must be
  behavior-preserving for the normal path — covered by keeping/extending the
  existing proxy tests before wiring fusion in.
