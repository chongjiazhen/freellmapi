# Provider Key-Nudge (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface providers that have enabled models but no API key, via a `/api/health` field, a dismissible KeysPage banner, and a permanent AddKeyForm dropdown annotation.

**Architecture:** A new server service (`provider-nudge.ts`) owns all logic and dismiss-state (settings table). `GET /api/health` returns the RAW unconfigured list + nudge state; the frontend derives the banner's visible subset client-side and annotates the existing platform dropdown. Dismiss actions POST to `/api/keys/nudge`; adding a key prunes that provider's dismiss state.

**Tech Stack:** TypeScript, Express, better-sqlite3, Zod, Vitest (server). React + shadcn/ui (client, no test runner — verified by typecheck/build/manual).

**Spec:** `docs/superpowers/specs/2026-06-17-provider-key-nudge-design.md`

**Baseline:** server suite green at 498 tests. Run all server tests with:
`cd server && npx vitest run`

---

## File Structure

- **Create** `server/src/services/provider-nudge.ts` — raw `getUnconfiguredProviders`, `getNudgeState`, `dismissNudge`, `pruneNudgeState`.
- **Create** `server/src/__tests__/services/provider-nudge.test.ts` — service unit tests.
- **Create** `server/src/__tests__/routes/provider-nudge.test.ts` — route tests (health field, nudge POST, prune-on-key-add).
- **Modify** `server/src/routes/health.ts` — add `unconfiguredProviders` + `nudgeState` to the GET response.
- **Modify** `server/src/routes/keys.ts` — add `POST /nudge`; call `pruneNudgeState` on key create.
- **Modify** `client/src/pages/KeysPage.tsx` — extend `HealthData`, add banner, annotate dropdown.
- **Modify** `client/src/i18n/locales/en.json` — new `keys.*` strings.

---

### Task 1: Service — `getUnconfiguredProviders` (raw)

**Files:**
- Create: `server/src/services/provider-nudge.ts`
- Test: `server/src/__tests__/services/provider-nudge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getUnconfiguredProviders } from '../../services/provider-nudge.js';

describe('getUnconfiguredProviders', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('lists a provider with enabled models but no key', () => {
    const list = getUnconfiguredProviders();
    const groq = list.find(p => p.platform === 'groq');
    expect(groq).toBeDefined();
    expect(groq!.models).toBeGreaterThan(0);
    expect(typeof groq!.name).toBe('string');
  });

  it('drops a provider once it has an enabled key', () => {
    getDb().prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','x','x','x','x','unknown',1)",
    ).run();
    expect(getUnconfiguredProviders().some(p => p.platform === 'groq')).toBe(false);
  });

  it('excludes keyless providers and unroutable platforms', () => {
    expect(getUnconfiguredProviders().some(p => p.platform === 'pollinations')).toBe(false);
    getDb().prepare(
      "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('bogus','m','M',1,1,1)",
    ).run();
    expect(getUnconfiguredProviders().some(p => p.platform === 'bogus')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/provider-nudge.test.ts`
Expected: FAIL — `getUnconfiguredProviders` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/provider-nudge.ts`:

```typescript
import type { Platform } from '@freellmapi/shared/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { getAllProviders } from '../providers/index.js';

export interface UnconfiguredProvider {
  platform: string;
  name: string;
  models: number;
}

/**
 * Providers with at least one enabled model and no enabled key — the RAW list,
 * with NO mute/snooze/disable filtering applied (that is banner-only display
 * state, derived on the frontend). Excludes `custom`, keyless providers (they
 * route without a key), and platforms this binary can't route.
 */
