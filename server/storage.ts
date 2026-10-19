import { MongoClient, Db, Collection, ObjectId } from "mongodb";
import mysql from "mysql2/promise";
import { randomUUID } from "crypto";
import { db } from "./db";
import { 
  botLogs, type InsertBotLog, type BotLog,
  farms, type Farm, type InsertFarm,
  fields, type Field, type InsertField,
  vehicles, type Vehicle, type InsertVehicle,
  silos, type Silo, type InsertSilo,
  productions, type Production, type InsertProduction,
  animals, type Animal, type InsertAnimal,
  jobs, type Job, type InsertJob,
  alerts, type Alert, type InsertAlert,
  weather, type Weather, type InsertWeather,
  deployedPanels, type DeployedPanel, type InsertDeployedPanel,
  players, type Player, type InsertPlayer,
  playerLinks, type PlayerLink, type InsertPlayerLink
} from "@shared/schema";
import { desc, eq, and, isNull, notInArray } from "drizzle-orm";

export interface IStorage {
  log(log: InsertBotLog): Promise<BotLog>;
  getLogs(limit?: number): Promise<BotLog[]>;
  getFarms(): Promise<Farm[]>;
  upsertFarm(farm: InsertFarm): Promise<Farm>;
  deleteFarmsNotIn(activeFarmIds: string[]): Promise<number>;
  getFields(): Promise<Field[]>;
  upsertField(field: InsertField): Promise<Field>;
  getVehicles(): Promise<Vehicle[]>;
  upsertVehicle(vehicle: InsertVehicle): Promise<Vehicle>;
  clearVehicles(): Promise<void>;
  getSilos(): Promise<Silo[]>;
  upsertSilo(silo: InsertSilo): Promise<Silo>;
  clearSilos(): Promise<void>;
  getProductions(): Promise<Production[]>;
  upsertProduction(production: InsertProduction): Promise<Production>;
  clearProductions(): Promise<void>;
  getAnimals(): Promise<Animal[]>;
  clearAnimals(): Promise<void>;
  upsertAnimal(animal: InsertAnimal): Promise<Animal>;
  getWeather(): Promise<Weather | null>;
  upsertWeather(weatherData: any): Promise<void>;
  upsertServerInfo(info: Record<string, any>): Promise<void>;
  getJobs(): Promise<Job[]>;
  getJob(jobId: number): Promise<Job | null>;
  createJob(job: InsertJob): Promise<Job>;
  updateJob(jobId: number, updates: Partial<InsertJob>): Promise<Job>;
  getAlerts(): Promise<Alert[]>;
  createAlert(alert: InsertAlert): Promise<Alert>;
  getDeployedPanel(channelId: string, panelType: string, farmId?: string | null): Promise<DeployedPanel | null>;
  getDeployedPanelByChannel(channelId: string, panelType: string): Promise<DeployedPanel | null>;
  upsertDeployedPanel(panel: InsertDeployedPanel): Promise<DeployedPanel>;
  getDeployedPanels(): Promise<DeployedPanel[]>;
  deleteDeployedPanel(id: number): Promise<void>;
  getPlayers(): Promise<Player[]>;
  upsertPlayer(player: InsertPlayer): Promise<Player>;
  addSessionPlayTime(uniqueUserId: string, hoursToAdd: number): Promise<void>;
  resetAllPlayTimes(): Promise<void>;
  setPlayerOffline(uniqueUserId: string): Promise<void>;
  setAllPlayersOffline(): Promise<void>;
  setPlayerFarm(uniqueUserId: string, farmId: string | null): Promise<void>;

  // Manual identity linking (admin-only)
  getPlayerLinks(): Promise<PlayerLink[]>;
  getPlayerLinkByDiscord(discordUserId: string): Promise<PlayerLink | null>;
  upsertPlayerLink(link: InsertPlayerLink): Promise<PlayerLink>;
  deletePlayerLinkByDiscord(discordUserId: string): Promise<void>;

  // Removed players tracking
  getRemovedPlayers(): Promise<any[]>;
  addRemovedPlayer(data: { discordUserId: string; discordName?: string; uniqueUserId?: string; playerName?: string; defaultFarmId?: string; reason?: string }): Promise<any>;
  findRemovedByGameId(uniqueUserId: string): Promise<any[]>;

  // Per-guild channel config
  getGuildChannelConfig(guildId: string): Promise<any | null>;
  saveGuildChannelConfig(guildId: string, config: any): Promise<void>;

  // Backup & Transcript storage (MongoDB)
  saveBackup(backup: { name: string; guildId: string; data: any; channelCount: number; messageCount: number; auto?: boolean }): Promise<{ id: string }>;
  listBackups(guildId: string): Promise<{ id: string; name: string; guildId: string; channelCount: number; messageCount: number; sizeMB: string; auto: boolean; createdAt: Date }[]>;
  getBackup(id: string): Promise<any | null>;
  deleteBackup(id: string): Promise<boolean>;
  // Restore state persistence (resume after restart)
  saveRestoreState(state: { guildId: string; backupId: string; mode: string; channelNames: string[]; targetChannelId?: string | null; targetGuildId?: string | null; channelsDone: string[]; messagesPosted: number; source: string }): Promise<void>;
  getRestoreState(guildId: string): Promise<any | null>;
  deleteRestoreState(guildId: string): Promise<void>;
  saveTranscript(transcript: { guildId: string; ticketName: string; closedBy: string; closedById: string; messageCount: number; content: string; messages: any[] }): Promise<{ id: string }>;
  listTranscripts(guildId: string, limit?: number): Promise<{ id: string; ticketName: string; closedBy: string; messageCount: number; createdAt: Date }[]>;
  getTranscript(id: string): Promise<any | null>;

  // Coop Market System
  getCoopMarket(): Promise<any[]>;
  upsertCoopMarketItem(item: any): Promise<any>;

  // Data maintenance
  pruneOldData(olderThanDays: number): Promise<{ collection: string; deleted: number }[]>;
  updateCoopSupply(fillType: string, addAmount: number): Promise<any>;
  resetDailySupply(): Promise<void>;
  getActiveContracts(): Promise<any[]>;
  getAllContracts(limit?: number): Promise<any[]>;
  createContract(contract: any): Promise<any>;
  updateContractDelivery(contractId: string, addAmount: number): Promise<any>;
  completeContract(contractId: string): Promise<any>;
  expireContracts(): Promise<number>;
  claimContract(contractId: string, farmId: string): Promise<any>;
  getContractsByFarm(farmId: string): Promise<any[]>;
  recordDelivery(delivery: any): Promise<any>;
  getRecentDeliveries(limit?: number): Promise<any[]>;
  getCoopLeaderboard(): Promise<any[]>;
  getDeliveriesByFarm(farmId: string, limit?: number): Promise<any[]>;

  // Coop Admin — extended management
  deleteDelivery(deliveryId: string): Promise<boolean>;
  getDeliveriesFiltered(filter: { farmId?: string; fillType?: string; fromDate?: Date; toDate?: Date }, limit?: number): Promise<any[]>;
  updateContract(contractId: string, updates: Partial<{ fillType: string; requiredAmount: number; bonusPercent: number; expiresAt: Date; status: string; claimedByFarmId: string }>): Promise<any>;
  deleteContract(contractId: string): Promise<boolean>;

  // Guild settings (channel key bindings — stored in MongoDB)
  getGuildSettings(): Promise<Record<string, Record<string, string>>>;
  saveGuildSettings(settings: Record<string, Record<string, string>>): Promise<void>;

  // Custom Contracts (Poslovi na ugovor — game ↔ bot sync)
  getCustomContracts(): Promise<any[]>;
  bulkSyncCustomContracts(contracts: any[]): Promise<{ created: any[]; updated: any[]; removed: any[] }>;
}

// Helper to get db with null check
function getDb() {
  if (!db) {
    throw new Error("PostgreSQL database not available - DATABASE_URL not set");
  }
  return db;
}

// PostgreSQL Storage (for Replit development)
class PostgresStorage implements IStorage {
  async log(log: InsertBotLog): Promise<BotLog> {
    const [entry] = await getDb().insert(botLogs).values(log).returning();
    return entry;
  }

