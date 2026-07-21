# Fusion Model Analysis

## Architecture Overview

Fusion is a virtual model (`model: "fusion"`) that implements a **multi-model synthesis** pattern — it fans the prompt out to a panel of diverse models in parallel, then uses a judge model to synthesize one final answer. It's a two-phase process: **panel** (fan-out, parallel) + **judge** (synthesis).

The code lives in `server/src/services/fusion.ts` (the orchestrator), invoked from `server/src/routes/proxy.ts` around line ~264.

---

## 1. Mechanics: Parallel vs. Sequential

**Panel execution is fully parallel** (lines 580-600 in `fusion.ts`). A "wave" of panel slots fires via `Promise.allSettled`, so the K models in each wave run concurrently. There's no explicit concurrency limiter — the panel size itself limits fan-out.

**Judge execution depends on streaming mode:**
- **Non-streaming** (`runModelCall`): buffered, single call
- **Streaming** (`runJudgeStreaming`): streams tokens to the client as the judge writes

**Fallback behavior:** If some panel slots fail (429, 402, 413, abort), the next wave pulls models from an `overflow` queue (the next servable models from the chain). This is **not** a retry of the same model — it's a different model from the chain.

**Synthesis quorum** (`SYNTHESIS_QUORUM = 2`): if fewer than 2 successful text answers come back, or if `strategy: "best_of"` is set, the judge is skipped entirely and the longest single answer is returned directly (lines 609-611).

**Judge fallback:** If the judge itself fails, it falls back to best-of automatically (lines 673-676).

### Panel sizing

- **Default panel size:** 4 models (`DEFAULT_PANEL_K = 4` at line 32)
- **Hard ceiling:** 8 (`HARD_MAX_PANEL_K = 8` at line 35)
- **Operator override:** via `fusion_default_k` and `fusion_max_k` settings
- **Overflow queue:** up to K refill candidates (≤ 2K total dispatches)

### Voting mechanism

There is **no voting** in the traditional sense. The fusion model does not:
- Count votes
- Run majority consensus
- Rank responses by length (except for best-of fallback)

Instead, the judge model receives all panel responses anonymized as "Response 1", "Response 2", etc., and **synthesizes one answer** that combines the best parts. The judge's prompt (line 304-308) instructs it to resolve contradictions and rewrite the answer in its own voice.

### Panel diversity strategy (`diversifyChain`)

Two-pass dedup:
1. **Provider diversity:** one model per distinct platform first, then duplicates
2. **Family dedup:** within that, demote same-family models (e.g. `qwen/qwen3-coder:free` and `qwen3-coder:480b` both map to `qwen3-coder`)

So the panel spans different backends AND different model families.

---

## 2. Underlying Models / Providers

Fusion itself is **not a provider** — it routes through the same model catalog as the proxy. The underlying models depend on the **fallback chain configuration**.

The `selectPanel` function (line 380) resolves panel candidates from:
- **Explicit panel** (`fusion.models`): user-provided list of model ids
- **Auto mode** (default): picks from the strategy-sorted servable chain via `getOrderedFusionChain()` at line 397

The servable chain is the active fallback chain, filtered by "has a healthy key that can serve right now" (line 408-417), and ordered by the current routing strategy.

**The chain is populated from:**
- `models` table (model metadata)
- `api_keys` table (providers)
- `fallback_config` or `profile_models` (ordering)

Provider selection is done via `getProvider(entry.platform)` from `server/src/providers/index.ts`.

**The judge model** (line 653): when no explicit `fusion.judge` is set, the judge runs on the **top-ranked available model** via the normal auto-router. An explicit judge model can be pinned (uses `routePinnedModel` at line 656).

---

## 3. Per-Member Fallback Behavior

Each panel slot uses `routePinnedModel` (line 583), which **hard-pins to the model** and rotates only that model's keys:
- Key 429 doesn't collapse the slot onto a duplicate backend
- Each slot tries at most `MAX_SLOT_ATTEMPTS = 4` keys (`MAX_SLOT_ATTEMPTS` at line 38)
- A slot fails if all its keys are cooled down

The judge uses the normal auto-router with `MAX_JUDGE_ATTEMPTS = 6` (line 40), giving it more room to fail over across the chain.

**Rate-limit cooldowns** are applied per-key: `setCooldown` at lines 212, 222, 341 in `runModelCall`.

---

## 4. Rate-Limit Implications

**Token accounting:** All panel + judge tokens are summed into a single `usage` block returned to the client (line 607). The usage is the sum of all panel + judge usage.