export function getUnconfiguredProviders(): UnconfiguredProvider[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.platform AS platform, COUNT(*) AS models
    FROM models m
    WHERE m.enabled = 1 AND m.platform != 'custom'
      AND NOT EXISTS (
        SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = 1
      )
    GROUP BY m.platform
  `).all() as { platform: string; models: number }[];

  const byPlatform = new Map(getAllProviders().map(p => [p.platform, p]));
  const out: UnconfiguredProvider[] = [];
  for (const r of rows) {
    const provider = byPlatform.get(r.platform as Platform);
    if (!provider) continue;        // not routable by this binary
    if (provider.keyless) continue; // routes without a key — nothing to nudge
    out.push({ platform: r.platform, name: provider.name, models: r.models });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/services/provider-nudge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-nudge.ts server/src/__tests__/services/provider-nudge.test.ts
git commit -m "feat(nudge): getUnconfiguredProviders raw list service"
```

---

### Task 2: Service — nudge state (`getNudgeState`, `dismissNudge`, `pruneNudgeState`)

**Files:**
- Modify: `server/src/services/provider-nudge.ts`
- Test: `server/src/__tests__/services/provider-nudge.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing describe block file)

```typescript
import { getNudgeState, dismissNudge, pruneNudgeState } from '../../services/provider-nudge.js';

describe('nudge state', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('defaults to empty/disabled-false', () => {
    expect(getNudgeState()).toEqual({ disabled: false, muted: [], snoozed: [] });
  });

  it('mute adds one platform; disable sets the flag', () => {
    dismissNudge('mute', 'groq');
    expect(getNudgeState().muted).toEqual(['groq']);
    dismissNudge('disable');
    expect(getNudgeState().disabled).toBe(true);
  });

  it('mute without a platform throws', () => {
    expect(() => dismissNudge('mute')).toThrow();
  });

  it('snooze snapshots raw-unconfigured minus muted', () => {
    dismissNudge('mute', 'groq');
    dismissNudge('snooze');
    const { snoozed } = getNudgeState();
    expect(snoozed).not.toContain('groq');           // excluded (muted)
    expect(snoozed).toContain('cerebras');           // a seeded unconfigured provider
  });

  it('pruneNudgeState clears a platform from muted and snoozed', () => {
    dismissNudge('mute', 'groq');
    dismissNudge('snooze'); // snoozes cerebras et al.
    pruneNudgeState('cerebras');
    expect(getNudgeState().snoozed).not.toContain('cerebras');
    pruneNudgeState('groq');
    expect(getNudgeState().muted).not.toContain('groq');
  });

  it('corrupt settings JSON degrades to empty arrays', () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('nudge_muted_platforms', 'not json')").run();
    expect(getNudgeState().muted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/provider-nudge.test.ts`
Expected: FAIL — `getNudgeState`/`dismissNudge`/`pruneNudgeState` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `server/src/services/provider-nudge.ts`)

```typescript
export interface NudgeState {
  disabled: boolean;
  muted: string[];
  snoozed: string[];
}

const KEY_DISABLED = 'nudge_disabled';
const KEY_MUTED = 'nudge_muted_platforms';
const KEY_SNOOZED = 'nudge_snoozed_platforms';

function readList(key: string): string[] {
  const raw = getSetting(key);
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function getNudgeState(): NudgeState {
  return {
    disabled: getSetting(KEY_DISABLED) === '1',
    muted: readList(KEY_MUTED),
    snoozed: readList(KEY_SNOOZED),
  };
}

export function dismissNudge(scope: 'snooze' | 'mute' | 'disable', platform?: string): void {
  if (scope === 'disable') {
    setSetting(KEY_DISABLED, '1');
    return;
  }
  if (scope === 'mute') {
    if (!platform) throw new Error('mute requires a platform');
    const muted = new Set(readList(KEY_MUTED));
    muted.add(platform);
    setSetting(KEY_MUTED, JSON.stringify([...muted]));
    return;
  }
  // snooze: snapshot the currently-shown set (raw unconfigured minus muted) so a
  // later brand-new unconfigured provider is absent and re-triggers the banner.
  const muted = new Set(readList(KEY_MUTED));
  const shown = getUnconfiguredProviders().map(p => p.platform).filter(p => !muted.has(p));
  setSetting(KEY_SNOOZED, JSON.stringify(shown));
}

/** Drop a platform from mute + snooze sets (called when its key is added). */
export function pruneNudgeState(platform: string): void {
  setSetting(KEY_MUTED, JSON.stringify(readList(KEY_MUTED).filter(p => p !== platform)));
  setSetting(KEY_SNOOZED, JSON.stringify(readList(KEY_SNOOZED).filter(p => p !== platform)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/services/provider-nudge.test.ts`
Expected: PASS (all tests, both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-nudge.ts server/src/__tests__/services/provider-nudge.test.ts
git commit -m "feat(nudge): nudge state read/dismiss/prune"
```

---

### Task 3: Route — `GET /api/health` adds `unconfiguredProviders` + `nudgeState`

**Files:**
- Modify: `server/src/routes/health.ts:33-54` (the `res.json({...})` block)
- Test: `server/src/__tests__/routes/provider-nudge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

describe('provider key-nudge routes', () => {
  let app: Express;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'nudge_%'").run();
  });

  it('GET /api/health exposes raw unconfiguredProviders + nudgeState', async () => {
    const { status, body } = await request(app, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(Array.isArray(body.unconfiguredProviders)).toBe(true);
    expect(body.unconfiguredProviders.some((p: any) => p.platform === 'groq')).toBe(true);
    expect(body.nudgeState).toEqual({ disabled: false, muted: [], snoozed: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/routes/provider-nudge.test.ts`
Expected: FAIL — `body.unconfiguredProviders` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/health.ts`, add the import at the top (next to the existing `hasProvider` import):

```typescript
import { getUnconfiguredProviders, getNudgeState } from '../services/provider-nudge.js';
```

Then extend the `res.json({...})` object in the `GET '/'` handler — add two keys after `keys: keys.map(...)`:

```typescript
    keys: keys.map(k => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: k.enabled === 1,
      createdAt: k.created_at,
      lastCheckedAt: k.last_checked_at,
    })),
    unconfiguredProviders: getUnconfiguredProviders(),
    nudgeState: getNudgeState(),
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/routes/provider-nudge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/health.ts server/src/__tests__/routes/provider-nudge.test.ts
git commit -m "feat(nudge): expose unconfiguredProviders + nudgeState on /api/health"
```

---

### Task 4: Route — `POST /api/keys/nudge`

**Files:**
- Modify: `server/src/routes/keys.ts` (add a new route + import)
- Test: `server/src/__tests__/routes/provider-nudge.test.ts`

- [ ] **Step 1: Write the failing test** (append inside the existing `describe('provider key-nudge routes', ...)`)

```typescript
  it('POST /api/keys/nudge mute adds a platform; reflected in nudgeState', async () => {
    const r = await request(app, 'POST', '/api/keys/nudge', { scope: 'mute', platform: 'groq' });
    expect(r.status).toBe(200);
    const { body } = await request(app, 'GET', '/api/health');
    expect(body.nudgeState.muted).toContain('groq');
  });

  it('POST /api/keys/nudge disable sets the flag', async () => {
    await request(app, 'POST', '/api/keys/nudge', { scope: 'disable' });
    const { body } = await request(app, 'GET', '/api/health');
    expect(body.nudgeState.disabled).toBe(true);
  });

  it('POST /api/keys/nudge mute without platform → 400', async () => {
    const r = await request(app, 'POST', '/api/keys/nudge', { scope: 'mute' });
    expect(r.status).toBe(400);
  });

  it('POST /api/keys/nudge with unknown scope → 400', async () => {
    const r = await request(app, 'POST', '/api/keys/nudge', { scope: 'bogus' });
    expect(r.status).toBe(400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/routes/provider-nudge.test.ts`
Expected: FAIL — POST `/api/keys/nudge` returns 404 (route absent).

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/keys.ts`, add the import near the top:

```typescript
import { dismissNudge, pruneNudgeState } from '../services/provider-nudge.js';
```

Add this route (place it directly after `export const keysRouter = Router();`, so the exact `/nudge` path is registered before the `/:id` patch/delete handlers — exact paths don't collide with `:id`, but keeping it early is clearest):

```typescript
const nudgeSchema = z.object({
  scope: z.enum(['snooze', 'mute', 'disable']),
  platform: z.string().min(1).optional(),
});

// Dismiss the unconfigured-provider nudge. Body: { scope, platform? }.
keysRouter.post('/nudge', (req: Request, res: Response) => {
  const parsed = nudgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { scope, platform } = parsed.data;
  if (scope === 'mute' && !platform) {
    res.status(400).json({ error: { message: 'platform is required to mute' } });
    return;
  }
  dismissNudge(scope, platform);
  res.json({ ok: true });
});
```

(`pruneNudgeState` is imported now but wired in Task 5.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/routes/provider-nudge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/keys.ts server/src/__tests__/routes/provider-nudge.test.ts
git commit -m "feat(nudge): POST /api/keys/nudge dismiss endpoint"
```

---

### Task 5: Wire `pruneNudgeState` into key creation

**Files:**
- Modify: `server/src/routes/keys.ts` (the `POST '/'` handler — both success branches)
- Test: `server/src/__tests__/routes/provider-nudge.test.ts`

- [ ] **Step 1: Write the failing test** (append inside the same describe)

```typescript
  it('adding a key prunes the provider from snooze + drops it from unconfigured', async () => {
    // snooze snapshots groq (among others), then add a groq key
    await request(app, 'POST', '/api/keys/nudge', { scope: 'snooze' });
    let health = (await request(app, 'GET', '/api/health')).body;
    expect(health.nudgeState.snoozed).toContain('groq');

    const add = await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'k_groq_nudge', label: 'x' });
    expect(add.status).toBe(201);

    health = (await request(app, 'GET', '/api/health')).body;
    expect(health.nudgeState.snoozed).not.toContain('groq'); // pruned
    expect(health.unconfiguredProviders.some((p: any) => p.platform === 'groq')).toBe(false); // now has a key
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/routes/provider-nudge.test.ts`
Expected: FAIL — `snoozed` still contains `groq` (no prune yet).

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/keys.ts`, in the `POST '/'` handler, call `pruneNudgeState(platform)` immediately before each of the two success responses.

Branch A — the keyless re-enable path (before `res.status(200).json({...})`):

```typescript
    if (existing) {
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
      pruneNudgeState(platform);
      res.status(200).json({
```

Branch B — the normal insert path (before `res.status(201).json({...})`):

```typescript
  `).run(platform, label ?? '', encrypted, iv, authTag);

  pruneNudgeState(platform);
  res.status(201).json({
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/routes/provider-nudge.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the FULL server suite (no regressions)**

Run: `cd server && npx vitest run`
Expected: all pass — baseline 498 + new service/route tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/keys.ts server/src/__tests__/routes/provider-nudge.test.ts
git commit -m "feat(nudge): prune nudge state when a key is added"
```

---

### Task 6: Frontend — banner + dropdown annotation + i18n

No client test runner exists (repo convention). Verify by typecheck + production build + manual smoke. Keep all logic inline in the existing KeysPage component where `healthData`, `setPlatform`, and the form already live.

**Files:**
- Modify: `client/src/pages/KeysPage.tsx`
- Modify: `client/src/i18n/locales/en.json`

- [ ] **Step 1: Add i18n strings**

In `client/src/i18n/locales/en.json`, inside the `"keys": { ... }` object (e.g. after `"configuredProviders": "Configured providers",`), add:

```json
    "unconfiguredTitle": "{count} providers have free models you're not using",
    "unconfiguredModelCount": "{name} ({count})",
    "dropdownNoKeyHint": "· {count} free models, no key",
    "nudgeAddKey": "Add key",
    "nudgeDismiss": "Dismiss",
    "nudgeSnooze": "Snooze until a new provider appears",
    "nudgeMute": "Don't show for {name}",
    "nudgeDisable": "Don't ask again",
```

- [ ] **Step 2: Extend the `HealthData` type**

In `client/src/pages/KeysPage.tsx`, extend the `HealthData` interface (around line 94):

```typescript
interface UnconfiguredProvider { platform: string; name: string; models: number }
interface NudgeState { disabled: boolean; muted: string[]; snoozed: string[] }

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
  unconfiguredProviders?: UnconfiguredProvider[]
  nudgeState?: NudgeState
}
```

- [ ] **Step 3: Add the DropdownMenu import**

At the top of `client/src/pages/KeysPage.tsx`, add (alongside the other `@/components/ui/*` imports):

```typescript
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
```

- [ ] **Step 4: Add a dismiss mutation** (inside the main KeysPage component, next to the existing `addKey`/`deleteKey` mutations, ~line 401)

```typescript
  const dismissNudge = useMutation({
    mutationFn: (body: { scope: 'snooze' | 'mute' | 'disable'; platform?: string }) =>
      apiFetch('/api/keys/nudge', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['health'] }),
  })
```

- [ ] **Step 5: Derive banner data + render the banner**

Inside the main component, after the `healthData` query, derive the visible set:

```typescript
  const nudge = healthData?.nudgeState
  const bannerProviders = (healthData?.unconfiguredProviders ?? []).filter(
    p => !nudge?.muted.includes(p.platform) && !nudge?.snoozed.includes(p.platform),
  )
  const showBanner = !nudge?.disabled && bannerProviders.length > 0
```

In the component's returned JSX, immediately after `<PageHeader ... />`, add:

```tsx
        {showBanner && (
          <div className="mb-6 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3 text-xs">
            <div className="mb-2 text-foreground">
              {t('keys.unconfiguredTitle', { count: bannerProviders.length })} —{' '}
              {bannerProviders.map(p => t('keys.unconfiguredModelCount', { name: p.name, count: p.models })).join(', ')}.
            </div>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">{t('keys.nudgeAddKey')}</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {bannerProviders.map(p => (
                    <DropdownMenuItem
                      key={p.platform}
                      onClick={() => {
                        setPlatform(p.platform as Platform)
                        document.querySelector('form')?.scrollIntoView({ behavior: 'smooth' })
                      }}
                    >
                      {p.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost">{t('keys.nudgeDismiss')}</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => dismissNudge.mutate({ scope: 'snooze' })}>
                    {t('keys.nudgeSnooze')}
                  </DropdownMenuItem>
                  {bannerProviders.map(p => (
                    <DropdownMenuItem
                      key={p.platform}
                      onClick={() => dismissNudge.mutate({ scope: 'mute', platform: p.platform })}
                    >
                      {t('keys.nudgeMute', { name: p.name })}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={() => dismissNudge.mutate({ scope: 'disable' })}>
                    {t('keys.nudgeDisable')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
```

- [ ] **Step 6: Annotate the platform dropdown**

The raw unconfigured list drives a permanent hint, independent of dismiss state. Before the `<Select>` in the AddKeyForm, build a lookup:

```typescript
  const unconfiguredByPlatform = new Map(
    (healthData?.unconfiguredProviders ?? []).map(p => [p.platform, p.models]),
  )
```

Then change the `PLATFORMS.map` that renders `<SelectItem>` (~line 555) to append the hint:

```tsx
                  {PLATFORMS.map(p => {
                    const models = unconfiguredByPlatform.get(p.value)
                    return (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                        {models ? ` ${t('keys.dropdownNoKeyHint', { count: models })}` : ''}
                      </SelectItem>
                    )
                  })}
```

- [ ] **Step 7: Typecheck + build**

Run: `cd client && npm run build`
Expected: `tsc -b` passes (no type errors) and `vite build` completes. If `Platform` isn't already imported in KeysPage, the `as Platform` casts will flag it — it is imported (used by existing `useState<Platform | ''>`), so no new import needed.

- [ ] **Step 8: Manual smoke (document, not automated)**

Start the server + client dev build against a DB with models but no keys. Confirm: banner lists unconfigured providers; "Add key" preselects the platform; each Dismiss option hides the banner appropriately (snooze → gone until a new provider; mute → that one drops; disable → banner gone but dropdown hints remain); the platform dropdown shows "· N free models, no key" on keyless-but-modelled providers.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/KeysPage.tsx client/src/i18n/locales/en.json
git commit -m "feat(nudge): KeysPage banner + dropdown annotation for unconfigured providers"
```

---

## Self-Review Notes

- **Spec coverage:** service raw list (T1) · nudge state + snooze snapshot + prune (T2) · health field (T3) · dismiss endpoint (T4) · prune-on-key-add (T5) · banner + dropdown annotation + i18n (T6). Error handling (400s, corrupt JSON) covered in T2/T4. All spec sections mapped.
- **Frontend test:** spec's "Frontend test" line is satisfied by typecheck + build + manual — the client has no test runner and adding one is out of scope. All branching logic that warrants a unit test lives server-side and is covered.
- **Type consistency:** `UnconfiguredProvider { platform, name, models }` and `NudgeState { disabled, muted, snoozed }` are identical across service, route response, and client interface. `dismissNudge(scope, platform?)` signature matches the route and the client mutation body.
