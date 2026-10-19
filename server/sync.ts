import * as ftp from "basic-ftp";
import { parseStringPromise } from "xml2js";
import { storage } from "./storage";
import { Writable } from "stream";
import { bot } from "./bot";
import { pickFirst, toNumber, toStringSafe } from "./parseUtils";
import { setSyncStatus, pushFileResult, bumpCount, writeSyncSnapshot } from "./syncStatus";
import { updatePlayerHoursFromPresenceSnapshot } from "./playerHours";
import { getActiveServer } from "./serverConfig";
import { detectCompanionOutbox } from "./ftpCommands";
import { getWebStatsSummaryFromEnv } from "./webstats";

export class FarmSyncService {
  private lastSyncTime: Date | null = null;
  private missingFileLogCooldown = new Map<string, number>();
  private syncInProgress = false;
  private siloDebugRemaining = Math.max(0, Number(process.env.SILO_DEBUG_CYCLES || '0') || 0);
  public lastFarmPlayers: FarmPlayersData | null = null;

  private normalizeEpochMs(value: any): number | undefined {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    if (raw < 1e11) return Math.round(raw * 1000);
    if (raw > 1e14) return Math.round(raw / 1000);
    return Math.round(raw);
  }

  // Runtime stats exported by patched FSG_Companion (playerTimeStats.xml, vehicleUsageStats.xml)
  // Napomena (hr): ne spremamo u bazu jer mod vec perzistira u savegame-u; bot ih drzi u memoriji
  // i osvjezi na svakom syncu.

