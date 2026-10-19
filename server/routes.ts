import type { Express } from "express";
import type { Server } from "http";
import path from "path";
import fs from "fs";
import { storage, mongoAdmin } from "./storage";
import { bot } from "./bot";
import { syncService } from "./sync";
import { getSyncStatus } from "./syncStatus";
import { api } from "@shared/routes";
import { getGitHubUser, listRepositories, pushMultipleFiles, createRelease, createModRelease, listRepoContents, deleteFile } from "./github";
import { uploadInboxXml, listInboxFiles, readFtpFile } from "./ftpCommands";
import { getServers, getActiveServerId, setActiveServer, getActiveServer } from "./serverConfig";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // ── Discord OAuth2 Auth ──
  const ALLOWED_ROLES = ['Upravitelj', 'Sugazda', 'Gazda', 'Suvlasnik', 'Vlasnik'];
  // Extract CLIENT_ID from bot token (first segment is base64-encoded app ID) — always correct
  const tokenClientId = (() => {
    try {
      const token = process.env.DISCORD_TOKEN || '';
      return Buffer.from(token.split('.')[0], 'base64').toString();
    } catch { return ''; }
  })();
  const CLIENT_ID = tokenClientId || process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '';
  const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET || '';
  const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';
  console.log(`[AUTH] OAuth CLIENT_ID=${CLIENT_ID} (source: ${tokenClientId ? 'token' : process.env.DISCORD_CLIENT_ID ? 'DISCORD_CLIENT_ID' : 'CLIENT_ID'})`);

  /** Build the OAuth callback URL reliably across Railway/local */
  function getRedirectUri(req: any): string {
    if (REDIRECT_URI) return REDIRECT_URI;
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (domain) return `https://${domain}/api/auth/discord/callback`;
    return `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;
  }

  // Auth: login redirect
  app.get('/api/auth/discord', (req, res) => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.error('[AUTH] Missing env: CLIENT_ID=' + !!CLIENT_ID + ' CLIENT_SECRET=' + !!CLIENT_SECRET);
      return res.redirect('/?error=auth_failed');
    }
    // Build redirect URI: prefer env var, then RAILWAY_PUBLIC_DOMAIN, then auto-detect
    const redirect = getRedirectUri(req);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'identify',
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  // Auth: OAuth callback
  app.get('/api/auth/discord/callback', async (req, res) => {
    const code = req.query.code as string;
    if (!code) return res.redirect('/?error=no_code');

    try {
      const redirect = getRedirectUri(req);
      // Exchange code for token
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirect,
        }),
      });
      const tokenData = await tokenRes.json() as any;
      if (!tokenData.access_token) {
        console.error('[AUTH] Token exchange failed:', tokenData);
        return res.redirect('/?error=token_failed');
      }

      // Get user info
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userRes.json() as any;
      if (!userData.id) return res.redirect('/?error=user_failed');

      // Check roles via bot
      const userRoles = await bot.getUserRoles(userData.id);
      console.log(`[AUTH] User ${userData.username} (${userData.id}) roles:`, JSON.stringify(userRoles));
      console.log(`[AUTH] ALLOWED_ROLES:`, ALLOWED_ROLES);
      const hasAccess = userRoles.some(r => ALLOWED_ROLES.some(a => r.includes(a)));
      console.log(`[AUTH] hasAccess=${hasAccess}`);

      if (!hasAccess) {
        const rolesDebug = encodeURIComponent(userRoles.join(', ') || 'NONE');
        return res.redirect(`/?error=no_access&roles=${rolesDebug}`);
      }

      // Save session
      req.session.user = {
        id: userData.id,
        username: userData.username,
        avatar: userData.avatar,
        roles: userRoles,
      };

      res.redirect('/');
    } catch (e: any) {
      console.error('[AUTH] OAuth callback error:', e);
      res.redirect('/?error=auth_failed');
    }
  });

  // Auth: get current user
  app.get('/api/auth/me', (req, res) => {
    if (req.session.user) {
      res.json(req.session.user);
    } else {
      res.status(401).json({ error: 'Not authenticated' });
    }
  });

  // Auth: logout
  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  // Auth middleware — protect all /api routes except auth & health
  app.use('/api', (req, res, next) => {
    const openPaths = ['/api/auth/', '/api/health'];
    if (openPaths.some(p => req.path.startsWith(p.replace('/api', '')))) return next();
    if (req.path === '/health' || req.path === '/health/env') return next();
    if (req.path.startsWith('/auth/')) return next();
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
  });

  // Start the bot
  console.log('[ROUTES] Calling bot.start()...');
  console.log('[ROUTES] GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET' : 'MISSING');
  bot.start().catch((err) => {
    console.error('[ROUTES] bot.start() rejected:', err);
  });

  app.get(api.bot.status.path, (req, res) => {
    const status = bot.getStatus();
    res.json({
      status: status.status as 'online' | 'offline' | 'connecting',
      uptime: status.uptime,
      lastPing: status.lastPing
    });
  });

  app.get(api.bot.logs.path, async (req, res) => {
    const logs = await storage.getLogs();
    res.json(logs);
  });

  app.get(api.farms.list.path, async (req, res) => {
    const farmList = await storage.getFarms();
    res.json(farmList);
  });

  app.get(api.fields.list.path, async (req, res) => {
    const fieldList = await storage.getFields();
    res.json(fieldList);
  });

  app.get(api.vehicles.list.path, async (req, res) => {
    const vehicleList = await storage.getVehicles();
    res.json(vehicleList);
  });

  app.get(api.silos.list.path, async (req, res) => {
    const siloList = await storage.getSilos();
    res.json(siloList);
  });

  app.get(api.productions.list.path, async (req, res) => {
    const productionList = await storage.getProductions();
    res.json(productionList);
  });

  app.get(api.animals.list.path, async (req, res) => {
    const animalList = await storage.getAnimals();
    res.json(animalList);
  });

  app.get(api.weather.get.path, async (req, res) => {
    const weatherData = await storage.getWeather();
    res.json(weatherData);
  });

  app.get(api.jobs.list.path, async (req, res) => {
    const jobList = await storage.getJobs();
    res.json(jobList);
  });

  app.get(api.alerts.list.path, async (req, res) => {
    const alertList = await storage.getAlerts();
    res.json(alertList);
  });

  app.get('/api/players', async (req, res) => {
    const playerList = await storage.getPlayers();
    res.json(playerList);
  });

  app.post('/api/players/reset-hours', async (_req, res) => {
    try {
      await storage.resetAllPlayTimes();
      res.json({ success: true, message: 'Svi sati igrača resetirani.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch('/api/players/:uid/farm', async (req, res) => {
    try {
      const { uid } = req.params;
      const { farmId } = req.body;
      if (!uid) return res.status(400).json({ error: 'Nedostaje uniqueUserId.' });
      await storage.setPlayerFarm(uid, farmId || null);
      res.json({ success: true, uniqueUserId: uid, farmId: farmId || null });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/player-links', async (_req, res) => {
    const links = await storage.getPlayerLinks();
    res.json(links);
  });

  app.post('/api/player-links', async (req, res) => {
    try {
      const { discordUserId, uniqueUserId, playerName, defaultFarmId } = req.body;
      if (!discordUserId || !uniqueUserId) {
        return res.status(400).json({ error: 'discordUserId i uniqueUserId su obavezni.' });
      }
      // Auto-fill defaultFarmId from players collection if not provided
      let farmId = defaultFarmId || null;
      if (!farmId) {
        const players = await storage.getPlayers();
        const matchingPlayer = players.find(p => p.uniqueUserId === uniqueUserId);
        if (matchingPlayer?.farmId) {
          farmId = matchingPlayer.farmId;
        }
      }
      // Fallback: match playerName to farm name
      if (!farmId && playerName) {
        const allFarms = await storage.getFarms();
        const matchedFarm = allFarms.find(f => f.name && f.name.trim().toLowerCase() === playerName.trim().toLowerCase());
        if (matchedFarm?.farmId) {
          farmId = matchedFarm.farmId;
        }
      }
      const link = await storage.upsertPlayerLink({ discordUserId, uniqueUserId, playerName: playerName || null, defaultFarmId: farmId });
      
      // Check if this game ID was previously removed — warn if returning
      let warning: string | null = null;
      try {
        const previousRemovals = await storage.findRemovedByGameId(uniqueUserId);
        if (previousRemovals.length > 0) {
          const last = previousRemovals[0];
          warning = `⚠️ Ovaj Game ID (${uniqueUserId}) je prethodno bio povezan s ${last.discordName || last.discordUserId} i uklonjen ${last.removedAt ? new Date(last.removedAt).toLocaleDateString('hr') : 'nepoznato'}. Razlog: ${last.reason || 'N/A'}`;
          await storage.log({
            type: 'warning',
            message: `⚠️ Povratak Game ID: ${uniqueUserId} — prethodno povezan s ${last.discordName || last.discordUserId}, sada povezan s ${discordUserId}`,
          });
        }
      } catch (e) { /* ignore check errors */ }
      
      res.json({ ...link, warning });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/player-links/:discordUserId', async (req, res) => {
    try {
      await storage.deletePlayerLinkByDiscord(req.params.discordUserId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Removed players (archived when Ratar role removed)
  app.get('/api/removed-players', async (_req, res) => {
    try {
      const removed = await storage.getRemovedPlayers();
      res.json(removed);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/removed-players/check/:uniqueUserId', async (req, res) => {
    try {
      const matches = await storage.findRemovedByGameId(req.params.uniqueUserId);
      res.json({ found: matches.length > 0, matches });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Get all Discord members with Ratar role
  app.get('/api/discord/ratar-members', async (_req, res) => {
    try {
      const members = await bot.getRatarMembers();
      res.json(members);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Resolve Discord user IDs to display names
  app.post('/api/discord/resolve-users', async (req, res) => {
    try {
      const { userIds } = req.body;
      if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds array required' });
      const names = await bot.resolveDiscordUsers(userIds.slice(0, 50));
      res.json(names);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post(api.sync.trigger.path, async (req, res) => {
    try {
      await syncService.sync();
      res.json({ success: true, message: 'Sync completed successfully' });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Diagnostics endpoint (safe, read-only)
  app.get('/api/sync/status', async (_req, res) => {
    res.json({ success: true, status: getSyncStatus() });
  });

  // GitHub Integration Routes
  app.get("/api/github/user", async (req, res) => {
    try {
      const user = await getGitHubUser();
      res.json(user);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/github/repos", async (req, res) => {
    try {
      const repos = await listRepositories();
      res.json(repos);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/github/push", async (req, res) => {
    try {
      const { owner, repo, files, message, branch } = req.body;
      
      if (!owner || !repo || !files || !message) {
        return res.status(400).json({ error: "Missing required fields: owner, repo, files, message" });
      }
      
      const result = await pushMultipleFiles(owner, repo, files, message, branch || "main");
      res.json({ success: true, commit: result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/github/push-all", async (req, res) => {
    try {
      const { owner, repo, message, branch, cleanPush } = req.body;
      
      if (!owner || !repo) {
        return res.status(400).json({ error: "Missing required fields: owner, repo" });
      }

      const projectDirs = ['server', 'shared', 'client/src', 'script'];
      const rootFiles = ['package.json', 'tsconfig.json', 'vite.config.ts', 'tailwind.config.ts', 'drizzle.config.ts', 'replit.md', 'postcss.config.js', 'client/index.html', 'railway.json', 'nixpacks.toml', 'components.json'];
      
      const files: Array<{ path: string; content: string }> = [];
      
      const readDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            readDir(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.css') || entry.name.endsWith('.json') || entry.name.endsWith('.md') || entry.name.endsWith('.js') || entry.name.endsWith('.toml') || entry.name.endsWith('.html'))) {
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              files.push({ path: fullPath, content });
            } catch (e) {
              console.error('Failed to read:', fullPath);
            }
          }
        }
      };

      for (const dir of projectDirs) {
        readDir(dir);
      }

      for (const file of rootFiles) {
        if (fs.existsSync(file)) {
          try {
            const content = fs.readFileSync(file, 'utf-8');
            files.push({ path: file, content });
          } catch (e) {
            console.error('Failed to read:', file);
          }
        }
      }

      console.log(`Pushing ${files.length} files to GitHub (cleanPush: ${!!cleanPush})...`);
      const result = await pushMultipleFiles(owner, repo, files, message || "Update from Replit", branch || "main", cleanPush || false);
      res.json({ success: true, filesCount: files.length, commit: result });
    } catch (error: any) {
      console.error('GitHub push error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/github/release", async (req, res) => {
    try {
      const { owner, repo, tagName, name, body, draft, prerelease } = req.body;
      
      if (!owner || !repo || !tagName || !name) {
        return res.status(400).json({ error: "Missing required fields: owner, repo, tagName, name" });
      }
      
      const release = await createRelease(owner, repo, tagName, name, body || "", draft || false, prerelease || false);
      res.json({ success: true, release });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // List and cleanup GitHub repo contents
  app.get("/api/github/contents/:owner/:repo", async (req, res) => {
    try {
      const { owner, repo } = req.params;
      const contents = await listRepoContents(owner, repo);
      res.json(contents);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/github/cleanup-python", async (req, res) => {
    try {
      const { owner, repo } = req.body;
      
      if (!owner || !repo) {
        return res.status(400).json({ error: "Missing required fields: owner, repo" });
      }
      
      const contents = await listRepoContents(owner, repo);
      const pythonFiles = ['requirements.txt', 'main.py', 'Procfile', 'runtime.txt', 'app.py', 'wsgi.py'];
      const pythonDirs = ['__pycache__', '.venv', 'venv'];
      
      const toDelete: string[] = [];
      for (const item of contents) {
        if (pythonFiles.includes(item.name) || item.name.endsWith('.py')) {
          toDelete.push(item.name);
        }
      }
      
      const deleted: string[] = [];
      for (const fileName of toDelete) {
        try {
          await deleteFile(owner, repo, fileName, `Remove Python file: ${fileName}`);
          deleted.push(fileName);
        } catch (e: any) {
          console.error(`Failed to delete ${fileName}:`, e.message);
        }
      }
      
      res.json({ success: true, deleted, found: toDelete });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Discord Admin Panel Routes
  app.get("/api/discord/channels", async (req, res) => {
    try {
      const channels = await bot.getChannels();
      res.json(channels);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/discord/send", async (req, res) => {
    try {
      const { channelId, dataType } = req.body;
      
      if (!channelId || !dataType) {
        return res.status(400).json({ error: "Missing required fields: channelId, dataType" });
      }

      const validDataTypes = ['status', 'farms', 'fields', 'vehicles', 'silos', 'productions', 'animals', 'weather', 'players', 'player_hours'];
      if (!validDataTypes.includes(dataType)) {
        return res.status(400).json({ error: `Invalid dataType. Must be one of: ${validDataTypes.join(', ')}` });
      }
      
      const result = await bot.sendToChannel(channelId, dataType);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/web/send', async (req, res) => {
    try {
      const { dataType } = req.body;
      const webPushUrl = process.env.WEB_PUSH_URL;
      const webPushToken = process.env.WEB_PUSH_TOKEN;
      const webPushEnabled = ['1', 'true', 'on', 'yes'].includes(String(process.env.WEB_PUSH_ENABLED || 'false').toLowerCase());

      if (!webPushEnabled) {
        return res.status(200).json({ success: false, skipped: true, message: 'WEB push je isključen (WEB_PUSH_ENABLED=false).' });
      }

      if (!webPushUrl) {
        return res.status(400).json({ error: 'WEB_PUSH_URL nije postavljen.' });
      }

      const validDataTypes = ['status', 'farms', 'fields', 'vehicles', 'silos', 'productions', 'animals', 'weather', 'players', 'player_hours'];
      if (!dataType || !validDataTypes.includes(dataType)) {
        return res.status(400).json({ error: `Invalid dataType. Must be one of: ${validDataTypes.join(', ')}` });
      }

      let payload: any = null;
      if (dataType === 'status') payload = bot.getStatus();
      if (dataType === 'farms') payload = await storage.getFarms();
      if (dataType === 'fields') payload = await storage.getFields();
      if (dataType === 'vehicles') payload = await storage.getVehicles();
      if (dataType === 'silos') payload = await storage.getSilos();
      if (dataType === 'productions') payload = await storage.getProductions();
      if (dataType === 'animals') payload = await storage.getAnimals();
      if (dataType === 'weather') payload = await storage.getWeather();
      if (dataType === 'players') payload = await storage.getPlayers();
      if (dataType === 'player_hours') payload = await storage.getPlayers();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (webPushToken) {
        headers['Authorization'] = `Bearer ${webPushToken}`;
      }

      const ctrl = new AbortController();
      const timeoutMs = Math.max(1000, Number(process.env.WEB_PUSH_TIMEOUT_MS || '4000') || 4000);
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(webPushUrl, {
          method: 'POST',
          headers,
          signal: ctrl.signal,
          body: JSON.stringify({
            source: 'slavonska-ravnica',
            dataType,
            sentAt: new Date().toISOString(),
            payload,
          })
        });
      } finally {
        clearTimeout(timer);
      }

      if (!upstreamRes.ok) {
        const txt = await upstreamRes.text().catch(() => '');
        return res.status(200).json({
          success: false,
          skipped: true,
          error: `Web push failed: HTTP ${upstreamRes.status}`,
          details: txt || null
        });
      }

      res.json({ success: true, message: `Podaci ${dataType} poslani na WEB_PUSH_URL.` });
    } catch (error: any) {
      const isAbort = String(error?.name || '').toLowerCase().includes('abort');
      res.status(200).json({
        success: false,
        skipped: true,
        error: isAbort ? 'Web push timeout (preskočeno).' : (error?.message || 'Web push error')
      });
    }
  });

  app.get('/api/web/push-status', (_req, res) => {
    const webPushUrl = process.env.WEB_PUSH_URL || '';
    const webPushToken = process.env.WEB_PUSH_TOKEN || '';
    const webPushEnabled = ['1', 'true', 'on', 'yes'].includes(String(process.env.WEB_PUSH_ENABLED || 'false').toLowerCase());

    res.json({
      enabled: webPushEnabled && !!webPushUrl,
      configured: !!webPushUrl,
      tokenSet: !!webPushToken,
      timeoutMs: Math.max(1000, Number(process.env.WEB_PUSH_TIMEOUT_MS || '4000') || 4000)
    });
  });

  // Mod download routes - explicit paths to avoid routing issues
  app.get('/api/mods', (req, res) => {
    res.json({
      mods: [
        { name: 'FS25_SR_Companion', url: '/api/mods/download/FS25_SR_Companion.zip' },
        { name: 'FS25_SR_FarmBuddy_Manager', url: '/api/mods/download/FS25_SR_FarmBuddy_Manager.zip' }
      ]
    });
  });

  app.get('/api/mods/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.resolve(process.cwd(), 'public', filename);
    
    if (fs.existsSync(filePath) && filename.endsWith('.zip')) {
      res.download(filePath, filename);
    } else {
      res.status(404).json({ error: 'Mod not found', path: filePath, exists: fs.existsSync(filePath) });
    }
  });

  // Push mods to GitHub repo (in mods/ folder)
  app.post('/api/github/push-mods', async (req, res) => {
    try {
      const { owner, repo, message, branch } = req.body;
      
      if (!owner || !repo) {
        return res.status(400).json({ error: "Missing required fields: owner, repo" });
      }

      const modFiles = [
        'FS25_SR_Companion.zip',
        'FS25_SR_FarmBuddy_Manager.zip'
      ];

      const files = [];
      
      for (const modFile of modFiles) {
        const filePath = path.resolve(process.cwd(), 'public', modFile);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          files.push({
            path: `mods/${modFile}`,
            content: content.toString('base64')
          });
        }
      }

      if (files.length === 0) {
        return res.status(404).json({ error: "No mod files found to push" });
      }

      // Push using base64 encoded binary files
      const { getGitHubClient } = await import('./github');
      const octokit = await getGitHubClient();
      
      // Get current commit SHA
      const { data: refData } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch || 'main'}`
      });
      const currentCommitSha = refData.object.sha;

      // Get current tree
      const { data: commitData } = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: currentCommitSha
      });
      const baseTreeSha = commitData.tree.sha;

      // Create blobs for each file (binary)
      const blobs = await Promise.all(
        files.map(async (file) => {
          const { data: blobData } = await octokit.git.createBlob({
            owner,
            repo,
            content: file.content,
            encoding: 'base64'
          });
          return {
            path: file.path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: blobData.sha
          };
        })
      );

      // Create new tree
      const { data: newTree } = await octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: blobs
      });

      // Create commit
      const { data: newCommit } = await octokit.git.createCommit({
        owner,
        repo,
        message: message || 'Update SR mods',
        tree: newTree.sha,
        parents: [currentCommitSha]
      });

      // Update branch ref
      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch || 'main'}`,
        sha: newCommit.sha
      });

      res.json({ 
        success: true, 
        commit: newCommit,
        files: files.map(f => f.path)
      });
    } catch (error: any) {
      console.error('Push mods error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Create GitHub Release with mod files as downloadable assets
  app.post('/api/github/release-mods', async (req, res) => {
    try {
      const { owner, repo, version } = req.body;
      
      if (!owner || !repo) {
        return res.status(400).json({ error: "Missing required fields: owner, repo" });
      }

      const tagName = version || `v${new Date().toISOString().split('T')[0].replace(/-/g, '.')}`;

      const modFileNames = [
        'FS25_SR_Companion.zip',
        'FS25_SR_FarmBuddy_Manager.zip'
      ];

      const modFiles = [];
      
      for (const modFile of modFileNames) {
        const filePath = path.resolve(process.cwd(), 'public', modFile);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          modFiles.push({
            name: modFile,
            content: content
          });
        }
      }

      if (modFiles.length === 0) {
        return res.status(404).json({ error: "No mod files found" });
      }

      const result = await createModRelease(owner, repo, tagName, modFiles);

      res.json({ 
        success: true, 
        release: {
          id: result.release.id,
          tag: result.release.tag_name,
          url: result.release.html_url
        },
        assets: result.assets.map(a => ({
          name: a.name,
          downloadUrl: a.browser_download_url,
          size: a.size
        }))
      });
    } catch (error: any) {
      console.error('Release mods error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Farm-player mapping + mod settings from companion mod
  app.get('/api/game/farm-players', async (_req, res) => {
    try {
      const data = syncService.lastFarmPlayers;
      res.json(data || { farms: [], modSettings: {} });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Player tracking data (tracks + map info)
  app.get('/api/game/tracks', async (_req, res) => {
    try {
      const data = bot.getPlayerTracksData();
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // SVG map with tracks for embedding in Discord
  app.get('/api/game/tracks/map.svg', async (req, res) => {
    try {
      const data = bot.getPlayerTracksData();
      const playerId = typeof req.query.player === 'string' ? req.query.player : '';
      const width = 900;
      const height = 900;
      const pad = 36;
      const minX = data.worldMinX;
      const maxX = data.worldMaxX;
      const minZ = data.worldMinZ;
      const maxZ = data.worldMaxZ;
      const mapUrl = data.mapImageUrl;
      const bgImage = mapUrl
        ? `<image href="${mapUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" opacity="0.95"/>`
        : `<rect x="0" y="0" width="${width}" height="${height}" fill="#1f2937"/>`;

      const colors = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#ec4899'];
      const tracksToRender = playerId
        ? data.tracks.filter(t => String(t.id || '').toLowerCase() === playerId.toLowerCase() || String(t.nickname || '').toLowerCase() === playerId.toLowerCase())
        : data.tracks;

      let tracksSvg = '';
      tracksToRender.forEach((track, idx) => {
        const pts = track.points || [];
        if (pts.length < 2) return;
        const color = colors[idx % colors.length];
        const poly = pts.map(p => {
          const px = pad + ((p.x - minX) / Math.max(1, maxX - minX)) * (width - pad * 2);
          const py = pad + ((p.z - minZ) / Math.max(1, maxZ - minZ)) * (height - pad * 2);
          return `${px.toFixed(1)},${py.toFixed(1)}`;
        }).join(' ');
        const last = pts[pts.length - 1];
        const lx = pad + ((last.x - minX) / Math.max(1, maxX - minX)) * (width - pad * 2);
        const ly = pad + ((last.z - minZ) / Math.max(1, maxZ - minZ)) * (height - pad * 2);
        tracksSvg += `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity="0.7"/>`;
        tracksSvg += `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="6" fill="${color}" stroke="#000" stroke-width="1"/>`;
        tracksSvg += `<text x="${(lx + 10).toFixed(1)}" y="${(ly + 4).toFixed(1)}" fill="${color}" font-size="12" font-weight="bold">${(track.nickname || track.id || '').replace(/[<>&"]/g, '')}</text>`;
      });

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bgImage}${tracksSvg}</svg>`;
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.send(svg);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Server list & switch
  app.get('/api/servers', (_req, res) => {
    res.json({ servers: getServers(), activeId: getActiveServerId() });
  });

  app.post('/api/servers/active', (req, res) => {
    const { id } = req.body;
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing server id.' });
    const ok = setActiveServer(id);
    if (!ok) return res.status(404).json({ error: 'Server not found.' });
    res.json({ activeId: id });
  });

  // Game Commands - send XML commands to FS25 via Companion mod inbox
  app.post('/api/game/command', async (req, res) => {
    try {
      const { command, params } = req.body;
      if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'Nedostaje command polje.' });
      }

      const allowedCommands = [
        'sendChat', 'saveGame', 'banUser', 'unBanUser', 'makeFarmManager', 'removeFarmManager', 'moneyTransfer',
        'kickUser', 'setSetting', 'sendPrivateMsg', 'transferVehicle', 'repairVehicle', 'setTimeScale',
        'setTargetTime',
        'createFarm', 'deleteFarm', 'purchaseFarmland', 'sellFarmland',
        'coopSiloStore', 'coopPalletStore', 'coopBaleStore',
        'setFieldState',
      ];
      if (!allowedCommands.includes(command)) {
        return res.status(400).json({ error: `Nepoznata komanda: ${command}. Dozvoljene: ${allowedCommands.join(', ')}` });
      }

      const id = Date.now().toString();
      const safeParams = params || {};

      // Build attribute string from params - escape XML special chars
      const escXml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      let attrs = `id="${escXml(id)}" command="${escXml(command)}"`;
      for (const [key, val] of Object.entries(safeParams)) {
        if (val !== undefined && val !== null && val !== '') {
          attrs += ` ${escXml(key)}="${escXml(String(val))}"`;
        }
      }

      const xml = `<?xml version="1.0" encoding="utf-8"?>\n<commands>\n  <command ${attrs} />\n</commands>`;
      const filename = `web-${command}-${id}.xml`;

      await uploadInboxXml(filename, xml);
      console.log(`[GAME CMD] Sent ${command} (${filename})`);
      res.json({ success: true, command, id: id, filename });
    } catch (error: any) {
      console.error('[GAME CMD] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Debug: list inbox/outbox files on FTP
  app.get('/api/game/inbox-debug', async (req, res) => {
    try {
      const result = await listInboxFiles();
      // Try to find CompanionSettings.xml
      const paths = [
        '/profile/modSettings/FS25_FSG_Companion/CompanionSettings.xml',
        '/profile/modSettings/FS25_SlavonskaRavnica_Companion/CompanionSettings.xml',
        '/profile/modSettings/CompanionSettings.xml',
      ];
      let settingsXml: string | null = null;
      let settingsFrom = '';
      for (const p of paths) {
        const xml = await readFtpFile(p);
        if (xml) { settingsXml = xml; settingsFrom = p; break; }
      }
      // Also list modSettings root to see folder structure
      const modSettingsFiles = await readFtpFile('/profile/modSettings/').catch(() => null);
      const { listFtpDir } = await import('./ftpCommands');
      const modSettingsDirs = await listFtpDir('/profile/modSettings/');
      res.json({ ...result, companionSettings: settingsXml || '[not found]', settingsFrom, modSettingsDirs });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy map image to avoid mixed-content (HTTPS dashboard → HTTP game server)
  app.get('/api/game/map-image', async (_req, res) => {
    try {
      let url = process.env.WEBSTATS_MAP_IMAGE_URL || process.env.SERVER_MAP_IMAGE_URL
        || getActiveServer()?.mapImageUrl;
      if (!url) return res.status(404).json({ error: 'No map image URL configured' });
      // Boost quality and size for better map rendering
      try {
        const u = new URL(url);
        u.searchParams.set('quality', '95');
        u.searchParams.set('size', '2048');
        url = u.toString();
      } catch {}
      const resp = await fetch(url);
      if (!resp.ok) return res.status(502).json({ error: `Upstream ${resp.status}` });
      const ct = resp.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=300');
      const buffer = Buffer.from(await resp.arrayBuffer());
      res.send(buffer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ====== Server Console / Control ======

  // Read server log via FTP
  app.get('/api/server/log', async (req, res) => {
    try {
      const tail = Math.min(Number(req.query.tail) || 200, 1000);
      const logPaths = ['/profile/log.txt', '/log.txt', '/FarmingSimulator2025/log.txt'];
      let content: string | null = null;
      for (const p of logPaths) {
        content = await readFtpFile(p);
        if (content) break;
      }
      if (!content) return res.json({ lines: [], error: 'Log file not found on server.' });
      const lines = content.split('\n');
      const tailedLines = lines.slice(-tail);
      res.json({ lines: tailedLines, total: lines.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GPortal API proxy - server status
  app.get('/api/server/gportal-status', async (_req, res) => {
    try {
      const srv = getActiveServer();
      const token = process.env.GPORTAL_TOKEN;
      const serverId = srv?.gportalServerId;
      if (!token || !serverId) return res.json({ available: false });
      const resp = await fetch(`https://www.g-portal.com/ngpapi/gameserver/${encodeURIComponent(serverId)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!resp.ok) return res.status(resp.status).json({ error: `GPortal API: ${resp.statusText}` });
      const data = await resp.json();
      res.json({ available: true, ...data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GPortal API - restart / stop / start
  app.post('/api/server/gportal/:action', async (req, res) => {
    try {
      const { action } = req.params;
      if (!['restart', 'stop', 'start'].includes(action)) {
        return res.status(400).json({ error: `Nepoznata akcija: ${action}. Dozvoljeno: restart, stop, start` });
      }
      const srv = getActiveServer();
      const token = process.env.GPORTAL_TOKEN;
      const serverId = srv?.gportalServerId;
      if (!token || !serverId) return res.status(400).json({ error: 'GPortal API nije konfiguriran (GPORTAL_TOKEN + gportalServerId).' });
      const resp = await fetch(`https://www.g-portal.com/ngpapi/gameserver/${encodeURIComponent(serverId)}/${encodeURIComponent(action)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        return res.status(resp.status).json({ error: `GPortal API: ${resp.statusText}`, details: errBody });
      }
      const data = await resp.json();
      console.log(`[GPORTAL] ${action} sent for server ${serverId}`);
      res.json({ success: true, action, ...data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ====== Bot Guild Management ======
  app.get('/api/bot/guilds', (req, res) => {
    res.json(bot.getGuilds());
  });

  app.get('/api/bot/guilds/:guildId', (req, res) => {
    const detail = bot.getGuildDetail(req.params.guildId);
    if (!detail) return res.status(404).json({ error: 'Guild not found' });
    res.json(detail);
  });

  // ── Guild channel settings (for dashboard) ──
  app.get('/api/bot/channel-keys', (_req, res) => {
    res.json(bot.getChannelKeys());
  });

  app.get('/api/bot/guilds/:guildId/settings', async (req, res) => {
    try {
      const data = await bot.getGuildSettings(req.params.guildId);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/bot/guilds/:guildId/settings/:key', async (req, res) => {
    try {
      const { channelId } = req.body || {};
      const ok = await bot.setGuildChannelSetting(req.params.guildId, req.params.key, channelId || null);
      if (!ok) return res.status(400).json({ error: 'Invalid key' });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/bot/info', (req, res) => {
    const status = bot.getStatus();
    const guilds = bot.getGuilds();
    res.json({
      ...status,
      username: (bot as any).client?.user?.tag || null,
      avatar: (bot as any).client?.user?.displayAvatarURL?.({ size: 128 }) || null,
      guildCount: guilds.length,
      totalMembers: guilds.reduce((sum: number, g: any) => sum + g.memberCount, 0),
    });
  });

  // ── Channel Manager API ──
  app.get('/api/channels/config', async (req, res) => {
    try {
      const guildId = req.query.guildId as string;
      if (guildId) {
        // Per-guild config from MongoDB
        let config = await storage.getGuildChannelConfig(guildId);
        if (!config) {
          // Auto-populate from actual Discord channels
          config = bot.buildConfigFromGuild(guildId);
          if (config && config.categories.length > 0) {
            await storage.saveGuildChannelConfig(guildId, config);
          }
        }
        if (config) return res.json(config);
      }
      // Fallback to file-based config
      const config = await bot.getChannelConfig();
      res.json(config);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/channels/config', async (req, res) => {
    try {
      const { categories, farmChannels, guildId } = req.body;
      if (!Array.isArray(categories)) return res.status(400).json({ error: 'categories must be an array' });
      if (guildId) {
        await storage.saveGuildChannelConfig(guildId, { categories, farmChannels: farmChannels || [] });
      } else {
        await bot.saveChannelConfig({ categories, farmChannels: farmChannels || [] });
      }
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Factory reset — restore default template
  app.post('/api/channels/config/reset', async (req, res) => {
    try {
      const guildId = req.body?.guildId as string;
      const defaultConfig = bot.getDefaultChannelConfig();
      if (guildId) {
        // For per-guild reset, rebuild from actual Discord channels
        const liveConfig = bot.buildConfigFromGuild(guildId);
        const configToSave = liveConfig && liveConfig.categories.length > 0 ? liveConfig : defaultConfig;
        await storage.saveGuildChannelConfig(guildId, configToSave);
        res.json({ success: true, config: configToSave });
      } else {
        await bot.saveChannelConfig(defaultConfig);
        res.json({ success: true, config: defaultConfig });
      }
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Auto-assign guild channel keys based on existing Discord channels
  app.post('/api/bot/guilds/:guildId/auto-assign', async (req, res) => {
    try {
      const result = await bot.autoAssignGuildChannels(req.params.guildId);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/channels/guild/:guildId', (req, res) => {
    try {
      const channels = bot.getGuildChannelList(req.params.guildId);
      res.json(channels);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/channels/deploy', async (req, res) => {
    try {
      const { guildId, categoryIndex } = req.body;
      if (!guildId) return res.status(400).json({ error: 'guildId required' });
      if (categoryIndex === undefined || categoryIndex === null) return res.status(400).json({ error: 'categoryIndex required' });
      const result = await bot.deployCategory(guildId, categoryIndex);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/channels/deploy-single', async (req, res) => {
    try {
      const { guildId, categoryName, channel } = req.body;
      if (!guildId || !categoryName || !channel) return res.status(400).json({ error: 'guildId, categoryName, channel required' });
      const result = await bot.deployChannel(guildId, categoryName, channel);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/channels/deploy-category', async (req, res) => {
    try {
      const { guildId, categoryName } = req.body;
      if (!guildId || !categoryName) return res.status(400).json({ error: 'guildId, categoryName required' });
      const result = await bot.createDiscordCategory(guildId, categoryName);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/channels/post-embed', async (req, res) => {
    try {
      const { guildId, channelId, autoEmbed } = req.body;
      if (!guildId || !channelId || !autoEmbed) return res.status(400).json({ error: 'guildId, channelId, autoEmbed required' });
      const result = await bot.postAutoEmbed(guildId, channelId, autoEmbed);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/channels/font-styles', (_req, res) => {
    res.json((bot.constructor as any).getFontStyles());
  });

  app.post('/api/channels/transform-text', (req, res) => {
    const { text, style } = req.body;
    if (!text || !style) return res.status(400).json({ error: 'text and style required' });
    let result = text;
    if (style === 'smallCaps') result = (bot.constructor as any).toSmallCaps(text);
    else if (style === 'bold') {
      // Use the static method via bot class reference
      result = text.split('').map((c: string) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));
        if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
        return c;
      }).join('');
    } else if (style === 'boldItalic') {
      result = text.split('').map((c: string) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D63C + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D656 + (code - 97));
        return c;
      }).join('');
    }
    res.json({ original: text, style, result });
  });

  // Edit existing Discord channel
  app.patch('/api/channels/guild/:guildId/:channelId', async (req, res) => {
    try {
      const { guildId, channelId } = req.params;
      const { name, topic, parentId, permFlags } = req.body;
      const result = await bot.editExistingChannel(guildId, channelId, { name, topic, parentId, permFlags });
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Delete existing Discord channel
  app.delete('/api/channels/guild/:guildId/:channelId', async (req, res) => {
    try {
      const { guildId, channelId } = req.params;
      const result = await bot.deleteExistingChannel(guildId, channelId);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Create a new Discord channel
  app.post('/api/channels/guild/:guildId/create', async (req, res) => {
    try {
      const { guildId } = req.params;
      const { name, type, parentId, permFlags } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const result = await bot.createNewChannel(guildId, { name, type: type || 0, parentId: parentId || null, permFlags });
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // List messages with embeds in a channel
  app.get('/api/channels/guild/:guildId/:channelId/messages', async (req, res) => {
    try {
      const { guildId, channelId } = req.params;
      const result = await bot.listChannelEmbeds(guildId, channelId);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Edit a message (embeds + components)
  app.patch('/api/channels/guild/:guildId/:channelId/messages/:messageId', async (req, res) => {
    try {
      const { guildId, channelId, messageId } = req.params;
      const { embeds, components } = req.body;
      const result = await bot.editChannelMessage(guildId, channelId, messageId, { embeds, components });
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Move existing Discord channel position
  app.post('/api/channels/guild/:guildId/:channelId/move', async (req, res) => {
    try {
      const { guildId, channelId } = req.params;
      const { position } = req.body;
      const result = await bot.moveExistingChannel(guildId, channelId, position);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── MongoDB Admin API ──
  app.get("/api/db/stats", async (_req, res) => {
    try {
      const stats = await mongoAdmin.getDatabaseStats();
      res.json(stats);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/db/collections", async (_req, res) => {
    try {
      const collections = await mongoAdmin.listCollections();
      res.json(collections);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/db/collections/:name", async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const data = await mongoAdmin.getCollectionDocuments(req.params.name, page, limit);
      res.json(data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/db/collections/:name/export", async (req, res) => {
    try {
      const docs = await mongoAdmin.exportCollection(req.params.name);
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}.json"`);
      res.setHeader("Content-Type", "application/json");
      res.json(docs);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/db/collections/:name/:id", async (req, res) => {
    try {
      const ok = await mongoAdmin.deleteDocument(req.params.name, req.params.id);
      res.json({ success: ok });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Backup/Restore API ──
  app.get('/api/backups/:guildId', async (req, res) => {
    try {
      const backups = await storage.listBackups(req.params.guildId);
      res.json(backups);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // List backups from ALL guilds (for cross-server force restore)
  app.get('/api/backups-all', async (_req, res) => {
    try {
      const guildIds = [...bot.getClient().guilds.cache.keys()];
      const all: any[] = [];
      for (const gid of guildIds) {
        const backups = await storage.listBackups(gid);
        const guildName = bot.getClient().guilds.cache.get(gid)?.name || gid;
        all.push(...backups.map(b => ({ ...b, guildName })));
      }
      all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(all);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/backups/:guildId', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'Name required' });
      const result = await bot.createBackupFromDashboard(req.params.guildId, name);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/backups/:guildId/restore/:backupId', async (req, res) => {
    try {
      const { mode, channelNames, targetGuildId, targetChannelId } = req.body;
      const result = await bot.restoreBackupFromDashboard(
        req.params.guildId,
        req.params.backupId,
        mode || 'messages',
        channelNames || null,
        targetGuildId || null,
        targetChannelId || null,
      );
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Get channels list from a specific backup (without loading full message data)
  app.get('/api/backups/:backupId/channels', async (req, res) => {
    try {
      const channels = await storage.getBackupChannels(req.params.backupId);
      if (!channels) return res.status(404).json({ error: 'Backup not found' });
      res.json(channels);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Get text channels for a specific guild (for restore target picker)
  app.get('/api/bot/guilds/:guildId/channels', (_req, res) => {
    const channels = bot.getGuildChannels(_req.params.guildId);
    res.json(channels);
  });

  app.delete('/api/backups/:id', async (req, res) => {
    try {
      const ok = await storage.deleteBackup(req.params.id);
      res.json({ success: ok });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Force restore — poll progress (must be before :backupId route)
  app.get('/api/backups/:guildId/forcerestore/progress', async (req, res) => {
    try {
      const progress = bot.getForceRestoreProgress(req.params.guildId);
      if (!progress) return res.json({ active: false });
      res.json({ active: true, ...progress });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Force restore — cancel (must be before :backupId route)
  app.post('/api/backups/:guildId/forcerestore/cancel', async (req, res) => {
    try {
      bot.cancelForceRestore(req.params.guildId);
      res.json({ cancelled: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Force restore — clear progress data (must be before :backupId route)
  app.post('/api/backups/:guildId/forcerestore/clear', async (req, res) => {
    try {
      bot.clearForceRestoreProgress(req.params.guildId);
      res.json({ cleared: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Force restore — start async restore from backup
  app.post('/api/backups/:guildId/forcerestore/:backupId', async (req, res) => {
    try {
      await bot.forceRestoreFromDashboard(req.params.guildId, req.params.backupId);
      res.json({ started: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Feature Requests API ──
  app.get('/api/requests', async (_req, res) => {
    try {
      const requests = await storage.getFeatureRequests();
      res.json(requests);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/requests', async (req, res) => {
    try {
      const { title, description, priority, author } = req.body;
      if (!title || !description) return res.status(400).json({ error: 'Title and description required' });
      const created = await storage.createFeatureRequest({ title, description, priority: priority || 'medium', author: author || 'Nepoznato' });
      // Notify Discord
      try { await bot.notifyFeatureRequest(created); } catch {}
      res.json(created);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/requests/:id', async (req, res) => {
    try {
      const { status, adminNote } = req.body;
      const ok = await storage.updateFeatureRequest(req.params.id, { status, adminNote });
      res.json({ success: ok });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/requests/:id', async (req, res) => {
    try {
      const ok = await storage.deleteFeatureRequest(req.params.id);
      res.json({ success: ok });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── AI Dashboard Chat API ──
  const dashboardAiSessions = new Map<string, Array<{ role: string; text: string }>>();

  app.post('/api/ai-chat', async (req: any, res) => {
    try {
      const user = req.session?.user;
      if (!user) return res.status(401).json({ error: 'Nisi prijavljen' });

      const { message } = req.body;
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'Poruka je obavezna' });
      }
      const trimmed = message.trim().slice(0, 2000);

      const model = bot.getGeminiModelPublic();
      if (!model) {
        console.error('[AI-CHAT] No Gemini model — GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET (length=' + process.env.GEMINI_API_KEY.length + ')' : 'MISSING');
        // Try direct instantiation as fallback
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          return res.status(503).json({ error: 'AI nije konfiguriran — GEMINI_API_KEY nije postavljen na serveru.' });
        }
        return res.status(503).json({ error: 'AI model se ne može inicijalizirati. Provjeri GEMINI_API_KEY.' });
      }

      // Per-user conversation (max 20 entries, 30 min TTL)
      const sessionKey = `dash_${user.id}`;
      let history = dashboardAiSessions.get(sessionKey) || [];

      const systemPrompt = [
        'Ti si FarmBuddy AI asistent ugrađen u admin dashboard.',
        'Korisnik koji priča s tobom je admin servera (Gazda/Sugazda/Upravitelj).',
        'Odgovaraj na hrvatskom jeziku, kratko i korisno.',
        '',
        'Dashboard ima ove tabove:',
        '• Karta — pregled mape, polja, vozila, silosa, produkcija, životinja, vremena, igrača',
        '• Logovi — bot logovi i server logovi',
        '• Admin — admin panel, backup/restore, player management',
        '• Konzola — FS25 server konzola (komande: kick, ban, tp, save, chat...)',
        '• Server — bot server info, restart, sync',
        '• Baza — MongoDB pregled kolekcija',
        '• Kanali — Discord channel manager (kreiranje, editiranje, brisanje kanala)',
        '• Zahtjevi — feature request sustav',
        '',
        'Možeš pomoći s:',
        '• Objašnjenjem kako koristiti svaki tab',
        '• Kreiranjem Discord embed JSON-a (format: ```embed\\n{"title":"...","description":"...","color":"#hex","fields":[]}\\n```)',
        '• Savjetima za upravljanje serverom',
        '• FS25 pitanjima (usjevi, životinje, produkcija, modovi)',
        '• Općenitim pitanjima o FarmBuddy sustavu',
        '',
        'NE možeš mijenjati kod ili konfiguraciju — ako korisnik traži promjenu, reci mu da kontaktira developera.',
      ].join('\n');

      const contents = [
        { role: 'user', parts: [{ text: systemPrompt + '\n\nOdgovori na pitanje admina.' }] },
        { role: 'model', parts: [{ text: 'Razumijem. Ja sam FarmBuddy AI asistent na dashboardu. Kako ti mogu pomoći?' }] },
        ...history.map(h => ({
          role: h.role === 'user' ? 'user' as const : 'model' as const,
          parts: [{ text: h.text }],
        })),
        { role: 'user' as const, parts: [{ text: trimmed }] },
      ];

      const result = await model.generateContent({ contents });
      const aiText = result.response.text();
      if (!aiText) return res.status(500).json({ error: 'AI nije vratio odgovor' });

      // Update conversation memory
      history.push({ role: 'user', text: trimmed });
      history.push({ role: 'model', text: aiText });
      if (history.length > 20) history = history.slice(-20);
      dashboardAiSessions.set(sessionKey, history);

      // Auto-expire after 30 min
      setTimeout(() => {
        const current = dashboardAiSessions.get(sessionKey);
        if (current === history) dashboardAiSessions.delete(sessionKey);
      }, 30 * 60 * 1000);

      res.json({ reply: aiText });
    } catch (e: any) {
      console.error('[AI-CHAT]', e?.message || e);
      console.error('[AI-CHAT] Full error:', JSON.stringify({ status: e?.status, code: e?.code, details: e?.errorDetails, message: e?.message }, null, 2));
      const msg = e?.message?.includes('API_KEY') ? 'Neispravan API ključ.' :
                  e?.message?.includes('quota') || e?.message?.includes('429') || e?.status === 429 ? 'AI kvota iskorištena.' :
                  `Greška pri komunikaciji s AI-em: ${(e?.message || '').slice(0, 100)}`;
      res.status(500).json({ error: msg });
    }
  });

  app.delete('/api/ai-chat', async (req: any, res) => {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'Nisi prijavljen' });
    dashboardAiSessions.delete(`dash_${user.id}`);
    res.json({ success: true });
  });

  // ── AI Code Requests API ──
  app.get('/api/ai-requests', async (_req, res) => {
    try {
      const requests = await bot.getAiRequests();
      res.json(requests);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/ai-requests/:id', async (req, res) => {
    try {
      const { status, note } = req.body;
      const ok = await bot.updateAiRequest(req.params.id, { status, note });
      res.json({ success: ok });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/ai-requests/:id', async (req, res) => {
    try {
      const ok = await storage.deleteAiRequest(req.params.id);
      res.json({ success: ok });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Coop Market API ──
  app.get('/api/coop/market', async (_req, res) => {
    try {
      const market = await storage.getCoopMarket();
      res.json(market);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/coop/contracts', async (_req, res) => {
    try {
      const contracts = await storage.getActiveContracts();
      res.json(contracts);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/coop/deliveries', async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit)) || 20));
      const deliveries = await storage.getRecentDeliveries(limit);
      res.json(deliveries);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/coop/leaderboard', async (_req, res) => {
    try {
      const leaderboard = await storage.getCoopLeaderboard();
      res.json(leaderboard);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Coop Admin API ──

  // All contracts (active + expired + completed)
  app.get('/api/coop/contracts/all', async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit)) || 50));
      const contracts = await storage.getAllContracts(limit);
      res.json(contracts);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Create manual contract
  app.post('/api/coop/contracts', async (req, res) => {
    try {
      const { fillType, requiredAmount, bonusPercent, expiresInHours } = req.body;
      if (!fillType || !requiredAmount || !bonusPercent) {
        return res.status(400).json({ error: 'fillType, requiredAmount, bonusPercent required' });
      }
      const expiresAt = new Date(Date.now() + (expiresInHours || 24) * 60 * 60 * 1000);
      const contract = await storage.createContract({
        fillType: fillType.toUpperCase(),
        requiredAmount: Number(requiredAmount),
        bonusPercent: Number(bonusPercent),
        expiresAt,
      });
      res.json(contract);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Update contract
  app.patch('/api/coop/contracts/:id', async (req, res) => {
    try {
      const updates: any = {};
      if (req.body.fillType) updates.fillType = req.body.fillType.toUpperCase();
      if (req.body.requiredAmount != null) updates.requiredAmount = Number(req.body.requiredAmount);
      if (req.body.bonusPercent != null) updates.bonusPercent = Number(req.body.bonusPercent);
      if (req.body.status) updates.status = req.body.status;
      if (req.body.expiresAt) updates.expiresAt = new Date(req.body.expiresAt);
      const result = await storage.updateContract(req.params.id, updates);
      res.json(result || { success: false });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Delete contract
  app.delete('/api/coop/contracts/:id', async (req, res) => {
    try {
      const ok = await storage.deleteContract(req.params.id);
      res.json({ success: ok });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Filtered deliveries
  app.get('/api/coop/deliveries/filter', async (req, res) => {
    try {
      const filter: any = {};
      if (req.query.farmId) filter.farmId = String(req.query.farmId);
      if (req.query.fillType) filter.fillType = String(req.query.fillType);
      if (req.query.fromDate) filter.fromDate = new Date(String(req.query.fromDate));
      if (req.query.toDate) filter.toDate = new Date(String(req.query.toDate));
      const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit)) || 100));
      const deliveries = await storage.getDeliveriesFiltered(filter, limit);
      res.json(deliveries);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Refund (delete) delivery
  app.delete('/api/coop/deliveries/:id', async (req, res) => {
    try {
      const ok = await storage.deleteDelivery(req.params.id);
      res.json({ success: ok });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Update market item price/demand
  app.patch('/api/coop/market/:fillType', async (req, res) => {
    try {
      const updates: any = { fillType: req.params.fillType.toUpperCase() };
      if (req.body.basePrice != null) updates.basePrice = Number(req.body.basePrice);
      if (req.body.currentPrice != null) updates.currentPrice = Number(req.body.currentPrice);
      if (req.body.demandLevel != null) updates.demandLevel = Number(req.body.demandLevel);
      if (req.body.supplyLevel != null) updates.supplyLevel = Number(req.body.supplyLevel);
      const result = await storage.upsertCoopMarketItem(updates);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Custom Contracts (Poslovi na ugovor) ──
  app.get("/api/custom-contracts", async (_req, res) => {
    try {
      const contracts = await storage.getCustomContracts();
      res.json(contracts);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/custom-contracts/:gameId/accept", async (req, res) => {
    try {
      const gameId = parseInt(req.params.gameId);
      const farmId = parseInt(req.body.farmId || '1');
      await bot.sendPosloviCommand('acceptContract', { contractId: gameId, farmId });
      res.json({ ok: true, message: 'Naredba za prihvaćanje poslana u igru.' });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/custom-contracts/:gameId/complete", async (req, res) => {
    try {
      const gameId = parseInt(req.params.gameId);
      const farmId = parseInt(req.body.farmId || '1');
      await bot.sendPosloviCommand('completeContract', { contractId: gameId, farmId });
      res.json({ ok: true, message: 'Naredba za dovršenje poslana u igru.' });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/custom-contracts/:gameId/cancel", async (req, res) => {
    try {
      const gameId = parseInt(req.params.gameId);
      const farmId = parseInt(req.body.farmId || '1');
      await bot.sendPosloviCommand('cancelContract', { contractId: gameId, farmId });
      res.json({ ok: true, message: 'Naredba za otkazivanje poslana u igru.' });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  return httpServer;
}
function isAllowedMapUrl(url: string): boolean {
  const allowed = process.env.WEBSTATS_MAP_IMAGE_URL || process.env.SERVER_MAP_IMAGE_URL
    || getActiveServer()?.mapImageUrl || '';
  if (!allowed) return false;
  try {
    const requested = new URL(url);
    const configured = new URL(allowed);
    return requested.origin === configured.origin && requested.pathname === configured.pathname;
  } catch { return false; }
}