  async getLogs(limit = 50): Promise<BotLog[]> {
    return await getDb().select().from(botLogs).orderBy(desc(botLogs.createdAt)).limit(limit);
  }

  async getFarms(): Promise<Farm[]> {
    const rows = await getDb().select().from(farms);
    // Hide internal/virtual farms (bank wallet etc.) from UI.
    return rows.filter(f => {
      const name = (f as any).name ? String((f as any).name) : '';
      const id = (f as any).farmId ? String((f as any).farmId) : '';
      if (/wallet/i.test(name)) return false;
      if (id.toLowerCase() === 'wallet') return false;
      return true;
    });
  }

  async upsertFarm(farm: InsertFarm): Promise<Farm> {
    const [existing] = await getDb().select().from(farms).where(eq(farms.farmId, farm.farmId));
    if (existing) {
      const [updated] = await getDb().update(farms).set(farm).where(eq(farms.farmId, farm.farmId)).returning();
      return updated;
    }
    const [created] = await getDb().insert(farms).values(farm).returning();
    return created;
  }

  async deleteFarmsNotIn(activeFarmIds: string[]): Promise<number> {
    if (!activeFarmIds.length) return 0;
    const deleted = await getDb().delete(farms).where(notInArray(farms.farmId, activeFarmIds)).returning();
    return deleted.length;
  }

  async getFields(): Promise<Field[]> {
    return await getDb().select().from(fields);
  }

  async upsertField(field: InsertField): Promise<Field> {
    const [existing] = await getDb().select().from(fields).where(eq(fields.fieldId, field.fieldId));
    if (existing) {
      const [updated] = await getDb().update(fields).set(field).where(eq(fields.fieldId, field.fieldId)).returning();
      return updated;
    }
    const [created] = await getDb().insert(fields).values(field).returning();
    return created;
  }

  async getVehicles(): Promise<Vehicle[]> {
    return await getDb().select().from(vehicles);
  }

  async upsertVehicle(vehicle: InsertVehicle): Promise<Vehicle> {
    const [created] = await getDb().insert(vehicles).values(vehicle).returning();
    return created;
  }

  async clearVehicles(): Promise<void> {
    await getDb().delete(vehicles);
  }

  async getSilos(): Promise<Silo[]> {
    return await getDb().select().from(silos);
  }

  async upsertSilo(silo: InsertSilo): Promise<Silo> {
    const [created] = await getDb().insert(silos).values(silo).returning();
    return created;
  }

  async clearSilos(): Promise<void> {
    await getDb().delete(silos);
  }

  async getProductions(): Promise<Production[]> {
    return await getDb().select().from(productions);
  }

  async upsertProduction(production: InsertProduction): Promise<Production> {
    const [created] = await getDb().insert(productions).values(production).returning();
    return created;
  }

  async clearProductions(): Promise<void> {
    await getDb().delete(productions);
  }

  async getAnimals(): Promise<Animal[]> {
    return await getDb().select().from(animals);
  }

  async upsertAnimal(animal: InsertAnimal): Promise<Animal> {
    const [existing] = await getDb().select().from(animals).where(eq(animals.husbandryId, animal.husbandryId));
    if (existing) {
      const [updated] = await getDb().update(animals).set(animal).where(eq(animals.husbandryId, animal.husbandryId)).returning();
      return updated;
    }
    const [created] = await getDb().insert(animals).values(animal).returning();
    return created;
  }

  async clearAnimals(): Promise<void> {
    await getDb().delete(animals);
  }

  async getWeather(): Promise<Weather | null> {
    const [w] = await getDb().select().from(weather).orderBy(desc(weather.updatedAt)).limit(1);
    return w || null;
  }

  async upsertWeather(weatherData: any): Promise<void> {
    const existing = await this.getWeather();
    if (existing) {
      await getDb().update(weather).set({
        current: weatherData.current || {},
        hourly: weatherData.hourly || [],
        daily: weatherData.daily || []
      }).where(eq(weather.id, existing.id));
    } else {
      await getDb().insert(weather).values({
        current: weatherData.current || {},
        hourly: weatherData.hourly || [],
        daily: weatherData.daily || []
      });
    }
  }

  async upsertServerInfo(_info: Record<string, any>): Promise<void> {
    // No-op for PostgreSQL — server_info is MongoDB-only
  }

  async getJobs(): Promise<Job[]> {
    return await getDb().select().from(jobs).orderBy(desc(jobs.createdAt));
  }

  async getJob(jobId: number): Promise<Job | null> {
    const result = await getDb().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    return result[0] || null;
  }

  async createJob(job: InsertJob): Promise<Job> {
    const [created] = await getDb().insert(jobs).values(job).returning();
    return created;
  }

  async updateJob(jobId: number, updates: Partial<InsertJob>): Promise<Job> {
    const [updated] = await getDb().update(jobs).set(updates).where(eq(jobs.id, jobId)).returning();
    return updated;
  }

  async getAlerts(): Promise<Alert[]> {
    return await getDb().select().from(alerts).orderBy(desc(alerts.createdAt)).limit(20);
  }

  async createAlert(alert: InsertAlert): Promise<Alert> {
    const [created] = await getDb().insert(alerts).values(alert).returning();
    return created;
  }

  async getDeployedPanel(channelId: string, panelType: string, farmId?: string | null): Promise<DeployedPanel | null> {
    const conditions = [
      eq(deployedPanels.channelId, channelId),
      eq(deployedPanels.panelType, panelType)
    ];
    
    if (farmId) {
      conditions.push(eq(deployedPanels.farmId, farmId));
    } else {
      conditions.push(isNull(deployedPanels.farmId));
    }
    
    const [panel] = await getDb().select().from(deployedPanels).where(and(...conditions));
    return panel || null;
  }

  async getDeployedPanelByChannel(channelId: string, panelType: string): Promise<DeployedPanel | null> {
    const [panel] = await getDb().select().from(deployedPanels).where(
      and(
        eq(deployedPanels.channelId, channelId),
        eq(deployedPanels.panelType, panelType)
      )
    );
    return panel || null;
  }

