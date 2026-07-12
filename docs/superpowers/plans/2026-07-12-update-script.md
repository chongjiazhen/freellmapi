# Repository Update Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe PowerShell command that updates the checkout, verifies it, rebuilds Docker, and confirms port 3001 health.

**Architecture:** One self-contained `scripts/update.ps1` orchestrates existing Git, npm, and Docker commands. It uses strict failure handling, tracked-worktree protection, fast-forward-only Git movement, and bounded health polling. No application runtime code changes.

**Tech Stack:** PowerShell 7, Git, npm, Docker Compose, existing Vitest/TypeScript build.

## Global Constraints

- Abort when tracked working-tree changes exist.
- Preserve untracked files.
- Fetch and fast-forward only; never reset, merge, or discard files.
- Run `npm ci`, `npm test`, and `npm run build` before Docker replacement.
- Preserve named Docker volumes; do not run volume deletion.
- Poll `/api/ping` after restart.
- Do not run `npm audit fix`.

---

### Task 1: Add update orchestrator

**Files:**
- Create: `scripts/update.ps1`

**Interfaces:**
- Parameters: `-HealthUrl` defaulting to `http://127.0.0.1:3001/api/ping`, `-HealthTimeoutSeconds` defaulting to `60`, and `-SkipDocker`.
- Exit code: `0` only after all selected stages succeed; nonzero on any failure.

- [ ] **Step 1: Implement strict preflight and Git update**

Use strict mode, stop on errors, inspect `git status --porcelain`, reject any non-`??` entry, then run `git fetch origin` and `git merge --ff-only` against the remote default branch. Resolve `origin/HEAD` with `git symbolic-ref --short refs/remotes/origin/HEAD`; if unavailable, fail clearly rather than choosing an arbitrary branch.

- [ ] **Step 2: Add dependency, test, and build stages**

Run `npm ci`, `npm test`, and `npm run build` through one helper that prints stage names and checks `$LASTEXITCODE`. Any failure stops before Docker changes.

- [ ] **Step 3: Add Docker and health stages**

Unless `-SkipDocker` is present, run `docker compose up -d --build`, then poll `$HealthUrl` with `Invoke-WebRequest -UseBasicParsing` until HTTP 200 or timeout. Sleep one second between attempts and include the last error in timeout output.

- [ ] **Step 4: Run static contract checks**

Run `rg -n "Set-StrictMode|ErrorActionPreference|git status --porcelain|git fetch|git merge --ff-only|npm ci|npm test|npm run build|docker compose up -d --build|api/ping|HealthTimeoutSeconds|SkipDocker" scripts/update.ps1`. Every required guard and stage must appear.

### Task 2: Verify safe execution

**Files:**
- Modify: none

- [ ] **Step 1: Run local verification**

Run `pwsh -File .\scripts\update.ps1 -SkipDocker`. Expected: fetch, fast-forward, dependency install, tests, and build complete with exit code `0`; `_issue_1.md` remains untouched.

- [ ] **Step 2: Inspect repository state**

Run `git status --short`. Expected: no generated tracked changes.

- [ ] **Step 3: Run deployment path**

Run `pwsh -File .\scripts\update.ps1`. Expected: Docker rebuild/recreate succeeds and health check receives HTTP 200.

- [ ] **Step 4: Commit implementation**

Run `git add scripts/update.ps1 docs/superpowers/specs/2026-07-12-update-script-design.md docs/superpowers/plans/2026-07-12-update-script.md` then `git commit -m "chore: automate safe repository updates"`.
