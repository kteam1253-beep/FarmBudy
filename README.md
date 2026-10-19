# FarmBudy – Admin Panel + Workflow + Field Details

## Key UX changes
- Clicking a field **updates one persistent "Field Details" message** (no message spam).
- The field details shows: current stage, what to do next, active task, priority, planned seeding, and recent history.
- "Refresh" is removed from the field UI. Use **Start** (auto-creates next task if needed).
- "Assign me" replaced by **Priority** (LOW=green, MED=🟠, HIGH=red).

## Panels you can deploy
- admin  : pinnable admin command panel (buttons)
- workflow: field list board
- activity: activity feed
- details: single field details panel (gets updated when clicking fields)

## Minimal commands
- /panel deploy type:<admin|workflow|activity|details> channel:#channel
- /panel refresh
- /fields add ids:"6,7,10-15"
- /fields remove ids:"3"
- /config setlog channel:#log-channel

## Secure env setup (recommended)
1. Copy `.env.example` to `.env`.
2. Fill real tokens/IDs only in `.env` (never commit secrets).
3. Keep `.env.example` as template values only.
4. Run app with `npm run dev` (or your deployment start command).

Notes:
- `.env` and `.env.*` are git-ignored by default.
- If `.env` was tracked earlier, untrack once with: `git rm --cached .env`.