  async sync() {
    if (this.syncInProgress) {
      return;
    }
    this.syncInProgress = true;

    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date();
    setSyncStatus({
      runId,
      inProgress: true,
      startedAt: startedAt.toISOString(),
      endedAt: undefined,
      durationMs: undefined,
      files: [],
      counts: {},
      lastError: undefined,
    });

    const srv = getActiveServer();
    const host = srv?.host;
    const user = srv?.user;
    const password = srv?.pass;
    const port = srv?.port || 21;

    if (!host || !user || !password) {
      console.log("FTP credentials missing, skipping sync");
      setSyncStatus({
        ftpHost: host,
        ftpPort: port,
        lastErrorAt: new Date().toISOString(),
        lastError: 'FTP credentials missing',
        inProgress: false,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
      });
      this.syncInProgress = false;
      return;
    }

    const client = new ftp.Client(30000);
    const ftpDebug = ['1', 'true', 'yes', 'on']
      .includes(String(process.env.FS25_FTP_DEBUG || 'false').trim().toLowerCase());
    client.ftp.verbose = ftpDebug;

    try {
      const secure = srv?.secure || false;
      setSyncStatus({ ftpHost: host, ftpPort: port, ftpSecure: secure });
      await client.access({
        host,
        port,
        user,
        password,
        secure
      });

      // Auto-detect the correct companion folder (handles renamed mods)
      const configuredPath = srv?.remotePath || "/profile/modSettings/FS25_FSG_Companion/commands/outbox";
      const detectedPath = await detectCompanionOutbox(client, srv?.id || 'default', configuredPath);

      // Try detected path first, then fallback options
      let basePath = detectedPath;
      try {
        await client.cd(detectedPath);
        setSyncStatus({ basePath: detectedPath });
      } catch {
        const fallbacks = [
          configuredPath,
          "/modSettings/FS25_FSG_Companion/commands/outbox",
          "/savegame1"
        ];
        let found = false;
        for (const path of fallbacks) {
          if (path === detectedPath) continue; // already tried
          try {
            await client.cd(path);
            basePath = path;
            setSyncStatus({ basePath: path });
            found = true;
            break;
          } catch {}
        }
        if (!found) {
          console.error("No savegame folder found");
          await storage.log({ type: 'error', message: 'No savegame or outbox folder found on FTP' });
          setSyncStatus({
            lastErrorAt: new Date().toISOString(),
            lastError: 'No savegame or outbox folder found on FTP',
          });
          return;
        }
      }

      // Sync Fields from fieldsStats.xml
      const fieldsXml = await this.getFileContent(client, `${basePath}/fieldsStats.xml`);
      if (fieldsXml) {
        await this.parseAndStoreFields(fieldsXml);
        bumpCount('fieldsSynced');
        pushFileResult({ name: 'fieldsStats.xml', ok: true, bytes: Buffer.byteLength(fieldsXml), parsed: true });
      } else {
        pushFileResult({ name: 'fieldsStats.xml', ok: false, error: 'missing' });
      }

      // Sync Vehicles from vehicleStats.xml
      const vehiclesXml = await this.getFileContent(client, `${basePath}/vehicleStats.xml`);
      if (vehiclesXml) {
        await this.parseAndStoreVehicles(vehiclesXml);
        bumpCount('vehiclesSynced');
        pushFileResult({ name: 'vehicleStats.xml', ok: true, bytes: Buffer.byteLength(vehiclesXml), parsed: true });
      } else {
        pushFileResult({ name: 'vehicleStats.xml', ok: false, error: 'missing' });
      }

      // Sync Silos from placeableSiloStats.xml
      const silosXml = await this.getFileContent(client, `${basePath}/placeableSiloStats.xml`);
      if (silosXml) {
        await this.parseAndStoreSilos(silosXml);
        bumpCount('silosSynced');
        pushFileResult({ name: 'placeableSiloStats.xml', ok: true, bytes: Buffer.byteLength(silosXml), parsed: true });
      } else {
        pushFileResult({ name: 'placeableSiloStats.xml', ok: false, error: 'missing' });
      }

      // Sync Productions from productionStats.xml
      const productionsXml = await this.getFileContent(client, `${basePath}/productionStats.xml`);
      if (productionsXml) {
        await this.parseAndStoreProductions(productionsXml);
        bumpCount('productionsSynced');
        pushFileResult({ name: 'productionStats.xml', ok: true, bytes: Buffer.byteLength(productionsXml), parsed: true });
      } else {
        pushFileResult({ name: 'productionStats.xml', ok: false, error: 'missing' });
      }

      // Sync Animals from animalStats.xml
      const animalsXml = await this.getFileContent(client, `${basePath}/animalStats.xml`);
      if (animalsXml) {
        await this.parseAndStoreAnimals(animalsXml);
        bumpCount('animalsSynced');
        pushFileResult({ name: 'animalStats.xml', ok: true, bytes: Buffer.byteLength(animalsXml), parsed: true });
      } else {
        pushFileResult({ name: 'animalStats.xml', ok: false, error: 'missing' });
      }

      // Sync Weather from WeatherForecast.xml (case-sensitive on Linux) or environment.xml
      const weatherXml = await this.getFileContent(client, `${basePath}/WeatherForecast.xml`)
        || await this.getFileContent(client, `${basePath}/weatherForecast.xml`)
        || await this.getFileContent(client, `${basePath}/environment.xml`);
      if (weatherXml) {
        await this.parseAndStoreWeather(weatherXml);
        bumpCount('weatherSynced');
        pushFileResult({ name: 'weather.xml', ok: true, bytes: Buffer.byteLength(weatherXml), parsed: true });
      } else {
        pushFileResult({ name: 'WeatherForecast.xml', ok: false, error: 'missing' });
      }

      // Sync Farms from farms.xml
      const farmsXml = await this.getFileContent(client, `${basePath}/farms.xml`);
      if (farmsXml) {
        await this.parseAndStoreFarms(farmsXml);
        bumpCount('farmsSynced');
        pushFileResult({ name: 'farms.xml', ok: true, bytes: Buffer.byteLength(farmsXml), parsed: true });
      } else {
        pushFileResult({ name: 'farms.xml', ok: false, error: 'missing' });
      }


      // Sync Selling Prices from sellingPrices.xml (companion exports real game prices)
      const sellingPricesXml = await this.getFileContent(client, `${basePath}/sellingPrices.xml`);
      if (sellingPricesXml) {
        try {
          const parsed = await parseStringPromise(sellingPricesXml, { explicitArray: false, ignoreAttrs: false });
          const root = parsed?.sellingPrices || parsed;

          // Parse fillType nodes: { name, basePrice }
          const fillTypeNodes = this.asArray(root?.fillType);
          const fillTypes: Array<{ name: string; basePrice: number }> = [];
          for (const ft of fillTypeNodes) {
            const a = ft?.$ || ft || {};
            const name = String(a.name || '').toUpperCase();
            const basePrice = parseFloat(a.basePrice);
            if (name && !isNaN(basePrice) && basePrice > 0) {
              fillTypes.push({ name, basePrice });
            }
          }

          // Parse bestPrice nodes: { fillType, price, station, greatDemand }
          const bestPriceNodes = this.asArray(root?.bestPrice);
          const bestPrices: Array<{ fillType: string; price: number; station: string; greatDemand: boolean }> = [];
          for (const bp of bestPriceNodes) {
            const a = bp?.$ || bp || {};
            const fillType = String(a.fillType || '').toUpperCase();
            const price = parseFloat(a.price);
            const station = String(a.station || '');
            const greatDemand = String(a.greatDemand).toLowerCase() === 'true';
            if (fillType && !isNaN(price) && price > 0) {
              bestPrices.push({ fillType, price, station, greatDemand });
            }
          }

          if (fillTypes.length > 0 || bestPrices.length > 0) {
            await bot.updateGamePrices(fillTypes, bestPrices);
            console.log(`[SYNC] sellingPrices.xml: ${fillTypes.length} fillTypes, ${bestPrices.length} bestPrices`);
          }
          bumpCount('sellingPricesSynced');
          pushFileResult({ name: 'sellingPrices.xml', ok: true, bytes: Buffer.byteLength(sellingPricesXml), parsed: true });
        } catch (e: any) {
          console.error('[SYNC] sellingPrices.xml parse error:', e.message);
          pushFileResult({ name: 'sellingPrices.xml', ok: false, error: e.message });
        }
      }

      // Player->Farm mapping via confirm-playerChat-*.xml (companion chat confirmations)
      const farmByUserId = new Map<string, string>();
      try {
        const listing = await client.list(basePath);
        const chatFiles = listing
          .map(f => f.name)
          .filter(name => /^confirm-playerChat-.*\.xml$/i.test(name));

        // Parse newest mapping per user (based on timestamp attribute)
        const latestTs = new Map<string, string>();
        for (const fileName of chatFiles) {
          const xml = await this.getFileContent(client, `${basePath}/${fileName}`);
          if (!xml) continue;

          try {
            const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
            let chats = result.chatLogger?.chat || result.confirm?.chat || [];
            if (!Array.isArray(chats)) chats = [chats];

            let sawChatMsg = false;

            for (const c of chats) {
              const a = c.$ || c;
              const uid = a.fromUserId || a.uniqueUserId || a.userId;
              const farmId = a.farmId;
              const ts = a.timestamp || a.time || "";
              if (!uid || !farmId) continue;
              const sender = a.sender || a.fromUser || a.userNickname || a.nickname || undefined;
              const msg = a.msg || a.message || a.content || undefined;
              const chatTs = a.timestamp || a.time || ts || "";
              if (msg) {
                sawChatMsg = true;
                try { bot.postGameChatMessage({ sender: String(sender || uid), msg: String(msg), farmId: String(farmId), uniqueUserId: String(uid), timestamp: String(chatTs) }); } catch (e) {}
              }

              const prev = latestTs.get(String(uid));
              if (!prev || (ts && ts > prev)) {
                latestTs.set(String(uid), String(ts));
                farmByUserId.set(String(uid), String(farmId));
              }
            }

            // If this was a real chat log file (has msg), delete it after ingest to avoid re-posting
            if (sawChatMsg) {
              try { await client.remove(`${basePath}/${fileName}`); } catch (e) {}
            }
          } catch (e) {
            // Ignore malformed confirm XML
          }
        }
      } catch (e) {
        // FTP servers may not support LIST; mapping remains empty
      }

      try {
        const ingest = await this.ingestCommandAcksAndEvents(client, basePath);
        if (ingest.acks > 0 || ingest.events > 0) {
          bumpCount('inboxAckEvents');
          await storage.log({ type: 'info', message: `ACK/EVENT ingest: ack=${ingest.acks}, events=${ingest.events}` });
        }
      } catch (e) {
        console.error('ACK/EVENT ingest error:', e);
      }

      // Process coop silo/pallet/bale outbox files (coopSiloStore-*.xml, coopPalletStore-*.xml, coopBaleStore-*.xml)
      try {
        const listing = await client.list(basePath);
        const coopFiles = listing
          .map(f => f.name)
          .filter(name => /^coop(SiloStore|PalletStore|BaleStore)-.*\.xml$/i.test(name));

        for (const fileName of coopFiles) {
          try {
            const xml = await this.getFileContent(client, `${basePath}/${fileName}`);
            if (!xml) continue;

            const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
            const cmd = result?.commands?.command;
            if (!cmd) continue;

            const attrs = cmd.$ || cmd;
            const command = attrs.command || '';
            const farmId = attrs.farmId || '';
            const transactionId = attrs.transactionId || '';
            const timestamp = attrs.timestamp || '';

            if (command === 'coopSiloStore') {
              const fillType = attrs.fillType || '';
              const amount = parseFloat(attrs.amount) || 0;
              if (farmId && fillType && amount > 0) {
                await bot.processCoopDelivery({ command, farmId, fillType, amount, transactionId, timestamp });
                console.log(`[COOP-SYNC] Processed silo delivery: Farm ${farmId}, ${amount}L ${fillType}`);
                bumpCount('coopDeliveries');
              }
            } else if (command === 'coopPalletStore') {
              // Pallet deliveries - extract fill info and process as delivery
              const fillTypeName = attrs.fillTypeName || '';
              const fillLevel = parseFloat(attrs.fillLevel) || 0;
              if (farmId && fillTypeName && fillLevel > 0) {
                await bot.processCoopDelivery({ command, farmId, fillType: fillTypeName, amount: fillLevel, transactionId, timestamp });
                console.log(`[COOP-SYNC] Processed pallet delivery: Farm ${farmId}, ${fillLevel}L ${fillTypeName}`);
                bumpCount('coopDeliveries');
              }
            } else if (command === 'coopBaleStore') {
              const fillTypeName = attrs.fillTypeName || attrs.fillType || '';
              const fillLevel = parseFloat(attrs.fillLevel) || 0;
              if (farmId && fillTypeName && fillLevel > 0) {
                await bot.processCoopDelivery({ command, farmId, fillType: fillTypeName, amount: fillLevel, transactionId, timestamp });
                console.log(`[COOP-SYNC] Processed bale delivery: Farm ${farmId}, ${fillLevel}L ${fillTypeName}`);
                bumpCount('coopDeliveries');
              }
            }

            // Delete the file after successful processing
            try { await client.remove(`${basePath}/${fileName}`); } catch {}
            pushFileResult({ name: fileName, ok: true, bytes: Buffer.byteLength(xml), parsed: true });
          } catch (fileErr: any) {
            console.error(`[COOP-SYNC] Error processing ${fileName}:`, fileErr.message);
            pushFileResult({ name: fileName, ok: false, error: fileErr.message });
          }
        }
      } catch (e) {
        // Directory listing may fail; coop not critical
        console.error('[COOP-SYNC] Error scanning coop files:', e);
      }

      // Process custom contracts state from Poslovi mod outbox
      try {
        const posloviOutbox = '/profile/modSettings/FS25_Poslovi/outbox';
        const contractsXml = await this.getFileContent(client, `${posloviOutbox}/contractsState.xml`);
        if (contractsXml) {
          const result = await parseStringPromise(contractsXml, { explicitArray: false, ignoreAttrs: false });
          const root = result?.ContractsState;
          if (root) {
            const rawContracts = root.contract;
            const contractArr = Array.isArray(rawContracts) ? rawContracts : rawContracts ? [rawContracts] : [];
            const contracts = contractArr.map((c: any) => {
              const a = c.$ || c;
              return {
                id: parseInt(a.id) || 0,
                creatorFarmId: parseInt(a.creatorFarmId) || 0,
                contractorFarmId: parseInt(a.contractorFarmId) || -1,
                fieldId: parseInt(a.fieldId) || 0,
                workType: a.workType || '',
                reward: parseInt(a.reward) || 0,
                status: a.status || '',
                description: a.description || '',
                startPeriod: parseInt(a.startPeriod) || -1,
                startDay: parseInt(a.startDay) || -1,
                duePeriod: parseInt(a.duePeriod) || -1,
                dueDay: parseInt(a.dueDay) || -1,
              };
            });
            await bot.processCustomContracts(contracts);
            bumpCount('posloviContracts');
            pushFileResult({ name: 'contractsState.xml', ok: true, bytes: Buffer.byteLength(contractsXml), parsed: true });
          }
        }
      } catch (e) {
        console.error('[POSLOVI-SYNC] Error reading contracts state:', e);
      }

      // Fetch authoritative player list from WebStats XML API (needed before player parse)
      let webStatsOnlineNames: string[] | null = null;
      try {
        const ws = await getWebStatsSummaryFromEnv();
        if (ws.summary?.players?.length) {
          webStatsOnlineNames = ws.summary.players.map(p => p.name);
        } else if (ws.summary) {
          // WebStats reachable but reports 0 players online
          webStatsOnlineNames = [];
        }

        // Store webstats summary in MongoDB for FS-web to read
        try {
          const serverInfo: Record<string, any> = { updatedAt: new Date() };
          if (ws.summary?.mapName) serverInfo.mapName = ws.summary.mapName;
          if (ws.summary?.serverName) serverInfo.serverName = ws.summary.serverName;
          if (ws.summary?.isOnline != null) serverInfo.isOnline = ws.summary.isOnline;
          if (ws.summary?.playersOnline != null) serverInfo.playersOnline = ws.summary.playersOnline;
          if (ws.mods?.modCount != null) serverInfo.modCount = ws.mods.modCount;
          if (ws.mods?.companionActive != null) serverInfo.companionActive = ws.mods.companionActive;
          await storage.upsertServerInfo(serverInfo);
        } catch (e) { /* ignore storage error */ }
      } catch { /* WebStats unavailable – fall back to heuristics */ }

      // Pre-check: will runtime stats handle presence detection?
      const playerTimeXml = await this.getFileContent(client, `${basePath}/playerTimeStats.xml`);
      const vehicleUsageXml = await this.getFileContent(client, `${basePath}/vehicleUsageStats.xml`);
      const runtimeWillHandlePresence = !!(playerTimeXml || vehicleUsageXml);

      // Farm-player mapping + mod settings (parse BEFORE players so farmByUserId is enriched)
      const farmPlayersXml = await this.getFileContent(client, `${basePath}/farmPlayers.xml`);
      if (farmPlayersXml) {
        const fpResult = await this.parseFarmPlayers(farmPlayersXml);
        if (fpResult) {
          this.lastFarmPlayers = fpResult;
          // Enrich farmByUserId from farmPlayers.xml (authoritative mapping)
          for (const farm of fpResult.farms) {
            for (const p of farm.players) {
              if (p.uniqueUserId && !farmByUserId.has(String(p.uniqueUserId))) {
                farmByUserId.set(String(p.uniqueUserId), String(farm.farmId));
              }
            }
          }
        }
      }

      // Sync Players
      const playersXml = await this.getFileContent(client, `${basePath}/playerStats.xml`);
      if (playersXml) {
        await this.parseAndStorePlayers(playersXml, farmByUserId, webStatsOnlineNames, runtimeWillHandlePresence);
        bumpCount('playersSynced');
        pushFileResult({ name: 'playerStats.xml', ok: true, bytes: Buffer.byteLength(playersXml), parsed: true });
      } else {
        // Fallback: some companion builds export only playerTimeStats.xml (with nickname + uniqueUserId)
        const fallbackPlayersXml = await this.getFileContent(client, `${basePath}/playerTimeStats.xml`);
        if (fallbackPlayersXml) {
          await this.parseAndStorePlayersFromTimeStats(fallbackPlayersXml);
          bumpCount('playersSynced');
          pushFileResult({ name: 'playerTimeStats.xml', ok: true, bytes: Buffer.byteLength(fallbackPlayersXml), parsed: true });
        } else {
          pushFileResult({ name: 'playerStats.xml', ok: false, error: 'missing' });
        }
      }

      // Runtime stats (optional) from patched companion
      if (runtimeWillHandlePresence) {
        const runtime = await this.parseRuntimeStats(playerTimeXml, vehicleUsageXml);

        bot.setRuntimeStats(runtime, webStatsOnlineNames);
        bumpCount('runtimeSynced');
      }

      // Player tracking (optional) from patched companion
      const tracksXml = await this.getFileContent(client, `${basePath}/playerTracks.xml`);
      const sessionsXml = await this.getFileContent(client, `${basePath}/playerSessionHistory.xml`);
      if (tracksXml || sessionsXml) {
        const tracking = await this.parsePlayerTracking(tracksXml, sessionsXml);
        bot.setPlayerTracking(tracking);
        bumpCount('trackingSynced');
      }

      // Mod error log (companion writes errors to outbox)
      const errorLogXml = await this.getFileContent(client, `${basePath}/modErrorLog.xml`);
      if (errorLogXml) {
        const errors = await this.parseModErrorLog(errorLogXml);
        if (errors.length > 0) {
          await bot.sendModErrorLog(errors);
          // Delete the file after processing so we don't resend
          try { await client.remove(`${basePath}/modErrorLog.xml`); } catch {}
        }
      }

      this.lastSyncTime = new Date();
      await storage.log({ type: 'info', message: 'Successfully synced FS25 data from FSG_Companion' });

      const endedAt = new Date();
      setSyncStatus({
        inProgress: false,
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        lastSuccessAt: endedAt.toISOString(),
        lastError: undefined,
      });
      await writeSyncSnapshot();
      
      // Refresh all Discord panels with new data
      try {
        await bot.refreshAllPanels();
        bumpCount('panelsRefreshed');
      } catch (e: any) {
        const msg = String(e?.message || e);
        await storage.log({ type: 'error', message: `Panel refresh failed: ${msg}` });
        console.error('Panel refresh failed:', e);
      }
    } catch (err: any) {
      console.error("FTP Sync Error:", err);
      const msg = String(err?.message || err);
      await storage.log({ type: 'error', message: `Sync failed: ${msg}` });
      setSyncStatus({
        inProgress: false,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        lastErrorAt: new Date().toISOString(),
        lastError: msg,
      });
    } finally {
      this.syncInProgress = false;
      client.close();
    }
  }