**Rate-limiting:** Each panel/judge sub-call goes through the normal rate-limit bookkeeping (`recordRequest`, `recordTokens`, `recordSuccess` at lines 205-207, 339-340).

**No special rate-limit treatment:** Fusion doesn't get a separate rate-limit bucket. Each sub-call is logged independently, so fusion traffic appears as normal requests in analytics (tagged with `FUSION_TAG = 'fusion'` at line 26).

**Client-visible rate-limit errors:** If the entire panel fails, the client gets a 429 with `rate_limit_error` type (line 633).

---

## 5. Customization Surfaces

### Inline per-request config (`fusion` field in request body)
Defined in `fusionConfigSchema` at lines 46-54:
- `models`: explicit panel members (list of model ids)
- `k`: panel size
- `judge`: override judge model id
- `strategy`: `synthesize` (default) or `best_of`
- `expose_panel`: attach per-model panel answers under `x_fusion` header

### Persisted dashboard config
Saved under `fusion_config` key in settings, managed via `getSavedFusionConfig` / `setSavedFusionConfig` (lines 81-100). Controls:
- `mode`: `auto` (pick from chain) or `explicit` (use saved `models` list)
- `models`: saved explicit panel
- `judge`: default judge model
- `k`: default panel size
- `strategy`: default strategy
- `expose_panel`: default header exposure

### Environment / settings overrides
- `fusion_default_k`: default panel size (line 56)
- `fusion_max_k`: hard ceiling for panel size (line 57)

### Streaming hooks
`FusionHooks` at lines 122-130: `onPanel`, `onJudge`, `onJudgeDelta` — used by the Playground to show live tokens as they arrive.

---

## Summary of Key Design Decisions

1. **Fusion is not a voting system** — it's a judge+synthesize pipeline
2. **No panel voting** — the judge rewrites, not ranks
3. **Panel diversity is explicit** — provider AND family dedup, not just provider
4. **Fallback is structural** — different models from the chain, not retries
5. **No image support** — fusion rejects image input (line 269-271 in proxy.ts)
6. **Tool calls short-circuit** — if any panel member returns tool_calls, that answer wins and the judge is skipped (lines 598-606)
7. **Judge fallback is graceful** — if the judge fails, returns best-of instead of erroring

---

# Part 2 - Fusion under coding-agent traffic

Written 2026-07-20, prompted by a coding agent (`pi`) getting hard 429s against `:3001`
where a chatbot client on the same instance was fine. Part 1 above is mechanics; this
part is application: **why the free-tier catalog collapses under agent-shaped traffic,
and what fusion would have to become to serve it.**

The original design intent was `freellmapi -> fusion -> fallback across custom model
families`. That intent is sound. It does not currently survive contact with an agent
that calls tools directly, and the reasons are structural rather than incidental. It
does survive if fusion is placed where tools are absent, which is §4.

## 1. The shape mismatch

Fusion, and the routing beneath it, were built against a **chatbot turn**. A coding
agent issues a **different shape of request**, and every axis moves in the direction
that shrinks the eligible pool:

| Axis | Chatbot turn | Coding-agent turn | Effect on routing |
|---|---|---|---|
| Tools in body | absent | **always present** | activates the `supports_tools` filter |
| Prompt size | ~hundreds of tokens | 20k-40k (system prompt + file context + history) | trips context-window *and* tpm gates |
| Turns per task | 1, human-paced | 10-50, machine-paced, bursty | drives keys into cooldown fast |
| Output shape | prose | structured tool call, must parse | a "close enough" answer is a hard failure |
| Judge value | high (synthesis helps) | ~zero (a tool call is right or wrong) | fusion's core premise does not apply |

The last row is the important one and is treated separately in §4. The first three
explain the 429.

## 2. Anatomy of the collapse

Observed error, `model: "auto"`, tools present:

```
429 routing_error: All models exhausted: 69 routes checked
    (7 rate-limited or on cooldown,
     32 no usable key configured,
     8 prompt too large for the model,
     22 model lacks tool-calling)
```

`7 + 32 + 8 + 22 = 69`, so every model in the chain was evaluated. **This is not the
old fallback-short-circuit bug** (`_issue_1.md`, fixed by the diagnostics work merged
at `2be9bb0`). `orderChain` (`router.ts:487-507`) is a pure reorder with no `slice`
or `filter`; the only pre-filter is `enabled` (`router.ts:1015`). The traversal is
complete and honest. The pool is genuinely dry, because of how it is *gated*, not
how it is *walked*.

Measured against the clean-tier instance (78 enabled chain models):

### Gate A - no usable key (32 routes)

