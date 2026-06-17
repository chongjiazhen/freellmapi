# Design: provider key-nudge (Phase 1)

Remind the user to add API keys for providers that have enabled catalog models
but no key — so newly catalog-synced providers don't sit as dead, unusable
model rows the user never notices.

Upstream context: freellmapi PRs #329/#330 (fusion) merged; this is an
independent follow-up contribution off `origin/main` (`feat/provider-key-nudge`).

## Problem

`catalog-sync` pulls new providers' models twice daily (`applyCatalog`,
`counts.inserted`). `/api/health` only reports platforms that **already have
keys** (`GROUP BY api_keys`), so a platform with enabled models and zero keys is
invisible — the user is never told they could unlock N free models by adding one
key. README provider edits merely trail the catalog; the catalog is the real
signal.

## Scope

**In:** all currently-unconfigured providers (no catalog-delta tracking),
surfaced as a dismissible banner on the KeysPage only. Dismiss is a menu
(software-update style): snooze / per-provider mute / disable.

**Out (Phase 2, not this spec):** catalog-delta "newly-added only" detection,
desktop tray notification, any global/all-pages banner.

## Architecture

Three units, each independently testable.

### 1. Service — `server/src/services/provider-nudge.ts` (new)

Pure logic + settings I/O, no HTTP. The whole feature's source of truth.

```
interface UnconfiguredProvider { platform: string; name: string; models: number }

getUnconfiguredProviders(): UnconfiguredProvider[]
getNudgeState(): { disabled: boolean; muted: string[]; snoozed: string[] }
dismissNudge(scope: 'snooze' | 'mute' | 'disable', platform?: string): void
pruneNudgeState(platform: string): void   // housekeeping when a key is added
```

`getUnconfiguredProviders` SQL (approved):

```sql
SELECT m.platform, COUNT(*) AS models
FROM models m
WHERE m.enabled = 1 AND m.platform != 'custom'
  AND NOT EXISTS (
    SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = 1
  )
GROUP BY m.platform
```

Then in JS, drop platforms where:
- `!hasProvider(platform)` — this binary can't route it,
- the registered provider is `keyless` (pollinations / ovh / kilo route without
  a key via a sentinel row — nothing to nudge),
- platform ∈ muted set,
- platform ∈ snoozed set.

`name` resolved from `getAllProviders()` (`provider.name`). Returns `[]` when
`disabled` is true.

Settings keys (settings table, JSON where noted):
- `nudge_disabled` — `'1'` / unset.
- `nudge_muted_platforms` — JSON `string[]`.
- `nudge_snoozed_platforms` — JSON `string[]`.

`dismissNudge`:
- `'disable'` → set `nudge_disabled = '1'`.
- `'mute'` (requires `platform`) → add platform to muted set.
- `'snooze'` (no platform) → overwrite snoozed set with the **currently-shown**
  platforms (unconfigured − muted). A later brand-new unconfigured provider is
  not in that set, so the banner re-appears showing only it.

`pruneNudgeState(platform)` removes a platform from muted + snoozed sets; called
when a key is added so a re-added-then-removed provider nudges again.

### 2. Routes

- `GET /api/health` — add `unconfiguredProviders: UnconfiguredProvider[]`
  (already filtered). Natural home: it already aggregates platform/key state.
- `POST /api/keys/nudge` — body `{ scope: 'snooze'|'mute'|'disable', platform?: string }`
  → validate (zod), call `dismissNudge`, return `{ ok: true }`. `mute` without
  `platform` → 400.
- Existing key-create path (`POST /api/keys`) calls `pruneNudgeState(platform)`
  after a successful insert.

### 3. Frontend — `<UnconfiguredProvidersBanner>` on KeysPage

Reuses the existing rounded-callout style (`KeysPage.tsx` uses
`border-… bg-…/10 px-3 py-2.5 text-xs`) in a neutral/info variant (NOT
destructive). Hidden when the list is empty.

```
ⓘ  3 providers have free models you're not using — Agnes AI (5),
   Zhipu (3), GitHub Models (4).
   [Add key ▾]                                          [Dismiss ▾]
     ├ (per-provider → preselect)                         ├ Snooze until a new provider appears
                                                          ├ Don't show for Agnes AI
                                                          ├ Don't show for Zhipu
                                                          ├ Don't show for GitHub Models
                                                          └ Don't ask again
```

- `[Add key ▾]` → preselect that platform in the existing AddKeyForm (scroll +
  set the platform `<select>`). Per-provider entries in the menu.
- `[Dismiss ▾]` → POSTs the chosen scope, then refetches health so the banner
  updates in place.
- Data: the KeysPage already fetches `/api/health`; read
  `unconfiguredProviders` off that response (no new fetch wiring).
- i18n: add the new strings to `client/src/i18n/locales/en.json` (other locales
  inherit English until translated, matching the repo's existing pattern).

## Data flow

```
catalog-sync inserts models ─▶ models table
                                   │
GET /api/health ──▶ getUnconfiguredProviders() ──┬─ SQL (models w/o key)
                                                 ├─ filter hasProvider/keyless
                                                 └─ filter muted/snoozed/disabled
   └─▶ { …, unconfiguredProviders: [...] } ──▶ KeysPage banner
                                                 │
   banner [Dismiss ▾] ──▶ POST /api/keys/nudge ──▶ dismissNudge() ──▶ settings
   banner [Add key]  ──▶ AddKeyForm (existing) ──▶ POST /api/keys ──▶ pruneNudgeState()
```

## Error handling

- `POST /api/keys/nudge` with unknown `scope`, or `mute` without `platform` →
  400, no state change.
- Corrupt JSON in a settings row → treat as empty array (same defensive pattern
  as `getSavedFusionConfig`).
- Banner fetch failure → render nothing (it's an additive hint, never blocks the
  page).

## Testing

Service unit tests (`provider-nudge.test.ts`):
- detects a provider with enabled models + no key; excludes one that has a key.
- excludes `custom`, keyless providers, and `!hasProvider` platforms.
- `mute` hides only that provider; `disable` hides all; `snooze` hides the
  current set but a newly-added unconfigured provider reappears.
- `pruneNudgeState` clears mute/snooze for a platform so it can nudge again.

Route tests:
- `GET /api/health` includes `unconfiguredProviders` with correct counts.
- each `POST /api/keys/nudge` scope mutates state as expected; `mute` w/o
  platform → 400.
- adding a key for a nudged provider drops it from the list.

## Non-goals

Catalog-delta "new since last sync" tracking, desktop tray notification, global
banner, auto-creating keys / OAuth. All deferred to Phase 2.