  private coercePlayTimeHours(attr: any): number {
    try {
      // Newer companion exports (playerTimeStats.xml) — total = online + AFK
      if (attr.totalOnlineMs != null) {
        const onlineMs = parseFloat(String(attr.totalOnlineMs)) || 0;
        const afkMs = parseFloat(String(attr.totalAfkMs || 0)) || 0;
        const totalMs = onlineMs + afkMs;
        return isFinite(totalMs) ? (totalMs / 3600000) : 0;
      }

      // Some builds export minutes
      if (attr.playTime != null) {
        const mins = parseFloat(String(attr.playTime));
        return isFinite(mins) ? (mins / 60) : 0;
      }

      // Some builds export hours directly
      if (attr.hours != null) {
        const h = parseFloat(String(attr.hours));
        return isFinite(h) ? h : 0;
      }

      return 0;
    } catch {
      return 0;
    }
  }

  /** Extract AFK hours from companion XML attrs */
  private coerceAfkHours(attr: any): number {
    try {
      if (attr.totalAfkMs != null) {
        const ms = parseFloat(String(attr.totalAfkMs));
        return isFinite(ms) ? (ms / 3600000) : 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private async getFileContent(client: ftp.Client, path: string): Promise<string | null> {
    let content = "";
    const stream = new Writable({
      write(chunk: any, encoding: any, callback: any) {
        content += chunk.toString();
        callback();
      }
    });

    try {
      await client.downloadTo(stream, path);
      return content;
    } catch (e: any) {
      // Make FTP "missing file" errors actionable, without spamming logs.
      const msg = String(e?.message || e || "");
      const code = (e?.code ?? e?.ftpCode ?? e?.status ?? undefined) as any;
      const isMissing = msg.includes("550") || code === 550 || code === "550";

      if (isMissing) {
        const key = `missing:${path}`;
        const now = Date.now();
        const last = this.missingFileLogCooldown.get(key) || 0;
        // cooldown: 10 minutes per missing file path
        if (now - last > 10 * 60 * 1000) {
          this.missingFileLogCooldown.set(key, now);
          const hint =
            msg.toLowerCase().includes("not exists") || msg.toLowerCase().includes("no such")
              ? "Mod nije instaliran/aktivan ili još nije generirao ovaj XML u outboxu."
              : "Provjeri FS25_REMOTE_PATH i da je Companion mod aktivan na tom serveru.";

          console.log(`[FTP 550] Missing outbox file: ${path}`);
          await storage.log({
            type: "warn",
            message: `FTP 550 (missing): ${path}. ${hint}`
          });
        }
        return null;
      }

      console.log(`[FTP] Download error for ${path}:`, msg);
      await storage.log({
        type: "error",
        message: `FTP download error: ${path} | ${msg}`
      });
      return null;
    }
  }


  private async parseAndStoreFields(xml: string) {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      let fieldsData = result.fields?.field || [];
      if (!Array.isArray(fieldsData)) fieldsData = [fieldsData];

      for (const f of fieldsData) {
        const attr = f.$ || f;
        await storage.upsertField({
          fieldId: toStringSafe(pickFirst(attr, ['fieldId', 'id'], 'unknown')),
          ownerFarmId: pickFirst(attr, ['ownerFarmId', 'farmId', 'ownerId'], null) as any,
          farmlandId: pickFirst(attr, ['farmlandId', 'landId'], null) as any,
          fieldArea: toNumber(pickFirst(attr, ['fieldArea', 'area'], 0)),
          fieldAreaFull: toNumber(pickFirst(attr, ['fieldAreaFull', 'areaFull'], 0)),
          fruitName: toStringSafe(pickFirst(attr, ['fieldFruitName', 'fruitName', 'fruit'], 'None')),
          fruitStatus: toStringSafe(pickFirst(attr, ['getFieldFruitStatus', 'fieldFruitStatus', 'fruitStatus', 'status'], 'Unknown')),
          growthStage: toStringSafe(pickFirst(attr, ['getFieldStage', 'fieldStage', 'growthStage', 'stage'], 'Unknown')),
          wheelsInfo: pickFirst(attr, ['getWheelsInfo', 'wheelsInfo'], undefined) as any,
          weedInfo: pickFirst(attr, ['weedInfo', 'weeds'], undefined) as any,
          limeInfo: toStringSafe(pickFirst(attr, ['limeInfo', 'lime'], 'None')),
          plowingInfo: toStringSafe(pickFirst(attr, ['plowingInfo', 'plowInfo'], 'None')),
          rollingInfo: pickFirst(attr, ['rollingInfo', 'rollInfo'], undefined) as any,
          fertilizationInfo: pickFirst(attr, ['fertilizationInfo', 'fertInfo', 'fertilizerInfo'], undefined) as any,
          posX: toNumber(pickFirst(attr, ['posX', 'x'], 0)),
          posZ: toNumber(pickFirst(attr, ['posZ', 'z'], 0)),
          farmlandPrice: toNumber(pickFirst(attr, ['farmlandPrice', 'price'], 0))
        });
      }
    } catch (e) {
      console.error("Error parsing fields:", e);
    }
  }

  private async parseAndStoreVehicles(xml: string) {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      let vehiclesData = result.vehicleStats?.vehicle || [];
      if (!Array.isArray(vehiclesData)) vehiclesData = [vehiclesData];

      // hr: prije brisanja snapshot tablice, uzmi prethodno stanje da mozemo detektirati prodana/uklonjena vozila.
      const prev = await storage.getVehicles();
      const prevKey = (v: any) => `${(v.farmId || '')}|${(v.name || '')}|${(v.vehType || '')}|${(v.imageFilename || '')}`.toLowerCase();

      const next: any[] = [];
      const nextKeys = new Set<string>();
      const nextFarmNameKeys = new Set<string>();

      for (const v of vehiclesData) {
        const attr = v.$ || v;

        let fillUnits: any[] = [];
        if (v.fill) {
          const fills = Array.isArray(v.fill) ? v.fill : [v.fill];
          fillUnits = fills.map((f: any) => ({
            fillType: f.$?.fillType || f.fillType,
            fillLevel: parseFloat(f.$?.fillLevel || f.fillLevel || "0"),
            fillPercentage: parseFloat(f.$?.fillPercentage || f.fillPercentage || "0")
          }));
        }

        const farmId = String(attr.farmId ?? attr.farmID ?? '');
        const name = attr.name || "Unknown Vehicle";
        const vehType = attr.vehType;
        const imageFilename = attr.imageFilename;

        const key = `${farmId}|${name}|${vehType || ''}|${imageFilename || ''}`.toLowerCase();
        nextKeys.add(key);
        nextFarmNameKeys.add(`${farmId}|${name}`.toLowerCase());

        next.push({
          name,
          farmId,
          damage: parseFloat(attr.damage || "0"),
          propertyState: attr.propertyState,
          fuelType: attr.fuelType,
          fuelLevel: parseFloat(attr.fuelLevel || "0"),
          defLevel: parseFloat(attr.defLevel || "0"),
          paint: attr.paint,
          dirt: parseFloat(attr.dirt || "0"),
          price: parseFloat(attr.price || "0"),
          sellPrice: parseFloat(attr.sellPrice || "0"),
          imageFilename,
          vehType,
          position: attr.position,
          fillUnits
        });
      }

      // hr: detektiraj vozila koja su nestala iz snapshot-a (prodana / uklonjena) i evidentiraj u log.
      const removed = prev.filter((v: any) => !nextKeys.has(prevKey(v)));
      if (removed.length) {
        for (const rv of removed.slice(0, 50)) { // hr: safety limit
          const usage = bot.getVehicleUsage(rv.farmId || '', rv.name || '');
          await storage.log({
            type: 'vehicle_removed',
            message: JSON.stringify({
              at: new Date().toISOString(),
              farmId: rv.farmId || null,
              name: rv.name,
              vehType: rv.vehType || null,
              imageFilename: rv.imageFilename || null,
              price: rv.price ?? null,
              sellPrice: rv.sellPrice ?? null,
              usage: usage || null
            })
          } as any);
        }
      }

      await storage.clearVehicles();
      for (const v of next) {
        await storage.upsertVehicle(v as any);
      }

      // hr: makni runtime statistiku za vozila koja vise ne postoje u snapshot-u
      bot.pruneRuntimeVehicleUsage(nextFarmNameKeys);

    } catch (e) {
      console.error("Error parsing vehicles:", e);
    }
  }

  private async parseAndStoreSilos(xml: string) {
    try {
      const result: any = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      const debugThisRun = this.siloDebugRemaining > 0;
      const debugRows: string[] = [];

      // Napomena (hr): FSG_Companion zna mijenjati root node naziv (siloStats vs placeableSiloStats).
      const root = result.placeableSiloStats || result.siloStats || result.placeableSilos || result;

      let silosData: any[] = root?.silo || root?.placeableSilo || root?.placeable || [];
      if (!Array.isArray(silosData)) silosData = [silosData];

      await storage.clearSilos();

      for (const s of silosData) {
        const attr = s.$ || s;

        // fillLevel može biti array ili single node; spremamo kao mapu { fillType: level }
        const fillMap: Record<string, number> = {};

        const toNum = (v: any) => {
          const n = Number(String(v ?? '').replace(',', '.'));
          return Number.isFinite(n) ? n : 0;
        };

        const addFill = (typeRaw: any, levelRaw: any, capRaw?: any, pctRaw?: any) => {
          const type = String(typeRaw || '').trim();
          if (!type) return;
          let level = toNum(levelRaw);
          if ((!Number.isFinite(level) || level <= 0) && pctRaw != null && capRaw != null) {
            const pct = toNum(pctRaw);
            const cap = toNum(capRaw);
            if (cap > 0) level = cap * (pct / 100);
          }
          if (!Number.isFinite(level) || level <= 0) return;
          fillMap[type] = (fillMap[type] || 0) + level;
        };

        const collectFillNodes = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) {
            for (const n of node) collectFillNodes(n);
            return;
          }

          const a = node.$ || node;
          const candidateType = a.fillType || a.type || a.filltype || a.name || a.title || a.fill;
          const hasValueLike =
            a.level != null || a.fillLevel != null || a.amount != null || a.current != null || a.value != null || a.liters != null || a.quantity != null ||
            (a.percent != null && a.capacity != null);
          if (candidateType && hasValueLike) {
            addFill(
              candidateType,
              a.level ?? a.fillLevel ?? a.amount ?? a.current ?? a.value ?? a.liters ?? a.quantity,
              a.capacity ?? a.maxCapacity ?? a.max,
              a.percent
            );
          }

          for (const [k, v] of Object.entries(node)) {
            if (k === '$') continue;
            collectFillNodes(v);
          }
        };

        const rawFill = (s.fillLevel || s.fillLevels || s.fill || []);
        collectFillNodes(rawFill);

        // Some exports keep only placeable-level fillType + totalFill/percent/capacity
        if (Object.keys(fillMap).length === 0) {
          const placeableType = String(attr.fillType || attr.type || attr.filltype || '').trim();
          if (placeableType) {
            addFill(
              placeableType,
              attr.totalFill ?? attr.fillLevel ?? attr.level ?? attr.amount,
              attr.capacity ?? attr.maxCapacity ?? attr.max,
              attr.percent
            );
          }
        }

        
        // Support older/special exports where fill data is under .silo(i) nodes with {name, percent, capacity}
        if (Object.keys(fillMap).length === 0 && (s.silo || s.silos)) {
          const rawSilos = (s.silo || s.silos || []);
          const siloNodes = Array.isArray(rawSilos) ? rawSilos : [rawSilos];

          const inferFillTypeFromName = (rawName: string) => {
            const normalized = String(rawName || '')
              .trim()
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, '_')
              .replace(/_+/g, '_')
              .replace(/^_+|_+$/g, '');
            if (!normalized) return '';

            // strip generic container words, keep actual commodity keyword when present
            const cleaned = normalized
              .replace(/(^|_)(SILO|HEAP|STORAGE|BUNKER|PLACEABLE|RACK|FARM|MULTI|TANK|PIT|BIN|HALL|SHED)(?=_|$)/g, '_')
              .replace(/_+/g, '_')
              .replace(/^_+|_+$/g, '');
            if (!cleaned) return '';

            if (cleaned.includes('MRKVA')) return 'CARROT';
            if (cleaned.includes('CARROT')) return 'CARROT';
            if (cleaned.includes('MANURE')) return 'MANURE';
            if (cleaned.includes('LIQUIDMANURE') || cleaned.includes('SLURRY')) return 'LIQUIDMANURE';
            if (cleaned.includes('DIGESTATE')) return 'DIGESTATE';

            // fall back to cleaned token if it still looks like a plausible fill type
            if (/^[A-Z][A-Z0-9_]*$/.test(cleaned) && !/\d/.test(cleaned)) return cleaned;
            return '';
          };

          let capSum = 0;
          let fillSum = 0;
          for (const sn of siloNodes) {
            const a = sn.$ || sn;
            const rawName = String(a.name || '').trim();
            const inferredType = inferFillTypeFromName(rawName);
            const type = String(a.fillType || a.type || a.title || a.fill || inferredType || '').trim();
            const pct = toNum(a.percent ?? 0);
            const cap = toNum(a.capacity ?? 0);
            if (Number.isFinite(cap) && cap > 0) capSum += cap;
            const lvl = (Number.isFinite(pct) && Number.isFinite(cap) && cap > 0) ? (cap * (pct / 100)) : 0;
            fillSum += lvl;
            if (!type) continue;
            fillMap[type] = (fillMap[type] || 0) + lvl;
          }
          // If placeable-level capacity is missing, use sum of child capacities
          if (!Number.isFinite(Number((s.$ || s).capacity)) || Number((s.$ || s).capacity) <= 0) {
            (s.$ || s).capacity = capSum;
          }
          if (!Number.isFinite(Number((s.$ || s).totalFill)) || Number((s.$ || s).totalFill) <= 0) {
            (s.$ || s).totalFill = fillSum;
          }
        }

// Neki exporti nemaju percent/totalFill; izračunaj ako možeš
        const capacity = Number(attr.capacity || 0);
        let totalFill = Number(attr.totalFill || attr.fillLevel || 0);
        if (!Number.isFinite(totalFill) || totalFill <= 0) {
          totalFill = Object.values(fillMap).reduce((s, v) => s + (Number(v) || 0), 0);
        }
        let percent = Number(attr.percent || 0);
        if ((!Number.isFinite(percent) || percent == 0) && capacity > 0) {
          percent = (totalFill / capacity) * 100;
        }

        if (debugThisRun && debugRows.length < 8) {
          const fillTypes = Object.keys(fillMap);
          const hasRawFillNode = !!(s.fillLevel || s.fillLevels || s.fill);
          const nodeKeys = Object.keys(s || {})
            .filter(k => k !== '$')
            .slice(0, 8)
            .join(',') || '-';
          debugRows.push(
            `[${attr.name || attr.title || 'Unknown'}] cap=${Math.round(capacity || 0)} total=${Math.round(totalFill || 0)} pct=${Math.round(percent || 0)} fillTypes=${fillTypes.length ? fillTypes.join('|') : '-'} rawFill=${hasRawFillNode ? 'yes' : 'no'} keys=${nodeKeys}`
          );
        }

        await storage.upsertSilo({
          name: attr.name || attr.title || "Unknown Silo",
          farmId: String(attr.farmId ?? attr.farmID ?? attr.ownerFarmId ?? ""),
          typeName: attr.typeName || attr.type || undefined,
          position: attr.position || undefined,
          capacity: Number.isFinite(capacity) ? capacity : 0,
          totalFill: Number.isFinite(totalFill) ? totalFill : 0,
          percent: Number.isFinite(percent) ? percent : 0,
          fillLevels: fillMap
        });
      }