`selectKeyForModel`, `router.ts:674-680`:
`SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy','unknown')`.
Zero rows means the model is skipped. This is **platform-level but counted per model**,
so one missing key multiplies across that platform's entire model list.

59 of 78 chain models sit on platforms with no key row. The chain carries entries for
agnes, cohere, google, groq, huggingface, kilo, llm7, mistral, nvidia, opencode,
openrouter, pollinations, reka and zhipu while keys exist for only a handful.

**Silent-failure note:** `router.ts:718` flips a key to `status='error'` on decrypt
failure. Because the selection query accepts only `healthy`/`unknown`, a decrypt-errored
key becomes **indistinguishable from no key at all** in this bucket. The operator sees
"no usable key configured" for a platform they know they configured. Worth splitting.
(Live instance: mistral showed 7 chain models and no usable key; re-minting the key
resolved it. Root cause between "key revoked upstream" and "key decrypt-errored locally"
was not established, since re-minting fixes both. The old row's `status` column would
have discriminated.)

### Gate B - no tool-calling (22 routes)

The agent-specific killer. Filter at `router.ts:1069`: `if (requireTools && !entry.supports_tools)`.
`requireTools` defaults false (`router.ts:1009`) and is set only when the body carries
tools (`proxy.ts:1147`, `anthropic.ts:289`, `responses.ts:395`). **A chatbot never sees
this gate. An agent sees it on every single request.**

`models.supports_tools` is `INTEGER NOT NULL DEFAULT 0`
(`db/migrations/20260101_000000_legacy_baseline.ts:1752`). Three writers, and all but
one collapse *unknown* into *false*:

1. `20260101_000000_legacy_baseline.ts:1756-1789` sets **every** row to 0, then
   re-flags to 1 by a hand-maintained ~14-pattern `LOWER(model_id) LIKE` allowlist
   (`%gpt-oss%`, `%llama-3%`, `%gemini-%`, `%qwen3%`, `%deepseek-v%`, and so on).
2. `services/catalog-sync.ts:259`: `supportsTools: m.supportsTools ? 1 : 0`. A missing
   or `undefined` field from the remote catalog (`api.freellmapi.co`, `catalog-sync.ts:37`)
   maps to 0 with no unknown state preserved.
3. `routes/keys.ts:512`: `COALESCE(@tools, 1)`, defaulting to **1**. Custom models get
   the opposite default from everything else.

Net effect: **absence of evidence is stored as evidence of absence, permanently.** 20 of
78 clean-tier models and 29 of 99 gray-tier models are zeroed. `openrouter` is 6-of-8
zeroed, which is suspicious on its face, since many OpenRouter free models do support
tools. Whether the remote catalog is under-reporting or those models genuinely lack
tools is **unverified**, and is the single highest-value thing to check before filing
anything upstream.

There is a 422 fast-fail when *zero* tool-capable models are enabled
(`proxy.ts:1148-1155`, `no_tools_model`, backed by `router.ts:1182-1184`). Note
`anthropic.ts` has **no such pre-check**, so that route goes straight to the 429.

### Gate C - "prompt too large" (8 routes), partly mislabelled

The bucket is assigned by substring match on `'< estimated'` (`router.ts:77`), which
matches **two different checks**:

- true context overflow: `router.ts:1090`, `estimatedTokens > entry.context_window`
- **tpm budget**: `router.ts:1097`, e.g. `tpm_limit 8000 < estimated 33476`

A free tier with an 8k tokens-per-minute cap cannot accept a 33k agent turn *regardless
of its context window*. These are unrelated problems with unrelated fixes, reported as
one. The classifier is an order-sensitive `if/else if` chain (`router.ts:71-99`), so
this bucket also steals from the rate-limit bucket: a line reading
`already-failed-this-request:1, cooldown:1` matches `failed earlier` (`:81`) before
`rate-limited` (`:82`). Asserted in `__tests__/services/exhaustion-summary.test.ts:55-62`.

Completion reservation is handled and capped. `routingReserveTokens()`
(`router.ts:168-171`) clamps requested `max_tokens` to `OUTPUT_RESERVE_CAP = 2000`
(`router.ts:160`), defaulting to 1000. This was issue #470: reserving the full
`max_tokens` was falsely excluding the entire free pool. Input is still counted whole,
which is correct but is exactly what agent traffic maximises.

### Gate D - rate-limited (7 routes)

The smallest bucket, and the only one the error message's advice ("wait for rate limits
to reset") actually addresses. The message tells the operator to add keys or wait when
the dominant causes were **missing configuration** and **capability filtering**, neither
of which resolves with time.

