# FarmBuddy — Copilot Instructions

## Project Overview
FarmBuddy is a Discord bot + web dashboard for managing a Farming Simulator 25 multiplayer server.
The server is "Slavonska Ravnica" — a Croatian FS25 community.

## Language
- All Discord embeds, messages, and UI text: **Croatian** (HR)
- Code comments can be English
- Git commit messages: **English**
- Variable/function names: **English**

## Tech Stack
- **Bot**: TypeScript, discord.js v14, Express
- **Database**: MongoDB (via MongoStorage class in server/storage.ts)
- **Dashboard**: React, Tailwind CSS, shadcn/ui (client/src/)
- **FS25 Mods**: Lua scripts + XML configs (_modwork/)
- **Deployment**: Railway (auto-deploy on push to main)
- **Game Communication**: XML commands via FTP (inbox/outbox pattern)

## Key Conventions
- Use `getGuildChannel(guild, key)` for Discord channels — never hardcode channel IDs
- Guild channel keys are defined in GUILD_CHANNEL_KEYS array
- All fill type names use COOP_FILL_NAMES map for Croatian translations
- Contract channels follow naming: `📦┃{fillname}-f{farmId}`
- Farm categories follow naming: `🏡 {FARMNAME}` with bold/smallcaps Unicode
- Use `escapeXml()` for all XML command values
- Use `storage.` methods for all DB operations — never access MongoDB directly

## File Structure
- `server/bot.ts` — Main bot file (large, ~20k lines). All Discord handlers, coop system, panels
- `server/storage.ts` — MongoDB storage layer (IStorage interface + MongoStorage)
- `server/sync.ts` — FTP sync: polls game server for XML commands
- `server/routes.ts` — Express API routes for dashboard
- `client/src/pages/Dashboard.tsx` — Main dashboard page (React)
- `_modwork/` — FS25 mod source files (Lua, XML, i3d)

## FS25 Mod Development
- Mod entry: modDesc.xml (manifest with scripts, l10n, dependencies)
- Scripts: Lua (.lua) — FS25 uses custom Lua API (GIANTS Engine)
- 3D Models: .i3d files (edit in GIANTS Editor, not VS Code)
- Textures: .dds files (DirectDraw Surface)
- Companion mod handles bot↔game communication via FTP XML files

## Common Pitfalls
- Always call `storage.completeContract()` when finishing a contract
- Always delete contract channels after completion (use deleteContractChannel helper)
- FTP file deletion can fail — always use transactionId deduplication for deliveries
- setTimeout for channel deletion should be short (5s) to survive bot restarts
- generateCoopContracts() runs on startup — don't put migration/recreation logic there