      if (debugThisRun) {
        const rootKeys = Object.keys(root || {}).slice(0, 10).join(',') || '-';
        const msg = [
          `[SILO_DEBUG] rootKeys=${rootKeys} silos=${silosData.length}`,
          ...debugRows
        ].join('\n');
        console.log(msg);
        await storage.log({ type: 'info', message: msg.slice(0, 1800) }).catch(() => {});
        this.siloDebugRemaining = Math.max(0, this.siloDebugRemaining - 1);
      }
    } catch (e) {
      console.error("Error parsing silos:", e);
    }
  }



  private async parseAndStoreProductions(xml: string) {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      let productionsData = result.productionStats?.production || [];
      if (!Array.isArray(productionsData)) productionsData = [productionsData];

      await storage.clearProductions();

      const num = (v: any) => {
        if (v == null) return 0;
        const n = Number(String(v).replace(',', '.'));
        return Number.isFinite(n) ? n : 0;
      };

      const normalizeFillType = (x: any) => {
        const raw = String(
          x?.fillType ?? x?.type ?? x?.name ?? x?.title ?? x?.filltype ?? x?.fill_type ?? ''
        ).trim();
        if (!raw) return '';
        return raw
          .replace(/\s+/g, '_')
          .replace(/[^A-Za-z0-9_]/g, '')
          .toUpperCase();
      };

      const toEntry = (x: any) => {
        const a = x?.$ || x || {};
        const fillType = normalizeFillType(a);
        if (!fillType) return null;
        return {
          fillType,
          amount: num(a.amount ?? a.level ?? a.fillLevel ?? a.value ?? a.current ?? a.liters ?? a.quantity),
          capacity: num(a.capacity ?? a.maxCapacity ?? a.max ?? a.limit)
        };
      };

      const uniqByType = (arr: any[]) => {
        const m = new Map<string, any>();
        for (const it of arr) {
          const k = String(it?.fillType || '').toUpperCase();
          if (!k) continue;
          const prev = m.get(k);
          if (!prev) {
            m.set(k, { ...it });
            continue;
          }
          m.set(k, {
            fillType: k,
            amount: num(prev.amount) + num(it.amount),
            capacity: Math.max(num(prev.capacity), num(it.capacity)),
          });
        }
        return [...m.values()];
      };

      const collectItems = (node: any, keyPattern: RegExp, out: any[]) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const n of node) collectItems(n, keyPattern, out);
          return;
        }

        for (const [k, v] of Object.entries(node)) {
          if (k === '$') continue;
          if (keyPattern.test(k)) {
            const arr = Array.isArray(v) ? v : [v];
            for (const item of arr) {
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                const direct = toEntry(item);
                if (direct) out.push(direct);
                // nested children often contain actual fillType nodes
                for (const nested of Object.values(item as any)) {
                  const nestedArr = Array.isArray(nested) ? nested : [nested];
                  for (const n of nestedArr) {
                    const e = toEntry(n);
                    if (e) out.push(e);
                  }
                }
              } else {
                const e = toEntry(item);
                if (e) out.push(e);
              }
            }
          }
          collectItems(v, keyPattern, out);
        }
      };

      for (const p of productionsData) {
        const attr = p.$ || p;

        const rawInputs: any[] = [];
        const rawOutputs: any[] = [];
        collectItems(p, /^(input|inputs|in|consum|consume|ingredient)/i, rawInputs);
        collectItems(p, /^(output|outputs|out|product|produce|produced|digestate)/i, rawOutputs);

        let inputs = uniqByType(rawInputs).filter(x => x.fillType);
        let outputs = uniqByType(rawOutputs).filter(x => x.fillType);

        // Legacy fallback (za jednostavne XML-e)
        if (inputs.length === 0 && p.input) {
          const inputList = Array.isArray(p.input) ? p.input : [p.input];
          inputs = inputList.map((i: any) => ({
            fillType: String(i.$?.fillType || i.fillType || '').toUpperCase(),
            amount: num(i.$?.amount || i.amount || 0),
            capacity: num(i.$?.capacity || i.capacity || 0),
          })).filter((x: any) => x.fillType);
        }

        if (outputs.length === 0 && p.output) {
          const outputList = Array.isArray(p.output) ? p.output : [p.output];
          outputs = outputList.map((o: any) => ({
            fillType: String(o.$?.fillType || o.fillType || '').toUpperCase(),
            amount: num(o.$?.amount || o.amount || 0),
            capacity: num(o.$?.capacity || o.capacity || 0),
          })).filter((x: any) => x.fillType);
        }

        await storage.upsertProduction({
          name: attr.name || "Unknown Production",
          farmId: String(attr.farmId ?? attr.farmID ?? ''),
          isOwned: (() => {
            const v = attr.isOwned ?? attr.owned ?? attr.isPurchased ?? attr.purchased ?? attr.propertyState;
            const s = String(v ?? '').toLowerCase();
            const truthy = (s === 'true' || s === '1' || s === 'yes' || s === 'owned' || s === 'purchased');
            const fid = String(attr.farmId ?? attr.farmID ?? '0');
            return truthy || (fid !== '' && fid !== '0');
          })(),
          productionPoint: attr.productionPoint,
          inputs: inputs,
          outputs: outputs,
          status: attr.status || attr.state || attr.productionState || attr.mode || 'N/A'
        });
      }
    } catch (e) {
      console.error("Error parsing productions:", e);
    }
  }

  private async parseAndStoreAnimals(xml: string) {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      let husbandries = result.animalStats?.husbandry || [];
      if (!Array.isArray(husbandries)) husbandries = [husbandries];

      // Full refresh: husbandry list can change between syncs
      if ((storage as any).clearAnimals) {
        await (storage as any).clearAnimals();
      }

      const slug = (s: string) => String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);

      const parseNum = (v: any) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      const parsePctFromTitle = (title: string) => {
        const m = String(title || '').match(/\((\d{1,3})%\)/);
        return m ? Math.max(0, Math.min(100, Number(m[1]))) : 0;
      };

      const normalizeType = (x: any) => String(x || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_]/g, '')
        .toUpperCase();

      const toEntry = (x: any) => {
        const a = x?.$ || x || {};
        let fillType = normalizeType(a.fillType || a.type || a.filltype);
        const title = String(a.title || a.name || '');
        if (!fillType && title) {
          if (/milk/i.test(title)) fillType = 'MILK';
          else if (/manure/i.test(title)) fillType = 'MANURE';
          else if (/slurry/i.test(title)) fillType = 'SLURRY';
          else if (/digestate/i.test(title)) fillType = 'DIGESTATE';
          else fillType = normalizeType(title);
        }
        if (!fillType) return null;

        const amount = parseNum(a.amount ?? a.level ?? a.fillLevel ?? a.current ?? a.value ?? a.liters);
        const capacity = parseNum(a.capacity ?? a.maxCapacity ?? a.max ?? a.limit);
        let percent = parseNum(a.percent);
        if (!percent && capacity > 0) percent = (amount / capacity) * 100;
        if (!percent && title) percent = parsePctFromTitle(title);

        if (!amount && !capacity && !percent) return null;
        return {
          fillType,
          amount,
          capacity,
          percent: Math.max(0, Math.min(100, percent)),
          title,
        };
      };

      const collectByKeyPattern = (node: any, keyPattern: RegExp, out: any[]) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const n of node) collectByKeyPattern(n, keyPattern, out);
          return;
        }
        for (const [k, v] of Object.entries(node)) {
          if (k === '$') continue;
          if (keyPattern.test(k)) {
            const arr = Array.isArray(v) ? v : [v];
            for (const item of arr) {
              const direct = toEntry(item);
              if (direct) out.push(direct);
              if (item && typeof item === 'object') {
                for (const nested of Object.values(item as any)) {
                  const nestedArr = Array.isArray(nested) ? nested : [nested];
                  for (const n of nestedArr) {
                    const e = toEntry(n);
                    if (e) out.push(e);
                  }
                }
              }
            }
          }
          collectByKeyPattern(v, keyPattern, out);
        }
      };

      const uniqByType = (arr: any[]) => {
        const m = new Map<string, any>();
        for (const it of arr) {
          const k = String(it?.fillType || '').toUpperCase();
          if (!k) continue;
          const prev = m.get(k);
          if (!prev) {
            m.set(k, { ...it });
            continue;
          }
          m.set(k, {
            fillType: k,
            amount: parseNum(prev.amount) + parseNum(it.amount),
            capacity: Math.max(parseNum(prev.capacity), parseNum(it.capacity)),
            percent: Math.max(parseNum(prev.percent), parseNum(it.percent)),
            title: prev.title || it.title,
          });
        }
        return [...m.values()];
      };

      for (let idx = 0; idx < husbandries.length; idx++) {
        const h = husbandries[idx];
        const attr = h.$ || h;

        // clusters: used to derive animalType + counts
        let clusters = h.cluster || [];
        if (!Array.isArray(clusters)) clusters = [clusters];

        let totalAnimals = 0;
        let healthSum = 0;
        let reproSum = 0;
        const typeWeights: Record<string, number> = {};

        for (const c of clusters) {
          const ca = c.$ || c;
          const n = parseNum(ca.numAnimals);
          const health = parseNum(ca.health);
          const repro = parseNum(ca.reproduction);
          const t = String(ca.type || '').toUpperCase();
          totalAnimals += n;
          healthSum += health * n;
          reproSum += repro * n;
          if (t) typeWeights[t] = (typeWeights[t] || 0) + n;
        }

        const dominantType = Object.entries(typeWeights).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        const avgHealth = totalAnimals > 0 ? (healthSum / totalAnimals) : 100;
        const avgRepro = totalAnimals > 0 ? (reproSum / totalAnimals) : 0;

        // foods
        let foods = h.food || [];
        if (!Array.isArray(foods)) foods = [foods];
        const food = foods.map((f: any) => {
          const fa = f.$ || f;
          const title = fa.title || '';
          const cap = parseNum(fa.capacity);
          const fill = parseNum(fa.fillLevel);
          let pct = parseNum(fa.percent);
          if (!pct && cap > 0) pct = (fill / cap) * 100;
          if (!pct) pct = parsePctFromTitle(title);
          return {
            index: parseNum(fa.index),
            title,
            fillType: normalizeType(fa.fillType || fa.type || title || ''),
            percent: Math.max(0, Math.min(100, pct)),
            capacity: cap,
            fillLevel: fill
          };
        });

        // outputs / by-products (milk, manure, slurry, wool, eggs...)
        const rawOutputs: any[] = [];
        collectByKeyPattern(h, /^(output|outputs|product|products|byproduct|byproducts|milk|manure|slurry|wool|egg|eggs)/i, rawOutputs);
        let outputs = uniqByType(rawOutputs).filter(x => x.fillType);

        if (outputs.length === 0 && h.output) {
          const list = Array.isArray(h.output) ? h.output : [h.output];
          outputs = uniqByType(list.map((o: any) => toEntry(o)).filter(Boolean));
        }

        const uniqueSource =
          attr.husbandryId ??
          attr.uniqueId ??
          attr.id ??
          attr.placeableId ??
          attr.nodeId ??
          idx;
        const uniquePart = slug(String(uniqueSource)) || String(idx);
        const husbandryId = `${attr.farmId || '0'}:${slug(attr.name || 'husbandry')}:${dominantType || attr.animalTypeIndex || 'type'}:${uniquePart}`;

        await storage.upsertAnimal({
          husbandryId,
          name: attr.name || 'Husbandry',
          farmId: String(attr.farmId || ''),
          animalType: dominantType || String(attr.animalTypeIndex || ''),
          numAnimals: Math.round(totalAnimals),
          maxAnimals: 0,
          health: avgHealth,
          productivity: avgRepro, // najbolji proxy koji imamo u ovom exportu
          reproduction: avgRepro,
          food,
          outputs
        });
      }
    } catch (e) {
      console.error("Error parsing animals:", e);
    }
  }

  private async parseAndStoreWeather(xml: string) {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });

      // New format: <forecast><forecast format="hourly|daily" .../></forecast>
      if (result.forecast && result.forecast.forecast) {
        let items = result.forecast.forecast;
        if (!Array.isArray(items)) items = [items];

        const mapType = (t: any) => {
          const n = Number(t);
          if (n === 1) return 'clear';
          if (n === 2) return 'cloudy';
          if (n === 3) return 'cloudy';
          if (n === 4) return 'rain';
          if (n === 5) return 'snow';
          return 'unknown';
        };

        const numOrNull = (v: any) => {
          if (v == null) return null;
          const s = String(v).trim();
          if (!s || s.toLowerCase() === 'nil') return null;
          const n = Number(s);
          return Number.isFinite(n) ? n : null;
        };

        const norm = (it: any) => {
          const a = it.$ || it;
          return {
            format: a.format,
            day: Number(a.day),
            time: numOrNull(a.time) ?? 0,
            weatherType: mapType(a.type),
            temperature: numOrNull(a.temp),
            minTemp: numOrNull(a.lowTemp),
            maxTemp: numOrNull(a.highTemp),
            windSpeed: numOrNull(a.windSpeed),
            windDirection: numOrNull(a.windDirection)
          };
        };

        type ParsedWeatherPoint = {
          format: string;
          day: number;
          time: number;
          weatherType: string;
          temperature: number | null;
          minTemp: number | null;
          maxTemp: number | null;
          windSpeed: number | null;
          windDirection: number | null;
        };

        const parsed: ParsedWeatherPoint[] = items.map(norm);
        const hourly = parsed.filter((p: ParsedWeatherPoint) => p.format === 'hourly')
          .sort((a: ParsedWeatherPoint, b: ParsedWeatherPoint) => (a.day - b.day) || (a.time - b.time));
        const daily = parsed.filter((p: ParsedWeatherPoint) => p.format === 'daily')
          .sort((a: ParsedWeatherPoint, b: ParsedWeatherPoint) => a.day - b.day);

        const current = hourly[0] ? {
          day: hourly[0].day,
          weatherType: hourly[0].weatherType,
          temperature: hourly[0].temperature ?? 'N/A',
          windSpeed: hourly[0].windSpeed,
          windDirection: hourly[0].windDirection
        } : {};

        const weatherData = {
          current,
          hourly: hourly.slice(0, 12).map((h: ParsedWeatherPoint) => ({
            day: h.day,
            weatherType: h.weatherType,
            temperature: h.temperature,
            windSpeed: h.windSpeed,
            windDirection: h.windDirection,
            time: h.time
          })),
          daily: daily.slice(0, 7).map((d: ParsedWeatherPoint) => ({
            day: d.day,
            weatherType: d.weatherType,
            minTemp: d.minTemp,
            maxTemp: d.maxTemp
          }))
        };

        await storage.upsertWeather(weatherData);
        return;
      }

      // Legacy formats
      if (result.weatherForecast || result.WeatherForecast) {
        const forecast = result.weatherForecast || result.WeatherForecast;
        let days = forecast.day || [];
        if (!Array.isArray(days)) days = [days];

        const weatherData = {
          current: days[0] ? {
            weatherType: days[0].$?.weatherType || days[0].weatherType || "unknown",
            temperature: parseFloat(days[0].$?.temperature || days[0].temperature || "20")
          } : {},
          hourly: [],
          daily: days.map((d: any) => ({
            day: d.$?.day || d.day,
            weatherType: d.$?.weatherType || d.weatherType,
            minTemp: parseFloat(d.$?.minTemp || d.minTemp || "10"),
            maxTemp: parseFloat(d.$?.maxTemp || d.maxTemp || "20")
          }))
        };
        await storage.upsertWeather(weatherData);
      } else if (result.environment) {
        const env = result.environment;
        const weatherData = {
          current: env.weather?.$?.current || "unknown",
          hourly: env.weather?.forecast || [],
          daily: []
        };
        await storage.upsertWeather(weatherData);
      }
    } catch (e) {
      console.error("Error parsing weather:", e);
    }
  }

  private async parseAndStoreFarms(xml: string) {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      let farmsData = result.farms?.farm || [];
      if (!Array.isArray(farmsData)) farmsData = [farmsData];

      const activeFarmIds: string[] = [];

      for (const f of farmsData) {
        const attr = f.$ || f;
        if (attr.farmId && attr.farmId !== "0") {
          const farmName = String(attr.name || "");
          if (/wallet/i.test(farmName)) continue;
          const farmId = String(attr.farmId ?? attr.farmID ?? '');
          activeFarmIds.push(farmId);
          await storage.upsertFarm({
            farmId,
            name: attr.name || `Farm ${attr.farmId}`,
            owner: attr.owner,
            balance: parseFloat(attr.money || attr.balance || "0")
          });
        }
      }

      // Remove farms from DB that no longer exist in the savegame
      if (activeFarmIds.length > 0) {
        const removed = await storage.deleteFarmsNotIn(activeFarmIds);
        if (removed > 0) {
          console.log(`[SYNC] Removed ${removed} stale farm(s) from DB`);
        }
      }
    } catch (e) {
      console.error("Error parsing farms:", e);
    }
  }

  private async parseAndStorePlayers(xml: string, farmByUserId?: Map<string, string>, webStatsOnlineNames?: string[] | null, skipPresenceNotify?: boolean) {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      let playersData: any[] = [];
      const direct = result.players?.player || result.playerStats?.player || [];
      if (Array.isArray(direct)) playersData = direct;
      else if (direct && typeof direct === 'object') playersData = [direct];

      if (!playersData.length) {
        const allPlayers = this.findNodesByKey(result, 'player');
        playersData = allPlayers.filter((p: any) => {
          const a = p?.$ || p || {};
          return !!(a.uniqueUserId || a.uniqueId || a.userId || a.id || a.name || a.playerName || a.nickname);
        });
      }

      // Build WebStats name set for authoritative online check (case-insensitive)
      const wsNamesSet: Set<string> | null = Array.isArray(webStatsOnlineNames)
        ? new Set(webStatsOnlineNames.map(n => n.toLowerCase().trim()))
        : null;
      // WebStats is available and reports 0 players → nobody is actually online
      const webStatsReportsEmpty = Array.isArray(webStatsOnlineNames) && webStatsOnlineNames.length === 0;

      // Snapshot previous online state (for join/leave notifications)
      const before = await storage.getPlayers();
      const wasOnline = new Map(before.map(p => [p.uniqueUserId, !!p.isOnline]));
      const beforeById = new Map(before.map(p => [String(p.uniqueUserId || ''), p]));

      const hasExplicitOnlineFlags = playersData.some((p: any) => {
        const a = p?.$ || p || {};
        return a.isOnline != null || a.online != null;
      });

      const playerStatsIsSnapshot = ['1', 'true', 'yes', 'on']
        .includes(String(process.env.PLAYERSTATS_ONLINE_SNAPSHOT ?? 'true').trim().toLowerCase());
      // When WebStats reports empty server, override snapshot to avoid false positives
      const effectiveSnapshot = playerStatsIsSnapshot && !webStatsReportsEmpty;
      const shouldResetBeforeUpsert = hasExplicitOnlineFlags || effectiveSnapshot || webStatsReportsEmpty;

      // First mark all offline, then mark listed players online.
      if (shouldResetBeforeUpsert) {
        await storage.setAllPlayersOffline();
      }

      const nowOnlineIds: string[] = [];

      for (const p of playersData) {
        const attr = p.$ || p;
        const uniqueId = attr.uniqueUserId || attr.uniqueId || attr.userId || attr.id;
        if (!uniqueId) continue;

        const playTimeHours = this.coercePlayTimeHours(attr);
        const onlineFlag =
          (attr.isOnline === "true" || attr.online === "true" || attr.isOnline === true || attr.online === true);

        const playerName = String(attr.name || attr.playerName || attr.nickname || '').trim();

        // Determine online status with priority:
        // 1. WebStats (authoritative when available)
        // 2. Explicit XML online flags
        // 3. Snapshot assumption (only when webstats unavailable)
        let isOnline: boolean;
        if (wsNamesSet !== null) {
          // WebStats is authoritative: player is online only if listed in webstats
          isOnline = wsNamesSet.has(playerName.toLowerCase());
        } else if (hasExplicitOnlineFlags) {
          isOnline = onlineFlag;
        } else {
          const prev = beforeById.get(String(uniqueId));
          isOnline = playerStatsIsSnapshot ? true : !!prev?.isOnline;
        }

        if (isOnline) nowOnlineIds.push(String(uniqueId));

        // When runtime stats (playerTimeStats.xml) will handle playTime, do NOT overwrite
        // with game-time inflated values from playerStats.xml (g_currentMission.time is
        // affected by time acceleration e.g. 15x speed = 15x inflated hours).
        // Only update name, farmId, isOnline here — let setRuntimeStats set correct playTime.
        const prev = beforeById.get(String(uniqueId));
        const upsertData: any = {
          uniqueUserId: String(uniqueId),
          name: attr.name || attr.playerName || attr.nickname || `Player ${uniqueId}`,
          farmId: (attr.farmId ?? (farmByUserId?.get(String(uniqueId)) ?? null)) as any,
          isOnline
        };
        if (!skipPresenceNotify) {
          // No runtime stats available — playerStats.xml is the only source of playTime
          upsertData.playTime = isFinite(playTimeHours) ? playTimeHours : 0;
        } else {
          // Runtime stats will handle playTime — preserve existing DB value
          upsertData.playTime = prev?.playTime ?? undefined;
        }

        await storage.upsertPlayer(upsertData);
      }

      // Compare after state to detect join/leave (force check: always detect leave if player disappears from online list)
      const after = await storage.getPlayers();
      const nowOnline = new Map(after.map(p => [p.uniqueUserId, !!p.isOnline]));

      const joined: Array<{ uniqueUserId: string; name: string; farmId: string | null }> = [];
      const left: Array<{ uniqueUserId: string; name: string; farmId: string | null }> = [];

      for (const p of after) {
        const prev = wasOnline.get(p.uniqueUserId) || false;
        const cur = nowOnline.get(p.uniqueUserId) || false;
        if (!prev && cur) joined.push({ uniqueUserId: p.uniqueUserId, name: p.name, farmId: (p.farmId as any) || null });
        if (prev && !cur) left.push({ uniqueUserId: p.uniqueUserId, name: p.name, farmId: (p.farmId as any) || null });
      }

      // Force check: if any player was online before but is missing from the after list, treat as left
      for (const [uniqueUserId, wasOnlineVal] of wasOnline.entries()) {
        if (wasOnlineVal && !nowOnline.has(uniqueUserId)) {
          const prevPlayer = beforeById.get(String(uniqueUserId));
          if (prevPlayer) {
            left.push({ uniqueUserId: prevPlayer.uniqueUserId, name: prevPlayer.name, farmId: (prevPlayer.farmId as any) || null });
          }
        }
      }

      // Only emit presence notifications if runtime stats won't handle it
      // (avoids two conflicting paths both firing join/leave events)
      if ((joined.length || left.length) && !skipPresenceNotify) {
        try {
          await bot.notifyPlayerPresence({ joined, left });
        } catch (e) {
          console.error("Presence notify error:", e);
        }
      }

      // Update public player-hours leaderboard state (monotonic + rolling 30 days)
      // SKIP when runtime stats will handle it — playerStats.xml uses game-time minutes
      // which are inflated by time acceleration (e.g. 15x speed = 15x hours).
      // playerTimeStats.xml (via setRuntimeStats) uses correct real-time milliseconds.
      if (!skipPresenceNotify) {
        try {
          updatePlayerHoursFromPresenceSnapshot({ users: after.map((p: any) => ({ userId: p.uniqueUserId, name: p.name, playTime: p.playTime })) });
          bumpCount('playerHoursUpdated');
        } catch (e) {
          console.error('Player hours update failed:', e);
        }
      }

    } catch (e) {
      console.error("Error parsing players:", e);
    }
  }

  private async parsePlayerTracking(tracksXml?: string | null, sessionsXml?: string | null): Promise<{
    tracks?: Array<{ id: string; nickname: string; sessionStartMs?: number; lastMoveMs?: number; distanceM: number; activeMs: number; idleMs: number; points: Array<{ t: number; x: number; z: number; mode?: string }> }>;
    sessions?: Array<{ id: string; nickname: string; startedAtMs?: number; endedAtMs?: number; distanceM: number; activeMs: number; idleMs: number; reason?: string }>;
  }> {
    const out: any = {};
    try {
      if (tracksXml) {
        const t = await parseStringPromise(tracksXml, { explicitArray: false, ignoreAttrs: false });
        let players: any[] = [];
        const direct = t.playerTracks?.player || [];
        if (Array.isArray(direct)) players = direct;
        else if (direct && typeof direct === 'object') players = [direct];

        if (!players.length) {
          const allPlayers = this.findNodesByKey(t, 'player');
          players = allPlayers.filter((p: any) => {
            const a = p?.$ || p || {};
            return !!(a.id || a.uniqueUserId || a.uniqueId || a.nickname || a.name);
          });
        }

        out.tracks = players.map((p: any) => {
          const attr = p.$ || p;
          const points = this.extractTrackPoints(p);

          const mappedPoints = points
            .map((pt: any) => {
              const a = pt.$ || pt;
              // Track point timestamps are game-time (not epoch) — use raw numeric value
              const tt = Number(a.t ?? a.time ?? a.ts ?? a.timestamp ?? a.ms ?? 0);
              const x = Number(a.x ?? a.posX ?? a.worldX ?? a.px ?? 0);
              const z = Number(a.z ?? a.posZ ?? a.worldZ ?? a.pz ?? 0);
              if (!Number.isFinite(tt) || !Number.isFinite(x) || !Number.isFinite(z)) return null;
              return { t: tt, x, z, mode: a.mode || a.state || a.activity };
            })
            .filter(Boolean);

          const normalizedSessionStart = this.normalizeEpochMs(attr.sessionStartMs ?? attr.startedAtMs);
          const normalizedLastMove = this.normalizeEpochMs(attr.lastMoveMs ?? attr.lastSeenAtMs);

          return {
            id: String(attr.uniqueUserId ?? attr.uniqueId ?? attr.userId ?? attr.id ?? ''),
            nickname: String(attr.nickname ?? attr.name ?? attr.playerName ?? ''),
            sessionStartMs: normalizedSessionStart,
            lastMoveMs: normalizedLastMove,
            distanceM: Number(attr.distanceM ?? attr.distance ?? 0),
            activeMs: Number(attr.activeMs ?? attr.movingMs ?? 0),
            idleMs: Number(attr.idleMs ?? attr.afkMs ?? 0),
            points: mappedPoints,
          };
        }).filter((x: any) => x.id && x.points?.length);
      }
    } catch (e) {
      console.error("Error parsing playerTracks.xml:", e);
    }

    try {
      if (sessionsXml) {
        const s = await parseStringPromise(sessionsXml, { explicitArray: false, ignoreAttrs: false });
        let sessions: any[] = [];
        const direct = s.playerSessionHistory?.session || [];
        if (Array.isArray(direct)) sessions = direct;
        else if (direct && typeof direct === 'object') sessions = [direct];

        if (!sessions.length) {
          const allSessions = this.findNodesByKey(s, 'session');
          sessions = allSessions.filter((sess: any) => {
            const a = sess?.$ || sess || {};
            return !!(a.id || a.uniqueUserId || a.uniqueId || a.nickname || a.name);
          });
        }

        out.sessions = sessions.map((sess: any) => {
          const a = sess.$ || sess;
          const normalizedStarted = this.normalizeEpochMs(a.startedAtMs ?? a.sessionStartMs);
          const normalizedEnded = this.normalizeEpochMs(a.endedAtMs ?? a.sessionEndMs);
          return {
            id: String(a.id ?? a.uniqueUserId ?? a.uniqueId ?? ''),
            nickname: String(a.nickname ?? a.name ?? a.playerName ?? ''),
            startedAtMs: normalizedStarted,
            endedAtMs: normalizedEnded,
            distanceM: Number(a.distanceM ?? a.distance ?? 0),
            activeMs: Number(a.activeMs ?? a.movingMs ?? 0),
            idleMs: Number(a.idleMs ?? a.afkMs ?? 0),
            reason: a.reason != null ? String(a.reason) : undefined,
          };
        }).filter((x: any) => x.id);
      }
    } catch (e) {
      console.error("Error parsing playerSessionHistory.xml:", e);
    }

    return out;
  }

