# Repository Update Script Design

## Goal

Provide one repeatable PowerShell command that updates FreeLLMAPI from its configured GitHub remote and refreshes the Docker deployment on port 3001.

## Safety boundaries

- Abort when tracked working-tree changes exist.
- Preserve untracked files.
- Fetch remote state and fast-forward only; never merge, reset, or discard files.
- Run dependency installation, tests, and production build before replacing the running container.
- Rebuild with `docker compose up -d --build` and preserve the named database volume.
- Poll `/api/ping` after restart and fail on timeout.
- Do not run automatic vulnerability fixes or mutate `.env`.

## Flow

`git status` → `git fetch` → `git merge --ff-only` → `npm ci` → `npm test` → `npm run build` → `docker compose up -d --build` → health polling.

Each command stops the script on failure and reports the failing stage. Script accepts optional `-HealthUrl`, `-HealthTimeoutSeconds`, and `-SkipDocker` switches for local verification or alternate deployments.

## Verification

Static checks confirm required safety commands and flags exist. Manual verification runs the script in `-SkipDocker` mode against the current clean tracked checkout, then runs the normal project tests/build separately. Docker deployment remains opt-in during verification because it changes the running service.
