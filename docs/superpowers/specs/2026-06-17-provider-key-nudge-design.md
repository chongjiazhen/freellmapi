# Design: provider key-nudge (Phase 1)

Remind the user to add API keys for providers that have enabled models but no
key — so supported providers don't sit as dead, unusable model rows the user
never notices.

Upstream context: freellmapi PRs #329/#330 (fusion) merged; this is an
independent follow-up contribution off `origin/main` (`feat/provider-key-nudge`).

## Problem

A platform can have enabled models and zero keys in three ways, none of which the
UI surfaces:
- **Day one** — bundled migrations ship ~18 providers' models; the user adds keys
  for only a few.
- **Catalog-sync** — for an *already-supported* provider, models get enabled or
  added that the user has no key for. (Note: catalog-sync does NOT add support
  for a *new* provider — `catalog-sync.ts:171` skips models whose platform isn't
  registered in this binary; new provider support needs a code update. There is
  no app auto-update.)
- **After a binary update** — an update registers a new provider; its models
  appear, still keyless.

`/api/health` only reports platforms that **already have keys** (`GROUP BY
api_keys`), so a keyless-but-modelled platform is invisible — the user is never
told they could unlock N free models by adding one key. The value is mostly
update-independent: the day-one and catalog-sync cases need no update at all.

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
  a key via a sentinel row — nothing to nudge).

`name` resolved from `getAllProviders()` (`provider.name`).

**This list is RAW** — it does NOT apply mute/snooze/disable. Those are dismiss
state for the *banner only*; the raw list also feeds the permanent dropdown
annotation (§3b), which must persist after "Don't ask again". The banner derives
its visible subset on the frontend from the raw list + `nudgeState` (below).

Settings keys (settings table, JSON where noted):
- `nudge_disabled` — `'1'` / unset.
- `nudge_muted_platforms` — JSON `string[]`.
- `nudge_snoozed_platforms` — JSON `string[]`.

`dismissNudge`:
- `'disable'` → set `nudge_disabled = '1'`.
- `'mute'` (requires `platform`) → add platform to muted set.
- `'snooze'` (no platform) → overwrite snoozed set with the **currently-shown**
  platforms — computed server-side as `getUnconfiguredProviders() − muted` — so
  a later brand-new unconfigured provider isn't in the set and the banner
  re-appears showing only it.

`pruneNudgeState(platform)` removes a platform from muted + snoozed sets; called
when a key is added so a re-added-then-removed provider nudges again.

### 2. Routes

- `GET /api/health` — add `unconfiguredProviders: UnconfiguredProvider[]` (RAW,
  unfiltered) and `nudgeState: { disabled, muted, snoozed }`. Natural home: it
  already aggregates platform/key state. The frontend derives the banner's
  visible set (`raw − muted − snoozed`, hidden when `disabled` or empty); the
  dropdown annotation uses the raw list directly.
- `POST /api/keys/nudge` — body `{ scope: 'snooze'|'mute'|'disable', platform?: string }`
  → validate (zod), call `dismissNudge`, return `{ ok: true }`. `mute` without
  `platform` → 400.
- Existing key-create path (`POST /api/keys`) calls `pruneNudgeState(platform)`
  after a successful insert.

### 3. Frontend — `<UnconfiguredProvidersBanner>` on KeysPage

Reuses the existing rounded-callout style (`KeysPage.tsx` uses
`border-… bg-…/10 px-3 py-2.5 text-xs`) in a neutral/info variant (NOT
destructive). Visible set = `unconfiguredProviders − muted − snoozed`; hidden
when `nudgeState.disabled` is true or the derived set is empty.

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
- Data: the KeysPage already fetches `/api/health`; read `unconfiguredProviders`
  + `nudgeState` off that response (no new fetch wiring). Banner derives its
  visible set client-side; dropdown annotation (§3b) uses the raw list.
- i18n: add the new strings to `client/src/i18n/locales/en.json` (other locales
  inherit English until translated, matching the repo's existing pattern).

### 3b. AddKeyForm dropdown annotation (permanent reference)

The banner is a transient nudge; the **missing-key state must stay referenceable
even after "Don't ask again".** Today the only all-providers surface is the
AddKeyForm platform `<select>`, built from a static client-side `PLATFORMS`
array — it gives no signal about which providers have free models waiting, and
the KeysPage provider cards render configured platforms only
(`grouped … filter(keys.length > 0)`).

Fix, reusing the health data already on the page (zero new UI): when building the
`<select>` options, join each `PLATFORMS` entry against `unconfiguredProviders`
and, for a match, append a hint to the label:

```
Agnes AI · 5 free models, no key
Zhipu · 3 free models, no key
Groq                              ← configured, no hint
```

So the count of unused free models lives permanently in the control used to fix
it. This is what makes "Don't ask again" safe — it silences the proactive
banner, not the information. (A provider in the catalog but absent from the
static `PLATFORMS` array still won't appear here — a pre-existing client/catalog
sync gap, out of scope for this Phase.)

## Data flow

```
catalog-sync inserts models ─▶ models table
                                   │
GET /api/health ──▶ getUnconfiguredProviders() ─── SQL (models w/o key)
                      │                              + filter hasProvider/keyless  (RAW)
                      └─▶ { …, unconfiguredProviders: [...raw],
                            nudgeState: { disabled, muted, snoozed } }
                                   │
                    ┌──────────────┴───────────────┐
              KeysPage banner                 AddKeyForm dropdown
         (raw − muted − snoozed,            (annotate options from
          hidden if disabled/empty)          raw list — always)
                    │
   banner [Dismiss ▾] ──▶ POST /api/keys/nudge ──▶ dismissNudge() ──▶ settings
   AddKeyForm submit  ──▶ POST /api/keys ──▶ pruneNudgeState()
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
- `getUnconfiguredProviders` (raw) detects a provider with enabled models + no
  key; excludes one that has a key; excludes `custom`, keyless, `!hasProvider`.
- `dismissNudge('mute', p)` adds `p` to muted; `'disable'` sets the flag;
  `'snooze'` snapshots `raw − muted` into snoozed, so a later brand-new
  unconfigured provider is absent from snoozed (banner-visible again).
- `getNudgeState` round-trips the three settings; corrupt JSON → empty arrays.
- `pruneNudgeState(p)` clears `p` from muted + snoozed so it can nudge again.

Route tests:
- `GET /api/health` includes the raw `unconfiguredProviders` (correct counts) and
  `nudgeState`.
- each `POST /api/keys/nudge` scope mutates state as expected; `mute` w/o
  platform → 400.
- adding a key for a nudged provider drops it from the raw list.

Frontend test (KeysPage):
- dropdown option for an unconfigured provider shows the "· N free models, no
  key" hint; a configured provider's option does not.

## Non-goals

Catalog-delta "new since last sync" tracking, desktop tray notification, global
banner, auto-creating keys / OAuth. All deferred to Phase 2.