async parseAndStorePlayersFromTimeStats(xml: string) {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      let playersData: any[] = [];
      const direct = result.playerTimeStats?.player || [];
      if (Array.isArray(direct)) playersData = direct;
      else if (direct && typeof direct === 'object') playersData = [direct];

      if (!playersData.length) {
        const allPlayers = this.findNodesByKey(result, 'player');
        playersData = allPlayers.filter((p: any) => {
          const a = p?.$ || p || {};
          return !!(a.totalOnlineMs || a.nickname || a.uniqueUserId || a.uniqueId || a.id);
        });
      }

      // Keep existing online flags because playerTimeStats is cumulative (not a presence snapshot).
      const existing = await storage.getPlayers();
      const existingMap = new Map(existing.map(p => [p.uniqueUserId, p]));

      for (const p of playersData) {
        const attr = p.$ || p;
        const uniqueId = attr.uniqueUserId || attr.uniqueId || attr.userId || attr.id;
        if (!uniqueId) continue;

        const nickname = attr.nickname || attr.playerName || attr.name || `Player ${uniqueId}`;
        const totalOnlineMs = parseFloat(attr.totalOnlineMs || "0");
        const totalAfkMs = parseFloat(attr.totalAfkMs || "0");
        const totalMs = totalOnlineMs + totalAfkMs;
        const playTimeHours = totalMs / 3600000;

        const prev = existingMap.get(String(uniqueId));
        await storage.upsertPlayer({
          uniqueUserId: String(uniqueId),
          name: nickname,
          farmId: prev?.farmId ?? null,
          playTime: isFinite(playTimeHours) ? playTimeHours : (prev?.playTime ?? 0),
          isOnline: prev?.isOnline ?? false,
        });
      }

      // Update leaderboard only for players parsed from this XML (not all stored players —
      // stale players from previous saves would pollute the leaderboard).
      try {
        const parsedUsers = playersData.map((p: any) => {
          const a = p.$ || p;
          const uid = String(a.uniqueUserId || a.uniqueId || a.userId || a.id || '');
          const nick = String(a.nickname || a.playerName || a.name || uid);
          const onMs = parseFloat(a.totalOnlineMs || '0') || 0;
          const afkMs = parseFloat(a.totalAfkMs || '0') || 0;
          return { userId: uid, name: nick, playTime: (onMs + afkMs) / 3600000, afkTime: afkMs / 3600000 };
        }).filter((u: any) => u.userId);
        if (parsedUsers.length) {
          updatePlayerHoursFromPresenceSnapshot({ users: parsedUsers });
          bumpCount('playerHoursUpdated');
        }
      } catch (e) {
        console.error('Player hours update (fallback) failed:', e);
      }
    } catch (e) {
      console.error("Failed to parse playerTimeStats.xml for players:", e);
    }
  }

