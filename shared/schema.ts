import { pgTable, text, serial, timestamp, integer, doublePrecision, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Bot Logs for system tracking
export const botLogs = pgTable("bot_logs", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Farm Management
export const farms = pgTable("farms", {
  id: serial("id").primaryKey(),
  farmId: text("farm_id").notNull().unique(),
  name: text("name").notNull(),
  owner: text("owner"),
  balance: doublePrecision("balance").default(0),
});

// FS25 Fields Data
export const fields = pgTable("fields", {
  id: serial("id").primaryKey(),
  fieldId: text("field_id").notNull().unique(),
  ownerFarmId: text("owner_farm_id"),
  farmlandId: text("farmland_id"),
  fieldArea: doublePrecision("field_area"),
  fieldAreaFull: doublePrecision("field_area_full"),
  fruitName: text("fruit_name"),
  fruitStatus: text("fruit_status"),
  growthStage: text("growth_stage"),
  wheelsInfo: text("wheels_info"),
  weedInfo: text("weed_info"),
  limeInfo: text("lime_info"),
  plowingInfo: text("plowing_info"),
  rollingInfo: text("rolling_info"),
  fertilizationInfo: text("fertilization_info"),
  posX: doublePrecision("pos_x"),
  posZ: doublePrecision("pos_z"),
  farmlandPrice: doublePrecision("farmland_price"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// FS25 Vehicles Data
export const vehicles = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  farmId: text("farm_id"),
  damage: doublePrecision("damage"),
  propertyState: text("property_state"),
  fuelType: text("fuel_type"),
  fuelLevel: doublePrecision("fuel_level"),
  defLevel: doublePrecision("def_level"),
  paint: text("paint"),
  dirt: doublePrecision("dirt"),
  price: doublePrecision("price"),
  sellPrice: doublePrecision("sell_price"),
  imageFilename: text("image_filename"),
  vehType: text("veh_type"),
  position: text("position"),
  fillUnits: jsonb("fill_units"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// FS25 Silos Data
export const silos = pgTable("silos", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  farmId: text("farm_id"),
  typeName: text("type_name"),
  position: text("position"),
  capacity: doublePrecision("capacity"),
  totalFill: doublePrecision("total_fill"),
  percent: doublePrecision("percent"),
  fillLevels: jsonb("fill_levels"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// FS25 Productions Data
export const productions = pgTable("productions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  farmId: text("farm_id"),
  isOwned: boolean("is_owned").default(false),
  productionPoint: text("production_point"),
  inputs: jsonb("inputs"),
  outputs: jsonb("outputs"),
  status: text("status"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// FS25 Animals Data
export const animals = pgTable("animals", {
  id: serial("id").primaryKey(),
  husbandryId: text("husbandry_id").notNull().unique(),
  name: text("name").notNull(),
  farmId: text("farm_id"),
  animalType: text("animal_type"),
  numAnimals: integer("num_animals").default(0),
  maxAnimals: integer("max_animals"),
  health: doublePrecision("health"),
  productivity: doublePrecision("productivity"),
  reproduction: doublePrecision("reproduction"),
  food: jsonb("food"),
  outputs: jsonb("outputs"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Weather Data
export const weather = pgTable("weather", {
  id: serial("id").primaryKey(),
  current: jsonb("current").notNull(),
  hourly: jsonb("hourly").notNull(),
  daily: jsonb("daily").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Job Board - Farm work requests between players
export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  jobId: text("job_id").notNull().unique(),
  jobType: text("job_type").notNull(), // harvesting, baling, plowing, cultivating, seeding, transport, other
  title: text("title").notNull(),
  description: text("description"),
  fieldId: text("field_id"), // optional - which field the job is for
  payment: doublePrecision("payment").notNull(),
  status: text("status").default("open"), // open, taken, completed, paid, cancelled
  createdByFarmId: text("created_by_farm_id").notNull(),
  createdByUserId: text("created_by_user_id"), // Discord user ID
  assignedToFarmId: text("assigned_to_farm_id"),
  assignedToUserId: text("assigned_to_user_id"), // Discord user ID who took the job
  completedAt: timestamp("completed_at"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Alerts
export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  type: text("type").default("info"),
  title: text("title"),
  message: text("message"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Players - tracks player hours and last played time
export const players = pgTable("players", {
  id: serial("id").primaryKey(),
  uniqueUserId: text("unique_user_id").notNull().unique(),
  name: text("name").notNull(),
  farmId: text("farm_id"),
  playTime: doublePrecision("play_time").default(0),
  lastPlayed: timestamp("last_played"),
  isOnline: boolean("is_online").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Manual linking between Discord users and FS25 uniqueUserId (admin-only)
export const playerLinks = pgTable("player_links", {
  id: serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull().unique(),
  uniqueUserId: text("unique_user_id").notNull().unique(),
  playerName: text("player_name"),
  defaultFarmId: text("default_farm_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Removed players - archived when Ratar role is removed
export const removedPlayers = pgTable("removed_players", {
  id: serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull(),
  discordName: text("discord_name"),
  uniqueUserId: text("unique_user_id"),
  playerName: text("player_name"),
  defaultFarmId: text("default_farm_id"),
  reason: text("reason"),
  removedAt: timestamp("removed_at").defaultNow(),
});

// Deployed Panels - tracks panels deployed to Discord channels for refresh
export const deployedPanels = pgTable("deployed_panels", {
  id: serial("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  panelType: text("panel_type").notNull(),
  farmId: text("farm_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Coop Market — dynamic supply & demand pricing per fill type
export const coopMarket = pgTable("coop_market", {
  id: serial("id").primaryKey(),
  fillType: text("fill_type").notNull().unique(),
  basePrice: doublePrecision("base_price").notNull(),
  demandLevel: doublePrecision("demand_level").default(1.0),
  supplyLevel: doublePrecision("supply_level").default(0),
  currentPrice: doublePrecision("current_price").notNull(),
  lastDemandReset: timestamp("last_demand_reset").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Coop Contracts — weekly delivery contracts with bonus rewards
export const coopContracts = pgTable("coop_contracts", {
  id: serial("id").primaryKey(),
  fillType: text("fill_type").notNull(),
  requiredAmount: doublePrecision("required_amount").notNull(),
  deliveredAmount: doublePrecision("delivered_amount").default(0),
  bonusPercent: doublePrecision("bonus_percent").notNull(),
  status: text("status").default("active"),   // active, completed, expired
  expiresAt: timestamp("expires_at").notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Coop Deliveries — per-farm delivery history
export const coopDeliveries = pgTable("coop_deliveries", {
  id: serial("id").primaryKey(),
  farmId: text("farm_id").notNull(),
  fillType: text("fill_type").notNull(),
  amount: doublePrecision("amount").notNull(),
  pricePerUnit: doublePrecision("price_per_unit").notNull(),
  totalEarned: doublePrecision("total_earned").notNull(),
  contractId: integer("contract_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Zod Schemas
export const insertBotLogSchema = createInsertSchema(botLogs).omit({ id: true, createdAt: true });
export const insertFarmSchema = createInsertSchema(farms).omit({ id: true });
export const insertFieldSchema = createInsertSchema(fields).omit({ id: true, updatedAt: true });
export const insertVehicleSchema = createInsertSchema(vehicles).omit({ id: true, updatedAt: true });
export const insertSiloSchema = createInsertSchema(silos).omit({ id: true, updatedAt: true });
export const insertProductionSchema = createInsertSchema(productions).omit({ id: true, updatedAt: true });
export const insertAnimalSchema = createInsertSchema(animals).omit({ id: true, updatedAt: true });
export const insertJobSchema = createInsertSchema(jobs).omit({ id: true, createdAt: true });
export const insertAlertSchema = createInsertSchema(alerts).omit({ id: true, createdAt: true });
export const insertWeatherSchema = createInsertSchema(weather).omit({ id: true, updatedAt: true });
export const insertDeployedPanelSchema = createInsertSchema(deployedPanels).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPlayerSchema = createInsertSchema(players).omit({ id: true, createdAt: true, updatedAt: true });

export const insertPlayerLinkSchema = createInsertSchema(playerLinks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRemovedPlayerSchema = createInsertSchema(removedPlayers).omit({ id: true, removedAt: true });

export const insertCoopMarketSchema = createInsertSchema(coopMarket).omit({ id: true, updatedAt: true });
export const insertCoopContractSchema = createInsertSchema(coopContracts).omit({ id: true, createdAt: true });
export const insertCoopDeliverySchema = createInsertSchema(coopDeliveries).omit({ id: true, createdAt: true });

// Types
export type BotLog = typeof botLogs.$inferSelect;
export type InsertBotLog = z.infer<typeof insertBotLogSchema>;
export type Farm = typeof farms.$inferSelect;
export type InsertFarm = z.infer<typeof insertFarmSchema>;
export type Field = typeof fields.$inferSelect;
export type InsertField = z.infer<typeof insertFieldSchema>;
export type Vehicle = typeof vehicles.$inferSelect;
export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type Silo = typeof silos.$inferSelect;
export type InsertSilo = z.infer<typeof insertSiloSchema>;
export type Production = typeof productions.$inferSelect;
export type InsertProduction = z.infer<typeof insertProductionSchema>;
export type Animal = typeof animals.$inferSelect;
export type InsertAnimal = z.infer<typeof insertAnimalSchema>;
export type Job = typeof jobs.$inferSelect;
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type Weather = typeof weather.$inferSelect;
export type InsertWeather = z.infer<typeof insertWeatherSchema>;
export type DeployedPanel = typeof deployedPanels.$inferSelect;
export type InsertDeployedPanel = z.infer<typeof insertDeployedPanelSchema>;
export type Player = typeof players.$inferSelect;
export type PlayerLink = typeof playerLinks.$inferSelect;
export type RemovedPlayer = typeof removedPlayers.$inferSelect;
export type InsertPlayer = z.infer<typeof insertPlayerSchema>;
export type InsertPlayerLink = z.infer<typeof insertPlayerLinkSchema>;
export type InsertRemovedPlayer = z.infer<typeof insertRemovedPlayerSchema>;

export type CoopMarket = typeof coopMarket.$inferSelect;
export type InsertCoopMarket = z.infer<typeof insertCoopMarketSchema>;
export type CoopContract = typeof coopContracts.$inferSelect;
export type InsertCoopContract = z.infer<typeof insertCoopContractSchema>;
export type CoopDelivery = typeof coopDeliveries.$inferSelect;
export type InsertCoopDelivery = z.infer<typeof insertCoopDeliverySchema>;