## 3. Why the collapse is agent-specific

Same instance, same moment, two clients:

- **Chatbot**: no tools, so Gate B is inert. Short prompt, so Gate C is inert. Slow
  cadence, so Gate D is rare. Eligible pool is roughly every model with a key. Works fine.
- **Coding agent**: Gate B removes 25-30% of catalog. Gate C removes every low-tpm
  free tier. Gate D fires early because agents burst. The gates compound
  multiplicatively, and the survivors are the *same few* models for every request, so
  they cool down together.

This is why "it works in the Playground but not in pi" is the expected observation
rather than a puzzling one.

## 4. Where fusion actually fits: commander, not worker

Fusion looks like the right answer to a thin, unreliable pool: fan out across families,
synthesize, degrade gracefully. Applied to an agent's **tool-calling turns** it is a
no-op at best and a lottery at worst. Applied to an agent's **reasoning turns** it works
as designed today, with no code change at all.

### 4a. Why direct tool-call fusion fails

- `fusion.ts:598-606`: **if any panel member returns `tool_calls`, that answer wins
  immediately and the judge is skipped.** Every agent turn is a tool turn, so fusion
  degrades to "whichever of K racing models replied with a tool call first". Not
  synthesis, not family-diverse fallback: a race decided by latency.
- `fusion.ts:681`: judge routing hardcodes `requireTools: false`, so the judge may be
  selected from models that cannot express the output the agent needs.
- Panel slots pin per model (`routePinnedModel`, `fusion.ts:583`) with
  `MAX_SLOT_ATTEMPTS = 4`. Under Gates A-C the servable chain feeding `selectPanel`
  (`fusion.ts:380`, `getOrderedFusionChain()` at `:397`) is already gutted before
  diversity dedup runs, so `diversifyChain`'s provider and family spread has little
  left to spread across.
- No image support (`proxy.ts:269-271`), which closes off multimodal agent use entirely.

The short-circuit is defensible for chat: you cannot meaningfully synthesize two
different tool calls into one. It is not *wrong*. It is **undefined behaviour for the
agent case**, undocumented, and silently different from what the fusion contract implies.

### 4b. The v1: fusion as commander, headless workers as hands

Split the agent loop by turn type and put fusion only on the half that has no tools:

```
  fusion panel + judge   ->  commander turn   (no tools in body, prose out)
        |
        v  delegation brief
  single tool-capable model  ->  headless worker  (tools in body, does the labor)
        |
        v  worker report
  back to fusion commander for the next decision
```

Why this works, mechanically:

- **Gate B goes inert on the commander turn.** No `tools` in the body means
  `requireTools` is false (`router.ts:1009`), so all 78 chain models are eligible
  instead of 56. `diversifyChain` finally has a wide pool to spread across, which is
  the condition fusion was designed for.
- **The judge premise applies again.** "Which approach should we take, what is the
  plan, did this worker report actually satisfy acceptance" are exactly the questions
  where multi-model synthesis beats one model. A tool call is right or wrong; a plan
  is better or worse.
- **`fusion.ts:681`'s hardcoded `requireTools: false` becomes correct** rather than a
  latent bug, since the judge genuinely does not need tools here.
- **The tool_calls short-circuit at `:598-606` never fires**, so there is no lottery.
- **Zero code change.** This is a topology decision, not a patch. That is the whole
  cheap-v1 property: it can be tried today against the running `:3001` instance.
- The tool-capable pool only has to serve *one* worker slot at a time, not a K-wide
  panel. Gates A-C still apply to the worker, but against a far smaller demand.

This is also the topology already proven in the qwen-delegate harness, where the
commander scopes, routes, sets acceptance and judges while workers do the labor and
never receive judgment. Fusion-as-commander upgrades the judgment layer from one model
to a panel and leaves the labor layer untouched.

### 4c. The one real risk: token multiplication into Gate C

Fusion sums **all panel plus judge tokens** into a single usage block (Part 1, §4). A
K=4 panel on a 30k-token commander prompt is ~120k input tokens of demand against
free-tier tpm caps that Gate C already shows are as low as 8k. **Fusion makes Gate C
worse, not better**, and the commander turn is the *large-context* turn in an agent
loop. This is the thing most likely to sink the v1.

Mitigations to try in order: keep commander context lean (worker reports summarized
rather than raw transcripts), lower `k` from the default 4 (`DEFAULT_PANEL_K`,
`fusion.ts:32`), and pin the panel to models with known tpm headroom rather than
auto-selecting.