  async upsertDeployedPanel(panel: InsertDeployedPanel): Promise<DeployedPanel> {
    const existing = await this.getDeployedPanel(panel.channelId, panel.panelType, panel.farmId);
    if (existing) {
      const [updated] = await getDb().update(deployedPanels)
        .set({ messageId: panel.messageId, updatedAt: new Date() })
        .where(eq(deployedPanels.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await getDb().insert(deployedPanels).values(panel).returning();
    return created;
  }

  async getDeployedPanels(): Promise<DeployedPanel[]> {
    return await getDb().select().from(deployedPanels);
  }

  async deleteDeployedPanel(id: number): Promise<void> {
    await getDb().delete(deployedPanels).where(eq(deployedPanels.id, id));
  }

  async getPlayers(): Promise<Player[]> {
    return await getDb().select().from(players).orderBy(desc(players.playTime));
  }

  async upsertPlayer(player: InsertPlayer): Promise<Player> {
    const [existing] = await getDb().select().from(players).where(eq(players.uniqueUserId, player.uniqueUserId));
    if (existing) {
      const [updated] = await getDb().update(players)
        .set({ 
          ...player, 
          updatedAt: new Date(),
          lastPlayed: player.isOnline ? new Date() : existing.lastPlayed
        })
        .where(eq(players.uniqueUserId, player.uniqueUserId))
        .returning();
      return updated;
    }
    const [created] = await getDb().insert(players).values({
      ...player,
      lastPlayed: new Date()
    }).returning();
    return created;
  }

  async addSessionPlayTime(uniqueUserId: string, hoursToAdd: number): Promise<void> {
    const [existing] = await getDb().select().from(players).where(eq(players.uniqueUserId, uniqueUserId));
    if (existing) {
      const newPlayTime = (existing.playTime || 0) + hoursToAdd;
      await getDb().update(players)
        .set({ playTime: newPlayTime, updatedAt: new Date() })
        .where(eq(players.uniqueUserId, uniqueUserId));
    }
  }

  async resetAllPlayTimes(): Promise<void> {
    await getDb().update(players)
      .set({ playTime: 0, updatedAt: new Date() });
  }

  async setPlayerOffline(uniqueUserId: string): Promise<void> {
    await getDb().update(players)
      .set({ isOnline: false, lastPlayed: new Date(), updatedAt: new Date() })
      .where(eq(players.uniqueUserId, uniqueUserId));
  }

  async setAllPlayersOffline(): Promise<void> {
    await getDb().update(players)
      .set({ isOnline: false, updatedAt: new Date() });
  }

  async setPlayerFarm(uniqueUserId: string, farmId: string | null): Promise<void> {
    await getDb().update(players)
      .set({ farmId, updatedAt: new Date() })
      .where(eq(players.uniqueUserId, uniqueUserId));
  }

  // Manual identity linking (admin-only)
  async getPlayerLinks(): Promise<PlayerLink[]> {
    return await getDb().select().from(playerLinks);
  }

  async getPlayerLinkByDiscord(discordUserId: string): Promise<PlayerLink | null> {
    const [row] = await getDb().select().from(playerLinks).where(eq(playerLinks.discordUserId, discordUserId));
    return row || null;
  }

  async upsertPlayerLink(link: InsertPlayerLink): Promise<PlayerLink> {
    const existing = await this.getPlayerLinkByDiscord(link.discordUserId);
    if (existing) {
      const [row] = await getDb()
        .update(playerLinks)
        .set({ ...link, updatedAt: new Date() })
        .where(eq(playerLinks.discordUserId, link.discordUserId))
        .returning();
      return row;
    }
    const [row] = await getDb().insert(playerLinks).values(link).returning();
    return row;
  }

  async deletePlayerLinkByDiscord(discordUserId: string): Promise<void> {
    await getDb().delete(playerLinks).where(eq(playerLinks.discordUserId, discordUserId));
  }

  async getRemovedPlayers(): Promise<any[]> { return []; }
  async addRemovedPlayer(_data: any): Promise<any> { return null; }
  async findRemovedByGameId(_uniqueUserId: string): Promise<any[]> { return []; }
  async getGuildChannelConfig(_guildId: string): Promise<any | null> { return null; }
  async saveGuildChannelConfig(_guildId: string, _config: any): Promise<void> {}

  // Coop Market stubs (PostgresStorage not used in production)
  async getCoopMarket(): Promise<any[]> { return []; }
  async upsertCoopMarketItem(_item: any): Promise<any> { return null; }
  async updateCoopSupply(_fillType: string, _addAmount: number): Promise<any> { return null; }
  async resetDailySupply(): Promise<void> {}
  async getActiveContracts(): Promise<any[]> { return []; }
  async getAllContracts(_limit?: number): Promise<any[]> { return []; }
  async createContract(_contract: any): Promise<any> { return null; }
  async updateContractDelivery(_contractId: string, _addAmount: number): Promise<any> { return null; }
  async completeContract(_contractId: string): Promise<any> { return null; }
  async expireContracts(): Promise<number> { return 0; }
  async claimContract(_contractId: string, _farmId: string): Promise<any> { return null; }
  async getContractsByFarm(_farmId: string): Promise<any[]> { return []; }
  async recordDelivery(_delivery: any): Promise<any> { return null; }
  async getRecentDeliveries(_limit?: number): Promise<any[]> { return []; }
  async getCoopLeaderboard(): Promise<any[]> { return []; }
  async getDeliveriesByFarm(_farmId: string, _limit?: number): Promise<any[]> { return []; }
  async deleteDelivery(_deliveryId: string): Promise<boolean> { return false; }
  async getDeliveriesFiltered(_filter: any, _limit?: number): Promise<any[]> { return []; }
  async updateContract(_contractId: string, _updates: any): Promise<any> { return null; }
  async deleteContract(_contractId: string): Promise<boolean> { return false; }

  // Backup/Transcript stubs (PostgresStorage not used in production)
  async saveBackup(_b: any): Promise<{ id: string }> { return { id: '' }; }
  async listBackups(_guildId: string): Promise<any[]> { return []; }
  async getBackup(_id: string): Promise<any | null> { return null; }
  async deleteBackup(_id: string): Promise<boolean> { return false; }
  async saveRestoreState(_state: any): Promise<void> {}
  async getRestoreState(_guildId: string): Promise<any | null> { return null; }
  async deleteRestoreState(_guildId: string): Promise<void> {}
  async saveTranscript(_t: any): Promise<{ id: string }> { return { id: '' }; }
  async listTranscripts(_guildId: string, _limit?: number): Promise<any[]> { return []; }
  async getTranscript(_id: string): Promise<any | null> { return null; }
  async getGuildSettings(): Promise<Record<string, Record<string, string>>> { return {}; }
  async saveGuildSettings(_settings: Record<string, Record<string, string>>): Promise<void> {}
  async getCustomContracts(): Promise<any[]> { return []; }
  async bulkSyncCustomContracts(_contracts: any[]): Promise<{ created: any[]; updated: any[]; removed: any[] }> { return { created: [], updated: [], removed: [] }; }
  async pruneOldData(_olderThanDays: number): Promise<{ collection: string; deleted: number }[]> { return []; }

}

type DocumentFilter = Record<string, any>;

class MySqlCursor {
  private sortSpec: Record<string, 1 | -1> | null = null;
  private limitValue: number | null = null;
  private skipValue = 0;

  constructor(private readonly rows: Promise<any[]>) {}

  sort(spec: Record<string, 1 | -1>): MySqlCursor {
    this.sortSpec = spec;
    return this;
  }

  limit(value: number): MySqlCursor {
    this.limitValue = value;
    return this;
  }

  skip(value: number): MySqlCursor {
    this.skipValue = value;
    return this;
  }

  async toArray(): Promise<any[]> {
    let rows = [...await this.rows];
    if (this.sortSpec) {
      const entries = Object.entries(this.sortSpec);
      rows.sort((a, b) => {
        for (const [key, dir] of entries) {
          const av = getPath(a, key);
          const bv = getPath(b, key);
          if (av == null && bv == null) continue;
          if (av == null) return dir === -1 ? 1 : -1;
          if (bv == null) return dir === -1 ? -1 : 1;
          const cmp = normalizeComparable(av) > normalizeComparable(bv) ? 1 : normalizeComparable(av) < normalizeComparable(bv) ? -1 : 0;
          if (cmp !== 0) return dir === -1 ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (this.skipValue) rows = rows.slice(this.skipValue);
    if (this.limitValue != null) rows = rows.slice(0, this.limitValue);
    return rows;
  }
}

class MySqlCollection {
  constructor(private readonly pool: mysql.Pool, private readonly name: string) {}

  find(filter: DocumentFilter = {}, options?: { projection?: Record<string, number> }): MySqlCursor {
    const filtered = this.loadAll().then((docs) =>
      docs.filter((doc) => matchesFilter(doc, filter)).map((doc) => applyProjection(doc, options?.projection))
    );
    return new MySqlCursor(filtered);
  }

  async findOne(filter: DocumentFilter = {}, options?: { sort?: Record<string, 1 | -1>; projection?: Record<string, number> }): Promise<any | null> {
    let cursor = this.find(filter, { projection: options?.projection });
    if (options?.sort) cursor = cursor.sort(options.sort);
    const rows = await cursor.limit(1).toArray();
    return rows[0] || null;
  }

  async insertOne(doc: any): Promise<{ insertedId: string }> {
    const id = stringifyId(doc._id || randomUUID());
    const stored = { ...doc, _id: id };
    await this.pool.execute(
      "INSERT INTO app_documents (collection_name, doc_id, data_json, created_at, updated_at) VALUES (?, ?, CAST(? AS JSON), NOW(), NOW())",
      [this.name, id, JSON.stringify(stored)]
    );
    return { insertedId: id };
  }

  async updateOne(filter: DocumentFilter, update: any, options?: { upsert?: boolean }): Promise<{ modifiedCount: number; upsertedId?: string }> {
    const existing = await this.findOne(filter);
    if (!existing) {
      if (!options?.upsert) return { modifiedCount: 0 };
      const base = plainFilterValues(filter);
      const inserted = applyUpdate({ ...base }, update, true);
      const res = await this.insertOne(inserted);
      return { modifiedCount: 0, upsertedId: res.insertedId };
    }
    const next = applyUpdate({ ...existing }, update, false);
    await this.saveDoc(next);
    return { modifiedCount: 1 };
  }

  async updateMany(filter: DocumentFilter, update: any): Promise<{ modifiedCount: number }> {
    const docs = (await this.loadAll()).filter((doc) => matchesFilter(doc, filter));
    for (const doc of docs) {
      await this.saveDoc(applyUpdate({ ...doc }, update, false));
    }
    return { modifiedCount: docs.length };
  }

  async replaceOne(filter: DocumentFilter, replacement: any, options?: { upsert?: boolean }): Promise<{ modifiedCount: number; upsertedId?: string }> {
    const existing = await this.findOne(filter);
    if (!existing) {
      if (!options?.upsert) return { modifiedCount: 0 };
      const res = await this.insertOne(replacement);
      return { modifiedCount: 0, upsertedId: res.insertedId };
    }
    await this.saveDoc({ ...replacement, _id: existing._id });
    return { modifiedCount: 1 };
  }

  async findOneAndUpdate(filter: DocumentFilter, update: any, options?: { upsert?: boolean; returnDocument?: "after" | "before" }): Promise<any | null> {
    const before = await this.findOne(filter);
    await this.updateOne(filter, update, { upsert: options?.upsert });
    return options?.returnDocument === "before" ? before : this.findOne(filter);
  }

  async deleteOne(filter: DocumentFilter): Promise<{ deletedCount: number }> {
    const doc = await this.findOne(filter);
    if (!doc) return { deletedCount: 0 };
    await this.pool.execute("DELETE FROM app_documents WHERE collection_name = ? AND doc_id = ?", [this.name, stringifyId(doc._id)]);
    return { deletedCount: 1 };
  }

  async deleteMany(filter: DocumentFilter): Promise<{ deletedCount: number }> {
    const docs = (await this.loadAll()).filter((doc) => matchesFilter(doc, filter));
    for (const doc of docs) {
      await this.pool.execute("DELETE FROM app_documents WHERE collection_name = ? AND doc_id = ?", [this.name, stringifyId(doc._id)]);
    }
    return { deletedCount: docs.length };
  }

  async countDocuments(): Promise<number> {
    const [rows] = await this.pool.execute<any[]>("SELECT COUNT(*) AS count FROM app_documents WHERE collection_name = ?", [this.name]);
    return Number(rows[0]?.count || 0);
  }

  aggregate(_pipeline: any[]): { toArray: () => Promise<any[]> } {
    return {
      toArray: async () => {
        if (this.name !== "coopDeliveries") return [];
        const docs = await this.loadAll();
        const grouped = new Map<string, any>();
        for (const doc of docs) {
          const farmId = String(doc.farmId || "");
          const current = grouped.get(farmId) || { _id: farmId, totalEarned: 0, totalAmount: 0, deliveryCount: 0 };
          current.totalEarned += Number(doc.totalEarned || 0);
          current.totalAmount += Number(doc.amount || 0);
          current.deliveryCount += 1;
          grouped.set(farmId, current);
        }
        return [...grouped.values()].sort((a, b) => b.totalEarned - a.totalEarned).slice(0, 20);
      }
    };
  }

  private async loadAll(): Promise<any[]> {
    const [rows] = await this.pool.execute<any[]>("SELECT data_json FROM app_documents WHERE collection_name = ?", [this.name]);
    return rows.map((row) => typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json);
  }

  private async saveDoc(doc: any): Promise<void> {
    const id = stringifyId(doc._id || randomUUID());
    const stored = { ...doc, _id: id };
    await this.pool.execute(
      "INSERT INTO app_documents (collection_name, doc_id, data_json, created_at, updated_at) VALUES (?, ?, CAST(? AS JSON), NOW(), NOW()) ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), updated_at = NOW()",
      [this.name, id, JSON.stringify(stored)]
    );
  }
}

function stringifyId(value: any): string {
  if (value == null) return randomUUID();
  if (typeof value === "object" && typeof value.toString === "function") return value.toString();
  return String(value);
}

function getPath(doc: any, key: string): any {
  return key.split(".").reduce((acc, part) => acc == null ? undefined : acc[part], doc);
}

function normalizeComparable(value: any): any {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).getTime();
  return value;
}

function matchesFilter(doc: any, filter: DocumentFilter): boolean {
  for (const [key, expected] of Object.entries(filter || {})) {
    const actual = key === "_id" ? stringifyId(doc._id) : getPath(doc, key);
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !(expected instanceof ObjectId)) {
      if ("$in" in expected && !expected.$in.map(stringifyId).includes(stringifyId(actual))) return false;
      if ("$nin" in expected && expected.$nin.map(stringifyId).includes(stringifyId(actual))) return false;
      if ("$exists" in expected) {
        const exists = actual !== undefined;
        if (Boolean(expected.$exists) !== exists) return false;
      }
      if ("$lte" in expected && !(normalizeComparable(actual) <= normalizeComparable(expected.$lte))) return false;
      if ("$gte" in expected && !(normalizeComparable(actual) >= normalizeComparable(expected.$gte))) return false;
      if (!["$in", "$nin", "$exists", "$lte", "$gte"].some(op => op in expected)) {
        if (stringifyId(actual) !== stringifyId(expected)) return false;
      }
    } else if (stringifyId(actual) !== stringifyId(expected)) {
      return false;
    }
  }
  return true;
}

function plainFilterValues(filter: DocumentFilter): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(filter || {})) {
    if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof ObjectId)) continue;
    result[key] = key === "_id" ? stringifyId(value) : value;
  }
  return result;
}

function setPath(doc: any, key: string, value: any): void {
  const parts = key.split(".");
  let current = doc;
  while (parts.length > 1) {
    const part = parts.shift()!;
    current[part] = current[part] || {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function applyUpdate(doc: any, update: any, inserting: boolean): any {
  if (!update.$set && !update.$setOnInsert && !update.$inc) return { ...doc, ...update };
  for (const [key, value] of Object.entries(update.$set || {})) setPath(doc, key, value);
  if (inserting) {
    for (const [key, value] of Object.entries(update.$setOnInsert || {})) setPath(doc, key, value);
  }
  for (const [key, value] of Object.entries(update.$inc || {})) {
    setPath(doc, key, Number(getPath(doc, key) || 0) + Number(value || 0));
  }
  return doc;
}

function applyProjection(doc: any, projection?: Record<string, number>): any {
  if (!projection) return doc;
  const clone = JSON.parse(JSON.stringify(doc));
  for (const [key, include] of Object.entries(projection)) {
    if (include === 0) setPath(clone, key, undefined);
  }
  return clone;
}

// MongoDB Storage (for Railway production)
class MongoStorage implements IStorage {
  private client: MongoClient | null = null;
  private database: Db | null = null;

  private async getDb(): Promise<Db> {
    if (this.database) return this.database;

    const mongoUrl = process.env.MONGO_URL;
    if (!mongoUrl) {
      throw new Error("MONGO_URL environment variable is not set");
    }

    this.client = new MongoClient(mongoUrl);
    await this.client.connect();
    this.database = this.client.db();
    console.log("Connected to MongoDB");
    return this.database;
  }

  protected async collection(name: string): Promise<any> {
    const database = await this.getDb();
    return database.collection(name);
  }

  async log(log: InsertBotLog): Promise<BotLog> {
    const col = await this.collection("botLogs");
    const doc = { ...log, createdAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() as any } as BotLog;
  }

  async getLogs(limit = 50): Promise<BotLog[]> {
    const col = await this.collection("botLogs");
    const docs = await col.find().sort({ createdAt: -1 }).limit(limit).toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as BotLog[];
  }

  async getFarms(): Promise<Farm[]> {
    const col = await this.collection("farms");
    const docs = await col.find().toArray();
    return (docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as Farm[]).filter(f => {
      const name = String((f as any).name || '');
      const id = String((f as any).farmId || '');
      if (/wallet/i.test(name)) return false;
      if (id.toLowerCase() === 'wallet') return false;
      return true;
    });
  }

  async upsertFarm(farm: InsertFarm): Promise<Farm> {
    const col = await this.collection("farms");
    await col.updateOne({ farmId: farm.farmId }, { $set: farm }, { upsert: true });
    const doc = await col.findOne({ farmId: farm.farmId });
    return { ...doc, id: doc!._id.toString() as any } as Farm;
  }

  async deleteFarmsNotIn(activeFarmIds: string[]): Promise<number> {
    if (!activeFarmIds.length) return 0;
    const col = await this.collection("farms");
    const result = await col.deleteMany({ farmId: { $nin: activeFarmIds } });
    return result.deletedCount;
  }

  async getFields(): Promise<Field[]> {
    const col = await this.collection("fields");
    const docs = await col.find().toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as Field[];
  }

  async upsertField(field: InsertField): Promise<Field> {
    const col = await this.collection("fields");
    await col.updateOne({ fieldId: field.fieldId }, { $set: { ...field, updatedAt: new Date() } }, { upsert: true });
    const doc = await col.findOne({ fieldId: field.fieldId });
    return { ...doc, id: doc!._id.toString() as any } as Field;
  }

  async getVehicles(): Promise<Vehicle[]> {
    const col = await this.collection("vehicles");
    const docs = await col.find().toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as Vehicle[];
  }

  async upsertVehicle(vehicle: InsertVehicle): Promise<Vehicle> {
    const col = await this.collection("vehicles");
    const doc = { ...vehicle, updatedAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() as any } as Vehicle;
  }

  async clearVehicles(): Promise<void> {
    const col = await this.collection("vehicles");
    await col.deleteMany({});
  }

  async getSilos(): Promise<Silo[]> {
    const col = await this.collection("silos");
    const docs = await col.find().toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as Silo[];
  }

  async upsertSilo(silo: InsertSilo): Promise<Silo> {
    const col = await this.collection("silos");
    const doc = { ...silo, updatedAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() as any } as Silo;
  }

  async clearSilos(): Promise<void> {
    const col = await this.collection("silos");
    await col.deleteMany({});
  }

  async getProductions(): Promise<Production[]> {
    const col = await this.collection("productions");
    const docs = await col.find().toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as Production[];
  }

  async upsertProduction(production: InsertProduction): Promise<Production> {
    const col = await this.collection("productions");
    const doc = { ...production, updatedAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() as any } as Production;
  }

  async clearProductions(): Promise<void> {
    const col = await this.collection("productions");
    await col.deleteMany({});
  }

  async getAnimals(): Promise<Animal[]> {
    const col = await this.collection("animals");
    const docs = await col.find().toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as Animal[];
  }

  async upsertAnimal(animal: InsertAnimal): Promise<Animal> {
    const col = await this.collection("animals");
    await col.updateOne({ husbandryId: animal.husbandryId }, { $set: { ...animal, updatedAt: new Date() } }, { upsert: true });
    const doc = await col.findOne({ husbandryId: animal.husbandryId });
    return { ...doc, id: doc!._id.toString() as any } as Animal;
  }

  async clearAnimals(): Promise<void> {
    const col = await this.collection("animals");
    await col.deleteMany({});
  }

  async getWeather(): Promise<Weather | null> {
    const col = await this.collection("weather");
    const doc = await col.findOne({}, { sort: { updatedAt: -1 } });
    return doc ? ({ ...doc, id: doc._id.toString() as any } as unknown as Weather) : null;
  }

  async upsertWeather(weatherData: any): Promise<void> {
    const col = await this.collection("weather");
    await col.updateOne({}, { 
      $set: { 
        current: weatherData.current || {}, 
        hourly: weatherData.hourly || [], 
        daily: weatherData.daily || [],
        updatedAt: new Date()
      } 
    }, { upsert: true });
  }

  async upsertServerInfo(info: Record<string, any>): Promise<void> {
    const col = await this.collection("server_info");
    await col.updateOne({}, { $set: info }, { upsert: true });
  }

  async getJobs(): Promise<Job[]> {
    const col = await this.collection("jobs");
    const docs = await col.find().sort({ createdAt: -1 }).toArray();
    return docs.map(d => ({ ...d, id: d.id || parseInt(d._id.toString().slice(-8), 16) })) as unknown as Job[];
  }

  async getJob(jobId: number): Promise<Job | null> {
    const col = await this.collection("jobs");
    const doc = await col.findOne({ id: jobId });
    if (!doc) return null;
    return { ...doc, id: doc.id || jobId } as unknown as Job;
  }

  async createJob(job: InsertJob): Promise<Job> {
    const col = await this.collection("jobs");
    // Generate simple incrementing ID for MongoDB
    const lastJob = await col.find().sort({ id: -1 }).limit(1).toArray();
    const newId = (lastJob[0]?.id || 0) + 1;
    const doc = { ...job, id: newId, createdAt: new Date() };
    await col.insertOne(doc);
    return doc as Job;
  }

  async updateJob(jobId: number, updates: Partial<InsertJob>): Promise<Job> {
    const col = await this.collection("jobs");
    await col.updateOne({ id: jobId }, { $set: updates });
    const doc = await col.findOne({ id: jobId });
    return { ...doc, id: jobId } as Job;
  }

  async getAlerts(): Promise<Alert[]> {
    const col = await this.collection("alerts");
    const docs = await col.find().sort({ createdAt: -1 }).limit(20).toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as Alert[];
  }

  async createAlert(alert: InsertAlert): Promise<Alert> {
    const col = await this.collection("alerts");
    const doc = { ...alert, createdAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() as any } as Alert;
  }

  async getDeployedPanel(channelId: string, panelType: string, farmId?: string | null): Promise<DeployedPanel | null> {
    const col = await this.collection("deployedPanels");
    const query: any = { channelId, panelType };
    if (farmId) {
      query.farmId = farmId;
    } else {
      query.farmId = { $in: [null, undefined] };
    }
    const doc = await col.findOne(query);
    return doc ? ({ ...doc, id: doc._id.toString() as any } as unknown as DeployedPanel) : null;
  }

  async getDeployedPanelByChannel(channelId: string, panelType: string): Promise<DeployedPanel | null> {
    const col = await this.collection("deployedPanels");
    const doc = await col.findOne({ channelId, panelType });
    return doc ? ({ ...doc, id: doc._id.toString() as any } as unknown as DeployedPanel) : null;
  }

  async upsertDeployedPanel(panel: InsertDeployedPanel): Promise<DeployedPanel> {
    const col = await this.collection("deployedPanels");
    const query: any = { channelId: panel.channelId, panelType: panel.panelType };
    if (panel.farmId) {
      query.farmId = panel.farmId;
    } else {
      query.farmId = { $in: [null, undefined] };
    }
    
    await col.updateOne(query, { 
      $set: { ...panel, updatedAt: new Date() }, 
      $setOnInsert: { createdAt: new Date() } 
    }, { upsert: true });
    
    const doc = await col.findOne(query);
    return { ...doc, id: doc!._id.toString() as any } as DeployedPanel;
  }

  async getDeployedPanels(): Promise<DeployedPanel[]> {
    const col = await this.collection("deployedPanels");
    const docs = await col.find().toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as DeployedPanel[];
  }

  async deleteDeployedPanel(id: number): Promise<void> {
    const col = await this.collection("deployedPanels");
    // In MongoDB, we store _id as ObjectId, so we need to find by _id string representation
    // Since id comes from the mapped object, we find documents that have that id pattern
    const docs = await col.find().toArray();
    const targetDoc = docs.find(d => d._id.toString() === id.toString());
    if (targetDoc) {
      await col.deleteOne({ _id: targetDoc._id });
    }
  }

  async getPlayers(): Promise<Player[]> {
    const col = await this.collection("players");
    const docs = await col.find().sort({ playTime: -1 }).toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() as any })) as unknown as Player[];
  }

  async upsertPlayer(player: InsertPlayer): Promise<Player> {
    const col = await this.collection("players");
    const existing = await col.findOne({ uniqueUserId: player.uniqueUserId });
    
    const update: any = {
      ...player,
      updatedAt: new Date()
    };
    
    if (player.isOnline) {
      update.lastPlayed = new Date();
    } else if (existing) {
      update.lastPlayed = existing.lastPlayed;
    } else {
      update.lastPlayed = new Date();
    }
    
    await col.updateOne(
      { uniqueUserId: player.uniqueUserId },
      { $set: update, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    
    const doc = await col.findOne({ uniqueUserId: player.uniqueUserId });
    return { ...doc, id: doc!._id.toString() as any } as Player;
  }

  async addSessionPlayTime(uniqueUserId: string, hoursToAdd: number): Promise<void> {
    const col = await this.collection("players");
    const existing = await col.findOne({ uniqueUserId });
    if (existing) {
      const newPlayTime = (existing.playTime || 0) + hoursToAdd;
      await col.updateOne(
        { uniqueUserId },
        { $set: { playTime: newPlayTime, updatedAt: new Date() } }
      );
    }
  }

  async resetAllPlayTimes(): Promise<void> {
    const col = await this.collection("players");
    await col.updateMany({}, { $set: { playTime: 0, updatedAt: new Date() } });
  }

  async setPlayerOffline(uniqueUserId: string): Promise<void> {
    const col = await this.collection("players");
    await col.updateOne(
      { uniqueUserId },
      { $set: { isOnline: false, lastPlayed: new Date(), updatedAt: new Date() } }
    );
  }

  async setAllPlayersOffline(): Promise<void> {
    const col = await this.collection("players");
    await col.updateMany({}, { $set: { isOnline: false, updatedAt: new Date() } });
  }

  async setPlayerFarm(uniqueUserId: string, farmId: string | null): Promise<void> {
    const col = await this.collection("players");
    await col.updateOne({ uniqueUserId }, { $set: { farmId, updatedAt: new Date() } });
  }

  // Manual identity linking (admin-only)
  async getPlayerLinks(): Promise<PlayerLink[]> {
    const col = await this.collection("player_links");
    const docs = await col.find({}).toArray();
    return docs.map((d: any) => ({ ...d, id: d._id.toString() })) as any;
  }

  async getPlayerLinkByDiscord(discordUserId: string): Promise<PlayerLink | null> {
    const col = await this.collection("player_links");
    const doc = await col.findOne({ discordUserId });
    return doc ? ({ ...doc, id: doc._id.toString() } as any) : null;
  }

  async upsertPlayerLink(link: InsertPlayerLink): Promise<PlayerLink> {
    const col = await this.collection("player_links");
    await col.updateOne(
      { discordUserId: link.discordUserId },
      { $set: { ...link, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    const doc = await col.findOne({ discordUserId: link.discordUserId });
    return ({ ...doc, id: doc!._id.toString() } as any);
  }

  async deletePlayerLinkByDiscord(discordUserId: string): Promise<void> {
    const col = await this.collection("player_links");
    await col.deleteOne({ discordUserId });
  }

  // ── Removed players tracking ──
  async getRemovedPlayers(): Promise<any[]> {
    const col = await this.collection("removed_players");
    const docs = await col.find({}).sort({ removedAt: -1 }).toArray();
    return docs.map((d: any) => ({ ...d, id: d._id.toString() }));
  }

  async addRemovedPlayer(data: { discordUserId: string; discordName?: string; uniqueUserId?: string; playerName?: string; defaultFarmId?: string; reason?: string }): Promise<any> {
    const col = await this.collection("removed_players");
    const doc = { ...data, removedAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() };
  }

  async findRemovedByGameId(uniqueUserId: string): Promise<any[]> {
    const col = await this.collection("removed_players");
    const docs = await col.find({ uniqueUserId }).toArray();
    return docs.map((d: any) => ({ ...d, id: d._id.toString() }));
  }

  // ── Per-guild channel config ──
  async getGuildChannelConfig(guildId: string): Promise<any | null> {
    const col = await this.collection("guild_channel_configs");
    const doc = await col.findOne({ guildId });
    return doc ? { categories: doc.categories || [], farmChannels: doc.farmChannels || [] } : null;
  }

  async saveGuildChannelConfig(guildId: string, config: any): Promise<void> {
    const col = await this.collection("guild_channel_configs");
    await col.updateOne(
      { guildId },
      { $set: { guildId, categories: config.categories || [], farmChannels: config.farmChannels || [], updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  }

  // ── Backup storage ──
  async saveBackup(backup: { name: string; guildId: string; data: any; channelCount: number; messageCount: number; auto?: boolean }): Promise<{ id: string }> {
    const col = await this.collection("backups");
    const jsonStr = JSON.stringify(backup.data);
    const sizeMB = (Buffer.byteLength(jsonStr, 'utf-8') / 1024 / 1024).toFixed(1);
    const doc = {
      name: backup.name,
      guildId: backup.guildId,
      data: backup.data,
      channelCount: backup.channelCount,
      messageCount: backup.messageCount,
      sizeMB,
      auto: backup.auto || false,
      createdAt: new Date(),
    };
    const result = await col.insertOne(doc);
    return { id: result.insertedId.toString() };
  }

  async listBackups(guildId: string): Promise<{ id: string; name: string; guildId: string; channelCount: number; messageCount: number; sizeMB: string; auto: boolean; createdAt: Date }[]> {
    const col = await this.collection("backups");
    // Don't return the full data field — just metadata
    const docs = await col.find({ guildId }, { projection: { data: 0 } }).sort({ createdAt: -1 }).toArray();
    return docs.map(d => ({
      id: d._id.toString(),
      name: d.name,
      guildId: d.guildId,
      channelCount: d.channelCount || 0,
      messageCount: d.messageCount || 0,
      sizeMB: d.sizeMB || '?',
      auto: d.auto || false,
      createdAt: d.createdAt || new Date(),
    }));
  }

  async getBackup(id: string): Promise<any | null> {
    const col = await this.collection("backups");
    try {
      const doc = await col.findOne({ _id: new ObjectId(id) });
      return doc ? doc.data : null;
    } catch { return null; }
  }

  async getBackupChannels(id: string): Promise<{ name: string; type: number; category: string | null; messageCount: number }[] | null> {
    const col = await this.collection("backups");
    try {
      const doc = await col.findOne({ _id: new ObjectId(id) }, { projection: { 'data.channels.name': 1, 'data.channels.type': 1, 'data.channels.category': 1, 'data.channels.messages': 1 } });
      if (!doc?.data?.channels) return null;
      return doc.data.channels.map((ch: any) => ({
        name: ch.name,
        type: ch.type || 0,
        category: ch.category || null,
        messageCount: Array.isArray(ch.messages) ? ch.messages.length : 0,
      }));
    } catch { return null; }
  }

  async deleteBackup(id: string): Promise<boolean> {
    const col = await this.collection("backups");
    try {
      const result = await col.deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    } catch { return false; }
  }

  // ── Restore state persistence ──
  async saveRestoreState(state: { guildId: string; backupId: string; mode: string; channelNames: string[]; targetChannelId?: string | null; targetGuildId?: string | null; channelsDone: string[]; messagesPosted: number; source: string }): Promise<void> {
    const col = await this.collection("restoreState");
    await col.updateOne(
      { guildId: state.guildId },
      { $set: { ...state, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async getRestoreState(guildId: string): Promise<any | null> {
    const col = await this.collection("restoreState");
    return col.findOne({ guildId });
  }

  async deleteRestoreState(guildId: string): Promise<void> {
    const col = await this.collection("restoreState");
    await col.deleteOne({ guildId });
  }

  // ── Transcript storage ──
  async saveTranscript(transcript: { guildId: string; ticketName: string; closedBy: string; closedById: string; messageCount: number; content: string; messages: any[] }): Promise<{ id: string }> {
    const col = await this.collection("transcripts");
    const doc = {
      ...transcript,
      createdAt: new Date(),
    };
    const result = await col.insertOne(doc);
    return { id: result.insertedId.toString() };
  }

  async listTranscripts(guildId: string, limit = 25): Promise<{ id: string; ticketName: string; closedBy: string; messageCount: number; createdAt: Date }[]> {
    const col = await this.collection("transcripts");
    const docs = await col.find({ guildId }, { projection: { content: 0, messages: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
    return docs.map(d => ({
      id: d._id.toString(),
      ticketName: d.ticketName,
      closedBy: d.closedBy,
      messageCount: d.messageCount || 0,
      createdAt: d.createdAt || new Date(),
    }));
  }

  async getTranscript(id: string): Promise<any | null> {
    const col = await this.collection("transcripts");
    try {
      const doc = await col.findOne({ _id: new ObjectId(id) });
      return doc || null;
    } catch { return null; }
  }

  // ── Feature Requests ──
  async getFeatureRequests(): Promise<any[]> {
    const col = await this.collection("featureRequests");
    return col.find().sort({ createdAt: -1 }).toArray();
  }

  async createFeatureRequest(req: { title: string; description: string; priority: string; author: string }): Promise<any> {
    const col = await this.collection("featureRequests");
    const doc = { ...req, status: 'pending', createdAt: new Date(), updatedAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async updateFeatureRequest(id: string, updates: { status?: string; adminNote?: string }): Promise<boolean> {
    const col = await this.collection("featureRequests");
    const result = await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updates, updatedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  async deleteFeatureRequest(id: string): Promise<boolean> {
    const col = await this.collection("featureRequests");
    const result = await col.deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount > 0;
  }

  // ── AI Code Change Requests ──
  async getAiRequests(): Promise<any[]> {
    const col = await this.collection("aiRequests");
    return col.find().sort({ createdAt: -1 }).toArray();
  }

  async createAiRequest(req: { summary: string; details: string; userId: string; userName: string; channelId: string; conversationSnippet: string }): Promise<any> {
    const col = await this.collection("aiRequests");
    const doc = { ...req, status: 'pending', createdAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async updateAiRequest(id: string, updates: { status?: string; note?: string }): Promise<boolean> {
    const col = await this.collection("aiRequests");
    const result = await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updates, updatedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  async deleteAiRequest(id: string): Promise<boolean> {
    const col = await this.collection("aiRequests");
    const result = await col.deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount > 0;
  }

  // ── Coop Market ──
  async getCoopMarket(): Promise<any[]> {
    const col = await this.collection("coopMarket");
    return col.find().sort({ fillType: 1 }).toArray();
  }

  async upsertCoopMarketItem(item: { fillType: string; basePrice: number; demandLevel: number; supplyLevel: number; currentPrice: number; lastDemandReset?: Date }): Promise<any> {
    const col = await this.collection("coopMarket");
    const result = await col.findOneAndUpdate(
      { fillType: item.fillType },
      { $set: { ...item, updatedAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    return result;
  }

  async updateCoopSupply(fillType: string, addAmount: number): Promise<any> {
    const col = await this.collection("coopMarket");
    return col.findOneAndUpdate(
      { fillType },
      { $inc: { supplyLevel: addAmount }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
  }

  async resetDailySupply(): Promise<void> {
    const col = await this.collection("coopMarket");
    await col.updateMany({}, {
      $set: { supplyLevel: 0, lastDemandReset: new Date(), updatedAt: new Date() }
    });
  }

  // ── Coop Contracts ──
  async getActiveContracts(): Promise<any[]> {
    const col = await this.collection("coopContracts");
    return col.find({ status: 'active' }).sort({ expiresAt: 1 }).toArray();
  }

  async getAllContracts(limit = 20): Promise<any[]> {
    const col = await this.collection("coopContracts");
    return col.find().sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async createContract(contract: { fillType: string; requiredAmount: number; bonusPercent: number; expiresAt: Date }): Promise<any> {
    const col = await this.collection("coopContracts");
    const doc = { ...contract, deliveredAmount: 0, status: 'active', createdAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async updateContractDelivery(contractId: string, addAmount: number): Promise<any> {
    const col = await this.collection("coopContracts");
    return col.findOneAndUpdate(
      { _id: new ObjectId(contractId) },
      { $inc: { deliveredAmount: addAmount } },
      { returnDocument: 'after' }
    );
  }

  async completeContract(contractId: string): Promise<void> {
    const col = await this.collection("coopContracts");
    await col.updateOne(
      { _id: new ObjectId(contractId) },
      { $set: { status: 'completed', completedAt: new Date() } }
    );
  }

  async expireContracts(): Promise<number> {
    const col = await this.collection("coopContracts");
    const result = await col.updateMany(
      { status: 'active', expiresAt: { $lte: new Date() } },
      { $set: { status: 'expired' } }
    );
    return result.modifiedCount;
  }

  // ── Coop Deliveries ──
  async recordDelivery(delivery: { farmId: string; fillType: string; amount: number; pricePerUnit: number; totalEarned: number; contractId?: string; transactionId?: string }): Promise<any> {
    const col = await this.collection("coopDeliveries");
    const doc = { ...delivery, createdAt: new Date() };
    const result = await col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async getRecentDeliveries(limit = 20): Promise<any[]> {
    const col = await this.collection("coopDeliveries");
    return col.find().sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async getCoopLeaderboard(): Promise<any[]> {
    const col = await this.collection("coopDeliveries");
    return col.aggregate([
      { $group: {
        _id: '$farmId',
        totalEarned: { $sum: '$totalEarned' },
        totalAmount: { $sum: '$amount' },
        deliveryCount: { $sum: 1 },
      }},
      { $sort: { totalEarned: -1 } },
      { $limit: 20 },
    ]).toArray();
  }

  async getDeliveriesByFarm(farmId: string, limit = 20): Promise<any[]> {
    const col = await this.collection("coopDeliveries");
    return col.find({ farmId }).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async deleteDelivery(deliveryId: string): Promise<boolean> {
    const col = await this.collection("coopDeliveries");
    const result = await col.deleteOne({ _id: new ObjectId(deliveryId) });
    return result.deletedCount > 0;
  }

  async getDeliveriesFiltered(filter: { farmId?: string; fillType?: string; fromDate?: Date; toDate?: Date }, limit = 100): Promise<any[]> {
    const col = await this.collection("coopDeliveries");
    const query: any = {};
    if (filter.farmId) query.farmId = filter.farmId;
    if (filter.fillType) query.fillType = filter.fillType.toUpperCase();
    if (filter.fromDate || filter.toDate) {
      query.createdAt = {};
      if (filter.fromDate) query.createdAt.$gte = filter.fromDate;
      if (filter.toDate) query.createdAt.$lte = filter.toDate;
    }
    return col.find(query).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async claimContract(contractId: string, farmId: string): Promise<any> {
    const col = await this.collection("coopContracts");
    return col.findOneAndUpdate(
      { _id: new ObjectId(contractId), claimedByFarmId: { $exists: false } },
      { $set: { claimedByFarmId: farmId, claimedAt: new Date() } },
      { returnDocument: 'after' }
    );
  }

  async getContractsByFarm(farmId: string): Promise<any[]> {
    const col = await this.collection("coopContracts");
    return col.find({ claimedByFarmId: farmId, status: 'active' }).toArray();
  }

  async updateContract(contractId: string, updates: Partial<{ fillType: string; requiredAmount: number; bonusPercent: number; expiresAt: Date; status: string; claimedByFarmId: string }>): Promise<any> {
    const col = await this.collection("coopContracts");
    return col.findOneAndUpdate(
      { _id: new ObjectId(contractId) },
      { $set: updates },
      { returnDocument: 'after' }
    );
  }

  async deleteContract(contractId: string): Promise<boolean> {
    const col = await this.collection("coopContracts");
    const result = await col.deleteOne({ _id: new ObjectId(contractId) });
    return result.deletedCount > 0;
  }

  async getGuildSettings(): Promise<Record<string, Record<string, string>>> {
    const col = await this.collection("guildSettings");
    const docs = await col.find({}).toArray();
    const result: Record<string, Record<string, string>> = {};
    for (const doc of docs) {
      const guildId = doc.guildId as string;
      if (!guildId) continue;
      const keys: Record<string, string> = {};
      for (const [k, v] of Object.entries(doc)) {
        if (k !== '_id' && k !== 'guildId' && typeof v === 'string') {
          keys[k] = v;
        }
      }
      result[guildId] = keys;
    }
    return result;
  }

  async saveGuildSettings(settings: Record<string, Record<string, string>>): Promise<void> {
    const col = await this.collection("guildSettings");
    for (const [guildId, keys] of Object.entries(settings)) {
      // Replace entire document to handle key deletions properly
      await col.replaceOne(
        { guildId },
        { guildId, ...keys },
        { upsert: true }
      );
    }
  }

  async getCustomContracts(): Promise<any[]> {
    const col = await this.collection("customContracts");
    return col.find({}).toArray();
  }

  async bulkSyncCustomContracts(contracts: any[]): Promise<{ created: any[]; updated: any[]; removed: any[] }> {
    const col = await this.collection("customContracts");
    const existing = await col.find({}).toArray();
    const existingMap = new Map(existing.map((c: any) => [c.gameId, c]));
    const incomingIds = new Set(contracts.map((c: any) => c.gameId));

    const created: any[] = [];
    const updated: any[] = [];

    for (const contract of contracts) {
      const old = existingMap.get(contract.gameId);
      if (!old) {
        await col.insertOne({ ...contract, syncedAt: new Date() });
        created.push(contract);
      } else {
        // Check if anything changed
        const changed = old.status !== contract.status
          || old.contractorFarmId !== contract.contractorFarmId
          || old.reward !== contract.reward;
        if (changed) {
          await col.updateOne(
            { gameId: contract.gameId },
            { $set: { ...contract, syncedAt: new Date() } }
          );
          updated.push({ old, new: contract });
        }
      }
    }

    // Remove contracts no longer in game state
    const removed: any[] = [];
    for (const old of existing) {
      if (!incomingIds.has(old.gameId)) {
        await col.deleteOne({ gameId: old.gameId });
        removed.push(old);
      }
    }

    return { created, updated, removed };
  }

  /** Prune old/temporary data to reduce DB size. Never touches player identity, farms, bans, or game state. */
  async pruneOldData(olderThanDays: number): Promise<{ collection: string; deleted: number }[]> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const results: { collection: string; deleted: number }[] = [];

    const pruneCol = async (name: string, query: any) => {
      try {
        const col = await this.collection(name);
        const res = await col.deleteMany(query);
        if (res.deletedCount > 0) results.push({ collection: name, deleted: res.deletedCount });
      } catch (e: any) {
        console.error(`[PRUNE] Failed for ${name}:`, e.message);
      }
    };

    // Bot logs — keep 30 days regardless of caller-specified days
    await pruneCol('botLogs', { createdAt: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } });
    // Coop deliveries
    await pruneCol('coopDeliveries', { createdAt: { $lt: cutoff } });
    // Ticket transcripts
    await pruneCol('transcripts', { createdAt: { $lt: cutoff } });
    // Old completed/expired coop contracts
    await pruneCol('coopContracts', { status: { $in: ['completed', 'expired'] }, expiresAt: { $lt: cutoff } });

    return results;
  }

}

class MySqlStorage extends MongoStorage {
  private pool: mysql.Pool | null = null;

  protected async collection(name: string): Promise<any> {
    const pool = await this.getPool();
    return new MySqlCollection(pool, name);
  }

  private async getPool(): Promise<mysql.Pool> {
    if (this.pool) return this.pool;
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required for MySQL storage.");
    this.pool = mysql.createPool({
      uri: databaseUrl,
      connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
      supportBigNumbers: true,
      dateStrings: false,
    });
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS app_documents (
        collection_name VARCHAR(128) NOT NULL,
        doc_id VARCHAR(191) NOT NULL,
        data_json JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (collection_name, doc_id),
        KEY idx_collection_updated (collection_name, updated_at)
      )
    `);
    console.log("Using MySQL document storage");
    return this.pool;
  }
}

function createStorage(): IStorage {
  if (process.env.DATABASE_URL?.startsWith("mysql://") || process.env.DATABASE_URL?.startsWith("mysql2://")) {
    return new MySqlStorage();
  }
  throw new Error("DATABASE_URL must be a MySQL URL.");


}

export const storage = createStorage();

// MongoDB admin functions (for dashboard management panel)
class MongoAdmin {
  private client: MongoClient | null = null;
  private database: Db | null = null;

  private async getDb(): Promise<Db> {
    if (this.database) return this.database;
    const mongoUrl = process.env.MONGO_URL;
    if (!mongoUrl) throw new Error("MONGO_URL not set");
    this.client = new MongoClient(mongoUrl);
    await this.client.connect();
    this.database = this.client.db();
    return this.database;
  }

  async listCollections(): Promise<{ name: string; count: number }[]> {
    const db = await this.getDb();
    const collections = await db.listCollections().toArray();
    const result: { name: string; count: number }[] = [];
    for (const col of collections) {
      const count = await db.collection(col.name).countDocuments();
      result.push({ name: col.name, count });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getCollectionDocuments(name: string, page: number, limit: number): Promise<{ documents: any[]; total: number }> {
    const db = await this.getDb();
    const col = db.collection(name);
    const total = await col.countDocuments();
    const documents = await col.find().sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    return { documents, total };
  }

  async exportCollection(name: string): Promise<any[]> {
    const db = await this.getDb();
    return db.collection(name).find().toArray();
  }

  async getDatabaseStats(): Promise<any> {
    const db = await this.getDb();
    return db.stats();
  }

  async deleteDocument(collectionName: string, documentId: string): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.collection(collectionName).deleteOne({ _id: new ObjectId(documentId) });
    return result.deletedCount > 0;
  }
}

class MySqlAdmin {
  private pool: mysql.Pool | null = null;

  private async getPool(): Promise<mysql.Pool> {
    if (this.pool) return this.pool;
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL not set");
    this.pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 5 });
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS app_documents (
        collection_name VARCHAR(128) NOT NULL,
        doc_id VARCHAR(191) NOT NULL,
        data_json JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (collection_name, doc_id),
        KEY idx_collection_updated (collection_name, updated_at)
      )
    `);
    return this.pool;
  }

  async listCollections(): Promise<{ name: string; count: number }[]> {
    const pool = await this.getPool();
    const [rows] = await pool.execute<any[]>(
      "SELECT collection_name AS name, COUNT(*) AS count FROM app_documents GROUP BY collection_name ORDER BY collection_name"
    );
    return rows.map((row) => ({ name: row.name, count: Number(row.count || 0) }));
  }

  async getCollectionDocuments(name: string, page: number, limit: number): Promise<{ documents: any[]; total: number }> {
    const pool = await this.getPool();
    const offset = (page - 1) * limit;
    const [countRows] = await pool.execute<any[]>("SELECT COUNT(*) AS count FROM app_documents WHERE collection_name = ?", [name]);
    const [rows] = await pool.execute<any[]>(
      "SELECT data_json FROM app_documents WHERE collection_name = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      [name, limit, offset]
    );
    return {
      documents: rows.map((row) => typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json),
      total: Number(countRows[0]?.count || 0)
    };
  }

  async exportCollection(name: string): Promise<any[]> {
    const pool = await this.getPool();
    const [rows] = await pool.execute<any[]>("SELECT data_json FROM app_documents WHERE collection_name = ?", [name]);
    return rows.map((row) => typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json);
  }

  async getDatabaseStats(): Promise<any> {
    const pool = await this.getPool();
    const [docRows] = await pool.execute<any[]>("SELECT COUNT(*) AS objects, COUNT(DISTINCT collection_name) AS collections FROM app_documents");
    const [sizeRows] = await pool.execute<any[]>(
      "SELECT COALESCE(SUM(data_length + index_length), 0) AS dataSize FROM information_schema.tables WHERE table_schema = DATABASE()"
    );
    return {
      db: "mysql",
      collections: Number(docRows[0]?.collections || 0),
      objects: Number(docRows[0]?.objects || 0),
      dataSize: Number(sizeRows[0]?.dataSize || 0),
    };
  }

  async deleteDocument(collectionName: string, documentId: string): Promise<boolean> {
    const pool = await this.getPool();
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      "DELETE FROM app_documents WHERE collection_name = ? AND doc_id = ?",
      [collectionName, documentId]
    );
    return result.affectedRows > 0;
  }
}

export const mongoAdmin = new MySqlAdmin();
