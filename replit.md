# FarmBudy - FS25 Discord Bot za Slavonsku Ravnicu

## Overview

FarmBudy is a **Discord-focused** application for managing Farming Simulator 25 (FS25) game data for the "Slavonska Ravnica" server. The system syncs farm data via FTP using the FSG_Companion mod, stores it in database, and provides Discord slash commands and an interactive Admin Panel with buttons for all operations. **Web dashboard is not needed** - all functionality is accessed through Discord.

## User Preferences

- Preferred communication style: Simple, everyday language (Croatian/English).
- **Discord-focused**: No web dashboard needed, all features via Discord bot
- Admin Panel with interactive buttons for all main functions
- Support for multiple farms with individual filtering and dedicated channels

## System Architecture

### Backend Architecture
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript compiled with tsx for development, esbuild for production
- **Discord Integration**: discord.js v14 for bot functionality with slash commands
- **FTP Sync**: basic-ftp library for syncing game data from FS25 servers

### Data Storage (Hybrid)
- **Development (Replit)**: PostgreSQL with Drizzle ORM via `DATABASE_URL`
- **Production (Railway)**: MongoDB via `MONGO_URL`
- **Schema Location**: shared/schema.ts defines all PostgreSQL tables with Drizzle ORM
- **Storage Layer**: server/storage.ts provides IStorage interface that works with both PostgreSQL and MongoDB
- **Hybrid Storage**: Automatically chooses PostgreSQL or MongoDB based on NODE_ENV and available connection strings

### Key Design Patterns
- **Storage Abstraction**: server/storage.ts provides IStorage interface layer that works with both PostgreSQL and MongoDB
- **Environment Detection**: Uses NODE_ENV and available connection strings to choose database

## External Dependencies

### Discord Integration
- Discord bot token required via `DISCORD_TOKEN` environment variable
- Guild ID for slash command registration via `DISCORD_GUILD_ID`
- Client ID for bot setup via `DISCORD_CLIENT_ID`
- Bot provides /admin, /status, /farms, /sync commands and interactive Admin Panel

### FS25 Game Server Sync
- FTP connection to game server for syncing field/weather data
- Requires `FS25_FTP_HOST`, `FS25_FTP_USER`, `FS25_FTP_PASSWORD` environment variables
- Parses XML files from FSG_Companion mod: fieldsStats.xml, vehicleStats.xml, placeableSiloStats.xml, productionStats.xml, animalStats.xml, WeatherForecast.xml, farms.xml, playerStats.xml
- Default FTP path: `/modSettings/FS25_FSG_Companion/commands/outbox`

### Database
- **Development**: PostgreSQL via `DATABASE_URL` (Replit built-in)
- **Production**: MongoDB via `MONGO_URL` (Railway)
- Collections/Tables: botLogs, farms, fields, vehicles, silos, productions, animals, weather, jobs, alerts, players, deployedPanels

### GitHub Integration
- Connected via Replit GitHub connector
- Uses @octokit/rest for GitHub API operations
- Endpoints for pushing code and creating releases at /api/github/*
- Deploy page at /deploy for pushing updates to GitHub
- Designed to work with Railway auto-deploy (connect Railway to GitHub repo)

### Deployment Flow
1. Make changes in Replit
2. Go to /deploy page
3. Select repository (e.g., 7oncha/FarmBudy)
4. Enter commit message
5. Push to GitHub
6. Railway auto-deploys new version (if configured)

## Admin Panel Features
- **Status**: Server status and last sync time
- **Farme**: List of farms with balance
- **Polja**: Field status (crops, growth stage, fertilization) with colored loading bars
- **Vozila**: Vehicles categorized by type (tractors, harvesters, trucks, cars, attachments) with fuel bars
- **Silosi**: Silo fill levels with content breakdown and individual item bars
- **Zivotinje**: Animal counts, health, food levels, and output levels with colored bars
- **Vrijeme**: Weather forecast (current + daily)
- **Proizvodnje**: Production facilities status with input/output bars
- **Igraci**: Player hours and online status
- **Poslovi**: Job board for farm work requests with payment system
- **Sync Sada**: Manual FTP sync trigger
- **Postavi Kanal**: Setup dedicated farm channels
- **Auto-refresh**: All deployed panels automatically refresh after each sync (every 5 minutes or manual)

## Job Board System (/posao command)
- **/posao kreiraj**: Create new job (type, description, payment, field)
- **/posao preuzmi**: Take a job by ID
- **/posao zavrsi**: Complete a job you created/took
- **/posao lista**: List all available jobs
- Job types: Oranje, Kultivacija, Sijanje, Zetva, Gnojenje, Prskanje, Kosidba, Baliranje, Prijevoz, Briga o zivotinjama, Ostalo

## Visual Features
- **3-Color Loading Bar System**: Red (<30%), Yellow (30-70%), Green (>70%)
- **Vehicle Categorization**: VELIKI TRAKTORI, SREDNJI TRAKTORI, MALI TRAKTORI, KOMBAJNI, KAMIONI, AUTI, PRIKLJUCCI, OSTALO
- **Code Block Formatting**: Uses Discord code blocks with syntax highlighting for better readability