Second-order: if the commander is expected to emit machine-parseable delegation briefs,
avoid `response_format`. There is a distinct `platform cannot honor response_format`
skip bucket (`router.ts:80`, matching `drops response_format`) that would re-narrow the
pool the v1 just widened. Have the commander emit prose or loose markdown and parse it
permissively.

### 4d. If direct tool-call fusion is attempted later

The chat premise (many opinions, one synthesis) does not transfer, so agent-mode fusion
has to trade **synthesis** for **reliability**:

1. **Race for liveness, not content.** Fire K tool-capable slots, take the first
   *schema-valid* tool call, cancel the rest. Roughly today's accidental behaviour, made
   deliberate by validating before accepting rather than selecting by arrival order.
2. **Restrict the panel to `supports_tools` models.** Today the panel is drawn from the
   general servable chain, so slots that cannot emit tool calls are wasted dispatches
   that also burn rate limit.
3. **Agree-or-escalate.** Where two slots return the same tool call, confidence is high,
   so dispatch it. Where they disagree, that is the signal worth spending a judge on.
   The only place a judge earns its cost in agent mode.
4. **Or bypass, loudly.** When `tools` is present, skip fusion, fall through to normal
   auto-routing, and return a header saying so. Better than silently behaving like
   something the caller did not ask for.

All of these are gated on Gate B: a 3-model tool-capable pool has nothing to fan out
across. **Gate B is upstream of all direct tool-call fusion work.** The §4b commander
split is not, which is why it goes first.

## 4e. CORRECTION 2026-07-20 (post tier-hardening): the pool numbers above are stale

Everything above was measured **before** `docker/reconcile-tier.cjs` was wired onto the
clean instance (`docker-compose.yml`, `TIER_ALLOWLIST_FILE`). That guard runs
unconditionally every boot, outside the migration ledger, and deletes plus tombstones
any platform not in `docker/tiers/clean.config.example.json` (`keys[].platform`).
It has now run. The §2 and §4b numbers are superseded.

**Allowlist enforced:** cerebras, cloudflare, mistral, ollama, ovh, requesty.

**Healed away on clean** (from the boot log): agnes, cohere, github, google, groq,
huggingface, kilo, llm7, nvidia, opencode, openrouter, pollinations, reka, zhipu.

**New clean-tier size: 23 real models** across 6 platforms (`/v1/models` returns 25
including the `auto` and `fusion` virtuals), down from 78 enabled chain models.

### This is not the capacity loss it looks like

Every healed platform logged `keys-0`. **None of them had an API key.** That is the same
59-of-78 keyless population that Gate A was reporting as "no usable key configured".
Real usable capacity before the guard was ~19 models; it is now 23, all of them keyed,
because the mistral key was re-minted the same day (7 models). **Clean-tier usable
capacity went up today, and the guard removed unusable rows rather than capacity.**

Two second-order effects, both good for this work:

- **Gate A should now be near-zero on clean.** A future exhaustion error will point at
  the real cause (tools, tpm, cooldown) instead of drowning it in 32 keyless skips. The
  §6 item-2 bucket-split work gets more valuable, not less, because the remaining
  buckets are now the informative ones.
- **The `google` row is the point of the exercise.** It logged `keys-0`, so the clean
  tier was never actually sending traffic to a Tier-B provider. The guard closes the
  *future* re-clone path described in its own header, which is a correctly-motivated
  fix rather than an incident response.

### What it changes for the §4b commander v1

The §4b premise was "Gate B goes inert, so the commander turn sees 78 models instead of
56 and `diversifyChain` finally has a wide pool." **That specific argument is now much
weaker on the clean tier**: 23 models across 6 platforms is not a wide pool.

The v1 still holds, for a narrower reason. `diversifyChain`'s provider-diversity pass
can still fill k=3 from 6 distinct platforms comfortably, and family spread across the
survivors is decent (mistral family, glm, qwen, llama, gemma, kimi, nemotron, gpt-oss,
granite, deepseek-distill). What changes is the risk balance:

- **k=3 is now more clearly right than 4**, not merely a Gate C hedge. A k=4 panel would
  consume 4 of 6 platforms' rate budget on every commander turn.
- **Gate D pressure per request is higher than §2 assumed.** With 6 platforms, a panel
  and its judge touch most of the tier at once. Cooldown, not tpm, may turn out to be
  the binding constraint. Measure both.
- **Gray is not a fallback test bed.** `/v1/models` on `:3003` exposes `auto` but **not
  `fusion`** (verified). Fusion bring-up has to happen on `:3001`.

### Operational facts about the guard worth carrying forward

- **The dashboard is no longer authoritative for provider adds on clean.** A key added
  via the UI for an unlisted platform survives only until the next boot. Adding a
  provider now means editing `clean.config.example.json` first.