async parseRuntimeStats(playerTimeXml: string | null, vehicleUsageXml: string | null): Promise<{
  playerTimes: Array<{ id: string; nickname: string; uniqueUserId?: string; farmId?: string; totalOnlineMs: number; totalAfkMs: number; lastOnlineAt?: string; lastSeenAtMs?: number }>;
    vehicleUsage: Array<{ uniqueId: string; name: string; farmId?: string; totalMs: number; movingMs: number; idleMs: number; players: Array<{ id: string; nickname: string; totalMs: number; movingMs: number; idleMs: number; lastUsedAt?: string }> }>;
  }> {
    const out = { playerTimes: [], vehicleUsage: [] } as any;

    // playerTimeStats.xml
    if (playerTimeXml) {
      try {
        const result = await parseStringPromise(playerTimeXml, { explicitArray: false, ignoreAttrs: false });
        let playersData: any[] = [];
        const direct = result.playerTimeStats?.player || [];
        if (Array.isArray(direct)) playersData = direct;
        else if (direct && typeof direct === 'object') playersData = [direct];

        if (!playersData.length) {
          const allPlayers = this.findNodesByKey(result, 'player');
          playersData = allPlayers.filter((p: any) => {
            const a = p?.$ || p || {};
            return !!(a.totalOnlineMs || a.totalAfkMs || a.nickname || a.uniqueUserId || a.id);
          });
        }
        out.playerTimes = playersData
          .map((p: any) => {
            const a = p.$ || p;
            return {
              id: String(a.uniqueUserId || a.uniqueId || a.userId || a.id || ''),
              nickname: String(a.nickname || a.playerName || a.name || ''),
              uniqueUserId: a.uniqueUserId ? String(a.uniqueUserId) : (a.uniqueId ? String(a.uniqueId) : (a.userId ? String(a.userId) : undefined)),
              farmId: a.farmId ? String(a.farmId) : (a.farmID ? String(a.farmID) : undefined),
              totalOnlineMs: Number(a.totalOnlineMs || 0),
              totalAfkMs: Number(a.totalAfkMs || 0),
              lastOnlineAt: a.lastOnlineAt ? String(a.lastOnlineAt) : (a.lastSeenAt ? String(a.lastSeenAt) : undefined),
              lastSeenAtMs: a.lastSeenAtMs ? Number(a.lastSeenAtMs) : (a.lastMoveMs ? Number(a.lastMoveMs) : undefined),
            };
          })
          .filter((p: any) => p.id);
      } catch (e) {
        console.error('Error parsing playerTimeStats.xml:', e);
      }
    }

    // vehicleUsageStats.xml
    if (vehicleUsageXml) {
      try {
        const result = await parseStringPromise(vehicleUsageXml, { explicitArray: false, ignoreAttrs: false });
        let vehiclesData = result.vehicleUsageStats?.vehicle || [];
        if (!Array.isArray(vehiclesData)) vehiclesData = [vehiclesData];
        out.vehicleUsage = vehiclesData
          .map((v: any) => {
            const a = v.$ || v;
            let players = v.player || [];
            if (!Array.isArray(players)) players = [players];
            const parsedPlayers = players
              .map((vp: any) => {
                const pa = vp.$ || vp;
                return {
                  id: String(pa.id || ''),
                  nickname: String(pa.nickname || ''),
                  totalMs: Number(pa.totalMs || 0),
                  movingMs: Number(pa.movingMs || 0),
                  idleMs: Number(pa.idleMs || 0),
                  lastUsedAt: pa.lastUsedAt ? String(pa.lastUsedAt) : undefined,
                };
              })
              .filter((vp: any) => vp.id);

            return {
              uniqueId: String(a.uniqueId || ''),
              name: String(a.name || ''),
              farmId: a.farmId ? String(a.farmId) : undefined,
              totalMs: Number(a.totalMs || 0),
              movingMs: Number(a.movingMs || 0),
              idleMs: Number(a.idleMs || 0),
              players: parsedPlayers,
            };
          })
          .filter((v: any) => v.uniqueId || v.name);
      } catch (e) {
        console.error('Error parsing vehicleUsageStats.xml:', e);
      }
    }

    return out;
  }

  private async ingestCommandAcksAndEvents(client: ftp.Client, basePath: string): Promise<{ acks: number; events: number }> {
    let ackCount = 0;
    let eventCount = 0;

    const isAckFileName = (name: string) => /^(ack|acks|commandAck|commandResult|confirm-command|confirm-\d|inboxAck)/i.test(name);
    const isEventFileName = (name: string) => /^(event|events|gameplayEvent|gameplayEvents)/i.test(name);

    try {
      const listing = await client.list(basePath);
      const targets = listing
        .map((f: any) => String(f?.name || ''))
        .filter((name: string) => {
          const low = name.toLowerCase();
          if (!(low.endsWith('.json') || low.endsWith('.xml'))) return false;
          return isAckFileName(name) || isEventFileName(name);
        })
        .slice(0, 80);

      for (const fileName of targets) {
        const full = `${basePath}/${fileName}`;
        const content = await this.getFileContent(client, full);
        if (!content) continue;

        try {
          const low = fileName.toLowerCase();
          let parsedAcks: Array<{ commandRef?: string; filename?: string; status?: string; error?: string }> = [];
          let parsedEvents: any[] = [];

          if (low.endsWith('.json')) {
            const data = JSON.parse(content);
            const arrify = (v: any) => Array.isArray(v) ? v : (v ? [v] : []);

            const ackCandidates = [
              ...arrify(data?.acks),
              ...arrify(data?.results),
              ...arrify(data?.commands),
              ...(data && typeof data === 'object' && (data.nonce || data.commandRef || data.id || data.status) ? [data] : [])
            ];

            parsedAcks = ackCandidates
              .map((a: any) => ({
                commandRef: a?.commandRef || a?.nonce || a?.id || a?.commandId,
                filename: a?.filename || a?.file,
                status: a?.status || a?.result,
                error: a?.error || a?.message,
              }))
              .filter((a: any) => !!(a.commandRef || a.filename) && !!a.status);

            const eventCandidates = [
              ...arrify(data?.events),
              ...arrify(data?.gameplayEvents),
              ...(data && typeof data === 'object' && (data.type || data.eventType) ? [data] : [])
            ];
            parsedEvents = eventCandidates.filter((e: any) => !!(e?.type || e?.eventType));
          } else {
            const xml = await parseStringPromise(content, { explicitArray: false, ignoreAttrs: false });

            const ackNodes = [
              ...this.findNodesByKey(xml, 'ack'),
              ...this.findNodesByKey(xml, 'result'),
              // Companion mod writes confirmations as <commands><command confirmation="true" ... />
              ...this.findNodesByKey(xml, 'command').filter((n: any) => {
                const a = n?.$ || n || {};
                return a.confirmation === 'true';
              }),
            ];

            parsedAcks = ackNodes
              .map((n: any) => {
                const a = n?.$ || n || {};
                return {
                  commandRef: a.commandRef || a.nonce || a.id || a.commandId,
                  filename: a.filename || a.file,
                  status: a.status || a.result || (a.confirmation === 'true' ? 'ok' : undefined),
                  error: a.error || a.errorMsg || a.message,
                  info: a.info,
                  before: a.before,
                  after: a.after,
                  amount: a.amount,
                  command: a.command,
                };
              })
              .filter((a: any) => !!(a.commandRef || a.filename) && !!a.status);

            const eventNodes = [
              ...this.findNodesByKey(xml, 'event'),
              ...this.findNodesByKey(xml, 'gameplayEvent')
            ];
            parsedEvents = eventNodes
              .map((n: any) => n?.$ || n)
              .filter((e: any) => !!(e?.type || e?.eventType));
          }

          for (const ack of parsedAcks) {
            try {
              const applied = await bot.applyInboxAck(ack as any);
              if (applied) ackCount += 1;
            } catch {}
          }

          if (parsedEvents.length) {
            try {
              const added = await bot.ingestGameplayEvents(parsedEvents);
              eventCount += Number(added || 0);
            } catch {}
          }

          if (parsedAcks.length || parsedEvents.length) {
            try { await client.remove(full); } catch {}
          }
        } catch {
          // ignore malformed ack/event file
        }
      }
    } catch {
      // ignore LIST/read failures for optional ingest
    }

    return { acks: ackCount, events: eventCount };
  }

  private asArray<T = any>(value: any): T[] {
    if (Array.isArray(value)) return value as T[];
    if (value === null || value === undefined) return [];
    return [value as T];
  }

  private findNodesByKey(root: any, key: string): any[] {
    const out: any[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        out.push(...this.asArray(node[key]));
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') {
          if (Array.isArray(v)) {
            for (const item of v) visit(item);
          } else {
            visit(v);
          }
        }
      }
    };
    visit(root);
    return out;
  }

  private extractTrackPoints(playerNode: any): any[] {
    const direct = this.asArray(playerNode?.point);
    if (direct.length) return direct;

    const nested = this.asArray(playerNode?.points?.point);
    if (nested.length) return nested;

    const altA = this.asArray(playerNode?.trackPoint);
    if (altA.length) return altA;

    const altB = this.asArray(playerNode?.position);
    if (altB.length) return altB;

    const altC = this.asArray(playerNode?.positions?.position);
    if (altC.length) return altC;

    const recursivePoints = this.findNodesByKey(playerNode, 'point');
    if (recursivePoints.length) return recursivePoints;

    const recursiveTrackPoints = this.findNodesByKey(playerNode, 'trackPoint');
    if (recursiveTrackPoints.length) return recursiveTrackPoints;

    return this.findNodesByKey(playerNode, 'position');
  }

  getLastSyncTime(): Date | null {
    return this.lastSyncTime;
  }

  // Parse farmPlayers.xml — returns farm-player mapping + mod settings
  private async parseFarmPlayers(xml: string): Promise<FarmPlayersData | null> {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      const root = result?.farmPlayers;
      if (!root) return null;

      const farms: FarmPlayerEntry[] = [];
      let farmNodes = root.farm;
      if (!farmNodes) farmNodes = [];
      if (!Array.isArray(farmNodes)) farmNodes = [farmNodes];

      for (const f of farmNodes) {
        const attr = f?.$ || f || {};
        const farmId = toNumber(attr.farmId, 0);
        const name = toStringSafe(attr.name, `Farma ${farmId}`);
        const balance = toNumber(attr.balance, 0);
        const loan = toNumber(attr.loan, 0);
        const color = toNumber(attr.color, 0);

        const players: FarmPlayerMember[] = [];
        let playerNodes = f?.player;
        if (!playerNodes) playerNodes = [];
        if (!Array.isArray(playerNodes)) playerNodes = [playerNodes];

        for (const p of playerNodes) {
          const pa = p?.$ || p || {};
          players.push({
            uniqueUserId: toStringSafe(pa.uniqueUserId),
            name: toStringSafe(pa.name),
            isOnline: pa.isOnline === 'true' || pa.isOnline === true,
            isFarmManager: pa.isFarmManager === 'true' || pa.isFarmManager === true,
            isAdmin: pa.isAdmin === 'true' || pa.isAdmin === true,
          });
        }

        farms.push({ farmId, name, balance, loan, color, players });
      }

      // Parse mod settings
      let modSettings: Record<string, any> = {};
      const msNode = root.modSettings;
      if (msNode) {
        const msAttr = msNode.$ || msNode;
        for (const [k, v] of Object.entries(msAttr)) {
          if (k === '$') continue;
          if (v === 'true' || v === true) modSettings[k] = true;
          else if (v === 'false' || v === false) modSettings[k] = false;
          else {
            const num = Number(v);
            modSettings[k] = Number.isFinite(num) ? num : v;
          }
        }
      }

      return { farms, modSettings };
    } catch (e) {
      console.error('parseFarmPlayers error:', e);
      return null;
    }
  }

  private async parseModErrorLog(xml: string): Promise<ModErrorEntry[]> {
    try {
      const result = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
      const root = result?.modErrorLog;
      if (!root) return [];

      let errorNodes = root.error;
      if (!errorNodes) return [];
      if (!Array.isArray(errorNodes)) errorNodes = [errorNodes];

      const entries: ModErrorEntry[] = [];
      for (const e of errorNodes) {
        const attr = e?.$ || e || {};
        entries.push({
          time: toStringSafe(attr.time, '??:??'),
          source: toStringSafe(attr.source, 'unknown'),
          message: toStringSafe(attr.message, ''),
        });
      }
      return entries;
    } catch (e) {
      console.error('parseModErrorLog error:', e);
      return [];
    }
  }
}

export interface FarmPlayerMember {
  uniqueUserId: string;
  name: string;
  isOnline: boolean;
  isFarmManager: boolean;
  isAdmin: boolean;
}

export interface FarmPlayerEntry {
  farmId: number;
  name: string;
  balance: number;
  loan: number;
  color: number;
  players: FarmPlayerMember[];
}

export interface FarmPlayersData {
  farms: FarmPlayerEntry[];
  modSettings: Record<string, any>;
}

export interface ModErrorEntry {
  time: string;
  source: string;
  message: string;
}

export const syncService = new FarmSyncService();