- **Tombstones are sticky across catalog syncs** by design (`catalog-sync.ts:243`
  consults `isCatalogModelTombstoned`). Reverting the hardening is therefore *not* just
  unsetting the env var: it needs `catalog_model_tombstones` rows deleted. The header
  comment records why plain disable was insufficient ("the models kept coming back
  keyless"), and the two differently-formatted boot log lines show that fix landing.
- **`delKeys` deletes rather than disables** offender `api_keys` rows, so a healed
  provider's key is gone and must be re-entered. Not an issue here (all offenders were
  `keys-0`), but it makes a mis-edited allowlist expensive.

### 4e-bis. CORRECTION to the correction: `keys-0` does not mean "was not flowing"

The reasoning above ("every healed platform logged `keys-0`, so nothing was actually
being sent") is **valid for chat models and wrong for media models**. Recorded here
because it was the load-bearing claim in the paragraph above and it does not hold.

`docker/reconcile-tier.cjs` (commit `270da2f`) scans **three** tables, not two:
`api_keys`, `models`, and `media_models`. The media dimension exists because:

- **pollinations media is `KEYLESS_CAPABLE`** (`server/src/services/media.ts`). It routes
  **anonymously**, so a `keys-0` media row is **live traffic to a Tier-B provider**, not a
  dormant zombie. Deleting the key does nothing; the media row itself must go.
- **Media-only platforms** (e.g. SiliconFlow) have **no chat rows at all**, so a
  chat-table scan misses them entirely regardless of key state.

So the clean tier plausibly *was* emitting anonymous media requests to gray providers,
which is the exact residency failure the tier split exists to prevent. That reframes the
guard from "correctly-motivated preventative fix" to "preventative for chat, corrective
for media". The `google` paragraph above stands (google is chat-only here); the general
`keys-0` inference does not.

The tombstone `kind` is parameterised at `reconcile-tier.cjs:120` and `catalog-sync.ts:217`
honours the `media` kind, so media tombstones survive future syncs the same way chat ones do.

### The media path has NOT executed yet

**The boot logs quoted in §4e came from the pre-media version of the script** (their
`keys-0 tombstoned-N` format predates the `chat-N media-N` format the current code emits,
`reconcile-tier.cjs:162`). `./docker` is mounted read-only into the container, so the new
file is visible, **but the guard only runs at boot**. The running `:3001` container was
started with the older script.

**Consequence: the pollinations keyless-media hole is still open on the live clean
instance until the container is restarted.** Verify after restart by confirming the boot
log switches to the `platform(keys-N chat-N media-N disabled-N fallback-N)` format and
reports non-zero `media-` counts for any off-allowlist media platform.

**RESOLVED 2026-07-20, same session.** `docker restart freellmapi-freellmapi-1` run;
container healthy. First media-aware boot reports:

```
[tier-guard] clean: all providers within allowlist
             {cerebras, cloudflare, mistral, ollama, ovh, requesty}. No changes.
```

That is the `offenders.length === 0` branch (`reconcile-tier.cjs:100`), which is
evaluated over the union of **all three** tables (`api_keys`, `models`, `media_models`,
`:95-102`). So zero off-allowlist rows exist in `media_models` either. The hole is
closed on the live instance.

Caveat on interpretation: "No changes" proves the current state is clean across all
three tables; it does **not** prove media rows were never there. Earlier boots (visible
in the same log, `models-N` then `tombstoned-N` formats) may have removed them, or this
DB may never have carried pollinations media rows. The residency outcome is the same;
only the forensic question of whether anonymous media traffic ever actually flowed
remains open, and the logs cannot settle it.

## 5. What to verify before acting

- [ ] **Is the catalog under-reporting `supportsTools`?** Pull `api.freellmapi.co`'s
      catalog payload and compare its `supportsTools` against provider docs for the 20
      zeroed clean-tier models, starting with the 6 `openrouter` ones. If the catalog is
      accurate there is **no bug here**, just a genuinely scarce tool-capable free tier,
      and §4 is the only remaining lever.
- [ ] Old mistral key row's `status` column: `error` (local decrypt) vs absent/revoked
      (upstream). Discriminates the §2 Gate A silent-failure case.
- [ ] Whether any tool-capable free model has tpm headroom for a 30k-token turn. If none
      do, Gate C is the real ceiling and Gate B work is wasted.
- [ ] For the §4b v1: measured tpm demand of a K=4 fusion commander turn against the
      tpm ceilings of the models the panel actually selects.

## 5-bis. MEASURED 2026-07-20: the §4b commander v1, live on :3001

Config applied via `PUT /api/settings/fusion` (dashboard-session auth) and read back
verified: `mode=auto, k=3, judge=null, strategy=synthesize, expose_panel=true`.
Two commander-shaped turns, **no `tools` in the body**, against the post-hardening
clean tier (23 models, 6 platforms).

| | Small turn | Large turn |
|---|---|---|
| Context sent | ~600 tok | ~11,000 tok |
| **Billed prompt tokens** | 2,206 | **46,035** |
| Completion | 2,058 | 1,665 |
| **Total** | 4,264 | **47,700** |
| **Wall clock** | **7.7s** | **76.5s** |
| Panel dispatches | 3 | **5** (2 overflow refills) |
| Slots ok / failed | 3 / 0 | 3 / 2 |
| Distinct platforms in winning set | **3** | **2** (degraded) |
| Judge | mistral/codestral-latest | mistral/codestral-latest |
| Synthesized | yes | yes |

### The headline numbers

- **Token multiplier is ~4.2x, not k=3x.** 11k of context billed 46k prompt tokens.
  The extra comes from overflow refills (5 dispatches, not 3) plus the judge re-reading
  every panel answer. Budget `k + expected_failures + 1` copies of the prompt, not `k`.
- **Latency is the sharper constraint, not tokens.** 7.7s to 76.5s for a 18x context
  increase. One slot (`cloudflare/@cf/nvidia/nemotron-3-120b-a12b`) burned a **full 60s
  provider timeout** before aborting, and the panel cannot finish faster than its slowest
  live slot. A commander turn that costs 76s is punishing in a loop that runs it per task.
- **§4b's core claim holds.** Gate B went inert as predicted; the initial panel spanned
  three distinct platforms (mistral, cerebras, ollama) and three distinct families
  (codestral, GLM, gemma). `diversifyChain` works on the narrowed 6-platform tier.

### Failure modes actually observed

```
ok      mistral/codestral-latest
failed  cerebras/zai-glm-4.7            no available key for model
ok      ollama/gemma4:31b
failed  cloudflare/@cf/nvidia/...       The operation was aborted (cloudflare, chat, 60s)
ok      mistral/ministral-8b-latest     <- overflow refill
```

- **Gate D confirmed, and fast.** `cerebras/zai-glm-4.7` served the small turn
  successfully and then reported "no available key" ~90 seconds later on the large turn.
  Two consecutive commander turns were enough to cool a platform on a 6-platform tier.
  This is the §4e prediction landing: **cooldown, not tpm, is the binding constraint.**
- **Overflow does not preserve diversity.** The refill pulled `mistral/ministral-8b-latest`
  when `mistral/codestral-latest` was already a live slot, so the winning set collapsed
  from 3 platforms to 2, both answers from the same backend. `diversifyChain` shapes the
  *initial* selection only; the overflow queue is diversity-blind. For a panel whose
  entire value is independence, two same-platform members is a quiet quality regression.
- **Graceful degradation works.** 2 of 5 dispatches failed and the turn still returned
  200 with quorum met and a synthesized answer. Nothing needed retrying by hand.

### Two observability gaps found

1. **`expose_panel` carries no per-slot usage.** The `x_fusion.panel[]` entries expose
   only `model`, `platform`, `status`, `content`. Aggregate usage is the sum across all
   sub-calls, so **per-slot token cost cannot be attributed** and the §5 "which models
   have tpm headroom" question is still unanswerable from the response. Adding `usage`
   per panel entry would be a small, high-value patch.
2. **The judge was also panel slot 1.** `judge=null` auto-selects the top-ranked model,
   which was `mistral/codestral-latest`, already a panel member. It therefore synthesized
   a set containing its own answer. Not necessarily wrong, but it is an unflagged
   self-preference risk and an argument for pinning a judge outside the panel.

### Verdict

The commander split is **viable and worth keeping**, but it is not free. It is a good fit
for a once-per-task planning turn and a bad fit for anything called in a tight loop. If it
goes into real use, the next tuning steps in order are: pin a judge outside the panel,
drop the slowest provider from the clean chain or lower the per-provider timeout below
60s, and treat 2 consecutive commander turns as the practical cooldown budget.

## 5-ter. MEASURED: pinning the judge is WRONG on this tier (recommendation reversed)

§5-bis recommended "pin a judge outside the panel" to fix the self-synthesis issue.
**Tested, and it is actively harmful here.** Two pins, two silent failures:

| Judge pinned to | Result | Direct probe of that model |
|---|---|---|
| `ovh/Qwen3.5-397B-A17B` | `judge:null, synthesized:false` | `1 route checked (1 rate-limited)` |
| `mistral/mistral-large-latest` | `judge:null, synthesized:false` | `1 route checked (1 rate-limited)` |

Both turns still returned **HTTP 200** with a plausible answer. Both had silently
degraded to best-of (longest single panel answer, no synthesis at all).

### Root cause, source-confirmed

`fusion.ts:676-680` branches judge routing on whether a judge is pinned:

```js
const getJudgeRoute = config.judge
  ? (skipKeys) => routePinnedModel(cand.modelDbId, judgeEstimate, skipKeys)  // ONE model, its keys only
  : (skipKeys, skipModels) => routeRequest(...)                              // full chain, skipModels failover
```

Pinned, the judge cannot fail over to another model. It can only rotate that one
model's keys. And on this deployment:

**Every one of the 26 clean-tier models has exactly `keyCount: 1`.** No model has a
second key. So a pinned judge has *zero* failover: one cooled key and the judge is
dead. Unpinned it walks the whole chain with `MAX_JUDGE_ATTEMPTS = 6`.

Worse, the timing is adversarial by construction. `fusion.ts:672`:

```js
const judgeEstimate = estimatedTokens + textSurvivors.reduce((n,a) => n + ceil(a.content.length/4), 0);
```

The judge's routing estimate is **larger than the panel's** (it carries every panel
answer), so the judge needs *more* headroom than the panel, at the exact moment the
panel has just spent that headroom. On a 1-key-per-model tier the panel reliably cools
the very provider the judge then needs.

**Conclusion: do not pin the judge on a single-key free tier.** The self-synthesis
concern from §5-bis is real but far cheaper than losing synthesis entirely. Config
reverted to `judge: null`. Revisit only if a model gains a second key.

### The silent-degradation complaint (worth filing)

A fusion request whose judge fails returns `200` with `synthesized: false` and
`judge: null`, and the caller **cannot detect it** unless `expose_panel` is on. The
documented "graceful judge fallback" (Part 1, §7) is graceful about availability and
silent about quality: the client asked for a synthesized answer across a diverse panel
and received one model's raw output, with no header, no warning, no status field in the
default response shape. Minimum fix: surface `synthesized` (and the reason) in the
default response, not only behind `expose_panel`.

### Bonus finding: one panel slot is dead on arrival every large turn

`cerebras/zai-glm-4.7` failed with "no available key for model" on **every** large
commander turn, yet `diversifyChain` re-selected it as the cerebras representative every
single time. Its `contextWindow` is **8192** against an ~11k-token prompt, and cerebras
is the only tier member with a published `tpmLimit` (30000) low enough to bite. So one
of three panel slots is structurally guaranteed to fail on any large commander turn,
burning a dispatch and forcing an overflow refill that then breaks platform diversity
(§5-bis). Panel selection does not appear to consult `contextWindow` before pinning a
slot; if confirmed, that is a cheap, high-value fix: filter panel candidates by
`contextWindow >= estimate` the way `router.ts:1090` already does for auto-routing.

### §5's tpm question, answered

`tpmLimit` is published for only two platforms: **cerebras 30,000** and
**mistral 500,000**. cloudflare, ollama and ovh report `null` (untracked). So mistral is
the headroom provider on the clean tier and cerebras is the binding constraint, which
matches every failure observed today.

## 6. Candidate changes, in dependency order

1. **§4b commander/worker split.** No code change, testable today, and it is the only
   item here that delivers value without upstream involvement. Do this first.
2. **Split the conflated buckets** in `summarizeExhaustion` (`router.ts:71-99`):
   tpm-budget vs context-window, and decrypt-errored vs absent key. Small, testable, and
   it is a fix to code the routing-diagnostics PR itself added, so it belongs as a commit
   on that open PR rather than a new filing. Also make the remediation advice conditional
   on the dominant bucket, since "add more API keys or wait" is wrong advice for a
   capability-filtered exhaustion.
3. **Tri-state `supports_tools`** (`NULL` = unknown), treating unknown as *eligible,
   failing forward on a 400* rather than pre-excluded. Reclaims 20-29 routes per
   instance. Needs a migration and upstream buy-in, gated on the §5 catalog check.
4. **Tool-aware fusion** per §4d, gated on (3) delivering a pool worth fanning across.

Filing posture as of writing: three PRs already open upstream (#331, #332, #364).
Adding to that queue before it drains is noise. Item (2) folds into #364, and item (3)
needs the §5 verification before it is a defensible claim rather than a guess.
