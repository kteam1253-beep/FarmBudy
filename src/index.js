// src/index.js
// FarmBudy – Admin command panel + field workflow + single Field Details panel (no spam)
//
// Panels:
//  - Admin Panel (pinnable): buttons to deploy other panels, set log channel, manage fields, refresh
//  - Workflow Board: choose a field (button)
//  - Field Details: one persistent message updated when a field is chosen
//  - Activity Panel: recent activity feed
//
// Defaults:
//  - fields: 1..5 (dynamic list; add/remove via admin panel or /fields)
//  - field click updates Field Details panel (if not deployed, it will auto-create in the same channel)
//
// Workflow per field:
//   Lime -> Fertilize -> Choose (Plow/Subsoil/Skip) -> Cultivate -> Seed (pick crop) -> Harvest -> loop
//
// Planning:
//  - You can set "planned seeding" anytime; when the workflow reaches SEED_PICK, it will auto-use the planned crop.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  RoleSelectMenuBuilder,
  REST,
  Routes,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from "discord.js";

///////////////////////////////////////////////////////////////////////////////////////////////////
// ENV
///////////////////////////////////////////////////////////////////////////////////////////////////

const ENV = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID ?? process.env.CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID ?? process.env.GUILD_ID,
  adminRoleId: process.env.ADMIN_ROLE_ID ?? null,
  telemetrySecret: process.env.TELEMETRY_SECRET ?? process.env.TELEMETARY_SECRET ?? null,
};

const missing = [];
if (!ENV.token) missing.push("DISCORD_TOKEN");
if (!ENV.clientId) missing.push("DISCORD_CLIENT_ID (or CLIENT_ID)");
if (!ENV.guildId) missing.push("DISCORD_GUILD_ID (or GUILD_ID)");
if (missing.length) {
  console.error("Missing env vars. Required:", missing.join(", "));
  process.exit(1);
}

console.log("[build] FarmBuddyTelemetry parser enabled (payload.users / playersOnline) v3c");

///////////////////////////////////////////////////////////////////////////////////////////////////
// STATE (JSON)
///////////////////////////////////////////////////////////////////////////////////////////////////

const DATA_DIR = path.resolve("./data");
const STATE_PATH = path.join(DATA_DIR, "state.json");

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

function nowISO() {
  return new Date().toISOString();
}

function loadState() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 3,
      config: {
        fields: [1, 2, 3, 4, 5],
        logChannelId: null,
        detailsChannelId: null, // optional, if you want details in a dedicated channel
        taskHistoryChannelId: null, // optional, channel for task history feed
      },
      panels: {},
      fields: {},
      tasks: {},
      activity: [],
      counters: { taskSeq: 1 },
      ...parsed,
    };
  } catch {
    return {
      version: 3,
      config: { fields: [1, 2, 3, 4, 5], logChannelId: null, detailsChannelId: null, taskHistoryChannelId: null },
      panels: {},
      fields: {},
      tasks: {},
      activity: [],
      counters: { taskSeq: 1 },
    };
  }
}

let state = loadState();

const runtime = { joins: [], lockdownUntil: 0 };

function saveState() {
  // Sigurna pohrana: atomic write (tmp -> rename) + .bak backup
  // Komentar HR: ovo sprječava corrupt state.json ako bot padne usred upisa.
  ensureDataDir();

  const json = JSON.stringify(state, null, 2);
  const tmpPath = STATE_PATH + ".tmp";
  const bakPath = STATE_PATH + ".bak";

  try {
    if (fs.existsSync(STATE_PATH)) {
      // Backup prethodne verzije
      fs.copyFileSync(STATE_PATH, bakPath);
    }
  } catch {
    // ignore backup errors
  }

  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, STATE_PATH);
}

function ensureConfig() {
  state.config = state.config ?? {};
  if (!Array.isArray(state.config.fields)) state.config.fields = [1, 2, 3, 4, 5];

  state.config.fields = [...new Set(state.config.fields.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))]
    .sort((a, b) => a - b);

  if (!("logChannelId" in state.config)) state.config.logChannelId = null;
  if (!("detailsChannelId" in state.config)) state.config.detailsChannelId = null;
  if (!("taskHistoryChannelId" in state.config)) state.config.taskHistoryChannelId = null;
  if (!("backupChannelId" in state.config)) state.config.backupChannelId = null;

  // Telemetry (FS25 -> bot)
  if (!("telemetryBaseUrl" in state.config)) state.config.telemetryBaseUrl = null; // e.g. https://your-railway.app
  if (!("telemetrySecret" in state.config)) state.config.telemetrySecret = null;   // optional fallback if env not set

  // Onboarding (welcome/goodbye)
  state.config.welcome = state.config.welcome ?? {
    enabled: false,
    channelId: null,
    message: "Dobrodošao {user} u **{server}**! Trenutno nas ima: **{memberCount}**.",
  };
  state.config.goodbye = state.config.goodbye ?? {
    enabled: false,
    channelId: null,
    message: "**{username}** je napustio **{server}**.",
  };

  // Moderation
  if (!("modLogChannelId" in state.config)) state.config.modLogChannelId = null;

// Permissions (Owner / Co-owner / Admin / Moderator)
state.config.perms = state.config.perms ?? {};
if (!Array.isArray(state.config.perms.owners)) state.config.perms.owners = [];
if (!Array.isArray(state.config.perms.coOwners)) state.config.perms.coOwners = [];
if (!Array.isArray(state.config.perms.adminUsers)) state.config.perms.adminUsers = [];
if (!Array.isArray(state.config.perms.adminRoles)) state.config.perms.adminRoles = [];
if (!Array.isArray(state.config.perms.modRoles)) state.config.perms.modRoles = [];

  // Security (anti-scam / anti-alt / anti-raid)
  state.config.security = state.config.security ?? {};
  if (!("minAccountAgeDays" in state.config.security)) state.config.security.minAccountAgeDays = 0;
  if (!("quarantineRoleId" in state.config.security)) state.config.security.quarantineRoleId = null;
  if (!("memberRoleId" in state.config.security)) state.config.security.memberRoleId = null;
  if (!("verificationChannelId" in state.config.security)) state.config.security.verificationChannelId = null;

  state.config.security.antiScam = state.config.security.antiScam ?? {
    enabled: true,
    blockLinksForUnverified: true,
    timeoutMinutes: 10,
    keywords: ["free nitro", "steam gift", "airdrop", "crypto", "giveaway", "gift"],
  };

  state.config.security.antiRaid = state.config.security.antiRaid ?? {
    enabled: true,
    windowSec: 30,
    maxJoins: 5,
    lockdownMinutes: 10,
  };

  if (!("fieldsPanelTitle" in state.config)) state.config.fieldsPanelTitle = "FarmBudy – Polja";
  state.config.embedColors = state.config.embedColors ?? {
    admin: 0x5865F2,
    workflow: 0x22aa22,
    fieldDetails: 0x22aa22,
    activity: 0x22aa22,
  };
  saveState();
}
ensureConfig();

function logActivity(text) {
  state.activity = state.activity ?? [];
  state.activity.unshift({ ts: nowISO(), text });
  state.activity = state.activity.slice(0, 120);
  saveState();

  // FS25 telemetry
  state.gameTelemetry = state.gameTelemetry ?? { servers: {} };
  state.gameTelemetry.servers = state.gameTelemetry.servers ?? {};

}


// -------------------------
// Player Hours (Option A)
// -------------------------
function ensurePlayerHoursState() {
  state.playerHours = state.playerHours ?? {};
  state.playerHours.servers = state.playerHours.servers ?? {};
  state.playerHours.links = state.playerHours.links ?? {}; // fsUniqueUserId -> discordUserId
}

function getServerHoursSlot(serverId) {
  ensurePlayerHoursState();
  const sid = String(serverId ?? "fs25").trim() || "fs25";
  state.playerHours.servers[sid] = state.playerHours.servers[sid] ?? {
    totalsSeconds: {},       // fsId -> seconds (all-time, completed sessions)
    sessions: {},            // fsId -> { startMs }
    lastNick: {},            // fsId -> nickname
    history: {}              // fsId -> [{ endMs, seconds }]
  };
  return state.playerHours.servers[sid];
}

function pruneHistory30d(slot, nowMs) {
  const cutoff = nowMs - 30 * 24 * 60 * 60 * 1000;
  for (const [fsId, arr] of Object.entries(slot.history ?? {})) {
    const kept = Array.isArray(arr) ? arr.filter((r) => (r?.endMs ?? 0) >= cutoff) : [];
    slot.history[fsId] = kept;
  }
}

function updatePlayerHoursOnSnapshot(serverId, usersArr, tsIso) {
  const slot = getServerHoursSlot(serverId);

  const nowMs = (() => {
    if (typeof tsIso === "string") {
      const t = Date.parse(tsIso);
      if (!Number.isNaN(t)) return t;
    }
    return Date.now();
  })();

  pruneHistory30d(slot, nowMs);

  const online = new Set();
  for (const u of usersArr ?? []) {
    const fsId = String(u?.uniqueUserId ?? "").trim();
    if (!fsId) continue;
    online.add(fsId);
    const nick = String(u?.nickname ?? "").trim() || fsId;
    slot.lastNick[fsId] = nick;

    if (!slot.sessions[fsId]) {
      slot.sessions[fsId] = { startMs: nowMs };
    }
  }

  const left = [];
  for (const fsId of Object.keys(slot.sessions)) {
    if (!online.has(fsId)) {
      const s = slot.sessions[fsId];
      const startMs = Number(s?.startMs ?? nowMs);
      const seconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
      if (seconds > 0) {
        slot.totalsSeconds[fsId] = Number(slot.totalsSeconds[fsId] ?? 0) + seconds;
        slot.history[fsId] = Array.isArray(slot.history[fsId]) ? slot.history[fsId] : [];
        slot.history[fsId].push({ endMs: nowMs, seconds });
      }
      delete slot.sessions[fsId];
      left.push(fsId);
    }
  }

  if (left.length) saveState();

  return { leftFsIds: left, nowMs };
}

function formatDurationHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds ?? 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function getDisplayNameForFsId(fsId, serverId) {
  ensurePlayerHoursState();
  const discordId = state.playerHours.links?.[fsId] ?? null;
  if (discordId) return `<@${discordId}>`;
  const slot = getServerHoursSlot(serverId);
  return slot.lastNick?.[fsId] ?? fsId;
}

function buildPlayerHoursRows(serverId) {
  const slot = getServerHoursSlot(serverId);
  const nowMs = Date.now();
  pruneHistory30d(slot, nowMs);

  const rows = [];
  const allIds = new Set([
    ...Object.keys(slot.totalsSeconds ?? {}),
    ...Object.keys(slot.sessions ?? {}),
    ...Object.keys(slot.lastNick ?? {})
  ]);

  for (const fsId of allIds) {
    const base = Number(slot.totalsSeconds?.[fsId] ?? 0);
    const activeStart = Number(slot.sessions?.[fsId]?.startMs ?? 0);
    const active = activeStart ? Math.max(0, Math.floor((nowMs - activeStart) / 1000)) : 0;

    const hist = Array.isArray(slot.history?.[fsId]) ? slot.history[fsId] : [];
    const last30 = hist.reduce((acc, r) => acc + Number(r?.seconds ?? 0), 0) + active;

    rows.push({
      fsId,
      name: getDisplayNameForFsId(fsId, serverId),
      allTime: base + active,
      last30
    });
  }

  rows.sort((a, b) => (b.allTime - a.allTime) || (b.last30 - a.last30) || a.name.localeCompare(b.name));
  return rows;
}


function getFieldsPanelTitle() {
  ensureConfig();
  return String(state.config.fieldsPanelTitle ?? "FarmBuddy – Polja");
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// DISCORD CLIENT
///////////////////////////////////////////////////////////////////////////////////////////////////

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel],
});

let telemetryServer = null;
let telemetryFtpTimer = null;

// Activity check DM state: Map<targetUserId, { adminId, attempt, timerId, guildId }>
const activeChecks = new Map();

async function gracefulShutdown(signal) {
  try {
    console.warn(`[shutdown] ${signal} received. Closing...`);
    if (telemetryServer) {
      await new Promise((resolve) => telemetryServer.close(() => resolve(null))).catch(() => null);
    }
    try { await client.destroy(); } catch {}
  } catch {}
  try { process.exit(0); } catch {}
}

function eph() {
  return { flags: MessageFlags.Ephemeral };
}

async function ackAndDelete(interaction, content = "OK.") {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ ...eph(), content }).catch(() => null);
    } else {
      await interaction.editReply({ content }).catch(() => null);
    }
    // Avoid clutter: remove ephemeral confirmation shortly after.
    setTimeout(() => {
      try { interaction.deleteReply().catch(() => null); } catch {}
    }, 800);
  } catch {}
}

function parseIdList(raw) {
  const s = String(raw ?? "");
  const ids = [];
  for (const token of s.split(/[\n,;\s]+/g)) {
    const m = String(token).match(/\d{15,22}/g);
    if (m) ids.push(...m);
  }
  return [...new Set(ids)];
}

function isOwner(member) {
  ensureConfig();
  const uid = member?.user?.id ?? member?.id ?? null;
  if (!uid) return false;
  return state.config.perms.owners.includes(String(uid));
}

function isCoOwner(member) {
  ensureConfig();
  const uid = member?.user?.id ?? member?.id ?? null;
  if (!uid) return false;
  return state.config.perms.coOwners.includes(String(uid));
}

function hasAnyRole(member, roleIds) {
  if (!member?.roles?.cache || !Array.isArray(roleIds) || roleIds.length === 0) return false;
  for (const rid of roleIds) {
    if (member.roles.cache.has(String(rid))) return true;
  }
  return false;
}

function isAdmin(member) {
  // Anti-lockout: if nothing is configured, allow admin actions during setup.
  ensureConfig();

  const configured =
    !!ENV.adminRoleId ||
    (state.config.perms.owners?.length ?? 0) > 0 ||
    (state.config.perms.coOwners?.length ?? 0) > 0 ||
    (state.config.perms.adminUsers?.length ?? 0) > 0 ||
    (state.config.perms.adminRoles?.length ?? 0) > 0;

  if (!configured) return true;

  // Discord admin permission is always admin
  if (member?.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;

  const uid = member?.user?.id ?? member?.id ?? null;
  if (uid) {
    const s = String(uid);
    if (state.config.perms.owners.includes(s)) return true;
    if (state.config.perms.coOwners.includes(s)) return true;
    if (state.config.perms.adminUsers.includes(s)) return true;
  }

  if (ENV.adminRoleId && (member?.roles?.cache?.has?.(ENV.adminRoleId) ?? false)) return true;
  if (hasAnyRole(member, state.config.perms.adminRoles)) return true;

  return false;
}

function isModerator(member) {
  ensureConfig();
  if (isAdmin(member)) return true;
  if (hasAnyRole(member, state.config.perms.modRoles)) return true;
  return false;
}

function canBasic(member) {
  if (isAdmin(member)) return true;
  const roleId = state.config?.security?.memberRoleId;
  if (!roleId) return true; // if not configured, allow everyone
  return member?.roles?.cache?.has?.(roleId) ?? false;
}

function hasChannelSendPerms(channel, meMember) {
  try {
    const perms = channel.permissionsFor(meMember);
    if (!perms) return false;
    return (
      perms.has(PermissionsBitField.Flags.ViewChannel) &&
      perms.has(PermissionsBitField.Flags.SendMessages) &&
      perms.has(PermissionsBitField.Flags.EmbedLinks)
    );
  } catch {
    return false;
  }
}

async function finalizeVerification(interaction, selectedRoleId) {
  ensureConfig();
  const sec = state.config.security ?? {};
  const guild = interaction.guild;
  const member = interaction.member;

  if (!guild || !member) {
    await interaction.reply({ ...eph(), content: "Verifikacija nije dostupna u DM-u." });
    return;
  }

  const selectable = Array.isArray(sec.verifySelectableRoleIds) ? sec.verifySelectableRoleIds.filter(Boolean) : [];
  const verifiedRoleId = sec.verifiedRoleId || null;
  const unverifiedRoleId = sec.unverifiedRoleId || null;

  let roleToGive = null;

  if (selectable.length > 0) {
    if (!selectedRoleId) {
      await interaction.reply({ ...eph(), content: "Prvo odaberi rolu." });
      return;
    }
    if (!selectable.includes(selectedRoleId)) {
      await interaction.reply({ ...eph(), content: "Ta rola nije dozvoljena za verifikaciju." });
      return;
    }
    roleToGive = selectedRoleId;
  } else if (verifiedRoleId) {
    roleToGive = verifiedRoleId;
  }

  try {
    // Remove unverified role if configured
    if (unverifiedRoleId && member.roles.cache.has(unverifiedRoleId)) {
      await member.roles.remove(unverifiedRoleId).catch(() => {});
    }

    // Add chosen role
    if (roleToGive && !member.roles.cache.has(roleToGive)) {
      await member.roles.add(roleToGive);
    }

    pendingVerifyRole.delete(interaction.user.id);

    // Acknowledge (edit if already replied, else reply)
    const msg = roleToGive ? "Verifikacija završena. Rola dodijeljena." : "Verifikacija završena.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg, components: [] }).catch(() => {});
    } else {
      await interaction.reply({ ...eph(), content: msg });
    }
  } catch (e) {
    await interaction.reply({ ...eph(), content: "Ne mogu dodijeliti rolu. Provjeri bot permisije i poziciju role." });
  }
}


async function grantDefaultVerifiedRole(guildMember) {
  // Komentar HR: Dodjeljuje verified rolu (i skida unverified) nakon uspješne provjere.
  ensureConfig();
  const sec = state.config.security ?? {};
  const verifiedRoleId = sec.verifiedRoleId || null;
  const unverifiedRoleId = sec.unverifiedRoleId || null;

  if (!guildMember) throw new Error("no_member");

  if (unverifiedRoleId && guildMember.roles.cache.has(unverifiedRoleId)) {
    await guildMember.roles.remove(unverifiedRoleId).catch(() => {});
  }
  if (verifiedRoleId && !guildMember.roles.cache.has(verifiedRoleId)) {
    await guildMember.roles.add(verifiedRoleId);
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// FS25 TELEMETRY HTTP SERVER (FS25 server-side mod -> bot)
//  - POST /telemetry/fs25 (Bearer TELEMETRY_SECRET)
//  - GET  /telemetry/ping
///////////////////////////////////////////////////////////////////////////////////////////////////

function getBearer(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        const err = new Error("payload_too_large");
        err.httpCode = 413;
        reject(err);
        try { req.destroy(); } catch {}
        return;
      }
      buf += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!buf) return resolve(null);
      try { resolve(JSON.parse(buf)); }
      catch (e) { const err = new Error("invalid_json"); err.httpCode = 400; reject(err); }
    });
  });
}

function diffJoinLeave(prevOnline, nextOnline) {
  const prev = new Set((prevOnline ?? []).map(String));
  const next = new Set((nextOnline ?? []).map(String));
  const joined = [...next].filter((x) => !prev.has(x));
  const left = [...prev].filter((x) => !next.has(x));
  return { joined, left };
}

function normalizePlayerName(x) {
  if (x == null) return null;
  if (typeof x === "string") return x.trim() || null;
  if (typeof x === "object") {
    return (
      String(x.nickname ?? x.name ?? x.playerName ?? x.username ?? x.displayName ?? "").trim() || null
    );
  }
  return String(x).trim() || null;
}

function extractPlayersFromSnapshot(snap) {
  // Supports multiple mod/build schemas.
  // 1) Older wrapper: playersOnline / players
  // 2) FarmBuddyTelemetry (XMLSink/JSON): payload.users[] with { nickname, uniqueUserId }
  const readArr = (arr) =>
    Array.isArray(arr)
      ? arr
          .map((p) => normalizePlayerName(p))
          .filter(Boolean)
          .slice(0, 128)
      : [];

  let out = readArr(snap?.playersOnline ?? snap?.players ?? null);
  if (!out.length) out = readArr(snap?.payload?.users ?? snap?.users ?? null);
  if (!out.length) out = readArr(snap?.payload?.playersOnline ?? snap?.payload?.players ?? null);

  // Many telemetry builds include a synthetic "Server" user; drop it if there are real players.
  if (out.length > 1) out = out.filter((n) => String(n).toLowerCase() !== "server");

  return out;
}

globalThis.extractPlayersFromSnapshot = extractPlayersFromSnapshot;


function extractUserObjectsFromSnapshot(snap) {
  // Returns stable IDs when available (FarmBuddyTelemetry: payload.users[] with { nickname, uniqueUserId })
  const users = [];
  const arr = snap?.payload?.users ?? snap?.users ?? null;
  if (Array.isArray(arr)) {
    for (const u of arr) {
      if (u == null || typeof u !== "object") continue;
      const uid = String(u.uniqueUserId ?? u.userId ?? "").trim();
      if (!uid) continue;
      const nickname = normalizePlayerName(u) ?? uid;
      if (String(nickname).toLowerCase() === "server") continue;
      users.push({ uniqueUserId: uid, nickname });
    }
  }
  return users;
}
globalThis.extractUserObjectsFromSnapshot = extractUserObjectsFromSnapshot;


function extractVehiclesCountFromSnapshot(snap) {
  // Supports multiple mod/build schemas.
  const vehiclesRaw = snap?.vehicles ?? snap?.payload?.vehicles ?? null;
  if (Array.isArray(vehiclesRaw)) return vehiclesRaw.length;
  const n = Number(snap?.vehiclesCount ?? snap?.payload?.vehiclesCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}
globalThis.extractVehiclesCountFromSnapshot = extractVehiclesCountFromSnapshot;

function extractVehiclesFromSnapshot(snap) {
  const vehiclesRaw = snap?.payload?.vehicles ?? snap?.vehicles ?? snap?.payload?.fleet ?? snap?.fleet ?? null;
  if (!Array.isArray(vehiclesRaw)) return [];
  // Ensure each entry has a stable string id
  return vehiclesRaw
    .filter(v => v && typeof v === "object")
    .map(v => ({
      ...v,
      id: v.id != null ? String(v.id) : (v.vehicleId != null ? String(v.vehicleId) : String(v.xmlFilename ?? v.name ?? Math.random())),
      name: v.name ?? v.displayName ?? v.typeName ?? v.xmlFilename ?? "Vehicle",
      category: v.category ?? v.vehicleType ?? v.typeName ?? null,
    }));
}
globalThis.extractVehiclesFromSnapshot = extractVehiclesFromSnapshot;

function extractFarmsFromSnapshot(snap) {
  const farmsRaw = snap?.payload?.farms ?? snap?.payload?.economy?.farms ?? snap?.farms ?? null;
  if (!Array.isArray(farmsRaw)) return [];
  return farmsRaw.filter(f => f && typeof f === "object").map(f => ({
    ...f,
    farmId: f.farmId != null ? Number(f.farmId) : (f.id != null ? Number(f.id) : null),
    name: f.name ?? f.farmName ?? null,
  }));
}
globalThis.extractFarmsFromSnapshot = extractFarmsFromSnapshot;

function summarizeEconomyFromSnapshot(snap) {
  const farms = globalThis.extractFarmsFromSnapshot(snap);
  if (!farms.length) return null;
  let money = 0;
  let loan = 0;
  let moneyKnown = false;
  let loanKnown = false;

  for (const f of farms) {
    const m = Number(f.money);
    const l = Number(f.loan);
    if (Number.isFinite(m)) { money += m; moneyKnown = true; }
    if (Number.isFinite(l)) { loan += l; loanKnown = true; }
  }

  return {
    farmsCount: farms.length,
    money: moneyKnown ? Math.round(money) : null,
    loan: loanKnown ? Math.round(loan) : null,
  };
}

function formatFsDayTime(dayTimeMs) {
  const ms = Number(dayTimeMs);
  if (!Number.isFinite(ms)) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hh = Math.floor((totalSeconds / 3600) % 24);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}



function extractFarmlandsStatsFromSnapshot(snap) {
  const farmlands = snap?.payload?.farmlands ?? snap?.farmlands ?? null;
  if (!Array.isArray(farmlands)) return { count: 0, areaHa: 0 };
  let area = 0;
  for (const f of farmlands) {
    const a = Number(f?.areaInHa ?? f?.areaHa ?? 0);
    if (Number.isFinite(a)) area += a;
  }
  return { count: farmlands.length, areaHa: Math.round(area * 100) / 100 };
}

function extractMapNameFromSnapshot(snap) {
  return (
    snap?.mapTitle ??
    snap?.mapName ??
    snap?.map ??
    snap?.mapId ??
    snap?.payload?.mapTitle ??
    null
  );
}



async function emitLogLine(line) {
  try {
    ensureConfig();
    const id = state.config.logChannelId;
    if (!id) return;
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    await ch.send({ content: line }).catch(() => null);
  } catch {}
}

function getFs25EventsChannelId() {
  try {
    ensureConfig();
    return (
      state.config?.fs25?.eventsChannelId ??
      process.env.FS25_EVENTS_CHANNEL_ID ??
      null
    );
  } catch {
    return process.env.FS25_EVENTS_CHANNEL_ID ?? null;
  }
}

async function emitFs25EventLine(line) {
  try {
    const id = getFs25EventsChannelId();
    if (!id) return;
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    await ch.send({ content: line }).catch(() => null);
  } catch {}
}

function getTelemetrySecret() {
  // Prefer env for security, but allow config fallback for convenience.
  try {
    ensureConfig();
    return (
      process.env.TELEMETRY_SECRET ??
      process.env.TELEMETARY_SECRET ??
      state.config?.telemetrySecret ??
      null
    );
  } catch {
    return process.env.TELEMETRY_SECRET ?? process.env.TELEMETARY_SECRET ?? null;
  }
}

function getTelemetryBaseUrl() {
  try {
    ensureConfig();
    const raw = String(state.config?.telemetryBaseUrl ?? "").trim();
    return raw || null;
  } catch {
    return null;
  }
}

async function applyFs25TelemetryUpdate(body) {
  ensureConfig();

  const serverId = String(body.serverId ?? "fs25").trim() || "fs25";
  const kind = String(body.kind ?? "snapshot");
  const tsRaw = body.ts;
  const ts = (typeof tsRaw === "string" && tsRaw.includes("T")) ? tsRaw : nowISO();

  state.gameTelemetry = state.gameTelemetry ?? {};
  state.gameTelemetry.servers = state.gameTelemetry.servers ?? {};
  state.gameTelemetry.servers[serverId] = state.gameTelemetry.servers[serverId] ?? {};
  const slot = state.gameTelemetry.servers[serverId];

  const prevPlayers = Array.isArray(slot.playersOnline) ? slot.playersOnline.slice() : [];

  slot.lastAt = ts;
  slot.sourceTs = tsRaw ?? null;

  if (kind === "snapshot") {
    const snap = body.data ?? body.snapshot ?? body;
    slot.snapshot = snap;

    // Players (supports multiple schemas)
    slot.playersOnline = globalThis.extractPlayersFromSnapshot(snap);
    // Keep a "sticky" last-known player list for dashboard UX (do not wipe the list when server is empty)
    if (Array.isArray(slot.playersOnline) && slot.playersOnline.length) {
      slot.lastNonEmptyPlayers = { list: slot.playersOnline.slice(0, 50), at: ts };
    }

    // Vehicles (may be absent in some telemetry builds)
    slot.vehiclesCount = globalThis.extractVehiclesCountFromSnapshot(snap);
    slot.vehicles = globalThis.extractVehiclesFromSnapshot(snap);
    slot.fleetUpdatedAt = ts;

    // Farms / economy (optional)
    slot.farms = globalThis.extractFarmsFromSnapshot(snap);
    slot.economy = summarizeEconomyFromSnapshot(snap);


    // Farmlands (optional)
    const fs = extractFarmlandsStatsFromSnapshot(snap);
    slot.farmlandsCount = fs.count;
    slot.farmlandsAreaHa = fs.areaHa;

    // Map / save
    slot.mapName = extractMapNameFromSnapshot(snap);
    slot.saveName = snap.saveName ?? snap.savegameName ?? null;

  } else if (kind === "event") {
    slot.lastEvent = body.event ?? body.data ?? body;
  }

  saveState();

  const { joined, left } = diffJoinLeave(prevPlayers, slot.playersOnline ?? []);

  // Player Hours (stable by uniqueUserId when available)
  try {
    if (kind === "snapshot") {
      const snap = body.data ?? body.snapshot ?? body;
      const usersObj = globalThis.extractUserObjectsFromSnapshot(snap);
      const r = updatePlayerHoursOnSnapshot(serverId, usersObj, ts);
      if (r.leftFsIds?.length) {
        // Refresh Player Hours panel on leave/crash
        const phMeta = state.panels?.playerhours;
        if (phMeta?.channelId && phMeta?.messageId) {
          try {
            const ch = await client.channels.fetch(phMeta.channelId);
            if (ch && ch.isTextBased()) await upsertPanel("playerhours", ch);
          } catch {}
        }
      }
    }
  } catch (e) {
    // Do not crash telemetry pipeline for hours accounting
    log.warn?.(`[PlayerHours] ${e?.message ?? e}`);
  }

  if (joined.length || left.length) {
    const onlineCount = (slot.playersOnline ?? []).length;
    for (const j of joined) {
      const msg = `🟢 Join: **${j}** (online: **${onlineCount}**)`;
      await emitFs25EventLine(msg);
      await emitLogLine(msg);
    }
    for (const l of left) {
      const msg = `🔴 Leave: **${l}** (online: **${onlineCount}**)`;
      await emitFs25EventLine(msg);
      await emitLogLine(msg);
    }
  }

  // Refresh serverstats panel (if deployed)
  if (state.panels?.serverstats?.channelId) {
    try { await upsertPanel("serverstats"); } catch {}
  }


  // Refresh fleet panel (if deployed)
  if (state.panels?.fleet?.channelId) {
    try { await upsertPanel("fleet"); } catch {}
  }
}


function startTelemetryFtpIngest() {
  // Pulls telemetry_latest.xml over FTP/FTPS and feeds it into the same pipeline as POST /telemetry/fs25.
  // ENV:
  //  FS25_FTP_HOST, FS25_FTP_USER, FS25_FTP_PASS
  //  FS25_FTP_REMOTE_PATH  (example: /profile/modSettings/FarmBuddyTelemetry/telemetry_latest.xml)
  //  FS25_FTP_SECURE       ("true" to enable FTPS explicit TLS)
  //  FS25_FTP_POLL_MS      (default 3000)
  //  FS25_SERVER_ID        (optional override)
  ensureConfig();

  const host = process.env.FS25_FTP_HOST;
  const user = process.env.FS25_FTP_USER;
  const password = process.env.FS25_FTP_PASS;
  const remotePath = process.env.FS25_FTP_REMOTE_PATH;
  const pollMs = Number(process.env.FS25_FTP_POLL_MS ?? 3000);

  if (!host || !user || !password || !remotePath) {
    console.log("[fs25ftp] Not configured; set FS25_FTP_HOST/USER/PASS/REMOTE_PATH to enable FTP telemetry ingest.");
    return null;
  }

  const secure = String(process.env.FS25_FTP_SECURE ?? "false").toLowerCase() === "true";
  const port = process.env.FS25_FTP_PORT ? Number(process.env.FS25_FTP_PORT) : 21;
  const timeoutMs = process.env.FS25_FTP_TIMEOUT_MS ? Number(process.env.FS25_FTP_TIMEOUT_MS) : 10_000;

  if (secure) {
    // basic FTP implementation below does not support FTPS. If you truly need FTPS, use the HTTP telemetry bridge.
    console.warn("[fs25ftp] FS25_FTP_SECURE=true requested, but this build supports plain FTP only. Set FS25_FTP_SECURE=false or use HTTP telemetry/bridge.");
    return null;
  }

  let lastHash = null;
  let running = false;

  const decodeXmlEntities = (s) =>
    String(s)
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCharCode(parseInt(n, 16)));

  const extractJsonFromTelemetryLatestXml = (xml) => {
    // Expect JSON stored as an XML attribute (json="{...}") or element text.
    // We keep it intentionally tolerant.
    const m1 = xml.match(/\bjson\s*=\s*"([\s\S]*?)"/i);
    if (m1) return decodeXmlEntities(m1[1]);
    const m2 = xml.match(/\bjson\s*=\s*'([\s\S]*?)'/i);
    if (m2) return decodeXmlEntities(m2[1]);
    // Fallback: first JSON-looking blob in the file.
    const m3 = xml.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (m3) return m3[1];
    return null;
  };

  const readFtpFile = async () => {
    // Minimal passive-mode FTP RETR implementation (plain FTP only).
    // NOTE: This is intentionally self-contained (no external deps). For troubleshooting set:
    //   FS25_FTP_DEBUG=true
    const debug = String(process.env.FS25_FTP_DEBUG ?? "false").toLowerCase() === "true";

    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(timeoutMs);

      let buffer = "";
      let pending = null;
      const replyQueue = [];

      let dataSocket = null;

      const log = (...args) => {
        if (debug) console.log("[fs25ftp][debug]", ...args);
      };

      const cleanup = () => {
        try { if (dataSocket) dataSocket.destroy(); } catch {}
        try { socket.destroy(); } catch {}
      };

      const fail = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const parseReplyLine = (line) => {
        const m = line.match(/^(\d{3})([ -])(.*)$/);
        if (!m) return null;
        return { code: Number(m[1]), sep: m[2], text: m[3] };
      };

      const waitReply = (label = "reply") =>
        new Promise((res, rej) => {
          const t = setTimeout(() => {
            if (pending) pending = null;
            rej(new Error(`Timeout waiting for FTP ${label}`));
          }, timeoutMs);

          const finish = (fn, arg) => {
            clearTimeout(t);
            fn(arg);
          };

          if (replyQueue.length) return finish(res, replyQueue.shift());

          pending = {
            res: (r) => finish(res, r),
            rej: (e) => finish(rej, e),
          };
        });

      const send = (cmd) => {
        log("C>", cmd);
        socket.write(cmd + "\r\n");
      };

      socket.on("timeout", () => fail(new Error("Timeout (control socket)")));
      socket.on("error", (e) => fail(e));

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n");
          const raw = buffer.slice(0, idx + 1);
          buffer = buffer.slice(idx + 1);
          const line = raw.replace(/\r?\n$/, "");

          const r = parseReplyLine(line);
          if (!r) continue;

          log("S<", `${r.code}${r.sep}${r.text}`);

          // We only treat lines with a space separator as the end of a reply.
          if (r.sep === " ") {
            if (pending) {
              const p = pending;
              pending = null;
              p.res(r);
            } else {
              replyQueue.push(r);
            }
          }
        }
      });

      (async () => {
        try {
          // 220 greeting
          let r = await waitReply("greeting");
          if (r.code !== 220) throw new Error(`FTP greet failed: ${r.code} ${r.text}`);

          send(`USER ${user}`);
          r = await waitReply("USER");
          if (r.code === 331) {
            send(`PASS ${password}`);
            r = await waitReply("PASS");
          }
          if (r.code !== 230) throw new Error(`FTP auth failed: ${r.code} ${r.text}`);

          send("TYPE I");
          r = await waitReply("TYPE");
          if (r.code !== 200) throw new Error(`FTP TYPE failed: ${r.code} ${r.text}`);

          // PASV (fallback EPSV)
          let pasvHost = host;
          let pasvPort = null;
          send("PASV");
          r = await waitReply("PASV");
          if (r.code === 227) {
            const m = r.text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
            if (!m) throw new Error(`FTP PASV parse failed: ${r.text}`);
            pasvHost = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
            pasvPort = Number(m[5]) * 256 + Number(m[6]);
          } else {
            // EPSV
            send("EPSV");
            r = await waitReply("EPSV");
            if (r.code !== 229) throw new Error(`FTP PASV/EPSV failed: ${r.code} ${r.text}`);
            const m = r.text.match(/\(\|\|\|(\d+)\|\)/);
            if (!m) throw new Error(`FTP EPSV parse failed: ${r.text}`);
            pasvPort = Number(m[1]);
          }

          // Data connection
          dataSocket = net.createConnection({ host: pasvHost, port: pasvPort });
          dataSocket.setTimeout(timeoutMs);

          const chunks = [];
          dataSocket.on("data", (b) => chunks.push(Buffer.from(b)));

          const dataDone = new Promise((res, rej) => {
            dataSocket.on("timeout", () => rej(new Error("Timeout (data socket)")));
            dataSocket.on("error", (e) => rej(e));
            dataSocket.on("end", () => res());
            dataSocket.on("close", () => res());
          });
          dataDone.catch(() => {}); // prevent unhandled rejection if we abort early

          send(`RETR ${remotePath}`);
          r = await waitReply("RETR");
          if (r.code !== 150 && r.code !== 125) throw new Error(`FTP RETR refused: ${r.code} ${r.text}`);

          // Guard against stuck transfers
          await Promise.race([
            dataDone,
            new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout waiting for data transfer")), timeoutMs + 2000)),
          ]);

          r = await waitReply("transfer-complete");
          if (r.code !== 226 && r.code !== 250) throw new Error(`FTP RETR did not complete: ${r.code} ${r.text}`);

          try { send("QUIT"); } catch {}
          const out = Buffer.concat(chunks).toString("utf8");
          resolve(out);
          cleanup();
        } catch (e) {
          fail(e);
        }
      })();
    });
  };


  const tick = async () => {
    if (running) return;
    running = true;

    try {
      const raw = await readFtpFile();
      const hash = crypto.createHash("sha1").update(raw, "utf8").digest("hex");
      if (hash === lastHash) return;
      lastHash = hash;

      const trimmed = String(raw ?? "").trim();
      let payload;

      // Mod file sink typically writes telemetry_latest.json (raw JSON).
      // Older builds may write telemetry_latest.xml with JSON embedded inside.
      if (remotePath && String(remotePath).toLowerCase().endsWith(".json")) {
        payload = JSON.parse(trimmed);
      } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        payload = JSON.parse(trimmed);
      } else {
        const jsonStr = extractJsonFromTelemetryLatestXml(raw);
        if (!jsonStr) throw new Error("No JSON found in telemetry file");
        payload = JSON.parse(jsonStr);
      }

      // Support both "wrapped" payloads and raw snapshot payloads
      const body =
        payload && typeof payload === "object" && payload.serverId && payload.kind
          ? payload
          : {
              serverId: String(process.env.FS25_SERVER_ID ?? payload?.serverId ?? "fs25"),
              kind: String(payload?.kind ?? "snapshot"),
              ts: String(payload?.ts ?? nowISO()),
              data: payload?.data ?? payload?.snapshot ?? payload,
            };
      try {
        const sid = String(body.serverId ?? "fs25");
        const snap = body.data ?? body.snapshot ?? body;
        const pCount = globalThis.extractPlayersFromSnapshot(snap).length;
        const vCount = globalThis.extractVehiclesCountFromSnapshot(snap);
        const bytes = Buffer.byteLength(String(raw ?? ""), "utf8");
        console.log(`[fs25ftp] pulled ${remotePath} (${bytes} bytes) server=${sid} players=${pCount} vehicles=${vCount}`);
      } catch {}
      await applyFs25TelemetryUpdate(body);
    } catch (e) {
      console.warn("[fs25ftp] ingest error:", String(e?.message ?? e), "| remotePath=", remotePath, "| host=", host);
    } finally {
      running = false;
    }
  };

  tick();
  const timer = setInterval(tick, Math.max(1000, pollMs));
  console.log("[fs25ftp] FTP telemetry ingest enabled.");
  return timer;
}

function startTelemetryHttpServer() {
  ensureConfig();
  const port = Number(process.env.PORT ?? 8080);
  const secret = getTelemetrySecret();

  if (!secret) {
    console.warn("[telemetry] TELEMETRY_SECRET not set; /telemetry endpoints disabled.");
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const reply = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    try {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = u.pathname;

      if (req.method === "GET" && pathname === "/telemetry/ping") {
        return reply(200, { ok: true, ts: nowISO() });
      }

      if (req.method === "POST" && pathname === "/telemetry/fs25") {
        const bearer = getBearer(req);
        if (!bearer || bearer !== secret) return reply(401, { ok: false, error: "unauthorized" });

        const body = await readJsonBody(req);
        if (!body || typeof body !== "object") return reply(400, { ok: false, error: "missing_body" });

        await applyFs25TelemetryUpdate(body);

        return reply(200, { ok: true });
      }

      return reply(404, { ok: false, error: "not_found" });
    } catch (e) {
      return reply(Number(e?.httpCode ?? 500), { ok: false, error: String(e?.message ?? "server_error") });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[telemetry] Listening on :${port}`);
  });

return server;
}

async function sendToLog(content) {
  const chId = state.config?.logChannelId;
  if (!chId) return;
  try {
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    const perms = getBotPermsInChannel(ch);
    if (!perms.ok) {
      warnRateLimited("log:send_perms", `[logs] Cannot send to log channel (missing perms: ${perms.missing.join(", ")}).`);
      return;
    }
    await ch.send(content);
  } catch (e) {
    warnRateLimited("log:send_failed", "[logs] Failed to send message to log channel.", e);
  }
}

async function sendToModLog(content) {
  const chId = state.config?.modLogChannelId || state.config?.logChannelId;
  if (!chId) return;
  try {
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    const perms = getBotPermsInChannel(ch);
    if (!perms.ok) {
      warnRateLimited("modlog:send_perms", `[modlog] Cannot send (missing perms: ${perms.missing.join(", ")}).`);
      return;
    }
    await ch.send(content);
  } catch (e) {
    warnRateLimited("modlog:send_failed", "[modlog] Failed to send moderation log message.", e);
  }
}


const __warnBuckets = new Map();
function warnRateLimited(key, msg, err = null, everyMs = 5 * 60 * 1000) {
  const now = Date.now();
  const last = __warnBuckets.get(key) ?? 0;
  if (now - last < everyMs) return;
  __warnBuckets.set(key, now);
  if (err) console.warn(msg, err);
  else console.warn(msg);
}

function getBotPermsInChannel(channel) {
  try {
    const guild = channel?.guild ?? null;
    const me = guild?.members?.me ?? null;
    if (!guild || !me) return { ok: false, missing: ["unknown_bot_member"] };
    const perms = channel.permissionsFor(me);
    const needed = [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.EmbedLinks,
    ];
    const missing = needed.filter((p) => !perms?.has(p));
    return { ok: missing.length === 0, missing };
  } catch {
    return { ok: false, missing: ["permission_check_failed"] };
  }
}

async function ensureLogChannel(guild, { name = process.env.LOG_CHANNEL_NAME || "logs" } = {}) {
  ensureConfig();

  // If configured, validate it still exists and is usable.
  if (state.config?.logChannelId) {
    const ch = await guild.channels.fetch(state.config.logChannelId).catch(() => null);
    if (ch && ch.isTextBased()) {
      const perms = getBotPermsInChannel(ch);
      if (perms.ok) return ch;
      warnRateLimited("log:perms", `[logs] Configured log channel exists but missing perms: ${perms.missing.join(", ")}`);
      return ch; // keep it; user can fix perms
    }
    // Channel deleted or invalid -> clear and proceed
    state.config.logChannelId = null;
    saveState();
  }

  // Try find existing by name
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name
  );
  if (existing && existing.isTextBased()) {
    state.config.logChannelId = existing.id;
    saveState();
    return existing;
  }

  // Create (if permitted)
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    warnRateLimited("log:no_me", "[logs] Cannot resolve bot member; skipping log channel auto-create.");
    return null;
  }

  if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    warnRateLimited("log:no_manage", "[logs] Missing Manage Channels permission; cannot auto-create log channel.");
    return null;
  }

  const created = await guild.channels
    .create({
      name,
      type: ChannelType.GuildText,
      topic: "FarmBudy logs (admin + errors, low-noise).",
      reason: "FarmBudy auto-created log channel",
    })
    .catch((e) => {
      warnRateLimited("log:create_failed", "[logs] Failed to create log channel.", e);
      return null;
    });

  if (created && created.isTextBased()) {
    state.config.logChannelId = created.id;
    saveState();
    return created;
  }

  return null;
}


function applyVars(template, memberOrUser, guild) {
  const user = memberOrUser?.user ?? memberOrUser;
  const memberCount = guild?.memberCount ?? 0;
  const username = user?.username ?? "User";
  const tag = user?.tag ?? username;
  return String(template ?? "")
    .replaceAll("{user}", user?.id ? `<@${user.id}>` : username)
    .replaceAll("{username}", username)
    .replaceAll("{tag}", tag)
    .replaceAll("{server}", guild?.name ?? "")
    .replaceAll("{memberCount}", String(memberCount));
}

function hasRole(member, roleId) {
  if (!roleId) return false;
  try { return member.roles?.cache?.has?.(roleId) ?? false; } catch { return false; }
}

function isVerified(member) {
  const memberRoleId = state.config?.security?.memberRoleId;
  if (!memberRoleId) return true; // if not configured, treat as verified
  return hasRole(member, memberRoleId);
}

function accountAgeDays(user) {
  try {
    const created = user?.createdAt ? user.createdAt.getTime() : 0;
    if (!created) return 9999;
    return (Date.now() - created) / (1000 * 60 * 60 * 24);
  } catch {
    return 9999;
  }
}

async function sendToTaskHistory(content) {
  const chId = state.config?.taskHistoryChannelId;
  if (!chId) return;
  try {
    const ch = await client.channels.fetch(chId);
    if (ch && ch.isTextBased()) await ch.send(content);
  } catch {}
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// BACKUP / RESTORE + DAILY SUMMARY (low-noise mode)
//  - Activity channel is OFF: we do not spam START/PAUSE.
//  - Task history channel receives DONE events and the daily summary.
//  - Backup posts state.json as attachment; restore pulls the latest JSON attachment.
///////////////////////////////////////////////////////////////////////////////////////////////////

function zagrebParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Zagreb",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const obj = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
  return obj; // {year, month, day, hour, minute}
}

function zagrebDateKey(date = new Date()) {
  const p = zagrebParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

function pushEvent(ev) {
  state.activity = state.activity ?? [];
  state.activity.unshift(ev);
  // keep last 2000 events
  if (state.activity.length > 2000) state.activity.length = 2000;
}

function getBackupChannelId() {
  return state.config?.backupChannelId || state.config?.logChannelId || state.config?.taskHistoryChannelId || null;
}

async function sendStateBackup(actorUserId = null) {
  const chId = getBackupChannelId();
  if (!chId) return false;

  try {
    const ch = await client.channels.fetch(chId);
    if (!ch || !ch.isTextBased()) return false;

    // Ensure on-disk state is up to date
    saveState();

    const buf = fs.readFileSync(STATE_PATH);
    const stamp = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
    const file = new AttachmentBuilder(buf, { name: `state-${Date.now()}.json` });

    await ch.send({
      content: `📦 Backup state.json${actorUserId ? ` — by <@${actorUserId}>` : ""} — ${stamp}`,
      files: [file],
    });

    pushEvent({ ts: Date.now(), type: "BACKUP", actorUserId: actorUserId ?? null });
    saveState();
    return true;
  } catch (e) {
    console.error("sendStateBackup error:", e);
    return false;
  }
}

function normalizeLoadedState(parsed) {
  const base = {
    version: 3,
    config: {
      fields: [1, 2, 3, 4, 5],
      logChannelId: null,
      detailsChannelId: null,
      taskHistoryChannelId: null,
      backupChannelId: null,
      activityMode: "OFF",
      lastDailySummaryDate: null,
    },
    panels: {},
    fields: {},
    tasks: {},
    activity: [],
    counters: { taskSeq: 1 },
  };

  const merged = { ...base, ...(parsed ?? {}) };
  merged.config = { ...base.config, ...(parsed?.config ?? {}) };
  merged.panels = merged.panels ?? {};
  merged.fields = merged.fields ?? {};
  merged.tasks = merged.tasks ?? {};
  merged.activity = Array.isArray(merged.activity) ? merged.activity : [];
  merged.counters = merged.counters ?? { taskSeq: 1 };

  // Force low-noise
  merged.config.activityMode = "OFF";

  return merged;
}

async function restoreStateFromLatestBackup(actorUserId = null) {
  const chId = getBackupChannelId();
  if (!chId) return { ok: false, reason: "no_channel" };

  try {
    const ch = await client.channels.fetch(chId);
    if (!ch || !ch.isTextBased()) return { ok: false, reason: "bad_channel" };

    const msgs = await ch.messages.fetch({ limit: 25 });
    const msg = msgs.find((m) => (m.attachments?.size ?? 0) > 0);

    if (!msg) return { ok: false, reason: "no_backup_found" };

    const att = msg.attachments.find((a) => (a.name || "").toLowerCase().endsWith(".json"));
    if (!att?.url) return { ok: false, reason: "no_json_attachment" };

    const res = await fetch(att.url);
    if (!res.ok) return { ok: false, reason: "download_failed" };
    const txt = await res.text();

    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch {
      return { ok: false, reason: "json_parse_failed" };
    }

    state = normalizeLoadedState(parsed);
    saveState();

    pushEvent({ ts: Date.now(), type: "RESTORE", actorUserId: actorUserId ?? null });
    saveState();

    return { ok: true };
  } catch (e) {
    console.error("restoreStateFromLatestBackup error:", e);
    return { ok: false, reason: "exception" };
  }
}

async function sendDailySummaryIfDue() {
  try {
    // Summary goes to task history
    if (!state.config?.taskHistoryChannelId) return;

    const zp = zagrebParts(new Date());
    const dateKey = zagrebDateKey(new Date());

    // Run once per day around 03:00 Zagreb (03:00-03:19 window).
    const h = Number(zp.hour);
    const m = Number(zp.minute);
    if (h !== 3 || m > 19) return;

    if (state.config.lastDailySummaryDate === dateKey) return;

    const since = Date.now() - 24 * 60 * 60 * 1000;
    const done = (state.activity ?? []).filter((e) => e && e.type === "DONE" && Number(e.ts) >= since);

    const total = done.length;
    const byStage = {};
    const byUser = {};
    for (const e of done) {
      const sk = e.stageKey || "UNKNOWN";
      byStage[sk] = (byStage[sk] || 0) + 1;
      const u = e.actorUserId || "unknown";
      byUser[u] = (byUser[u] || 0) + 1;
    }

    const topStages = Object.entries(byStage).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const topUsers = Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 8);

    const stageLines = topStages.length
      ? topStages.map(([k, v]) => `• ${STAGES[k]?.emoji ?? "🔹"} ${STAGES[k]?.label ?? k}: **${v}**`).join("\n")
      : "• (nema)";

    const userLines = topUsers.length
      ? topUsers
          .map(([u, v]) => `• ${u === "unknown" ? "Nepoznato" : `<@${u}>`}: **${v}**`)
          .join("\n")
      : "• (nema)";

    await sendToTaskHistory({
      content:
        `📊 **Dnevni sažetak (zadnjih 24h)**
` +
        `Ukupno završeno: **${total}**

` +
        `**Po fazama**
${stageLines}

` +
        `**Po igračima**
${userLines}`,
    });

    state.config.lastDailySummaryDate = dateKey;
    saveState();
  } catch (e) {
    console.error("sendDailySummaryIfDue error:", e);
  }
}

function startDailySummaryLoop() {
  // check every 10 minutes
  setInterval(() => void sendDailySummaryIfDue(), 10 * 60 * 1000);
}

function startBackupLoop() {
  // every 12 hours
  const ms = 12 * 60 * 60 * 1000;
  setInterval(() => void sendStateBackup(null), ms);
}

// TEMP: disable per-embed colors (prevents ReferenceError)

function getEmbedColor(key = null) {
  // Uses per-panel embed colors from config (admin/workflow/fieldDetails/activity).
  // When called without a key, default to Field Details.
  const defaults = {
    admin: 0x5865F2,
    workflow: 0x22aa22,
    fieldDetails: 0x22aa22,
    activity: 0x2B2D31,
  };

  const k = key || "fieldDetails";
  return colorFor(k, defaults[k] ?? 0x2B2D31);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// WORKFLOW CONFIG
///////////////////////////////////////////////////////////////////////////////////////////////////

const STAGES = {
  LIME: { key: "LIME", label: "Limanje (lime)", emoji: "🪨" },
  FERTILIZE: { key: "FERTILIZE", label: "Gnojidba", emoji: "💩" },
  TILLAGE_CHOICE: { key: "TILLAGE_CHOICE", label: "Odabir obrade", emoji: "🛠️" },
  PLOW: { key: "PLOW", label: "Oranje", emoji: "🚜" },
  SUBSOIL: { key: "SUBSOIL", label: "Podrivanje", emoji: "🪓" },
  CULTIVATE: { key: "CULTIVATE", label: "Kultiviranje", emoji: "🌿" },
  SEED_PICK: { key: "SEED_PICK", label: "Sjetva (odaberi kulturu)", emoji: "🌱" },
  SEED: { key: "SEED", label: "Sjetva", emoji: "🌱" },
  HARVEST: { key: "HARVEST", label: "Žetva / vršenje", emoji: "🌾" },
  MEADOW_MOW_1: { key: "MEADOW_MOW_1", label: "Košnja (1/3)", emoji: "✂️" },
  MEADOW_FERTILIZE: { key: "MEADOW_FERTILIZE", label: "Gnojidba (opcionalno)", emoji: "💩" },
  MEADOW_LIME: { key: "MEADOW_LIME", label: "Limanje (opcionalno)", emoji: "🪨" },
  MEADOW_MOW_2: { key: "MEADOW_MOW_2", label: "Košnja (2/3)", emoji: "✂️" },
  MEADOW_MOW_3: { key: "MEADOW_MOW_3", label: "Košnja (3/3)", emoji: "✂️" },
};

const DEFAULT_STAGE = "LIME";

const CROPS = [
  { key: "ALFAALFA", label: "AlfaAlfa", emoji: "🌿" },
  { key: "CANOLA", label: "Canola", emoji: "🌼" },
  { key: "CARROTS", label: "Carrots", emoji: "🥕" },
  { key: "CLOVER", label: "Clover", emoji: "🍀" },
  { key: "CORN", label: "Corn", emoji: "🌽" },
  { key: "COTTON", label: "Cotton", emoji: "🧵" },
  { key: "COVER_CROP", label: "Cover Crop", emoji: "🌱" },
  { key: "GRAPES", label: "Grapes", emoji: "🍇" },
  { key: "GRASS", label: "Grass", emoji: "🌾" },
  { key: "GREEN_BEANS", label: "Green Beans", emoji: "🫛" },
  { key: "GREEN_RYE", label: "Green Rye", emoji: "🌾" },
  { key: "LONG_GRAIN_RICE", label: "Long Grain Rice", emoji: "🍚" },
  { key: "MAIZE_SILAGE", label: "Maize Silage", emoji: "🌽" },
  { key: "MEADOW_GRASS", label: "Meadow grass", emoji: "🌿" },
  { key: "MUSTARD", label: "Mustard", emoji: "🌼" },
  { key: "OAT", label: "Oat", emoji: "🌾" },
  { key: "OILSEED_RADISH", label: "Oilseed Radish", emoji: "🌱" },
  { key: "OLIVES", label: "Olives", emoji: "🫒" },
  { key: "PARSNIP", label: "Parsnip", emoji: "🥕" },
  { key: "PEAS", label: "Peas", emoji: "🫛" },
  { key: "POPLAR", label: "Poplar", emoji: "🌳" },
  { key: "POTATOS", label: "Potatos", emoji: "🥔" },
  { key: "RED_BEET", label: "Red Beet", emoji: "🟥" },
  { key: "RICE", label: "Rice", emoji: "🍚" },
  { key: "RYE", label: "Rye", emoji: "🌾" },
  { key: "SORGHUM", label: "Sorghum", emoji: "🌾" },
  { key: "SOYBEANS", label: "Soybeans", emoji: "🫘" },
  { key: "SPELT", label: "Spelt", emoji: "🌾" },
  { key: "SPINACH", label: "Spinach", emoji: "🥬" },
  { key: "SPRING_BARLEY", label: "Spring Barley", emoji: "🌾" },
  { key: "SPRING_WHEAT", label: "Spring Wheat", emoji: "🌾" },
  { key: "SUGAR_BEET", label: "Sugar Beet", emoji: "🥕" },
  { key: "SUGARCANE", label: "Sugarcane", emoji: "🎋" },
  { key: "SUNFLOWERS", label: "Sunflowers", emoji: "🌻" },
  { key: "TRITICALE", label: "Triticale", emoji: "🌾" },
  { key: "VETCH_RYE", label: "Vetch-rye", emoji: "🌾" },
  { key: "WINTER_BARLEY", label: "Winter Barley", emoji: "🌾" },
  { key: "WINTER_WHEAT", label: "Winter wheat", emoji: "🌾" },
];

const CROP_ALIASES = {
  // backward compatibility with older keys
  WHEAT: "WINTER_WHEAT",
  BARLEY: "WINTER_BARLEY",
  OATS: "OAT",
  SUNFLOWER: "SUNFLOWERS",
  SOYBEAN: "SOYBEANS",
  POTATO: "POTATOS",
  SUGARBEET: "SUGAR_BEET",

  // Meadow aliases (people and mods love variation)
  ALFALFA: "ALFAALFA",
  MEADOWGRASS: "MEADOW_GRASS",
  MEADOWGRASS2: "MEADOW_GRASS",
};

function resolveCropKey(key) {
  if (!key) return key;
  return CROP_ALIASES[key] ?? key;
}

function isMeadowCropKey(key) {
  const k = resolveCropKey(key);
  return k === "GRASS" || k === "MEADOW_GRASS" || k === "CLOVER" || k === "ALFAALFA" || k === "ALFALFA";
}

const PRIORITY = {
  LOW: { key: "LOW", label: "LOW", emoji: "🟢", buttonStyle: ButtonStyle.Success },
  MED: { key: "MED", label: "MED", emoji: "🟠", buttonStyle: ButtonStyle.Primary }, // Discord has no orange style; we mimic with 🟠
  HIGH: { key: "HIGH", label: "HIGH", emoji: "🔴", buttonStyle: ButtonStyle.Danger },
};
const PRIORITY_ORDER = ["LOW", "MED", "HIGH"];

function parseHexColor(input, fallback = 0x22aa22) {
  if (typeof input !== 'string') return fallback;
  const s = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return fallback;
  return parseInt(s, 16);
}

function colorFor(key, fallback = 0x22aa22) {
  const c = state?.config?.embedColors?.[key];
  return typeof c === 'number' ? c : fallback;
}

function cropLabel(key) {
  const k = resolveCropKey(key);
  const c = CROPS.find(x => x.key === k);
  return c ? c.label : (k ?? key);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// CORE MODEL
///////////////////////////////////////////////////////////////////////////////////////////////////

function getField(fieldId) {
  const id = String(fieldId);
  state.fields = state.fields ?? {};
  if (!state.fields[id]) {
    state.fields[id] = {
      fieldId: id,
      stage: DEFAULT_STAGE,
      cycle: 1,
      crop: null,          // actual crop for current cycle (when seeded)
      plannedCrop: null,   // plan ahead
      activeTaskId: null,
      updatedAt: nowISO(),
    };
    saveState();
  } else {
    // forward-compat
    if (!("plannedCrop" in state.fields[id])) state.fields[id].plannedCrop = null;
  }
  return state.fields[id];
}

function getFieldList() {
  ensureConfig();
  return state.config.fields;
}

function nextTaskId() {
  state.counters = state.counters ?? { taskSeq: 1 };
  const n = state.counters.taskSeq ?? 1;
  state.counters.taskSeq = n + 1;
  saveState();
  return `T${String(n)}`;
}

function formatTaskId(id) {
  if (!id) return "";
  const s = String(id);
  const m = /^T0+(\d+)$/.exec(s);
  if (m) return `T${m[1]}`;
  const m2 = /^T(\d+)$/.exec(s);
  if (m2) return `T${m2[1]}`;
  return s;
}

function setFieldStage(fieldId, stageKey) {
  const f = getField(fieldId);
  f.stage = stageKey;
  f.updatedAt = nowISO();
  saveState();
}

function setFieldActiveTask(fieldId, taskId) {
  const f = getField(fieldId);
  f.activeTaskId = taskId;
  f.updatedAt = nowISO();
  saveState();
}

function getActiveTask(fieldId) {
  const f = getField(fieldId);
  if (!f.activeTaskId) return null;
  return state.tasks?.[f.activeTaskId] ?? null;
}

function getRunnableTaskForField(fieldId) {
  // Returns the task the user should be able to Run/Pause/Done for this field.
  // Priority: explicit activeTaskId → otherwise first OPEN/ACTIVE task by oldest id.
  const active = getActiveTask(fieldId);
  if (active && (active.status === "ACTIVE" || active.status === "OPEN")) return active;

  const tasks = listTasksForField(fieldId)
    .filter((t) => t.status === "ACTIVE" || t.status === "OPEN")
    .slice();

  if (!tasks.length) return null;

  const idNum = (t) => {
    const m = /^(?:T0*)?(\d+)$/.exec(String(t.id ?? ""));
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };

  tasks.sort((a, b) => {
    const sa = a.status === "ACTIVE" ? 0 : 1;
    const sb = b.status === "ACTIVE" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return idNum(a) - idNum(b);
  });

  return tasks[0] ?? null;
}

function activateTask(task, userId = null) {
  if (!task) return;
  if (task.status !== "ACTIVE") {
    task.status = "ACTIVE";
    task.startedAt = new Date().toISOString();
    if (userId) task.assignedTo = userId;
    saveState();
  }
}

function listTasksForField(fieldId) {
  const tasks = Object.values(state.tasks ?? {}).filter((t) => t.fieldId === String(fieldId));
  tasks.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return tasks;
}

function createTask(fieldId, stageKey, createdByUserId, extra = {}) {
  const id = nextTaskId();
  const stage = STAGES[stageKey] ?? { label: stageKey, emoji: "📌" };

  const status = extra.status ?? "OPEN"; // OPEN -> ACTIVE -> DONE

  const task = {
    id,
    fieldId: String(fieldId),
    stageKey,
    title: `${stage.emoji} ${stage.label}`,
    status,
    isRunning: status === "ACTIVE" ? true : false,
    priority: extra.priority ?? "LOW",
    assignedTo: extra.assignedTo ?? null,
    createdBy: createdByUserId ?? null,
    createdAt: nowISO(),
    startedAt: status === "ACTIVE" ? nowISO() : null,
    completedAt: null,
    crop: extra.crop ?? null,
    notes: extra.notes ?? "",
  };

  if (task.crop && stageKey === "SEED") {
    const c = CROPS.find((x) => x.key === resolveCropKey(task.crop));
    if (c) task.title = `${c.emoji} Sjetva: ${c.label}`;
  }

  state.tasks = state.tasks ?? {};
  state.tasks[id] = task;
  setFieldActiveTask(fieldId, id);
  saveState();
  return task;
}

function applyPlannedSeedingIfReady(fieldId, actorUserId = null) {
  const f = getField(fieldId);
  if (f.stage !== "SEED_PICK") return false;
  if (!f.plannedCrop) return false;

  const crop = CROPS.find((c) => c.key === resolveCropKey(f.plannedCrop));
  if (!crop) return false;

  // Close the pick-crop task if it is currently active
  const pick = getActiveTask(fieldId);
  if (pick && pick.stageKey === "SEED_PICK" && pick.status !== "DONE") {
    pick.status = "DONE";
    pick.completedAt = nowISO();
  }

  f.crop = f.plannedCrop;
  setFieldStage(fieldId, "SEED");
  createTask(fieldId, "SEED", actorUserId, { crop: f.plannedCrop });
  logActivity(`Plan sjetve primijenjen: **${crop.label}** (polje ${fieldId}).`);
  sendToLog({ content: `${crop.emoji} Plan sjetve primijenjen — polje **${fieldId}**: **${crop.label}**.` });
  saveState();
  return true;
}

function advanceAfterDone(fieldId, doneTask) {
  const f = getField(fieldId);
  const stage = doneTask.stageKey;

  if (stage === "LIME") setFieldStage(fieldId, "FERTILIZE");
  else if (stage === "FERTILIZE") setFieldStage(fieldId, "TILLAGE_CHOICE");
  else if (stage === "PLOW" || stage === "SUBSOIL") setFieldStage(fieldId, "CULTIVATE");
  else if (stage === "CULTIVATE") setFieldStage(fieldId, "SEED_PICK");
  else if (stage === "SEED") {
    // Grass / meadow crops loop into mowing instead of harvest.
    const cropKey = f.crop || f.plannedCrop;
    if (isMeadowCropKey(cropKey)) {
      setFieldStage(fieldId, "MEADOW_MOW_1");
      void sendToTaskHistory({ content: `🌿 **Polje ${String(fieldId)}** je livada: prelazak na **Košnja (1/3)**.` });
    } else {
      setFieldStage(fieldId, "HARVEST");
    }
  }

  // Meadow rotation (3 cuts + optional steps)
  else if (stage === "MEADOW_MOW_1") setFieldStage(fieldId, "MEADOW_FERTILIZE");
  else if (stage === "MEADOW_FERTILIZE") setFieldStage(fieldId, "MEADOW_MOW_2");
  else if (stage === "MEADOW_LIME") setFieldStage(fieldId, "MEADOW_MOW_2"); // legacy safety (step removed)
  else if (stage === "MEADOW_MOW_2") setFieldStage(fieldId, "MEADOW_MOW_3");
  else if (stage === "MEADOW_MOW_3") {
    // After 3rd cut, finish the meadow rotation ONCE (no loop).
    const prevCycle = f.cycle ?? 1;
    f.cycle = prevCycle + 1;
    f.crop = null;
    f.plannedCrop = null; // ask again next rotation unless re-planned
    setFieldStage(fieldId, "LIME");
    void sendToTaskHistory({
      content: `✂️ **Polje ${String(fieldId)}**: završena **Košnja (3/3)** — završio ciklus **${prevCycle}** → **LIME**`,
    });
  }

  else if (stage === "HARVEST") {
    const prevCycle = f.cycle ?? 1;
    f.cycle = prevCycle + 1;
    f.crop = null;
    f.plannedCrop = null; // ask again next rotation unless re-planned
    setFieldStage(fieldId, "LIME");
    void sendToTaskHistory({ content: `✅ **Polje ${String(fieldId)}** završilo ciklus **${prevCycle}** → **LIME**.` });
  } else {
    setFieldStage(fieldId, "LIME");
  }

  f.activeTaskId = null;
  f.updatedAt = nowISO();
  saveState();

  // If we reached SEED_PICK and a plan exists, immediately create seed task
  applyPlannedSeedingIfReady(fieldId, doneTask.createdBy);
}

function completeTaskById(taskId, actorUserId) {
  const t = state.tasks?.[String(taskId)];
  if (!t) return { ok: false, reason: "not_found" };
  if (t.status === "DONE") return { ok: false, reason: "already_done" };
  if (t.stageKey === "TILLAGE_CHOICE" || t.stageKey === "SEED_PICK") return { ok: false, reason: "choice_required" };

  t.isRunning = false;
  t.status = "DONE";
  t.completedAt = nowISO();
  saveState();

  const durMs = t.startedAt ? (Date.parse(t.completedAt) - Date.parse(t.startedAt)) : null;
  pushEvent({
    ts: Date.now(),
    type: "DONE",
    actorUserId,
    fieldId: String(t.fieldId),
    taskId: t.id,
    stageKey: t.stageKey,
    priority: t.priority ?? "LOW",
    durationMs: durMs ?? null,
  });

  // Low-noise mode: send DONE events to task history channel (if configured)
  try {
    const sdef = STAGES[t.stageKey] ?? { emoji: "📌", label: t.stageKey };
    const pr = PRIORITY[t.priority ?? "MED"] ?? PRIORITY.MED;
    const dur = durMs != null ? formatDurationMs(durMs) : "-";
    void sendToTaskHistory({
      content: `✅ ${actorUserId ? `<@${actorUserId}>` : "(nepoznato)"} završio ${sdef.emoji} **${sdef.label}** — Polje **${String(t.fieldId)}** • ${pr.emoji} ${pr.label} • Trajanje: ${dur}`,
    });
  } catch {}

  // Low-noise mode: DONE events go to task history channel
  try {
    const s = STAGES[t.stageKey] ?? { emoji: "📌", label: t.stageKey };
    const p = PRIORITY[t.priority ?? "MED"] ?? PRIORITY.MED;
    const who = actorUserId ? `<@${actorUserId}>` : "Nepoznato";
    const dur = durMs != null ? formatDurationMs(durMs) : "-";
    void sendToTaskHistory({
      content: `✅ ${who} završio ${s.emoji} **${s.label}** — Polje **${t.fieldId}** • ${p.emoji} ${p.label} • Trajanje: **${dur}** (Task **${formatTaskId(t.id)}**)`,
    });
  } catch {}

  advanceAfterDone(t.fieldId, t);
  return { ok: true, task: t };
}

function ensureNextForField(fieldId, userIdForCreate = null) {
  const f = getField(fieldId);

  // If we are waiting for seed pick but have a plan, auto apply it
  if (applyPlannedSeedingIfReady(fieldId, userIdForCreate)) return getActiveTask(fieldId);

  const active = getActiveTask(fieldId);
  if (active && (active.status === "OPEN" || active.status === "ACTIVE")) return active;

  if (f.stage === "TILLAGE_CHOICE") return createTask(fieldId, "TILLAGE_CHOICE", userIdForCreate);
  if (f.stage === "SEED_PICK") {
    // If a plan exists, auto-create SEED task; otherwise create a pick-crop task.
    if (applyPlannedSeedingIfReady(fieldId, userIdForCreate)) return getActiveTask(fieldId);
    return createTask(fieldId, "SEED_PICK", userIdForCreate);
  }

  return createTask(fieldId, f.stage, userIdForCreate);
}

function fieldCounters(fieldId) {
  const tasks = listTasksForField(fieldId);
  return {
    open: tasks.filter((t) => t.status === "OPEN").length,
    active: tasks.filter((t) => t.status === "ACTIVE").length,
    done: tasks.filter((t) => t.status === "DONE").length,
  };
}

function countersAll() {
  let open = 0, active = 0, done = 0;
  const fields = getFieldList();
  for (const fieldId of fields) {
    const c = fieldCounters(fieldId);
    open += c.open;
    active += c.active;
    done += c.done;
  }
  return { open, active, done };
}

function cyclePriority(task) {
  const cur = task.priority ?? "MED";
  const idx = PRIORITY_ORDER.indexOf(cur);
  const next = PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length];
  task.priority = next;
  return next;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// PARSING HELPERS
///////////////////////////////////////////////////////////////////////////////////////////////////

function parseIds(input) {
  if (!input) return [];
  const s = String(input).replace(/\s+/g, "");
  const parts = s.split(",").filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (/^\d+$/.test(p)) out.push(Number(p));
    else if (/^\d+\-\d+$/.test(p)) {
      const [a, b] = p.split("-").map(Number);
      const start = Math.min(a, b), end = Math.max(a, b);
      for (let n = start; n <= end; n++) out.push(n);
    }
  }
  return [...new Set(out.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
}

function parseChannelId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/^<\#(\d+)>$/) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// PANEL RENDERING
///////////////////////////////////////////////////////////////////////////////////////////////////

const FIELDS_PER_PAGE = 20;

const WORKFLOW_TASKS_PER_PAGE = 10;

function getWorkflowTasks(mode = "ALL") {
  const modeU = String(mode || "ALL").toUpperCase();

  // Source of truth: state.tasks (not field.tasks)
  const all = Object.values(state.tasks ?? {});

  // Running = ACTIVE + isRunning true
  const running = all.filter((t) => t && t.status === "ACTIVE" && t.isRunning === true);

  // Filter by priority
  let filtered = running;
  if (modeU !== "ALL") {
    filtered = running.filter((t) => String(t.priority || "LOW").toUpperCase() === modeU);
  }

  // Sort: priority (HIGH -> MED -> LOW), then older first
  filtered.sort((a, b) => {
    const pa = PRIORITY_ORDER.indexOf(String(a.priority || "LOW").toUpperCase());
    const pb = PRIORITY_ORDER.indexOf(String(b.priority || "LOW").toUpperCase());
    if (pa !== pb) return pb - pa;

    const ta = a.startedAt || a.createdAt || "";
    const tb = b.startedAt || b.createdAt || "";
    return String(ta).localeCompare(String(tb));
  });

  return filtered;
}

function getWorkflowWaiting() {
  const waiting = [];
  const fields = getFieldList();
  for (const fieldId of fields) {
    const f = getField(fieldId);
    if (!f) continue;

    // Waiting for a manual decision (do NOT auto-create tasks here)
    if (f.stage === "TILLAGE_CHOICE") {
      waiting.push({ fieldId: String(fieldId), kind: "TILLAGE_CHOICE", label: "Odabir obrade (oranje/podrivanje)" });
      continue;
    }

    // Waiting for seeding crop selection (no planned crop)
    if (f.stage === "SEED_PICK" && !f.plannedCrop) {
      waiting.push({ fieldId: String(fieldId), kind: "SEED_PICK", label: "Odabir sjetve (nije odabrano što se sije)" });
      continue;
    }
  }

  // Stable ordering: by field number
  waiting.sort((a, b) => Number(a.fieldId) - Number(b.fieldId));
  return waiting;
}

function boardPages(mode = "ALL") {
  const total = getWorkflowTasks(mode).length;
  return Math.max(1, Math.ceil(total / WORKFLOW_TASKS_PER_PAGE));
}

function renderWorkflowBoardEmbed(page = 0, mode = "ALL") {
  const modeU = String(mode || "ALL").toUpperCase();
  const modeLabel = modeU === "ALL" ? "Sve" : modeU === "HIGH" ? "Hitno" : modeU === "MED" ? "Srednje" : "Nisko";

  const waiting = getWorkflowWaiting();
  const runningAll = getWorkflowTasks("ALL"); // running tasks regardless of filter

  const tasks = getWorkflowTasks(mode);
  const totalPages = Math.max(1, Math.ceil(tasks.length / WORKFLOW_TASKS_PER_PAGE));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const slice = tasks.slice(safePage * WORKFLOW_TASKS_PER_PAGE, safePage * WORKFLOW_TASKS_PER_PAGE + WORKFLOW_TASKS_PER_PAGE);

  const embed = new EmbedBuilder()
    .setTitle(`FarmBudy – Polja — Aktivni zadaci`)
    .setDescription(
      `Pokrenuto: **${runningAll.length}**\n` +
      `Čeka: **${waiting.length}**\n\n` +
      `Filter: **${modeLabel}**\n`
    );

  if (slice.length) {
    const lines = slice.map((t) => {
      const p = String(t.priority || "LOW").toUpperCase();
      const pIcon = p === "HIGH" ? "🔴" : p === "MED" ? "🟠" : "🟢";
      const who = t.assignedTo ? ` <@${t.assignedTo}>` : "";
      const title = t.title ? String(t.title) : "Zadatak";
      return `• **Polje ${t.fieldId}** — ${title} — ${pIcon} **${p}**${who}`;
    });
    embed.addFields({ name: `Pokrenuto (${safePage + 1}/${totalPages})`, value: lines.join("\n").slice(0, 1024) });
  } else {
    embed.addFields({ name: "Pokrenuto", value: "*Nema pokrenutih zadataka za ovaj filter.*" });
  }

if (waiting.length) {
    const waitLines = waiting.slice(0, 10).map((w) => {
      const icon = w.kind === "TILLAGE_CHOICE" ? "🛠️" : "🌱";
      return `• **Polje ${w.fieldId}** — ${icon} ${w.label}`;
    });
    const more = waiting.length > 10 ? `\n… i još **${waiting.length - 10}**` : "";
    embed.addFields({ name: "Čeka odluku / odabir", value: (waitLines.join("\n") + more).slice(0, 1024) });
  }

  embed.setFooter({ text: `Str ${safePage + 1}/${totalPages} • Prikaz: ${WORKFLOW_TASKS_PER_PAGE}/str • Prev/Next • Filter` });
  return embed;
}

function renderWorkflowBoardComponents(page = 0, mode = "ALL", selectedTaskId = null) {
  const totalPages = boardPages(mode);
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const modeU = String(mode || "ALL").toUpperCase();

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wf:board:prev:${safePage}:${modeU}`)
      .setLabel("⬅️ Prev")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`wf:board:next:${safePage}:${modeU}`)
      .setLabel("Next ➡️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage >= totalPages - 1)
  );

  const filterRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wf:board:mode:ALL:${safePage}`).setLabel("Sve").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wf:board:mode:HIGH:${safePage}`).setLabel("Hitno").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wf:board:mode:MED:${safePage}`).setLabel("Srednje").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wf:board:mode:LOW:${safePage}`).setLabel("Nisko").setStyle(ButtonStyle.Primary)
  );

  // Allow basic users to finish a running task from the workflow board.
  const all = getWorkflowTasks("ALL");
  const opts = all.slice(0, 25).map((t) => ({
    label: `Polje ${t.fieldId} — ${String(t.title || "Zadatak").slice(0, 60)}`,
    value: String(t.id),
  }));

  const pickRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("wf:donepick")
      .setPlaceholder(all.length ? "Odaberi zadatak za završiti" : "Nema aktivnih zadataka")
      .setMinValues(0)
      .setMaxValues(1)
      .setDisabled(!all.length)
      .addOptions(opts.length ? opts : [{ label: "Nema", value: "none" }])
  );

  const doneRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(selectedTaskId ? `wf:done:${selectedTaskId}` : "wf:done:none")
      .setLabel("✅ Završi odabrani")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!selectedTaskId)
  );

  return [navRow, filterRow, pickRow, doneRow];
}

function buildFieldButtonsRows(fieldNums) {
  const rows = [];
  let btns = [];

  for (const fieldNum of fieldNums) {
    btns.push(
      new ButtonBuilder()
        .setCustomId(`wf:field:${fieldNum}`)
        .setLabel(`Polje ${fieldNum}`)
        .setStyle(ButtonStyle.Primary)
    );
    if (btns.length === 5) {
      rows.push(new ActionRowBuilder().addComponents(btns));
      btns = [];
    }
  }

if (btns.length) rows.push(new ActionRowBuilder().addComponents(btns));
  return rows;
}

function renderActivityEmbed() {
  const lines = (state.activity ?? []).slice(0, 12).map((a) => {
    const t = new Date(a.ts).toLocaleString("hr-HR");
    return `• **${t}** — ${a.text}`;
  });
  const desc = lines.length ? lines.join("\n") : "*Nema aktivnosti još.*";
  return new EmbedBuilder().setTitle("FarmBudy – Activity").setDescription(desc).setColor(getEmbedColor("activity")).setTimestamp(new Date());
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// FS25 SERVER STATS PANEL
///////////////////////////////////////////////////////////////////////////////////////////////////

function renderServerStatsEmbed() {
  ensureConfig();
  const servers = state.gameTelemetry?.servers ?? {};
  const ids = Object.keys(servers);

  const serverId = String(state.panels?.serverstats?.serverId ?? ids[0] ?? "fs25");
  const slot = servers[serverId] ?? {};
  const lastAt = slot.lastAt ? new Date(slot.lastAt).toLocaleString("hr-HR") : "—";

  const snap = slot.snapshot ?? {};
  const playersNow = Array.isArray(slot.playersOnline) ? slot.playersOnline : [];
  const onlineNow = playersNow.length;
  const stickyPlayers = Array.isArray(slot.lastNonEmptyPlayers?.list) ? slot.lastNonEmptyPlayers.list : [];
  const stickyAt = slot.lastNonEmptyPlayers?.at ? new Date(slot.lastNonEmptyPlayers.at).toLocaleString("hr-HR") : null;

  const inGame = formatFsDayTime(snap.dayTime) ?? "—";

  const uptimeSec = Number(snap.uptimeSeconds ?? null);
  const missionMs = Number(snap.missionTimeMs ?? slot.snapshot?.missionTimeMs ?? 0);
  const baseMs = Number.isFinite(uptimeSec) && uptimeSec > 0 ? uptimeSec * 1000 : missionMs;
  const upHours = Number.isFinite(baseMs) && baseMs > 0 ? Math.floor(baseMs / 3600000) : null;
  const upMins = Number.isFinite(baseMs) && baseMs > 0 ? Math.floor((baseMs % 3600000) / 60000) : null;
  const uptime = upHours != null ? `${upHours}h ${String(upMins).padStart(2, "0")}m` : "—";

  const vehicles = Array.isArray(slot.vehicles) ? slot.vehicles : [];
  const vCount = Number(slot.vehiclesCount ?? vehicles.length ?? 0) || 0;

  const catCounts = { tractor: 0, harvester: 0, truck: 0, other: 0 };
  for (const v of vehicles) {
    const s = String(v.category ?? v.typeName ?? v.vehicleType ?? "").toLowerCase();
    if (s.includes("tractor")) catCounts.tractor++;
    else if (s.includes("harvester") || s.includes("combine")) catCounts.harvester++;
    else if (s.includes("truck") || s.includes("semi")) catCounts.truck++;
    else catCounts.other++;
  }

  const economy = slot.economy ?? null;

  const lines = [
    `**Server:** ${serverId}`,
    `**Last update:** ${lastAt}`,
    `**Map:** ${slot.mapName ?? "—"}`,
    `**Save:** ${slot.saveName ?? "—"}`,
    `**Season:** ${snap.season != null ? snap.season : "—"}`,
    `**In-game time:** ${inGame}`,
    `**Uptime:** ${uptime}`,
    "",
    onlineNow === 0 && stickyPlayers.length
      ? `**Online:** **0** (zadnje stanje: **${stickyPlayers.length}** @ ${stickyAt ?? "—"})`
      : `**Online:** **${onlineNow}**`,
    onlineNow
      ? ["**Players:**", ...playersNow.slice(0, 20).map((p) => `• ${p}`), ...(playersNow.length > 20 ? ["…"] : [])].join("\n")
      : stickyPlayers.length
        ? ["**Players (zadnje):**", ...stickyPlayers.slice(0, 20).map((p) => `• ${p}`), ...(stickyPlayers.length > 20 ? ["…"] : [])].join("\n")
        : "*Nema igrača online.*",
    "",
    `**Fleet:** ${vCount}` + (vehicles.length ? ` (tractor ${catCounts.tractor}, harvester ${catCounts.harvester}, truck ${catCounts.truck}, other ${catCounts.other})` : ""),
    slot.farmlandsCount
      ? `**Farmlands:** ${Number(slot.farmlandsCount) || 0} (Σ ${Number(slot.farmlandsAreaHa ?? 0) || 0} ha)`
      : `**Farmlands:** —`,
    economy?.farmsCount != null ? `**Farms:** ${economy.farmsCount}` : `**Farms:** —`,
    economy?.money != null ? `**Money (Σ):** ${economy.money.toLocaleString("hr-HR")}` : `**Money (Σ):** —`,
    economy?.loan != null ? `**Loan (Σ):** ${economy.loan.toLocaleString("hr-HR")}` : `**Loan (Σ):** —`,
  ].filter(Boolean);

  return new EmbedBuilder()
    .setTitle("FS25 – Server Stats")
    .setDescription(lines.join("\n"))
    .setColor(getEmbedColor("workflow"))
    .setTimestamp(new Date());
}



///////////////////////////////////////////////////////////////////////////////////////////////////
// FS25 FLEET PANEL
///////////////////////////////////////////////////////////////////////////////////////////////////

function getFleetServerId() {
  const servers = state.gameTelemetry?.servers ?? {};
  const ids = Object.keys(servers);
  return String(state.panels?.fleet?.serverId ?? ids[0] ?? state.panels?.serverstats?.serverId ?? "fs25");
}

function getFleetOwners(serverId) {
  state.fleetOwners = state.fleetOwners ?? {};
  state.fleetOwners[serverId] = state.fleetOwners[serverId] ?? {};
  return state.fleetOwners[serverId];
}

function setVehicleOwner(serverId, vehicleId, userId) {
  const owners = getFleetOwners(serverId);
  if (!userId) delete owners[vehicleId];
  else owners[vehicleId] = String(userId);
  saveState();
}

function formatNumber(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toLocaleString("hr-HR");
}


function formatVehicleImplements(v) {
  const arr = v?.attachedImplements ?? v?.implements ?? v?.attachments ?? [];
  if (!Array.isArray(arr) || arr.length === 0) return "—";
  const names = arr.map((x) => (typeof x === "string" ? x : (x?.name ?? x?.title ?? x?.typeName ?? ""))).filter(Boolean);
  return names.length ? names.join(", ") : "—";
}

function formatVehicleFills(v) {
  const arr = v?.fills ?? v?.fillUnits ?? v?.tanks ?? [];
  if (!Array.isArray(arr) || arr.length === 0) return "—";
  const parts = arr.map((x) => {
    if (typeof x === "string") return x;
    const t = x?.fillType ?? x?.type ?? x?.name ?? "";
    const lvl = x?.level ?? x?.amount ?? null;
    const cap = x?.capacity ?? x?.max ?? null;
    if (t && lvl != null && cap != null) return `${t} ${formatNumber(lvl)}/${formatNumber(cap)}`;
    if (t && lvl != null) return `${t} ${formatNumber(lvl)}`;
    return t || null;
  }).filter(Boolean);
  return parts.length ? parts.join(", ") : "—";
}

function resolveVehicleOwnerDisplay(serverId, v) {
  // Prefer linked Discord owner for vehicle; fallback to farm name if present
  const owners = getFleetOwners(serverId);
  const ownerId = owners[String(v?.id ?? "")];
  if (ownerId) return `<@${ownerId}>`;

  const farmId = v?.farmId ?? v?.ownerFarmId ?? null;
  const farms = (state.gameTelemetry?.servers ?? {})[serverId]?.farms ?? null;
  if (farmId != null && farms && Array.isArray(farms)) {
    const f = farms.find((x) => Number(x?.farmId) === Number(farmId));
    if (f?.name) return f.name;
  }
  return "—";
}

// Fleet should only show vehicles that are actually drivable/controllable.
// Telemetry includes many implements/attachments which should not be selectable.
function isDrivableVehicle(v) {
  const typeName = String(v?.typeName ?? "").toLowerCase();
  const cat = String(v?.category ?? "").toUpperCase();

  // Fast deny-list for common non-drivable items
  const deny = [
    "implement",
    "weight",
    "plow",
    "mower",
    "windrower",
    "baler",
    "cultivator",
    "seeder",
    "planter",
    "sprayer",
    "spreader",
    "trailer",
    "traintrailer",
    "shovel",
    "fork",
    "leveler",
    "tool",
    "frontloadertool",
  ];
  if (deny.some((x) => typeName.includes(x))) return false;
  if (["WEIGHTS", "PLOWS", "SEEDERS", "PLANTERS", "MOWERS", "CULTIVATORS", "FRONTLOADERTOOLS", "TELELOADERTOOLS"].includes(cat)) return false;

  // Allow-list for typical drivable vehicles
  const allow = [
    "tractor",
    "truck",
    "car",
    "pickup",
    "harvester",
    "combine",
    "forageharvester",
    "telehandler",
    "wheel",
    "skidsteer",
    "excavator",
    "locomotive",
  ];
  if (allow.some((x) => typeName.includes(x))) return true;

  // Category safety-net
  const allowCats = new Set([
    "TRACTORSM",
    "TRACTORSL",
    "HARVESTERS",
    "FORAGEHARVESTERS",
    "TRUCKS",
    "CARS",
    "TELELOADERVEHICLES",
    "WHEELLOADERVEHICLES",
  ]);
  if (allowCats.has(cat)) return true;

  return false;
}

function getDrivableVehicles(serverId) {
  const slot = (state.gameTelemetry?.servers ?? {})[serverId] ?? {};
  const vehicles = Array.isArray(slot.vehicles) ? slot.vehicles : [];
  const out = [];
  const seen = new Set();
  for (const v of vehicles) {
    const id = v?.id;
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    if (!isDrivableVehicle(v)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function clampPct(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, x));
}

function barPct(pct, width = 16) {
  const p = clampPct(pct);
  if (p == null) return "—";
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function renderFleetListEmbed(serverId, page = 0) {
  const vehicles = getDrivableVehicles(serverId);

  const perPage = 15;
  const pages = Math.max(1, Math.ceil(vehicles.length / perPage));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = vehicles.slice(p * perPage, p * perPage + perPage);

  const lines = slice.map((v, i) => {
    const name = v.name ?? "Vozilo";
    const hpTxt = v.powerHp != null ? ` • ${v.powerHp} hp` : "";
    const ownerTxt = resolveVehicleOwnerDisplay(serverId, v);
    const impl = formatVehicleImplements(v);
    const fills = formatVehicleFills(v);
    const short = (s, n = 60) => (typeof s === "string" && s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const implTxt = impl !== "—" ? ` • Priključci: ${short(impl, 50)}` : "";
    const fillTxt = fills !== "—" ? ` • Spremnici: ${short(fills, 50)}` : "";
    const own = ownerTxt && ownerTxt !== "—" ? ` • Vlasnik: ${ownerTxt}` : "";
    const motorTxt = v.engineOn === true ? " • Motor: upaljen" : (v.engineOn === false ? " • Motor: ugašen" : "");
    return `**${p * perPage + i + 1}.** ${name}${hpTxt}${own}${implTxt}${fillTxt}${motorTxt}`;
  });


  const desc = [
    `**Server:** ${serverId}`,
    `**Vehicles:** ${vehicles.length}`,
    `**Page:** ${p + 1}/${pages}`,
    "",
    lines.length ? lines.join("\n") : "*Nema vozila (još).*",
  ].join("\n");

  return new EmbedBuilder()
    .setTitle("FS25 – Fleet")
    .setDescription(desc)
    .setColor(getEmbedColor("workflow"))
    .setTimestamp(new Date());
}

function renderFleetDetailsEmbed(serverId, vehicleId) {
  const slot = (state.gameTelemetry?.servers ?? {})[serverId] ?? {};
  const vehicles = Array.isArray(slot.vehicles) ? slot.vehicles : [];
  const v = vehicles.find(x => String(x.id) === String(vehicleId)) ?? null;
  if (!v) {
    return new EmbedBuilder()
      .setTitle("Vehicle details")
      .setDescription("Odaberi vozilo iz liste iznad.")
      .setColor(getEmbedColor("admin"))
      .setTimestamp(new Date());
  }

  const ownerTxt = resolveVehicleOwnerDisplay(serverId, v);

  // Best-effort farm name
  let farmName = "—";
  const farmId = v?.farmId ?? v?.ownerFarmId ?? null;
  const farms = slot?.farms ?? null;
  if (farmId != null && Array.isArray(farms)) {
    const f = farms.find((x) => Number(x?.farmId) === Number(farmId));
    if (f?.name) farmName = f.name;
  }

  const damage = clampPct(v.damagePct);
  const dirt = clampPct(v.dirtPct);
  const wear = clampPct(v.wearPct);

  const barBlock = [
    "```",
    `Šteta      ${damage == null ? "—" : `${formatNumber(damage)}%`}  ${barPct(damage)}`,
    `Prljavšt.  ${dirt == null ? "—" : `${formatNumber(dirt)}%`}  ${barPct(dirt)}`,
    `Trošenje   ${wear == null ? "—" : `${formatNumber(wear)}%`}  ${barPct(wear)}`,
    "```",
  ].join("\n");

  const headerLine = `🚜 **${v.name ?? "Vozilo"}** | ${farmName !== "—" ? farmName : serverId} | ${ownerTxt !== "—" ? ownerTxt : "bez ownera"}`;

  const desc = [
    headerLine,
    "",
    "**Vozilo**",
    `Naziv: ${v.name ?? "—"}`,
    `Tip: ${v.typeName ?? v.category ?? "—"}`,
    `Farma: ${farmName}`,
    `Vlasnik: ${ownerTxt}`,
    "",
    "**Status**",
    `Motor: ${v.engineOn === true ? "ON" : (v.engineOn === false ? "OFF" : "—")}`,
    v.hours != null ? `Sati: ${formatNumber(v.hours)}` : "Sati: —",
    "",
    "**Stanje**",
    barBlock,
    "**Spremnici**",
    `${formatVehicleFills(v)}`,
    "",
    "**Priključci**",
    `${formatVehicleImplements(v)}`,
  ].join("\n");

  return new EmbedBuilder()
    .setTitle(`FS25 TELEMETRY | ${slot?.mapTitle ?? serverId}`)
    .setDescription(desc)
    .setColor(getEmbedColor("admin"))
    .setTimestamp(new Date());
}

function renderFleetListComponents(serverId, page = 0) {
  const vehicles = getDrivableVehicles(serverId);
  const perPage = 15;
  const pages = Math.max(1, Math.ceil(vehicles.length / perPage));
  const p = Math.min(Math.max(0, page), pages - 1);

  const slice = vehicles.slice(p * perPage, p * perPage + perPage);

  // Discord constraint: select menu options must be 1..25. When there are no vehicles,
  // we must still send at least one (disabled) option, otherwise Discord rejects the message.
  const select = new StringSelectMenuBuilder()
    .setCustomId("fleet:select")
    .setPlaceholder(slice.length ? "Odaberi vozilo…" : "Nema vozila")
    .setMaxValues(1);

  if (!slice.length) {
    select
      .setMinValues(0)
      .setDisabled(true)
      .addOptions([{ label: "Nema vozila", value: "none" }]);
  } else {
    select.setMinValues(1);
    // Discord requires each option value in a select menu to be unique.
    // Telemetry data can occasionally contain duplicated vehicle IDs (e.g. stale snapshots),
    // so we de-duplicate values while keeping the base ID recoverable.
    const seen = new Map();
    for (const v of slice.slice(0, 25)) {
      const label = String(v.name ?? "Vehicle").slice(0, 90);
      const baseId = String(v.id ?? "");
      if (!baseId) continue;

      const count = seen.get(baseId) ?? 0;
      const value = count === 0 ? baseId : `${baseId}::${count}`;
      seen.set(baseId, count + 1);

      select.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setValue(value)
      );
    }
  }

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("fleet:prev").setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(p <= 0),
    new ButtonBuilder().setCustomId("fleet:next").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1),
    new ButtonBuilder().setCustomId("fleet:refresh").setLabel("Refresh").setStyle(ButtonStyle.Primary)
  );

  const selRow = new ActionRowBuilder().addComponents(select);

  return [nav, selRow];
}

function renderFleetDetailsComponents(hasSelection) {
  const pickedOwnerId = state.panels?.fleet?.selectedOwnerId ?? null;

  const ownerPick = new UserSelectMenuBuilder()
    .setCustomId("fleet:ownerPick")
    .setPlaceholder(pickedOwnerId ? "Odabrani farmer: postavljen" : "Odaberi farmera (owner)…")
    .setMinValues(1)
    .setMaxValues(1);

  return [
    new ActionRowBuilder().addComponents(ownerPick),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fleet:assignOwner")
        .setLabel("Assign owner")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!hasSelection || !pickedOwnerId),
      new ButtonBuilder()
        .setCustomId("fleet:clearOwner")
        .setLabel("Clear owner")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!hasSelection)
    )
  ];
}



function renderPlayerHoursEmbed() {
  ensureConfig();
  const serverId = state.panels?.playerhours?.serverId ?? (state.panels?.serverstats?.serverId ?? "fs25");
  const rows = buildPlayerHoursRows(serverId);

  const top = rows[0] ? `${rows[0].name} — **${formatDurationHMS(rows[0].allTime)}**` : "*nema podataka*";

  const lines = [];
  let shown = 0;
  for (const r of rows) {
    const line = `• ${r.name}: **${formatDurationHMS(r.allTime)}** (30d: ${formatDurationHMS(r.last30)})`;
    if ((lines.join("\n").length + line.length + 2) > 3500) break;
    lines.push(line);
    shown++;
  }
  if (rows.length > shown) lines.push(`… i još **${rows.length - shown}** igrača`);

  const embed = new EmbedBuilder()
    .setTitle("Player Hours")
    .setDescription(
      [
        `Server: **${serverId}**`,
        "",
        `Top Player: ${top}`,
        "",
        lines.length ? lines.join("\n") : "*nema podataka*",
      ].join("\n")
    )
    .setColor(getEmbedColor("serverstats"))
    .setTimestamp(new Date());

  return embed;
}

function renderPlayerHoursComponents() {
  const r = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("playerhours:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Secondary)
  );
  return [r];
}

function renderServerStatsComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("serverstats:refresh").setLabel("Refresh").setStyle(ButtonStyle.Primary)
    )
  ];
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// VERIFICATION PANEL (Discord)
//  - one persistent message in the configured verification channel
///////////////////////////////////////////////////////////////////////////////////////////////////


// Realism onboarding (HR) + quiz 3 pitanja (prolaz 2/3)
const REALISM_QUIZ_QUESTIONS = [
  { id: "Q1", q: "Koliko farmi smije imati jedan igrač?", options: ["Jednu", "Dvije", "Neograničeno"], correct: 0 },
  { id: "Q2", q: "Kakva je ekonomija na serveru?", options: ["Hard – nema besplatnog novca i resetiranja", "Casual – admin pomaže kad si u minusu", "Ekonomija je nebitna"], correct: 0 },
  { id: "Q3", q: "Koja je automatika dopuštena?", options: ["Samo zadani AI Worker", "Courseplay", "AutoDrive"], correct: 0 },
  { id: "Q4", q: "Što vrijedi za uništavanje usjeva?", options: ["Uvijek je uključeno", "Isključeno je", "Uključeno je samo vikendom"], correct: 0 },
  { id: "Q5", q: "Što se događa nakon 14 dana neaktivnosti zaredom?", options: ["Farma se likvidira", "Farma se pauzira", "Admin resetira stanje"], correct: 0 },
  { id: "Q6", q: "Ako prodaja farme ne pokrije dug, što vrijedi?", options: ["Dug ostaje vezan uz igrača", "Dug se briše", "Dug se dijeli na sve farme"], correct: 0 },
  { id: "Q7", q: "Kada se posao mora dogovoriti?", options: ["Prije početka", "Nakon završetka", "Nije važno"], correct: 0 },
  { id: "Q8", q: "Tko je odgovoran za štetu koju napravi AI Worker?", options: ["Igrač koji je pokrenuo AI", "Vlasnik farme", "Admin"], correct: 0 },
  { id: "Q9", q: "Smiješ li koristiti tuđu opremu bez dopuštenja?", options: ["Ne", "Da", "Da, ako je AI Worker uključen"], correct: 0 },
  { id: "Q10", q: "Završeni posao se mora…", options: ["isplatiti", "ignorirati", "isplatiti samo ako radnik traži"], correct: 0 },
  { id: "Q11", q: "Što vrijedi za farme na serveru?", options: ["Financijski su odvojene", "Dijele isti račun", "Admin raspodjeljuje novac"], correct: 0 },
  { id: "Q12", q: "Suradnja između farmi je dopuštena…", options: ["isključivo kroz dogovoreni rad", "kad god netko želi", "samo u istoj Discord sobi"], correct: 0 },
];

runtime.verifyQuiz = runtime.verifyQuiz ?? { sessions: new Map(), lastQ: new Map() };

function buildRealismVerifyPanelEmbed() {
  ensureConfig();
  const lines = [
    "**Ovo je HARD REALISM FS25 server.** Igranjem prihvaćaš pravila ispod.",
    "",
    "**Osnovno**",
    "• Svaki igrač ima **jednu farmu** (Farmer).",
    "• Farme su **financijski odvojene**.",
    "• Suradnja je dopuštena samo kroz **dogovoreni rad**.",
    "",
    "**Hard ekonomija**",
    "• Nema besplatnog novca, resetiranja ni bailouts.",
    "• Dug je stvaran i mora se vratiti.",
    "",
    "**AI Worker**",
    "• Dopušten je samo **zadani AI Worker** (Courseplay/AutoDrive zabranjeno).",
    "• Odgovoran si za štetu koju napravi AI Worker.",
    "",
    "**Crop destruction**",
    "• Uništavanje usjeva je **uvijek uključeno** i šteta se nadoknađuje.",
    "",
    "**Neaktivnost (kritično)**",
    "• **14 dana neaktivnosti** = likvidacija farme (zemlja+strojevi).",
    "• Ako ostane dug, ostaje vezan uz igrača; radiš na tuđoj/CO-OP farmi dok ga ne otplatiš.",
    "",
    "Klikni **Započni provjeru** i odgovori na 3 pitanja. Prolaz je **2/3**."
  ];

  return new EmbedBuilder()
    .setTitle("FS25 Realism – Verifikacija (obavezno)")
    .setDescription(lines.join("\n"))
    .setColor(getEmbedColor("admin"))
    .setTimestamp(new Date());
}

function buildVerifyPanelEmbed() {
  return buildRealismVerifyPanelEmbed();
}

function buildVerifyPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("verify:quiz:start").setLabel("Započni provjeru").setStyle(ButtonStyle.Success)
    )
  ];
}

function pickQuizQuestions(userId, count = 3) {
  const last = runtime.verifyQuiz.lastQ.get(userId) ?? [];
  const pool = REALISM_QUIZ_QUESTIONS.slice();
  // Prefer pitanja koja nisu bila u zadnjem pokušaju
  const preferred = pool.filter((q) => !last.includes(q.id));
  const source = preferred.length >= count ? preferred : pool;

  // Random shuffle
  for (let i = source.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [source[i], source[j]] = [source[j], source[i]];
  }
  const picked = source.slice(0, count).map((q) => q.id);
  runtime.verifyQuiz.lastQ.set(userId, picked);
  return picked;
}

function buildQuizQuestionPayload(userId, guildId, channelId, rulesMessageId) {
  const s = runtime.verifyQuiz.sessions.get(userId);
  if (!s) return null;

  const qObj = REALISM_QUIZ_QUESTIONS.find((x) => x.id === s.qids[s.index]);
  if (!qObj) return null;

  const embed = new EmbedBuilder()
    .setTitle(`Provjera pravila (${s.index + 1}/3)`)
    .setDescription(`**${qObj.q}**

Odaberi jedan odgovor:`)
    .setColor(getEmbedColor("admin"))
    .setTimestamp(new Date());

  const select = new StringSelectMenuBuilder()
    .setCustomId(`verify:quiz:ans:${qObj.id}`)
    .setPlaceholder("Odaberi odgovor")
    .addOptions(
      qObj.options.map((label, i) => ({ label, value: String(i) }))
    );

  const row = new ActionRowBuilder().addComponents(select);

  // Link natrag na pravila (ako imamo message id)
  const rows = [row];
  if (guildId && channelId && rulesMessageId) {
    const url = `https://discord.com/channels/${guildId}/${channelId}/${rulesMessageId}`;
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Pravila").setURL(url)
      )
    );
  }

  return { embeds: [embed], components: rows };
}

function buildQuizResultPayload(pass, score, guildId, channelId, rulesMessageId) {
  const title = pass ? "✅ Verifikacija uspješna" : "❌ Verifikacija nije prošla";
  const desc = pass
    ? `Točni odgovori: **${score}/3**. Dodjeljujem pristup.`
    : `Točni odgovori: **${score}/3**. Pročitaj pravila i pokušaj ponovno. (Potrebno je **2/3**)`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(getEmbedColor("admin"))
    .setTimestamp(new Date());

  const rows = [];
  if (!pass) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("verify:quiz:retry").setLabel("Novi test").setStyle(ButtonStyle.Primary)
      )
    );
  }
  if (guildId && channelId && rulesMessageId) {
    const url = `https://discord.com/channels/${guildId}/${channelId}/${rulesMessageId}`;
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Pravila").setURL(url)
      )
    );
  }

  return { embeds: [embed], components: rows };
}


async function upsertVerifyPanel(channel) {
  ensureConfig();
  const sec = state.config.security ?? (state.config.security = {});
  if (!channel || !channel.isTextBased()) throw new Error("verification_channel_invalid");

  let msg = null;
  if (sec.verificationMessageId) {
    try {
      msg = await channel.messages.fetch(sec.verificationMessageId);
    } catch {
      msg = null;
    }
  }

  const payload = { embeds: [buildVerifyPanelEmbed()], components: buildVerifyPanelComponents() };
  msg = await safeEditOrSend(msg, channel, payload);

  sec.verificationChannelId = channel.id;
  sec.verificationMessageId = msg.id;
  saveState();
  return msg;
}

function getAdminView() {
  state.panels = state.panels ?? {};
  state.panels.admin = state.panels.admin ?? {};
  const v = state.panels.admin.view;
  return v ? String(v) : "ROOT";
}

function setAdminView(view) {
  state.panels = state.panels ?? {};
  state.panels.admin = state.panels.admin ?? {};
  state.panels.admin.view = view;
  saveState();
}

function renderAdminEmbed() {
  const view = getAdminView();

  const fields = getFieldList();

  const logCh = state.config.logChannelId ? `<#${state.config.logChannelId}>` : "*nije postavljeno*";
  const detailsDefault = state.config.detailsChannelId ? `<#${state.config.detailsChannelId}>` : "*auto (isti kanal kao panel)*";
  const histCh = state.config.taskHistoryChannelId ? `<#${state.config.taskHistoryChannelId}>` : "*nije postavljeno*";
  const backupCh = state.config.backupChannelId ? `<#${state.config.backupChannelId}>` : "*nije postavljeno*";

  const panels = state.panels ?? {};
  const admin = panels.admin ? `<#${panels.admin.channelId}>` : "*nije deployano*";
  const wf = panels.workflow ? `<#${panels.workflow.channelId}>` : "*nije deployano*";
  const det = panels.details ? `<#${panels.details.channelId}>` : "*nije deployano*";
  const act = panels.activity ? `<#${panels.activity.channelId}>` : "*nije deployano*";

  let title = "FarmBudy – Admin";
  let lines = [];

  if (view === "HELP") {
    title = "FarmBudy – Admin • Help";
    lines = [
      "**Kako radi admin panel (trenutna verzija)**",
      "",
      "**Paneli**",
      "- Deployaj panele kroz **POSTAVKE → Deploy panel**: odaberi panel + kanal + **Deploy** (bot će napraviti / obnoviti poruku).",
      "- *Panel polja* je glavni UI za rad (lista zadataka + detalji polja).",
      "",
      "**Kanali**",
      `- Log kanal: ${logCh} (admin + greške, bez spama)`,
      `- Default kanal panela polja: ${detailsDefault} (ako panel nije deployan ručno)`,
      `- Task history kanal: ${histCh} (završeni taskovi / povijest + dnevni sažetak)`,
      `- Backup kanal: ${backupCh} (state.json backup / restore)`,
      "",
      "**Važno**",
      "- Activity je OFF (nema start/pause spama; povijest dobiva samo DONE + dnevni sažetak).",
      "- Kanali se biraju iz padajućih izbornika (ne treba ID). Paneli se deployaju na isti način.",
      "- Polja se uređuju u izborniku **Polja** (format `6,7,10-15`).",
    ];
  } else if (view === "PANELS") {
    title = "FarmBudy – Admin • Paneli";
    lines = [
      "**Paneli**",
      "",
      `Admin panel: ${admin}`,
      `Field panel: ${det}`,
      `Workflow board: ${wf}`,
      `Activity panel: ${act}`,
      "",
      "Tip: Deployaj **Panel polja** u kanal gdje ekipa radi (i pinaj).",
    ];
  } else if (view === "CHANNELS") {
    title = "FarmBudy – Admin • Kanali";
    lines = [
      "**Odabir kanala**",
      "",
      "Odaberi kanale ispod (dropdown). Promjena se sprema odmah.",
      "",
      `Log kanal: ${logCh}`,
      `Default kanal panela polja: ${detailsDefault}`,
      `Task history kanal: ${histCh}`,
    ];

  } else if (view === "ONBOARDING") {
    title = "FarmBudy – Admin • Onboarding";
    const w = state.config?.welcome ?? {};
    const g = state.config?.goodbye ?? {};
    const sec = state.config?.security ?? {};
    lines = [
      "**Welcome**",
      `- Status: ${w.enabled ? "ON" : "OFF"}`,
      `- Kanal: ${w.channelId ? `<#${w.channelId}>` : "*nije postavljeno*"}`,
      "",
      "**Goodbye**",
      `- Status: ${g.enabled ? "ON" : "OFF"}`,
      `- Kanal: ${g.channelId ? `<#${g.channelId}>` : "*nije postavljeno*"}`,
      "",
      "**Verification / Roles**",
      `- Verification kanal: ${sec.verificationChannelId ? `<#${sec.verificationChannelId}>` : "*nije postavljeno*"}`,
      `- Member role: ${sec.memberRoleId ? `<@&${sec.memberRoleId}>` : "*nije postavljeno*"}`,
      `- Quarantine role: ${sec.quarantineRoleId ? `<@&${sec.quarantineRoleId}>` : "*nije postavljeno*"}`,
      `- Min account age: **${Number(sec.minAccountAgeDays ?? 0)}** dana`,
    ];

  } else if (view === "VERIFY_ROLES") {
    title = "FarmBudy – Admin • Verify roles";
    const sec = state.config?.security ?? {};
    lines = [
      "**Verification**",
      `- Kanal: ${sec.verificationChannelId ? `<#${sec.verificationChannelId}>` : "*nije postavljeno*"}`,
      `- Unverified rola (na join): ${sec.unverifiedRoleId ? `<@&${sec.unverifiedRoleId}>` : "*nije postavljeno*"}`,
      `- Default verified rola: ${sec.verifiedRoleId ? `<@&${sec.verifiedRoleId}>` : "*nije postavljeno*"}`,
      `- Selectable roles: ${(Array.isArray(sec.verifySelectableRoleIds) && sec.verifySelectableRoleIds.length) ? sec.verifySelectableRoleIds.map(r => `<@&${r}>`).join(" ") : "*nije postavljeno*"}`,
      "",
      "Napomena: Ako su Selectable roles postavljene, igrač dobije rolu koju odabere; inače dobije Default verified rolu."
    ];

} else if (view === "TELEMETRY") {
    title = "FarmBudy – Admin • Telemetry";
    const secretSet = getTelemetrySecret() ? "YES" : "NO";
    const baseUrl = getTelemetryBaseUrl();
    const servers = state.gameTelemetry?.servers ?? {};
    const ids = Object.keys(servers);

    const summaries = ids.length
      ? ids.map((sid) => {
          const s = servers[sid] ?? {};
          const online = Array.isArray(s.playersOnline) ? s.playersOnline.length : 0;
          const last = s.lastAt ? new Date(s.lastAt).toLocaleString("hr-HR") : "—";
          return `- **${sid}** • online: **${online}** • last: ${last}`;
        })
      : ["- (nema podataka još)"];

    lines = [
      "**Povezivanje FS25 servera (telemetry mod → bot)**",
      `Base URL: ${baseUrl ? `\`${baseUrl}\`` : "*nije postavljeno*"}`,
      baseUrl ? `- Ping: \`${baseUrl}/telemetry/ping\`` : "- Ping: `.../telemetry/ping`",
      baseUrl ? `- Endpoint: \`${baseUrl}/telemetry/fs25\`` : "- Endpoint: `.../telemetry/fs25`",
      "- Header: `Authorization: Bearer <SECRET>`",
      "",
      `TELEMETRY_SECRET set: **${secretSet}**`,
      "",
      "**Servers**",
      ...summaries,
      "",
      "Tip: postavi Base URL + Secret ispod, pa spoji FS25 mod na /telemetry/fs25.",
    ];
  } else if (view === "MODERATION") {
    title = "FarmBudy – Admin • Moderation";
    const modLog = state.config?.modLogChannelId ? `<#${state.config.modLogChannelId}>` : "*nije postavljeno*";
    lines = [
      "**Moderation komande**",
      "- `/kick user reason`",
      "- `/ban user reason delete_days`",
      "- `/timeout user minutes reason`",
      "- `/unban user_id reason`",
      "",
      `Mod log kanal: ${modLog} (ako nije postavljeno, koristi Log kanal)`,
    ];
  } else if (view === "SECURITY") {
    title = "FarmBudy – Admin • Security";
    const sec = state.config?.security ?? {};
    const as = sec.antiScam ?? {};
    const ar = sec.antiRaid ?? {};
    lines = [
      "**Anti-scam**",
      `- Status: ${as.enabled ? "ON" : "OFF"}`,
      `- Linkovi za neverificirane: ${as.blockLinksForUnverified ? "ON" : "OFF"}`,
      `- Timeout: **${Number(as.timeoutMinutes ?? 10)}** min`,
      `- Keywords: ${(as.keywords ?? []).slice(0, 6).join(", ")}${(as.keywords ?? []).length > 6 ? "..." : ""}`,
      "",
      "**Anti-raid**",
      `- Status: ${ar.enabled ? "ON" : "OFF"}`,
      `- Prag: **${Number(ar.maxJoins ?? 5)}** joinova / **${Number(ar.windowSec ?? 30)}s**`,
      `- Lockdown: **${Number(ar.lockdownMinutes ?? 10)}** min`,
"",
"**Permisije (Owner / Co-owner / Admin / Mod)**",
`- Owners: ${(state.config?.perms?.owners?.length ?? 0) ? state.config.perms.owners.map((id)=>`<@${id}>`).join(", ").slice(0, 1800) : "*nije postavljeno*"}`,
`- Co-owners: ${(state.config?.perms?.coOwners?.length ?? 0) ? state.config.perms.coOwners.map((id)=>`<@${id}>`).join(", ").slice(0, 1800) : "*nije postavljeno*"}`,
`- Admin users: ${(state.config?.perms?.adminUsers?.length ?? 0) ? state.config.perms.adminUsers.map((id)=>`<@${id}>`).join(", ").slice(0, 1800) : "*nije postavljeno*"}`,
`- Admin roles: ${(state.config?.perms?.adminRoles?.length ?? 0) ? state.config.perms.adminRoles.map((id)=>`<@&${id}>`).join(", ").slice(0, 1800) : "*nije postavljeno*"}`,
`- Mod roles: ${(state.config?.perms?.modRoles?.length ?? 0) ? state.config.perms.modRoles.map((id)=>`<@&${id}>`).join(", ").slice(0, 1800) : "*nije postavljeno*"}`,
    ];
  } else if (view === "BACKUP") {
    title = "FarmBudy – Admin • Backup";
    const backupCh = state.config?.backupChannelId ? `<#${state.config.backupChannelId}>` : "Not set";
    lines = [
      `Backup channel: ${backupCh}`,
      "",
      "Use **Backup now** to upload a fresh state.json, or **Restore latest** to restore from the last backup.",
      "",
      "Restore will remove old panel messages and re-post fresh ones (where possible)."
    ];
  } else if (view === "FIELDS") {
    title = "FarmBudy – Admin • Fields";
    lines = [
      "**Manage fields**",
      "",
      `Fields (${fields.length}): ${fields.slice(0, 30).join(", ")}${fields.length > 30 ? "..." : ""}`,
      "",
      "Use buttons below to Add/Remove (format: `6,7,10-15`).",
    ];
  } else {
    // ROOT
    lines = [
      "**Admin panel**",
      "Choose a category below: **SETTINGS**, **ONBOARDING**, **MODERATION**, **SECURITY**, **BACKUP**, **FIELDS**, **HELP**.",
      "",
      `Field panel: ${det} • Workflow: ${wf} • Activity: ${act}`,
      `Log: ${logCh} • Task history: ${histCh}`,
      "",
      `Fields (${fields.length}): ${fields.slice(0, 30).join(", ")}${fields.length > 30 ? "..." : ""}`,
    ];
  }

  const desc = lines.join("\n");
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(getEmbedColor("admin"))
    .setTimestamp(new Date());
}

function renderAdminComponents() {
  const view = getAdminView();

  // ROOT
  if (view === "ROOT") {
    const r1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:setup").setLabel("SETTINGS").setStyle(view==="SETUP"?ButtonStyle.Success:ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:view:onboarding").setLabel("ONBOARDING").setStyle(view==="ONBOARDING"?ButtonStyle.Success:ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:view:moderation").setLabel("MODERATION").setStyle(view==="MODERATION"?ButtonStyle.Success:ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:view:security").setLabel("SECURITY").setStyle(view==="SECURITY"?ButtonStyle.Success:ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:view:fields").setLabel("FIELDS").setStyle(view==="FIELDS"?ButtonStyle.Success:ButtonStyle.Primary),
    );

    const r2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:backup").setLabel("BACKUP").setStyle(view==="BACKUP"?ButtonStyle.Success:ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:view:telemetry").setLabel("TELEMETRY").setStyle(view==="TELEMETRY"?ButtonStyle.Success:ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:view:help").setLabel("HELP").setStyle(view==="HELP"?ButtonStyle.Success:ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );

    return [r1, r2];
  }

  // BACKUP
  if (view === "BACKUP") {
    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );
    const chId = state.config.backupChannelId;
    const chSelect = new ChannelSelectMenuBuilder()
      .setCustomId("admin:backup:channel")
      .setPlaceholder("Backup channel")
      .setMinValues(1).setMaxValues(1);
    if (chId) chSelect.setDefaultChannels([chId]);
    const r1 = new ActionRowBuilder().addComponents(chSelect);
    const r2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:backup:now").setLabel("Backup now").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:backup:restore").setLabel("Restore latest").setStyle(ButtonStyle.Danger)
    );
    return [r0, r1, r2];
  }

  // SETUP (PANELS + CHANNELS)
  if (view === "SETUP") {
    state.panels = state.panels ?? {};
    state.panels.admin = state.panels.admin ?? {};
    state.panels.admin.setup = state.panels.admin.setup ?? { section: "DEPLOY" };
    const section = state.panels.admin.setup.section ?? "DEPLOY";

    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );

    const sectionSelect = new StringSelectMenuBuilder()
      .setCustomId("admin:setup:section")
      .setPlaceholder("Choose an option")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel("Deploy panel").setValue("DEPLOY").setDefault(section === "DEPLOY"),
        new StringSelectMenuOptionBuilder().setLabel("Log channel").setValue("LOG").setDefault(section === "LOG"),
        new StringSelectMenuOptionBuilder().setLabel("Task history channel").setValue("HISTORY").setDefault(section === "HISTORY"),
        new StringSelectMenuOptionBuilder().setLabel("Default channel (Field panel)").setValue("DETAILS").setDefault(section === "DETAILS"),
        new StringSelectMenuOptionBuilder().setLabel("Field panel title").setValue("TITLE").setDefault(section === "TITLE")
      );

    const r1 = new ActionRowBuilder().addComponents(sectionSelect);

    if (section === "DEPLOY") {
      const sel = state.panels.admin.panelDeploy ?? { panel: "details", channelId: state.config.detailsChannelId ?? null };

      const panelSelect = new StringSelectMenuBuilder()
        .setCustomId("admin:setup:selectpanel")
        .setPlaceholder("Pick a panel to deploy")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("Field Tasks").setValue("details").setDefault(sel.panel === "details"),
          new StringSelectMenuOptionBuilder().setLabel("Workflow").setValue("workflow").setDefault(sel.panel === "workflow"),
          new StringSelectMenuOptionBuilder().setLabel("Activity").setValue("activity").setDefault(sel.panel === "activity"),
          new StringSelectMenuOptionBuilder().setLabel("Admin").setValue("admin").setDefault(sel.panel === "admin"),
          new StringSelectMenuOptionBuilder().setLabel("ServerStats (FS25)").setValue("serverstats").setDefault(sel.panel === "serverstats"),
          new StringSelectMenuOptionBuilder().setLabel("Player Hours").setValue("playerhours").setDefault(sel.panel === "playerhours"),
          new StringSelectMenuOptionBuilder().setLabel("Fleet (FS25)").setValue("fleet").setDefault(sel.panel === "fleet")
        );

      const chSelect = new ChannelSelectMenuBuilder()
        .setCustomId("admin:setup:selectchannel")
        .setPlaceholder("Select channel to deploy");

      if (sel.channelId) chSelect.setDefaultChannels([sel.channelId]);

      const r2 = new ActionRowBuilder().addComponents(panelSelect);
      const r3 = new ActionRowBuilder().addComponents(chSelect);

      const r4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin:setup:deploy").setLabel("Deploy").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("admin:paneltitle").setLabel("Title").setStyle(ButtonStyle.Primary)
      );

      return [r0, r1, r2, r3, r4];
    }

if (section === "TITLE") {
      state.panels = state.panels ?? {};
      state.panels.admin = state.panels.admin ?? {};
      state.panels.admin.panelTitle = state.panels.admin.panelTitle ?? { channelId: state.panels?.details?.channelId ?? state.config.detailsChannelId ?? null };
      const selChId = state.panels.admin.panelTitle.channelId ?? state.panels?.details?.channelId ?? state.config.detailsChannelId ?? null;

      const chSel = new ChannelSelectMenuBuilder()
        .setCustomId("admin:setup:titlechannel")
        .setPlaceholder("Odaberi kanal gdje je Field panel")
        .setMinValues(1)
        .setMaxValues(1);
      if (selChId) chSel.setDefaultChannels([selChId]);

      const r2 = new ActionRowBuilder().addComponents(chSel);
      const r3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin:paneltitle").setLabel("Change title").setStyle(ButtonStyle.Primary)
      );
      return [r0, r1, r2, r3];
    }

        // Channel sections
    let chId = null;
    let selectId = null;

    if (section === "LOG") {
      chId = state.config.logChannelId;
      // Use ids that are handled in the ChannelSelectMenu handler
      selectId = "admin:ch:log";
    } else if (section === "HISTORY") {
      chId = state.config.taskHistoryChannelId;
      selectId = "admin:ch:history";
    } else if (section === "DETAILS") {
      chId = state.config.detailsChannelId;
      selectId = "admin:ch:detailsDefault";
    }

    if (!selectId) {
      // Safety: if something goes out of sync, still render something instead of a blank/broken UI
      return [r0, r1];
    }

    const chSelect = new ChannelSelectMenuBuilder()
      .setCustomId(selectId)
      .setPlaceholder("Select channel")
      .setMinValues(1)
      .setMaxValues(1);

    if (chId) chSelect.setDefaultChannels([chId]);

    const r2 = new ActionRowBuilder().addComponents(chSelect);

    return [r0, r1, r2];
  }
  // ONBOARDING
  if (view === "ONBOARDING") {
    state.panels = state.panels ?? {};
    state.panels.admin = state.panels.admin ?? {};
    state.panels.admin.onboarding = state.panels.admin.onboarding ?? { section: "WELCOME" };
    const section = state.panels.admin.onboarding.section ?? "WELCOME";

    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );

    const sectionSelect = new StringSelectMenuBuilder()
      .setCustomId("admin:onboarding:section")
      .setPlaceholder("Choose an option")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel("Welcome").setValue("WELCOME").setDefault(section === "WELCOME"),
        new StringSelectMenuOptionBuilder().setLabel("Goodbye").setValue("GOODBYE").setDefault(section === "GOODBYE"),
        new StringSelectMenuOptionBuilder().setLabel("Verification / Roles").setValue("VERIFY").setDefault(section === "VERIFY")
      );

    const r1 = new ActionRowBuilder().addComponents(sectionSelect);

    if (section === "WELCOME") {
      const w = state.config.welcome ?? {};
      const chSel = new ChannelSelectMenuBuilder()
        .setCustomId("admin:onboarding:welcome:channel")
        .setPlaceholder("Welcome kanal")
        .setMinValues(1).setMaxValues(1);
      if (w.channelId) chSel.setDefaultChannels([w.channelId]);

      const r2 = new ActionRowBuilder().addComponents(chSel);
      const r3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin:onboarding:welcome:toggle").setLabel(w.enabled ? "Welcome: ON" : "Welcome: OFF").setStyle(w.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("admin:onboarding:welcome:message").setLabel("Message").setStyle(ButtonStyle.Primary)
      );
      return [r0, r1, r2, r3];
    }

if (section === "GOODBYE") {
      const g = state.config.goodbye ?? {};
      const chSel = new ChannelSelectMenuBuilder()
        .setCustomId("admin:onboarding:goodbye:channel")
        .setPlaceholder("Goodbye kanal")
        .setMinValues(1).setMaxValues(1);
      if (g.channelId) chSel.setDefaultChannels([g.channelId]);

      const r2 = new ActionRowBuilder().addComponents(chSel);
      const r3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin:onboarding:goodbye:toggle").setLabel(g.enabled ? "Goodbye: ON" : "Goodbye: OFF").setStyle(g.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("admin:onboarding:goodbye:message").setLabel("Message").setStyle(ButtonStyle.Primary)
      );
      return [r0, r1, r2, r3];
    }

    // VERIFY
    const sec = state.config.security ?? {};
    const verCh = new ChannelSelectMenuBuilder()
      .setCustomId("admin:onboarding:verify:channel")
      .setPlaceholder("Verification kanal")
      .setMinValues(1).setMaxValues(1);
    if (sec.verificationChannelId) verCh.setDefaultChannels([sec.verificationChannelId]);

    const r2 = new ActionRowBuilder().addComponents(verCh);

    const r3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:onboarding:verify:deployPanel").setLabel("Deploy verify panel").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:onboarding:verifyRoles").setLabel("Verify roles").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:onboarding:roles").setLabel("Role postavke").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:onboarding:perms").setLabel("Permisije").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:onboarding:minage").setLabel("Min account age").setStyle(ButtonStyle.Primary)
    );

    return [r0, r1, r2, r3];
  }

  if (view === "VERIFY_ROLES") {
    ensureConfig();
    const sec = state.config.security ?? (state.config.security = {});

    const unv = new RoleSelectMenuBuilder()
      .setCustomId("admin:onboarding:verify:unverifiedRole")
      .setPlaceholder("Unverified rola (dodijeli na join)")
      .setMinValues(1).setMaxValues(1);
    if (sec.unverifiedRoleId) unv.setDefaultRoles([sec.unverifiedRoleId]);

    const verified = new RoleSelectMenuBuilder()
      .setCustomId("admin:onboarding:verify:verifiedRole")
      .setPlaceholder("Default verified rola (ako nema selectable roles)")
      .setMinValues(1).setMaxValues(1);
    if (sec.verifiedRoleId) verified.setDefaultRoles([sec.verifiedRoleId]);

    const selectable = new RoleSelectMenuBuilder()
      .setCustomId("admin:onboarding:verify:selectableRoles")
      .setPlaceholder("Selectable roles (igrač bira jednu)")
      .setMinValues(1).setMaxValues(10);
    if (Array.isArray(sec.verifySelectableRoleIds) && sec.verifySelectableRoleIds.length) selectable.setDefaultRoles(sec.verifySelectableRoleIds.slice(0, 10));

    const r2 = new ActionRowBuilder().addComponents(unv);
    const r3 = new ActionRowBuilder().addComponents(verified);
    const r4 = new ActionRowBuilder().addComponents(selectable);

    // Note: nav rows (r0, r1) already exist
    return [r0, r1, r2, r3, r4];
  }

// TELEMETRY
  if (view === "TELEMETRY") {
    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );

    const r1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:telemetry:setBaseUrl").setLabel("Set Base URL").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:telemetry:setSecret").setLabel("Set Secret").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:telemetry:clearSecret").setLabel("Clear Secret").setStyle(ButtonStyle.Danger)
    );

    const chSel = new ChannelSelectMenuBuilder()
      .setCustomId("admin:telemetry:serverstatsChannel")
      .setPlaceholder("Kanal za ServerStats panel")
      .setMinValues(1).setMaxValues(1);
    if (state.panels?.serverstats?.channelId) chSel.setDefaultChannels([state.panels.serverstats.channelId]);
    const r2 = new ActionRowBuilder().addComponents(chSel);

    const r3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:telemetry:deployServerStats").setLabel("Deploy ServerStats").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:telemetry:reset").setLabel("Reset telemetry").setStyle(ButtonStyle.Danger)
    );

    return [r0, r1, r2, r3];
  }

  // MODERATION
  if (view === "MODERATION") {
    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );

    const modSelect = new ChannelSelectMenuBuilder()
      .setCustomId("admin:moderation:modlog")
      .setPlaceholder("Odaberi mod log kanal")
      .setMinValues(1)
      .setMaxValues(1);

    if (state.config.modLogChannelId) modSelect.setDefaultChannels([state.config.modLogChannelId]);

    const r1 = new ActionRowBuilder().addComponents(modSelect);
    return [r0, r1];
  }

  // SECURITY
  if (view === "SECURITY") {
    state.panels = state.panels ?? {};
    state.panels.admin = state.panels.admin ?? {};
    state.panels.admin.security = state.panels.admin.security ?? { section: "ANTISCAM" };
    state.panels.admin.security.playerLinksSel = state.panels.admin.security.playerLinksSel ?? { fsId: null, discordId: null };
    const section = state.panels.admin.security.section ?? "ANTISCAM";

    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );

    const sectionSelect = new StringSelectMenuBuilder()
      .setCustomId("admin:security:section")
      .setPlaceholder("Choose an option")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel("Anti-scam").setValue("ANTISCAM").setDefault(section === "ANTISCAM"),
        new StringSelectMenuOptionBuilder().setLabel("Anti-raid").setValue("ANTIRAID").setDefault(section === "ANTIRAID"),
        new StringSelectMenuOptionBuilder().setLabel("Player links").setValue("PLAYERLINKS").setDefault(section === "PLAYERLINKS")
      );

    const r1 = new ActionRowBuilder().addComponents(sectionSelect);


    if (section === "PLAYERLINKS") {
      ensurePlayerHoursState();

      const serverId = state.panels?.serverstats?.serverId ?? "fs25";
      const rows = buildPlayerHoursRows(serverId);

      const fsOptions = rows.slice(0, 25).map((r) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(String(r.name).replace(/<@\d+>/g, "DiscordUser").slice(0, 80))
          .setValue(String(r.fsId))
      );

      if (!fsOptions.length) {
        fsOptions.push(new StringSelectMenuOptionBuilder().setLabel("No players yet").setValue("none"));
      }

      const fsSelect = new StringSelectMenuBuilder()
        .setCustomId("admin:security:playerlinks:fs")
        .setPlaceholder("Select FS player")
        .addOptions(fsOptions);

      const discordSelect = new UserSelectMenuBuilder()
        .setCustomId("admin:security:playerlinks:discord")
        .setPlaceholder("Select Discord user to link");

      const r2 = new ActionRowBuilder().addComponents(fsSelect);
      const r3 = new ActionRowBuilder().addComponents(discordSelect);

      const r4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin:security:playerlinks:save").setLabel("Link").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("admin:security:playerlinks:clear").setLabel("Unlink").setStyle(ButtonStyle.Secondary)
      );

      return [r0, r1, r2, r3, r4];
    }

    if (section === "ANTISCAM") {
      const as = state.config.security?.antiScam ?? {};
      const r2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin:security:antiscam:toggle").setLabel(as.enabled ? "Anti-scam: ON" : "Anti-scam: OFF").setStyle(as.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("admin:security:antiscam:links").setLabel(as.blockLinksForUnverified ? "Block links: ON" : "Block links: OFF").setStyle(as.blockLinksForUnverified ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("admin:security:antiscam:timeout").setLabel("Timeout").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("admin:security:antiscam:keywords").setLabel("Keywords").setStyle(ButtonStyle.Primary)
      );
      return [r0, r1, r2];
    }

    const ar = state.config.security?.antiRaid ?? {};
    const r2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:security:antiraid:toggle").setLabel(ar.enabled ? "Anti-raid: ON" : "Anti-raid: OFF").setStyle(ar.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:security:antiraid:threshold").setLabel("Prag").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:security:antiraid:lockdown").setLabel("Lockdown").setStyle(ButtonStyle.Primary)
    );
    return [r0, r1, r2];
  }

  // PANELS
  if (view === "PANELS") {
    state.panels = state.panels ?? {};
    state.panels.admin = state.panels.admin ?? {};
    state.panels.admin.panelDeploy = state.panels.admin.panelDeploy ?? {
      panel: "details",
      channelId: state.config.detailsChannelId ?? null,
    };

    const sel = state.panels.admin.panelDeploy;

    const panelSelect = new StringSelectMenuBuilder()
      .setCustomId("admin:panels:selectpanel")
      .setPlaceholder("Select panel")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel("Field panel").setValue("details").setDefault(sel.panel === "details"),
        new StringSelectMenuOptionBuilder().setLabel("Workflow").setValue("workflow").setDefault(sel.panel === "workflow"),
        new StringSelectMenuOptionBuilder().setLabel("Activity").setValue("activity").setDefault(sel.panel === "activity"),
        new StringSelectMenuOptionBuilder().setLabel("Admin").setValue("admin").setDefault(sel.panel === "admin"),
          new StringSelectMenuOptionBuilder().setLabel("ServerStats (FS25)").setValue("serverstats").setDefault(sel.panel === "serverstats")
      );

    const chSelect = new ChannelSelectMenuBuilder()
      .setCustomId("admin:panels:selectchannel")
      .setPlaceholder("Select channel to deploy");

    if (sel.channelId) chSelect.setDefaultChannels([sel.channelId]);

    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );

    const r1 = new ActionRowBuilder().addComponents(panelSelect);
    const r2 = new ActionRowBuilder().addComponents(chSelect);

    const r3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:panels:deploy").setLabel("Deploy").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:paneltitle").setLabel("Field panel title").setStyle(ButtonStyle.Primary)
    );

    return [r0, r1, r2, r3];
  }

  // CHANNELS
  if (view === "CHANNELS") {
    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );

    const logSelect = new ChannelSelectMenuBuilder()
      .setCustomId("admin:ch:log")
      .setPlaceholder("Odaberi log kanal")
      .setMinValues(1)
      .setMaxValues(1);

    if (state.config.logChannelId) logSelect.setDefaultChannels([state.config.logChannelId]);

    const detailsSelect = new ChannelSelectMenuBuilder()
      .setCustomId("admin:ch:detailsDefault")
      .setPlaceholder("Odaberi default kanal panela polja")
      .setMinValues(1)
      .setMaxValues(1);

    if (state.config.detailsChannelId) detailsSelect.setDefaultChannels([state.config.detailsChannelId]);

    const histSelect = new ChannelSelectMenuBuilder()
      .setCustomId("admin:ch:history")
      .setPlaceholder("Odaberi kanal za task history")
      .setMinValues(1)
      .setMaxValues(1);

    if (state.config.taskHistoryChannelId) histSelect.setDefaultChannels([state.config.taskHistoryChannelId]);

    const r1 = new ActionRowBuilder().addComponents(logSelect);
    const r2 = new ActionRowBuilder().addComponents(detailsSelect);
    const r3 = new ActionRowBuilder().addComponents(histSelect);

    return [r0, r1, r2, r3];
  }

  // FIELDS
  if (view === "FIELDS") {
    const r1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:fields:add").setLabel("Add Field(s)").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:fields:remove").setLabel("Remove Field(s)").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:refresh").setLabel("REFRESH").setStyle(ButtonStyle.Success)
    );
    return [r1];
  }

  // HELP
  if (view === "HELP") {
    const helpRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary)
    );
    return [helpRow];
  }

  // Fallback
  const fallbackRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin:view:root").setLabel("Back").setStyle(ButtonStyle.Primary)
  );
  return [fallbackRow];
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// FIELD DETAILS PANEL (persistent message)
///////////////////////////////////////////////////////////////////////////////////////////////////

function nextStageKey(currentKey, fieldId = null) {
  // Returns the *next* stage in the workflow (not the current one)
  switch (currentKey) {
    case "LIME":
      return "FERTILIZE";
    case "FERTILIZE":
      return "TILLAGE_CHOICE";
    case "TILLAGE_CHOICE":
      return null; // depends on choice
    case "PLOW":
    case "SUBSOIL":
      return "CULTIVATE";
    case "CULTIVATE":
      return "SEED_PICK";
    case "SEED_PICK":
      return null; // depends on crop choice
    case "SEED": {
      if (fieldId != null) {
        try {
          const f = getField(fieldId);
          const cropKey = f?.crop || f?.plannedCrop;
          if (isMeadowCropKey(cropKey)) return "MEADOW_MOW_1";
        } catch {}
      }
      return "HARVEST";
    }
    case "HARVEST":
      return "LIME";

    // Meadow loop
    case "MEADOW_MOW_1":
      return "MEADOW_FERTILIZE";
    case "MEADOW_FERTILIZE":
      return "MEADOW_MOW_2";
    case "MEADOW_LIME":
      return "MEADOW_MOW_2"; // legacy safety (step removed)
    case "MEADOW_MOW_2":
      return "MEADOW_MOW_3";
    case "MEADOW_MOW_3":
      return "LIME";

    default:
      return null;
  }
}

function stageNextHint(fieldId) {
  const f = getField(fieldId);

  // Waiting stages (need user input)
  if (f.stage === "TILLAGE_CHOICE") {
    return "Odaberi obradu: **Oranje** / **Podrivanje** (ili **Preskoči**).";
  }

if (f.stage === "SEED_PICK") {
    if (f.plannedCrop) {
      const c = CROPS.find((x) => x.key === f.plannedCrop);
      if (c) return `${STAGES.SEED.emoji} **Sjetva** • plan: ${c.emoji} **${c.label}**`;
    }
    return "Odaberi kulturu za sjetvu (ili postavi plan sjetve).";
  }

  const nextKey = nextStageKey(f.stage, fieldId);
  const next = nextKey ? STAGES[nextKey] : null;
  if (next) return `${next.emoji} **${next.label}**`;

  // Fallback
  return "**nepoznato**";
}

function priorityRank(p) {
  const v = String(p ?? "MED").toUpperCase();
  if (v === "HIGH") return 0;
  if (v === "MED") return 1;
  if (v === "LOW") return 2;
  return 1;
}

function priorityLine(task) {
  const p = PRIORITY[task.priority ?? "MED"] ?? PRIORITY.MED;
  return `${p.emoji} **${p.label}**`;
}

function plannedCropLine(fieldId) {
  const f = getField(fieldId);
  // Planned crop is meant as the *next* crop; if it matches current crop, treat as not set to avoid confusion.
  if (!f.plannedCrop || f.plannedCrop === f.crop) return "*nije postavljeno*";
  const c = CROPS.find((x) => x.key === f.plannedCrop);
  return c ? `${c.emoji} **${c.label}**` : `**${f.plannedCrop}**`;
}

function buildCropPickerComponents(fieldId) {
  ensureConfig();
  state.panels = state.panels ?? {};
  state.panels.details = state.panels.details ?? {};
  const meta = state.panels.details;

  const f = getField(fieldId);

  const pageSize = 20; // 4 rows * 5 buttons (keeps us within Discord's 5-row limit)
  const totalPages = Math.max(1, Math.ceil(CROPS.length / pageSize));
  const page = Math.min(Math.max(Number(meta.cropPage ?? 0), 0), totalPages - 1);
  meta.cropPage = page;

  const slice = CROPS.slice(page * pageSize, page * pageSize + pageSize);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`fd:croppage:prev:${fieldId}`)
      .setLabel("Prev")
      .setEmoji("⬅️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`fd:croppage:page:${fieldId}`)
      .setLabel(`Str ${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`fd:croppage:next:${fieldId}`)
      .setLabel("Next")
      .setEmoji("➡️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`fd:crop:${fieldId}:CLEAR`)
      .setLabel("🧹 Obriši plan")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!f.plannedCrop),
    new ButtonBuilder()
      .setCustomId(`fd:back:${fieldId}`)
      .setLabel("Back")
      .setStyle(ButtonStyle.Primary)
  );

  const rows = [navRow];

  const cropButtons = slice.map((c) =>
    new ButtonBuilder()
      .setCustomId(`fd:crop:${fieldId}:${c.key}`)
      .setLabel(`${c.emoji} ${c.label}`)
      .setStyle(f.plannedCrop === c.key ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  for (let i = 0; i < cropButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(cropButtons.slice(i, i + 5)));
  }

  // Always return <= 5 rows.
  return rows.slice(0, 5);
}

function activeCropLine(fieldId) {
  const f = getField(fieldId);
  if (!f.crop) return "*nije postavljeno*";
  const c = CROPS.find((x) => x.key === resolveCropKey(f.crop));
  return c ? `${c.emoji} **${c.label}**` : `**${f.crop}**`;
}

function buildFieldDetailsEmbed(fieldId) {
  ensureConfig();

  state.panels = state.panels ?? {};
  state.panels.details = state.panels.details ?? {};
  const meta = state.panels.details;

  const filter = meta.filter ?? "ALL";
  const view = meta.view ?? "MAIN";

  const fieldPageSize = 3;
  const activePageSize = 10;
  const tasksPageSize = 10;

  const fieldsAll = getFieldList();

  const filteredFields = fieldsAll
    .filter((fid) => {
      const f = getField(fid);
      const tasks = listTasksForField(fid);
      const active = getActiveTask(fid);
      const hasActive = !!active && active.status === "ACTIVE";
      const hasOpen = tasks.some((t) => t.status === "OPEN");
      const waiting =
        f.stage === "TILLAGE_CHOICE" ||
        f.stage === "SEED_PICK" ||
        (active && (active.stageKey === "TILLAGE_CHOICE" || active.stageKey === "SEED_PICK"));

      if (filter === "ACTIVE") return hasActive;
      if (filter === "DONE") return tasks.some((t) => t.status === "DONE");
      if (filter === "WAITING") return waiting;
      if (filter === "URGENT") return hasActive && (active?.priority ?? "MED") === "HIGH";
      // ALL
      return true;
    })
    .sort((a, b) => {
      // Sorting must follow filter intent (priority first when relevant)
      if (filter === "ACTIVE" || filter === "URGENT") {
        const aa = getActiveTask(a);
        const bb = getActiveTask(b);
        const ar = priorityRank(aa?.priority ?? "MED");
        const br = priorityRank(bb?.priority ?? "MED");
        if (ar !== br) return ar - br;
        return Number(a) - Number(b);
      }

if (filter === "WAITING") {
        const fa = getField(a);
        const fb = getField(b);
        const ra = fa.stage === "TILLAGE_CHOICE" ? 0 : fa.stage === "SEED_PICK" ? 1 : 2;
        const rb = fb.stage === "TILLAGE_CHOICE" ? 0 : fb.stage === "SEED_PICK" ? 1 : 2;
        if (ra !== rb) return ra - rb;
        return Number(a) - Number(b);
      }
      return Number(a) - Number(b);
    });

  const totalFieldPages = Math.max(1, Math.ceil(filteredFields.length / fieldPageSize));
  const safeFieldPage = Math.min(Math.max(Number(meta.page ?? 0), 0), totalFieldPages - 1);

  const pageFields = filteredFields.slice(
    safeFieldPage * fieldPageSize,
    safeFieldPage * fieldPageSize + fieldPageSize
  );

  const explicit = (fieldId === null ? null : (fieldId ?? meta.fieldId));

  // If nothing is selected, show a clean "Active tasks" view (workflow merged into this panel).
  if (explicit === null || explicit === undefined) {
    meta.fieldId = null;
    meta.view = "LIST";

    // Build a single list of "active work": one *running* ACTIVE task per field.
    // Paused tasks are not shown here.
    const workAll = fieldsAll
      .map((fid) => {
        const t = getActiveTask(fid);
        return { fieldId: String(fid), task: t };
      })
      .filter((x) => x.task && x.task.status === "ACTIVE" && !!x.task.isRunning);

    workAll.sort((a, b) => {
      const sa = a.task.status === "ACTIVE" ? 0 : 1;
      const sb = b.task.status === "ACTIVE" ? 0 : 1;
      if (sa !== sb) return sa - sb;

      const ar = priorityRank(a.task?.priority ?? "MED");
      const br = priorityRank(b.task?.priority ?? "MED");
      if (ar !== br) return ar - br;

      return Number(a.fieldId) - Number(b.fieldId);
    });

    const totalPages = Math.max(1, Math.ceil(workAll.length / activePageSize));
    const page = Math.min(Math.max(Number(meta.activePage ?? 0), 0), totalPages - 1);
    meta.activePage = page;

    const slice = workAll.slice(page * activePageSize, page * activePageSize + activePageSize);

    const lines = slice.map((x) => {
      const t = x.task;
      const p = PRIORITY[t.priority ?? "MED"] ?? PRIORITY.MED;
      const who = t.assignedTo ? ` <@${t.assignedTo}>` : "";
      const title = t.title ?? ((STAGES[t.stageKey]?.emoji ?? "📌") + " " + (STAGES[t.stageKey]?.label ?? t.stageKey));
      return `• **Polje ${x.fieldId}** — ${title} — ${p.emoji} ${p.label}${who}`;
    });

    const summaryLine = `Pokrenuto: **${workAll.length}**`;

    const desc = lines.length
      ? `${summaryLine}\n\n${lines.join("\n")}`
      : `_Nema aktivnih zadataka._\n\n${summaryLine}`;

    return new EmbedBuilder()
      .setTitle(`${getFieldsPanelTitle()} — Aktivni zadaci`)
      .setDescription(desc)
      .setFooter({ text: `Str ${page + 1}/${totalPages} • Prikaz: ${activePageSize}/str • Odaberi polje ili 🔢 Polje` });
  }

  const selected = String(explicit ?? pageFields[0] ?? filteredFields[0] ?? (fieldsAll[0] ?? 1));
  meta.fieldId = selected;

// Ensure task context exists for selected field
  ensureNextForField(selected);

  const f = getField(selected);
  const stage = STAGES[f.stage] ?? { label: f.stage ?? "?", emoji: "📌" };

  const tasks = listTasksForField(selected);
  const active = getActiveTask(selected);

  const counts = {
    open: tasks.filter((t) => t.status === "OPEN").length,
    active: tasks.filter((t) => t.status === "ACTIVE").length,
    done: tasks.filter((t) => t.status === "DONE").length,
  };

  const detailsLines = [
    `Polje: **${selected}**`,
    `Ciklus: **${f.cycle ?? 1}**`,
    `Trenutno: ${stage.emoji} **${stage.label}**`,
    `Sljedeće: ${stageNextHint(selected)}`,
    `Plan sjetve (sljedeća): ${plannedCropLine(selected)}`,
    `Kultura (trenutna): ${activeCropLine(selected)}`,
    `Taskovi: OPEN **${counts.open}** | ACTIVE **${counts.active}** | DONE **${counts.done}**`,
  ].join("\n");

  // Selected field tasks list (OPEN/ACTIVE), paged in TASKS view
  const tasksForList = tasks
    .filter((t) => t.status === "ACTIVE" || t.status === "OPEN")
    .slice()
    .sort((a, b) => {
      const sa = a.status === "ACTIVE" ? 0 : 1;
      const sb = b.status === "ACTIVE" ? 0 : 1;
      if (sa !== sb) return sa - sb;

      const pa = priorityRank(a.priority ?? "MED");
      const pb = priorityRank(b.priority ?? "MED");
      if (pa !== pb) return pa - pb;

      // tie-breaker: numeric task id if possible
      const na = Number(String(a.id).replace(/^\D+/, "")) || 0;
      const nb = Number(String(b.id).replace(/^\D+/, "")) || 0;
      if (na !== nb) return nb - na;
      return 0;
    });

  const totalTasksPages = Math.max(1, Math.ceil(tasksForList.length / tasksPageSize));
  const safeTasksPage = Math.min(Math.max(Number(meta.tasksPage ?? 0), 0), totalTasksPages - 1);

  const tasksSlice = (view === "TASKS")
    ? tasksForList.slice(safeTasksPage * tasksPageSize, safeTasksPage * tasksPageSize + tasksPageSize)
    : tasksForList.slice(0, 5);

  const taskListLines = tasksSlice.map((t) => {
    const p = PRIORITY[t.priority ?? "MED"] ?? PRIORITY.MED;
    const who = t.assignedTo ? ` <@${t.assignedTo}>` : "";
    const title = t.title ?? ((STAGES[t.stageKey]?.emoji ?? "📌") + " " + (STAGES[t.stageKey]?.label ?? t.stageKey));
    const status = t.status === "ACTIVE" ? "🟢" : "🟠";
    return `${status} **${formatTaskId(t.id)}** • ${title} • ${p.emoji} ${p.label}${who}`;
  });

  const tasksListValue = taskListLines.length ? taskListLines.join("\n") : "_Nema OPEN/ACTIVE zadataka._";
  const tasksFieldName = (view === "TASKS")
    ? `Zadaci polja (str ${safeTasksPage + 1}/${totalTasksPages} • OPEN/ACTIVE)`
    : "Zadaci polja (TOP 5 • OPEN/ACTIVE)";

  const titleBase = state.config?.fieldsPanelTitle ?? "FarmBudy – Polja";

  const embed = new EmbedBuilder()
    .setTitle(`${titleBase} — Polje ${selected}`)
    .setColor(getEmbedColor("fieldDetails"))
    .addFields(
      { name: "Sažetak polja", value: detailsLines },
      { name: tasksFieldName, value: tasksListValue }
    )
    .setFooter({ text: `Polja/str: ${fieldPageSize} • Zadaci/str: ${tasksPageSize} • Aktivni/str: ${activePageSize}` });

  return embed;
}

function buildFieldDetailsComponents(fieldId) {
  ensureConfig();

  state.panels = state.panels ?? {};
  state.panels.details = state.panels.details ?? {};
  const meta = state.panels.details;

  const fieldPageSize = 3;
  const activePageSize = 10;

  const fieldsAll = getFieldList();
  const totalFieldPages = Math.max(1, Math.ceil(fieldsAll.length / fieldPageSize));
  const safeFieldPage = Math.min(Math.max(Number(meta.page ?? 0), 0), totalFieldPages - 1);
  meta.page = safeFieldPage;

  const pageFields = fieldsAll.slice(safeFieldPage * fieldPageSize, safeFieldPage * fieldPageSize + fieldPageSize);

  const selected = (fieldId === null ? null : (fieldId ?? meta.fieldId));
  const hasSelection = selected !== null && selected !== undefined;

  const view = meta.view ?? "MAIN";
  // Crop picker view (Plan sjetve)
  if (hasSelection && view === "PLAN_PICK") {
    return buildCropPickerComponents(String(meta.fieldId));
  }

  const rows = [];

  // Row: Active list paging (only meaningful in list view)
  if (!hasSelection) {
    // Build work list length to decide paging enablement
    const workAll = fieldsAll
      .map((fid) => {
        const t = getActiveTask(fid);
        return { fieldId: String(fid), task: t };
      })
      .filter((x) => x.task && x.task.status === "ACTIVE" && !!x.task.isRunning);

    const totalPages = Math.max(1, Math.ceil(workAll.length / activePageSize));
    const page = Math.min(Math.max(Number(meta.activePage ?? 0), 0), totalPages - 1);
    meta.activePage = page;

    const rActive = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fd:activePrev")
        .setLabel("Prev")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId("fd:activePage")
        .setLabel(`Aktivni ${page + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId("fd:activeNext")
        .setLabel("Next")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page >= totalPages - 1)
    );
    rows.push(rActive);
  }

  // Row: Field navigation (always visible)
  const fieldRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("fd:fieldsPrev")
      .setLabel("Prev")
      .setEmoji("⬅️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safeFieldPage <= 0),
    ...pageFields.map((fid) =>
      new ButtonBuilder()
        .setCustomId(`fd:field:${fid}`)
        .setLabel(`Polje ${fid}`)
        .setStyle(String(fid) === String(meta.fieldId) ? ButtonStyle.Success : ButtonStyle.Secondary)
    ),
    new ButtonBuilder()
      .setCustomId("fd:fieldsNext")
      .setLabel("Next")
      .setEmoji("➡️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safeFieldPage >= totalFieldPages - 1)
  );
  rows.push(fieldRow);

  // Row: Back + jump (only in field view) OR jump-only (list view)
  if (hasSelection) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fd:back").setLabel("Lista").setEmoji("📋").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("fd:jump").setLabel("Polje").setEmoji("🔢").setStyle(ButtonStyle.Primary)
      )
    );
  } else {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fd:jump").setLabel("Polje").setEmoji("🔢").setStyle(ButtonStyle.Primary)
      )
    );
  }

  // Tillage choice row (only when selected field is waiting for choice)
  if (hasSelection) {
    const f = getField(meta.fieldId);
    const act = getActiveTask(meta.fieldId);
    const waitingChoice = (act && act.stageKey === "TILLAGE_CHOICE" && act.status !== "DONE") || (f && f.stage === "TILLAGE_CHOICE");
    if (waitingChoice) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("fd:tillage:PLOW").setLabel("Oranje").setEmoji("🚜").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("fd:tillage:SUBSOIL").setLabel("Podrivanje").setEmoji("🪓").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("fd:tillage:SKIP").setLabel("Preskoči").setEmoji("⏭️").setStyle(ButtonStyle.Primary)
        )
      );
    }

  // Actions row
  const runnableTask = getRunnableTaskForField(meta.fieldId);
  const isChoiceTask =
    runnableTask?.stageKey === "TILLAGE_CHOICE" || runnableTask?.stageKey === "SEED_PICK";
  const isRunning = !!runnableTask?.isRunning;
  const canToggleRun = !!runnableTask && !isChoiceTask;
  const canDone = !!runnableTask && canToggleRun && runnableTask.status === "ACTIVE" && isRunning;

  const isMeadowOptional =
    !!runnableTask && (runnableTask.stageKey === "MEADOW_FERTILIZE" || runnableTask.stageKey === "MEADOW_LIME");
  const canSkipOptional = isMeadowOptional && runnableTask.status !== "DONE";

  const actionButtons = [
    new ButtonBuilder().setCustomId(`fd:plan:${meta.fieldId}`).setLabel("Plan sjetve").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`fd:priority:${meta.fieldId}`).setLabel("Prioritet").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`fd:run:${meta.fieldId}`)
      .setLabel(isRunning ? "Pauziraj" : "Pokreni")
      .setStyle(ButtonStyle.Primary)
      .setEmoji(isRunning ? "⏸️" : "▶️")
      .setDisabled(!canToggleRun),
    new ButtonBuilder()
      .setCustomId(`fd:done:${meta.fieldId}`)
      .setLabel("Sljedeći")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("⏭️")
      .setDisabled(!canDone),
  ];

  if (isMeadowOptional) {
    actionButtons.push(
      new ButtonBuilder()
        .setCustomId(`fd:skipopt:${meta.fieldId}`)
        .setLabel("Preskoči")
        .setEmoji("⏭️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canSkipOptional)
    );
  }

  rows.push(new ActionRowBuilder().addComponents(actionButtons.slice(0, 5)));
}

  return rows.slice(0, 5);
}

///////////////////////////////////////////////////////////////////////////////////////////////////

async function safeEditOrSend(message, channel, payload) {
  if (message) {
    try {
      return await message.edit(payload);
    } catch (err) {
      // Unknown Message (was deleted) -> re-send
      if (err?.code !== 10008) throw err;
    }
  }
  return await channel.send(payload);
}

// PANELS UPSERT/REFRESH
///////////////////////////////////////////////////////////////////////////////////////////////////

async function upsertPanel(panelType, channel, titleOverride = null) {
  state.panels = state.panels ?? {};
  const key = panelType;

  // Resolve channel if not provided (e.g., deploy from admin saves channelId then calls upsertPanel(panelKey))
  if (!channel) {
    const metaChId = state.panels?.[key]?.channelId;
    if (metaChId) {
      try {
        const fetched = await client.channels.fetch(metaChId);
        if (fetched && fetched.isTextBased()) channel = fetched;
      } catch {}
    }
  }

  const existing = state.panels[key];
  let message = null;

  const page = existing?.page ?? 0;
  const mode = existing?.mode ?? "ALL";

  if (!message && (!channel || (channel.isTextBased && !channel.isTextBased()) || !channel.isTextBased)) {
    // No channel configured and no existing message to edit
    return null;
  }

if (existing?.channelId && existing?.messageId) {
    try {
      const ch = await client.channels.fetch(existing.channelId);
      if (ch && ch.isTextBased()) {
        if (!channel) channel = ch;
        message = await ch.messages.fetch(existing.messageId);
      }
    } catch {
      message = null;
    }
  }

if (panelType === "workflow") {
    const embed = renderWorkflowBoardEmbed(page, mode);
    if (titleOverride) embed.setTitle(titleOverride);
    const selectedTaskId = state.panels?.workflow?.selectedTaskId ?? null;
    const components = renderWorkflowBoardComponents(page, mode, selectedTaskId);

    message = await safeEditOrSend(message, channel, { embeds: [embed], components });

    state.panels[key] = { ...(state.panels[key] ?? {}), channelId: channel.id, messageId: message.id, page, mode };
    saveState();
    return message;
  }

if (panelType === "activity") {
    const embed = renderActivityEmbed();
    if (titleOverride) embed.setTitle(titleOverride);

    message = await safeEditOrSend(message, channel, { embeds: [embed], components: [] });

    state.panels[key] = { ...(state.panels[key] ?? {}), channelId: channel.id, messageId: message.id };
    saveState();
    return message;
  }

if (panelType === "admin") {
    const embed = renderAdminEmbed();
    if (titleOverride) embed.setTitle(titleOverride);
    const components = renderAdminComponents();

    message = await safeEditOrSend(message, channel, { embeds: [embed], components });

    state.panels[key] = { ...(state.panels[key] ?? {}), channelId: channel.id, messageId: message.id };
    saveState();
    return message;
  }

if (panelType === "details") {
    // Field panel can be in LIST mode (no selection) or field mode.
    const view = existing?.view ?? "LIST";
    const fallbackField = String(getFieldList()[0] ?? 1);
    const fieldId = (view === "LIST" || existing?.fieldId === null || existing?.fieldId === undefined)
      ? null
      : String(existing.fieldId ?? fallbackField);
    const embed = buildFieldDetailsEmbed(fieldId);
    if (titleOverride) embed.setTitle(titleOverride);
    const components = buildFieldDetailsComponents(fieldId);

    message = await safeEditOrSend(message, channel, { embeds: [embed], components });

    state.panels[key] = { ...(state.panels[key] ?? {}), channelId: channel.id, messageId: message.id, fieldId, view };
    saveState();
    return message;
  }

  if (panelType === "serverstats") {
    const embed = renderServerStatsEmbed();
    if (titleOverride) embed.setTitle(titleOverride);
    const components = renderServerStatsComponents();

    message = await safeEditOrSend(message, channel, { embeds: [embed], components });

    state.panels[key] = { ...(state.panels[key] ?? {}), channelId: channel.id, messageId: message.id, serverId: state.panels?.serverstats?.serverId };
    saveState();
    return message;
  }


  if (panelType === "playerhours") {
    const embed = renderPlayerHoursEmbed();
    if (titleOverride) embed.setTitle(titleOverride);
    const components = renderPlayerHoursComponents();

    message = await safeEditOrSend(message, channel, { embeds: [embed], components });

    state.panels[key] = { ...(state.panels[key] ?? {}), channelId: channel.id, messageId: message.id, serverId: state.panels?.playerhours?.serverId ?? state.panels?.serverstats?.serverId };
    saveState();
    return message;
  }




  if (panelType === "fleet") {
    const serverId = getFleetServerId();
    const meta = state.panels?.fleet ?? {};
    const page = Number.isFinite(Number(meta.page)) ? Number(meta.page) : 0;
    const selectedVehicleId = meta.selectedVehicleId != null ? String(meta.selectedVehicleId) : null;

    const listEmbed = renderFleetListEmbed(serverId, page);
    if (titleOverride) listEmbed.setTitle(titleOverride);
    const listComponents = renderFleetListComponents(serverId, page);

    // List message (panel root)
    message = await safeEditOrSend(message, channel, { embeds: [listEmbed], components: listComponents });

    // Details message (second "window" right under list)
    let detailsMsg = null;
    const detailsId = meta.detailsMessageId ?? null;
    if (detailsId) {
      try { detailsMsg = await channel.messages.fetch(detailsId); } catch { detailsMsg = null; }
    }

    const detailsEmbed = renderFleetDetailsEmbed(serverId, selectedVehicleId);
    const detailsComponents = renderFleetDetailsComponents(Boolean(selectedVehicleId));

    detailsMsg = await safeEditOrSend(detailsMsg, channel, { embeds: [detailsEmbed], components: detailsComponents });

    state.panels[key] = {
      ...(state.panels[key] ?? {}),
      channelId: channel.id,
      messageId: message.id,
      detailsMessageId: detailsMsg.id,
      page,
      selectedVehicleId,
      serverId
    };
    saveState();
    return message;
  }

throw new Error(`Unknown panel type: ${panelType}`);
}

async function purgePanelMessages() {
  const panels = state.panels ?? {};
  for (const [type, meta] of Object.entries(panels)) {
    const chId = meta?.channelId;
    const msgId = meta?.messageId;
    if (!chId || !msgId) continue;
    try {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch || !ch.isTextBased()) continue;
      const msg = await ch.messages.fetch(msgId).catch(() => null);
      if (msg) await msg.delete().catch(() => null);
    } catch {}
    // force re-post
    state.panels[type] = { ...(state.panels[type] ?? {}), messageId: null };
  }
  saveState();
}

async function refreshAllPanels() {
  const panels = state.panels ?? {};
  for (const [type, meta] of Object.entries(panels)) {
    try {
      const ch = await client.channels.fetch(meta.channelId);
      if (!ch || !ch.isTextBased()) continue;
      await upsertPanel(type, ch);
    } catch {}
  }
}

async function refreshWorkflowPanel() {
  const meta = state.panels?.workflow;
  if (!meta?.channelId) return;
  try {
    const ch = await client.channels.fetch(meta.channelId);
    if (!ch || !ch.isTextBased()) return;
    await upsertPanel("workflow", ch);
  } catch (e) {
    console.error("refreshWorkflowPanel error:", e);
  }
}

async function updateDetailsPanel(fieldId, fallbackChannel) {
  // If details panel is deployed, update it. If not, auto-create in detailsChannelId or fallbackChannel.
  const meta = state.panels?.details;
  let channel = null;

  if (meta?.channelId) {
    channel = await client.channels.fetch(meta.channelId).catch(() => null);
  }

if (!channel) {
    const cfgChId = state.config?.detailsChannelId;
    if (cfgChId) channel = await client.channels.fetch(cfgChId).catch(() => null);
  }

if (!channel) channel = fallbackChannel;

  if (!channel || !channel.isTextBased()) return;

  // persist selection and update
  state.panels = state.panels ?? {};
  state.panels.details = state.panels.details ?? {};
  state.panels.details.fieldId = String(fieldId);
  saveState();

  await upsertPanel("details", channel);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// ONBOARDING + SECURITY EVENTS
///////////////////////////////////////////////////////////////////////////////////////////////////

function getTextChannelById(id) {
  if (!id) return null;
  return client.channels.fetch(id).catch(() => null);
}

function urlOrInvitePresent(content) {
  if (!content) return false;
  const s = String(content);
  return /(https?:\/\/|www\.|discord\.gg\/|discord\.com\/invite\/)/i.test(s);
}

function keywordHit(content, keywords) {
  if (!content) return null;
  const s = String(content).toLowerCase();
  for (const k of (keywords ?? [])) {
    const kk = String(k).trim().toLowerCase();
    if (!kk) continue;
    if (s.includes(kk)) return kk;
  }
  return null;
}

async function maybeTimeout(member, minutes, reason) {
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0) return false;
  try {
    if (!member.moderatable) return false;
    await member.timeout(mins * 60 * 1000, reason ?? "Moderation");
    return true;
  } catch {
    return false;
  }
}

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    ensureConfig();

    // Anti-raid join rate tracking
    const antiRaid = state.config?.security?.antiRaid ?? {};
    if (antiRaid.enabled) {
      const now = Date.now();
      const windowMs = Math.max(5, Number(antiRaid.windowSec ?? 30)) * 1000;
      runtime.joins.push(now);
      runtime.joins = runtime.joins.filter((t) => now - t <= windowMs);

      const maxJoins = Math.max(2, Number(antiRaid.maxJoins ?? 5));
      if (runtime.joins.length >= maxJoins) {
        const lockMins = Math.max(1, Number(antiRaid.lockdownMinutes ?? 10));
        runtime.lockdownUntil = Math.max(runtime.lockdownUntil, now + lockMins * 60 * 1000);

        await sendToModLog({
          content: `⚠️ **Anti-raid**: detektiran burst joinova (${runtime.joins.length} u ${Math.round(windowMs / 1000)}s). Lockdown ${lockMins} min.`,
        });
      }
    }

    // Anti-alt (account age) + lockdown quarantine
    const sec = state.config?.security ?? {};
    const minDays = Math.max(0, Number(sec.minAccountAgeDays ?? 0));
    const ageDays = accountAgeDays(member.user);
    const inLockdown = Date.now() < (runtime.lockdownUntil ?? 0);
    const shouldQuarantine = inLockdown || (minDays > 0 && ageDays < minDays);

    if (shouldQuarantine && sec.quarantineRoleId) {
      try { await member.roles.add(sec.quarantineRoleId, "Auto quarantine (anti-alt/raid)"); } catch {}
    }

    // Welcome message
    const w = state.config?.welcome;
    if (w?.enabled && w.channelId) {
      const ch = await getTextChannelById(w.channelId);
      if (ch?.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle(`Dobrodošao, ${member.user.username}`)
          .setDescription(applyVars(w.message, member, member.guild))
          .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
          .setColor(getEmbedColor("admin"))
          .setTimestamp(new Date());
        await ch.send({ embeds: [embed] }).catch(() => null);
      }
    }

    // Verification hint (if quarantined)
    if (shouldQuarantine && sec.verificationChannelId) {
      const ch = await getTextChannelById(sec.verificationChannelId);
      if (ch?.isTextBased()) {
        await ch.send({
          content: `👋 ${member} • račun je ${Math.floor(ageDays)} dana star${inLockdown ? " (raid mode)" : ""}. Klikni **Verify** da dobiješ pristup.`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("verify:accept").setLabel("Verify").setStyle(ButtonStyle.Success)
            ),
          ],
        }).catch(() => null);
      }
    }
  } catch {}
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    ensureConfig();
    const g = state.config?.goodbye;
    if (!g?.enabled || !g.channelId) return;
    const ch = await getTextChannelById(g.channelId);
    if (!ch?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle(`Doviđenja, ${member.user?.username ?? "member"}`)
      .setDescription(applyVars(g.message, member.user ?? member, member.guild))
      .setThumbnail((member.user ?? member)?.displayAvatarURL?.({ size: 256 }) ?? null)
      .setColor(getEmbedColor("admin"))
      .setTimestamp(new Date());

    await ch.send({ embeds: [embed] }).catch(() => null);
  } catch {}
});

client.on(Events.MessageCreate, async (message) => {
  try {
    ensureConfig();
    if (!message.guild) return;
    if (!message.member) return;
    if (message.author?.bot) return;

    const antiScam = state.config?.security?.antiScam ?? {};
    if (!antiScam.enabled) return;

    const minDays = Math.max(0, Number(state.config?.security?.minAccountAgeDays ?? 0));
    const ageDays = accountAgeDays(message.author);

    const unverified = !isVerified(message.member);
    const link = urlOrInvitePresent(message.content);
    const hit = keywordHit(message.content, antiScam.keywords);

    const blockLinks = antiScam.blockLinksForUnverified && unverified && link;
    const blockKeywords = (unverified || (minDays > 0 && ageDays < minDays)) && Boolean(hit);

    if (!blockLinks && !blockKeywords) return;

    // Delete message (best effort)
    try { await message.delete(); } catch {}

    const mins = Math.max(0, Number(antiScam.timeoutMinutes ?? 10));
    const reason = blockLinks ? "Anti-scam: link od neverificiranog" : `Anti-scam: keyword "${hit}"`;
    const timedOut = await maybeTimeout(message.member, mins, reason);

    const embed = new EmbedBuilder()
      .setTitle("🛡️ Anti-scam akcija")
      .setDescription([
        `**User:** ${message.author} (age ~${Math.floor(ageDays)}d)`,
        `**Channel:** <#${message.channelId}>`,
        `**Reason:** ${reason}`,
        `**Action:** ${blockLinks ? "delete link" : "delete keyword"}${mins > 0 ? (timedOut ? ` + timeout ${mins}m` : " (timeout failed)") : ""}`,
      ].join("\n"))
      .setColor(0xED4245)
      .setTimestamp(new Date());

    await sendToModLog({ embeds: [embed] });
  } catch {}
});


///////////////////////////////////////////////////////////////////////////////////////////////////
// DISCORD MESSAGE DELETE LOGGING
///////////////////////////////////////////////////////////////////////////////////////////////////

function clipTextForLog(s, max = 800) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

async function logDeletedMessage({ guild, channelId, author, messageId, content, attachmentsCount, bulkCount }) {
  try {
    ensureConfig();
    if (!guild) return;

    const channelMention = channelId ? `<#${channelId}>` : "(unknown channel)";
    const title = bulkCount ? "🗑️ Bulk delete" : "🗑️ Poruka obrisana";

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0xED4245)
      .setTimestamp(new Date());

    if (bulkCount) {
      embed.setDescription(`**Kanal:** ${channelMention}\n**Broj poruka:** ${bulkCount}`);
      await sendToLog({ embeds: [embed] });
      return;
    }

    const authorLine = author ? `${author} (\`${author.id}\`)` : "(nije u cacheu)";
    embed.setDescription(`**Kanal:** ${channelMention}\n**Autor:** ${authorLine}`);

    embed.addFields(
      { name: "Message ID", value: `\`${messageId ?? "unknown"}\``, inline: true },
      { name: "Prilozi", value: String(attachmentsCount ?? 0), inline: true },
    );

    if (content) {
      embed.addFields({ name: "Sadržaj", value: clipTextForLog(content, 900) });
    } else {
      embed.addFields({ name: "Sadržaj", value: "(nije dostupno — poruka nije bila u cacheu / nema Message Content)" });
    }

    await sendToLog({ embeds: [embed] });
  } catch {}
}

client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message) return;
    if (!message.guild) return;

    // Ne logiraj botove housekeeping deleteove (da ne spamamo sami sebe)
    if (message.author?.id && client.user?.id && message.author.id === client.user.id) return;

    await logDeletedMessage({
      guild: message.guild,
      channelId: message.channelId ?? message.channel?.id,
      author: message.author ?? null,
      messageId: message.id,
      content: typeof message.content === 'string' && message.content.length ? message.content : null,
      attachmentsCount: message.attachments?.size ?? 0,
      bulkCount: null,
    });
  } catch {}
});

client.on(Events.MessageDeleteBulk, async (messages) => {
  try {
    const count = messages?.size ?? 0;
    const first = messages?.first?.() ?? null;
    const guild = first?.guild ?? null;
    const channelId = first?.channelId ?? first?.channel?.id ?? null;

    await logDeletedMessage({
      guild,
      channelId,
      author: null,
      messageId: null,
      content: null,
      attachmentsCount: 0,
      bulkCount: count,
    });
  } catch {}
});

///////////////////////////////////////////////////////////////////////////////////////////////////
// SLASH COMMANDS
///////////////////////////////////////////////////////////////////////////////////////////////////

const SLASH_COMMANDS = [
  {
    name: "panel",
    description: "Deploy panels to channels (choose where boards go).",
    options: [
      {
        type: 1,
        name: "deploy",
        description: "Create/update a panel in a selected channel",
        options: [
          {
            type: 3,
            name: "type",
            description: "Panel type",
            required: true,
            choices: [
              { name: "admin", value: "admin" },
              { name: "workflow", value: "workflow" },
              { name: "details", value: "details" },
              { name: "activity", value: "activity" },
              { name: "serverstats", value: "serverstats" },
              { name: "fleet", value: "fleet" },
            ],
          },
          {
            type: 7,
            name: "channel",
            description: "Target channel",
            required: true,
          },
          {
            type: 3,
            name: "title",
            description: "Optional title override",
            required: false,
          },
        ],
      },
      { type: 1, name: "refresh", description: "Refresh all deployed panels" },
    ],
  },
  {
    name: "fields",
    description: "Manage fields list",
    options: [
      { type: 1, name: "add", description: "Add fields (ids or ranges)", options: [{ type: 3, name: "ids", description: 'e.g. "6,7,10-15"', required: true }] },
      { type: 1, name: "remove", description: "Remove fields", options: [{ type: 3, name: "ids", description: 'e.g. "3" or "10-15"', required: true }] },
    ],
  },
  {
    name: "config",
    description: "Configuration",
    options: [
      { type: 1, name: "setlog", description: "Set log channel", options: [{ type: 7, name: "channel", description: "Log channel", required: true, channel_types: [ChannelType.GuildText] }] },
      { type: 1, name: "setevents", description: "Set FS25 join/leave channel", options: [{ type: 7, name: "channel", description: "Events channel", required: true, channel_types: [ChannelType.GuildText] }] },
    ],
  },
  {
    name: "announce",
    description: "Pošalji poruku u log kanal (npr. git commit poruka)",
    options: [
      { type: 3, name: "text", description: "Tekst poruke", required: true },
      { type: 7, name: "channel", description: "Opcionalno: ciljani kanal", required: false, channel_types: [ChannelType.GuildText] },
    ],
  },
  {
    name: "kick",
    description: "Kick a member",
    options: [
      { type: 6, name: "user", description: "User", required: true },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "ban",
    description: "Ban a member",
    options: [
      { type: 6, name: "user", description: "User", required: true },
      { type: 3, name: "reason", description: "Reason", required: false },
      { type: 4, name: "delete_days", description: "Delete message days (0-7)", required: false },
    ],
  },
  {
    name: "timeout",
    description: "Timeout a member",
    options: [
      { type: 6, name: "user", description: "User", required: true },
      { type: 4, name: "minutes", description: "Minutes", required: true },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "unban",
    description: "Unban by user id",
    options: [
      { type: 3, name: "user_id", description: "User ID", required: true },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "provjera",
    description: "Posalji provjeru aktivnosti korisniku putem DM-a",
    options: [
      { type: 6, name: "user", description: "Korisnik kojem saljes provjeru", required: true },
    ],
  },
  {
    name: "launcher",
    description: "Prikazi download link za SR Manager (launcher za Slavonska Ravnica server)",
  },

];

///////////////////////////////////////////////////////////////////////////////////////////////////
// ACTIVITY CHECK DM (/provjera)
///////////////////////////////////////////////////////////////////////////////////////////////////

async function sendActivityCheckDM(targetId, adminId, guildId, attempt) {
  try {
    const user = await client.users.fetch(targetId).catch(() => null);
    if (!user) return false;

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    const serverName = guild?.name ?? "Slavonska ravnica";

    const embed = new EmbedBuilder()
      .setTitle("Provjera aktivnosti")
      .setDescription(
        `Pozdrav! Ovo je automatska provjera aktivnosti sa servera **${serverName}**.\n\n` +
        `Molimo te da odabereš jedan od gumbova ispod kako bismo potvrdili da si još aktivan/na.\n\n` +
        `Pokušaj: **${attempt}/3**`
      )
      .setColor(0x5865F2)
      .setTimestamp(new Date());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("actcheck:da").setLabel("DA").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("actcheck:ne").setLabel("NE").setStyle(ButtonStyle.Danger),
    );

    await user.send({ embeds: [embed], components: [row] });

    // Schedule retry after 1 hour if no response
    const timerId = setTimeout(async () => {
      const check = activeChecks.get(targetId);
      if (!check) return; // already answered

      if (attempt >= 3) {
        // Max attempts reached — notify admin
        activeChecks.delete(targetId);
        try {
          const admin = await client.users.fetch(adminId).catch(() => null);
          if (admin) {
            const member = guild ? await guild.members.fetch(targetId).catch(() => null) : null;
            const displayName = member?.displayName ?? user.username;
            await admin.send({
              content: `⚠️ **Provjera aktivnosti** — bez odgovora!\n**Korisnik:** ${displayName} (<@${targetId}>)\n**Pokušaji:** 3/3 — korisnik nije odgovorio.`,
            }).catch(() => null);
          }
        } catch {}
        return;
      }

      // Send next attempt
      await sendActivityCheckDM(targetId, adminId, guildId, attempt + 1);
    }, 60 * 60 * 1000); // 1 hour

    activeChecks.set(targetId, { adminId, attempt, timerId, guildId });
    return true;
  } catch (err) {
    console.warn("[actcheck] Failed to send DM:", err?.message ?? err);
    return false;
  }
}

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(ENV.token);
  await rest.put(Routes.applicationGuildCommands(ENV.clientId, ENV.guildId), { body: SLASH_COMMANDS });
  console.log("Slash commands registered.");
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// INTERACTIONS
///////////////////////////////////////////////////////////////////////////////////////////////////

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // DEBUG: log every interaction (helps diagnose 'buttons do nothing')
    try {
      const t = interaction.type;
      const kind = interaction.isButton() ? 'button' : interaction.isStringSelectMenu() ? 'select' : interaction.isChannelSelectMenu() ? 'ch_select' : interaction.isRoleSelectMenu() ? 'role_select' : interaction.isUserSelectMenu() ? 'user_select' : interaction.isModalSubmit() ? 'modal' : interaction.isChatInputCommand() ? 'slash' : 'other';
      const cid = interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit() ? interaction.customId : '';
      const name = interaction.isChatInputCommand() ? interaction.commandName : '';
      console.log(`[interaction] kind=${kind} cmd=${name} id=${cid} user=${interaction.user?.id ?? 'unknown'} channel=${interaction.channelId ?? 'unknown'}`);
    } catch {}
    // SLASH
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const sub = interaction.options.getSubcommand();
        if (sub === "deploy") {
          const type = interaction.options.getString("type", true);
          const channel = interaction.options.getChannel("channel", true);
          const title = interaction.options.getString("title", false);

          const guild = interaction.guild;
          const me = guild?.members?.me ?? (await guild.members.fetchMe());
          if (!hasChannelSendPerms(channel, me)) {
            return interaction.reply({ ...eph(), content: `Nemam permission za slanje embeda u ${channel}. Treba: View + Send + Embed Links.` });
          }

          await interaction.deferReply(eph());
          await upsertPanel(type, channel, title ?? null);
          logActivity(`Panel **${type}** deployan u #${channel.name} od <@${interaction.user.id}>.`);
          await refreshAllPanels();
          return interaction.editReply({ content: `OK. Panel **${type}** je postavljen u ${channel}.` });
        }

if (sub === "refresh") {
          await interaction.deferReply(eph());
          await refreshAllPanels();
          return interaction.editReply({ content: "OK. Svi paneli osvježeni." });
        }
      }

if (interaction.commandName === "fields") {
        const sub = interaction.options.getSubcommand();
        const ids = parseIds(interaction.options.getString("ids", true));
        if (!ids.length) return interaction.reply({ ...eph(), content: "Nema validnih ID-eva." });

        if (sub === "add") {
          const before = new Set(getFieldList());
          for (const n of ids) before.add(n);
          state.config.fields = [...before].sort((a, b) => a - b);
          saveState();
          logActivity(`<@${interaction.user.id}> dodao polja: ${ids.join(", ")}.`);
          await refreshAllPanels();
          await interaction.deferReply(eph());
          await ackAndDelete(interaction, `Added: ${ids.join(", ")}`);
          return;
        }

if (sub === "remove") {
          const remove = new Set(ids);
          state.config.fields = getFieldList().filter((n) => !remove.has(n));
          saveState();
          logActivity(`<@${interaction.user.id}> maknuo polja: ${ids.join(", ")}.`);
          await refreshAllPanels();
          await interaction.deferReply(eph());
          await ackAndDelete(interaction, `Removed: ${ids.join(", ")}`);
          return;
        }
      }

if (interaction.commandName === "config") {
        const sub = interaction.options.getSubcommand();
        if (sub === "setlog") {
          const channel = interaction.options.getChannel("channel", true);
          state.config.logChannelId = channel.id;
          saveState();
          logActivity(`<@${interaction.user.id}> postavio log kanal: #${channel.name}.`);
          await refreshAllPanels();
          return interaction.reply({ ...eph(), content: `Log kanal postavljen na ${channel}.` });
        }

        if (sub === "setevents") {
          const channel = interaction.options.getChannel("channel", true);
          state.config.fs25 = state.config.fs25 ?? {};
          state.config.fs25.eventsChannelId = channel.id;
          saveState();
          logActivity(`<@${interaction.user.id}> postavio FS25 join/leave kanal: #${channel.name}.`);
          return interaction.reply({ ...eph(), content: `FS25 join/leave kanal postavljen na ${channel}.` });
        }
      }

      if (interaction.commandName === "announce") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        await interaction.deferReply(eph());

        const text = interaction.options.getString("text", true);
        const chosen = interaction.options.getChannel("channel", false);
        const targetId = chosen?.id || state.config?.logChannelId || state.config?.taskHistoryChannelId || null;

        if (!targetId) return interaction.editReply({ content: "Nije postavljen log kanal, niti je zadan kanal." });

        const ch = await client.channels.fetch(targetId).catch(() => null);
        if (!ch || !ch.isTextBased()) return interaction.editReply({ content: "Kanal nije valjan." });

        await ch.send({ content: `📝 **Deploy / Git:** ${text}\nBy: <@${interaction.user.id}>` }).catch(() => null);
        return interaction.editReply({ content: "Poslano." });
      }
      // ACTIVITY CHECK (/provjera)
      if (interaction.commandName === "provjera") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        await interaction.deferReply(eph());

        const targetUser = interaction.options.getUser("user", true);
        const targetId = targetUser.id;
        const adminId = interaction.user.id;
        const guildId = interaction.guildId;

        if (activeChecks.has(targetId)) {
          return interaction.editReply({ content: `Provjera za <@${targetId}> je već u tijeku.` });
        }

        const sent = await sendActivityCheckDM(targetId, adminId, guildId, 1);
        if (!sent) {
          return interaction.editReply({ content: `Ne mogu poslati DM korisniku <@${targetId}>. Možda ima zatvorene DM-ove.` });
        }

        return interaction.editReply({ content: `Provjera aktivnosti poslana korisniku <@${targetId}>. Dobit ćeš odgovor kad reagira (ili nakon 3 pokušaja).` });
      }

      // SR MANAGER DOWNLOAD (/launcher)
      if (interaction.commandName === "launcher") {
        const embed = new EmbedBuilder()
          .setTitle("SR Manager - Download")
          .setDescription(
            "Aplikacija za upravljanje modovima i brzi ulazak na **Slavonska Ravnica** server.\n\n" +
            "**Sto radi:**\n" +
            "- Automatski provjerava i skida modove\n" +
            "- Postavlja server password\n" +
            "- Prikazuje tko je online\n" +
            "- Auto-update\n\n" +
            "**Instalacija:**\n" +
            "1. Skini ZIP sa linka ispod\n" +
            "2. Raspakiraj folder\n" +
            "3. Pokreni `SR Manager.bat`\n\n" +
            "Treba: Windows 10+, FS25"
          )
          .setColor(0xF5C518)
          .setFooter({ text: "Slavonska Ravnica | by Anthony" });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Download SR Manager")
            .setStyle(ButtonStyle.Link)
            .setURL("https://github.com/7oncha/SlavonskaRavnica-apk/archive/refs/heads/main.zip"),
          new ButtonBuilder()
            .setLabel("GitHub")
            .setStyle(ButtonStyle.Link)
            .setURL("https://github.com/7oncha/SlavonskaRavnica-apk"),
        );

        return interaction.reply({ embeds: [embed], components: [row] });
      }

      // MODERATION COMMANDS
      if (["kick", "ban", "timeout", "unban"].includes(interaction.commandName)) {
        if (!isModerator(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš moderator ovlasti." });

        await interaction.deferReply(eph());

        const modLogEmbedBase = (title, desc) =>
          new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xED4245).setTimestamp(new Date());

        try {
          if (interaction.commandName === "kick") {
            const user = interaction.options.getUser("user", true);
            const reason = interaction.options.getString("reason", false) ?? "—";
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!member) return interaction.editReply({ content: "Ne mogu naći tog člana." });
            if (!member.kickable) return interaction.editReply({ content: "Ne mogu kickati ovog člana (permission/role hijerarhija)." });

            await member.kick(reason).catch(() => null);
            await sendToModLog({ embeds: [modLogEmbedBase("👢 Kick", `**User:** ${user}\n**By:** <@${interaction.user.id}>\n**Reason:** ${reason}`)] });
            return interaction.editReply({ content: `Kickan: ${user}` });
          }

if (interaction.commandName === "ban") {
            const user = interaction.options.getUser("user", true);
            const reason = interaction.options.getString("reason", false) ?? "—";
            const del = interaction.options.getInteger("delete_days", false) ?? 0;
            const deleteMessageSeconds = Math.min(7, Math.max(0, del)) * 24 * 60 * 60;

            await interaction.guild.members.ban(user.id, { reason, deleteMessageSeconds }).catch(() => null);
            await sendToModLog({ embeds: [modLogEmbedBase("⛔ Ban", `**User:** <@${user.id}>\n**By:** <@${interaction.user.id}>\n**Reason:** ${reason}`)] });
            return interaction.editReply({ content: `Banan: <@${user.id}>` });
          }

if (interaction.commandName === "timeout") {
            const user = interaction.options.getUser("user", true);
            const minutes = interaction.options.getInteger("minutes", true);
            const reason = interaction.options.getString("reason", false) ?? "—";
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!member) return interaction.editReply({ content: "Ne mogu naći tog člana." });
            const ok = await maybeTimeout(member, minutes, reason);
            await sendToModLog({ embeds: [modLogEmbedBase("⏳ Timeout", `**User:** ${user}\n**By:** <@${interaction.user.id}>\n**Minutes:** ${minutes}\n**Reason:** ${reason}\n**Result:** ${ok ? "OK" : "FAIL"}`)] });
            return interaction.editReply({ content: ok ? `Timeout: ${user} (${minutes} min)` : "Timeout nije uspio (permission/role hijerarhija)." });
          }

if (interaction.commandName === "unban") {
            const userId = interaction.options.getString("user_id", true);
            const reason = interaction.options.getString("reason", false) ?? "—";
            await interaction.guild.bans.remove(userId, reason).catch(() => null);
            await sendToModLog({ embeds: [modLogEmbedBase("✅ Unban", `**User ID:** ${userId}\n**By:** <@${interaction.user.id}>\n**Reason:** ${reason}`)] });
            return interaction.editReply({ content: `Unban OK: ${userId}` });
          }
        } catch {
          return interaction.editReply({ content: "Greška kod moderacije." });
        }
      }

      return;
    }

    // BUTTONS
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Activity check buttons (DA / NE) - works in DM
      if (id === "actcheck:da" || id === "actcheck:ne") {
        const targetId = interaction.user.id;
        const check = activeChecks.get(targetId);
        if (!check) {
          await interaction.reply({ content: "Ova provjera je već istekla ili obrađena." }).catch(() => null);
          return;
        }

        // Clear retry timer
        if (check.timerId) clearTimeout(check.timerId);
        activeChecks.delete(targetId);

        const answer = id === "actcheck:da" ? "DA" : "NE";

        // Confirm to user
        await interaction.update({
          content: `Hvala na odgovoru! Odgovorio/la si: **${answer}**`,
          components: [],
        }).catch(() => null);

        // Notify admin
        try {
          const admin = await client.users.fetch(check.adminId).catch(() => null);
          if (admin) {
            const guild = await client.guilds.fetch(check.guildId).catch(() => null);
            const member = guild ? await guild.members.fetch(targetId).catch(() => null) : null;
            const displayName = member?.displayName ?? interaction.user.username;
            await admin.send({
              content: `📋 **Provjera aktivnosti** — odgovor primljen!\n**Korisnik:** ${displayName} (<@${targetId}>)\n**Odgovor:** ${answer}\n**Pokušaj:** ${check.attempt}/3`,
            }).catch(() => null);
          }
        } catch {}

        return;
      }

      // Server stats panel
      if (id === "serverstats:refresh") {
        await interaction.deferUpdate();
        const ch = interaction.channel;
        if (ch && ch.isTextBased()) {
          await upsertPanel("serverstats", ch);
        }
        return;
      }



      // Player Hours panel
      if (id === "playerhours:refresh") {
        await interaction.deferUpdate();
        const ch = interaction.channel;
        if (ch && ch.isTextBased()) {
          await upsertPanel("playerhours", ch);
        }
        return;
      }

      // Fleet panel
      if (id === "fleet:prev" || id === "fleet:next" || id === "fleet:refresh" || id === "fleet:assignOwner" || id === "fleet:clearOwner") {
        state.panels = state.panels ?? {};
        state.panels.fleet = state.panels.fleet ?? {};
        const ch = interaction.channel;

        if (id === "fleet:prev") state.panels.fleet.page = Math.max(0, Number(state.panels.fleet.page ?? 0) - 1);
        if (id === "fleet:next") state.panels.fleet.page = Math.max(0, Number(state.panels.fleet.page ?? 0) + 1);

        if (id === "fleet:assignOwner") {
          const serverId = getFleetServerId();
          const vehicleId = state.panels.fleet.selectedVehicleId ? String(state.panels.fleet.selectedVehicleId) : null;
          const ownerId = state.panels.fleet.selectedOwnerId ? String(state.panels.fleet.selectedOwnerId) : null;

          if (!vehicleId) {
            await interaction.reply({ ...eph(), content: "Prvo odaberi vozilo iz liste." });
            return;
          }
          if (!ownerId) {
            await interaction.reply({ ...eph(), content: "Prvo odaberi farmera (owner) u Vehicle details." });
            return;
          }

          setVehicleOwner(serverId, vehicleId, ownerId);
        }

        if (id === "fleet:clearOwner") {
          const serverId = getFleetServerId();
          const vehicleId = state.panels.fleet.selectedVehicleId ? String(state.panels.fleet.selectedVehicleId) : null;
          if (vehicleId) setVehicleOwner(serverId, vehicleId, null);
        }

        saveState();
        await interaction.deferUpdate();
        if (ch && ch.isTextBased()) await upsertPanel("fleet", ch);
        return;
      }


      // Verification (player) – Realism quiz
      if (id === "verify:quiz:start" || id === "verify:start") {
        ensureConfig();
        const sec = state.config.security ?? {};
        const minAgeDays = Number(sec.minAccountAgeDays ?? 0) || 0;

        // Optional account age gate
        if (minAgeDays > 0) {
          const createdAt = interaction.user.createdAt ? interaction.user.createdAt.getTime() : 0;
          const ageDays = createdAt ? (Date.now() - createdAt) / (1000 * 60 * 60 * 24) : 9999;
          if (ageDays < minAgeDays) {
            await interaction.reply({ ...eph(), content: `Verifikacija odbijena: račun je mlađi od ${minAgeDays} dana.` });
            return;
          }
        }

        const qids = pickQuizQuestions(interaction.user.id, 3);
        runtime.verifyQuiz.sessions.set(interaction.user.id, { qids, index: 0, score: 0 });

        const payload = buildQuizQuestionPayload(
          interaction.user.id,
          interaction.guildId,
          sec.verificationChannelId,
          sec.verificationMessageId
        );

        await interaction.reply({ ...eph(), ...(payload ?? { content: "Greška: ne mogu pokrenuti provjeru." }) });
        return;
      }

      if (id === "verify:quiz:retry") {
        ensureConfig();
        const sec = state.config.security ?? {};
        const qids = pickQuizQuestions(interaction.user.id, 3);
        runtime.verifyQuiz.sessions.set(interaction.user.id, { qids, index: 0, score: 0 });

        const payload = buildQuizQuestionPayload(
          interaction.user.id,
          interaction.guildId,
          sec.verificationChannelId,
          sec.verificationMessageId
        );

        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ ...(payload ?? { content: "Greška: ne mogu pokrenuti provjeru." }) }).catch(() => {});
        } else {
          await interaction.reply({ ...eph(), ...(payload ?? { content: "Greška: ne mogu pokrenuti provjeru." }) });
        }
        return;
      }


      // Admin panel buttons
      if (id.startsWith("admin:")) {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

        // Backup / Restore
        // New location: BACKUP view
        // Legacy ids kept as aliases (no longer shown in UI)
        if (id === "admin:backup:now" || id === "admin:setup:backupNow") {
          await interaction.deferReply(eph());
          const ok = await sendStateBackup(interaction.user.id);
          await interaction.editReply(ok ? "Backup saved." : "Backup channel not set (or missing permissions).");
          return;
        }

        if (id === "admin:backup:restore" || id === "admin:setup:restoreLast") {
          await interaction.deferReply(eph());
          const res = await restoreStateFromLatestBackup(interaction.user.id);
          if (!res.ok) {
            const msg =
              res.reason === "no_channel" ? "Backup/Log channel not set." :
              res.reason === "no_backup_found" ? "No backup (.json attachment) found in the last 25 messages." :
              "Restore failed.";
            await interaction.editReply(msg);
            return;
          }
          // After restore, clean old panel messages where possible, then re-deploy fresh
          await purgePanelMessages();
          await refreshAllPanels();
          await interaction.editReply("Restore successful. Panels redeployed.");
          return;
        }

// Admin view navigation (grouped UI)
if (id.startsWith("admin:view:")) {
  const v = id.split(":")[2];
  const view =
    v === "setup" ? "SETUP" :
    v === "fields" ? "FIELDS" :
    v === "onboarding" ? "ONBOARDING" :
    v === "moderation" ? "MODERATION" :
    v === "security" ? "SECURITY" :
    v === "backup" ? "BACKUP" :
    v === "telemetry" ? "TELEMETRY" :
    v === "help" ? "HELP" :
    "ROOT";
  setAdminView(view);
  await interaction.deferUpdate();
  await upsertPanel("admin", interaction.channel);
  return;
}

// Backward compatibility: old help button
if (id === "admin:help") {
  setAdminView("HELP");
  await interaction.deferUpdate();
  await upsertPanel("admin", interaction.channel);
  return;
}

// Backward compatibility: old channel buttons (now use dropdowns)
if (id === "admin:setlog" || id === "admin:setdetailsch" || id === "admin:sethistorych") {
  setAdminView("CHANNELS");
  await interaction.deferUpdate();
  await upsertPanel("admin", interaction.channel);
  return;
}

if (id === "admin:setup:deploy") {
  if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

  state.panels = state.panels ?? {};
  state.panels.admin = state.panels.admin ?? {};
  const sel = state.panels.admin.panelDeploy ?? { panel: "details", channelId: state.config.detailsChannelId ?? null };

  const panelKey = sel.panel;
  const channelId = sel.channelId;

  if (!channelId) {
    await interaction.deferUpdate();
    await upsertPanel("admin", interaction.channel);
    await sendToLog(`Admin deploy: nije odabran kanal za panel **${panelKey}**.`);
    return;
  }

  // Force re-send in selected channel
  state.panels[panelKey] = state.panels[panelKey] ?? {};
  state.panels[panelKey].channelId = channelId;
  state.panels[panelKey].messageId = null;
  saveState();

  await interaction.deferUpdate();

  // Resolve channel via fetch (cache-safe)
  let ch = null;
  try { ch = await client.channels.fetch(channelId); } catch {}

if (ch && ch.isTextBased()) {
    await upsertPanel(panelKey, ch);
  } else {
    await upsertPanel(panelKey); // will try resolve from saved channelId
  }

  await upsertPanel("admin", interaction.channel);
  return;
}

if (id === "admin:panels:deploy") {
          if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

          state.panels = state.panels ?? {};
          state.panels.admin = state.panels.admin ?? {};
          const sel = state.panels.admin.panelDeploy ?? { panel: "details", channelId: state.config.detailsChannelId ?? null };

          const panelKey = sel.panel;
          const channelId = sel.channelId;

          if (!channelId) {
            await interaction.deferUpdate();
            await upsertPanel("admin", interaction.channel);
            await sendToLog(`Admin deploy: nije odabran kanal za panel **${panelKey}**.`);
            return;
          }

          state.panels[panelKey] = state.panels[panelKey] ?? {};
          state.panels[panelKey].channelId = channelId;
          state.panels[panelKey].messageId = null; // force re-send in selected channel
          saveState();

          await interaction.deferUpdate();
          await upsertPanel(panelKey);
          await upsertPanel("admin", interaction.channel);
          return;
        }

if (id === "admin:refresh") {
          await interaction.deferUpdate();
          await refreshAllPanels();
          return;
        }

        // TELEMETRY setup
        if (id === "admin:telemetry:setBaseUrl") {
          const modal = new ModalBuilder().setCustomId("admin:modal:telemetryBaseUrl").setTitle("Telemetry Base URL");
          const input = new TextInputBuilder()
            .setCustomId("url")
            .setLabel("Railway public URL (https://...)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200)
            .setValue(String(state.config?.telemetryBaseUrl ?? "").slice(0, 200));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        if (id === "admin:telemetry:setSecret") {
          const modal = new ModalBuilder().setCustomId("admin:modal:telemetrySecret").setTitle("Telemetry Secret");
          const current = String(state.config?.telemetrySecret ?? "");
          const input = new TextInputBuilder()
            .setCustomId("secret")
            .setLabel("Secret (min 16 char preporuka)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200)
            .setValue(current.slice(0, 200));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        if (id === "admin:telemetry:clearSecret") {
          ensureConfig();
          state.config.telemetrySecret = null;
          saveState();
          await interaction.reply({ ...eph(), content: "Telemetry secret uklonjen iz state-a (env i dalje vrijedi ako je postavljen)." });
          await refreshAllPanels();
          return;
        }

        if (id === "admin:telemetry:reset") {
          state.gameTelemetry = state.gameTelemetry ?? { servers: {} };
          state.gameTelemetry.servers = {};
          saveState();
          await interaction.deferUpdate();
          await refreshAllPanels();
          return;
        }

        if (id === "admin:telemetry:deployServerStats") {
          state.panels = state.panels ?? {};
          state.panels.serverstats = state.panels.serverstats ?? {};
          const channelId = state.panels.serverstats.channelId ?? null;
          if (!channelId) {
            await interaction.reply({ ...eph(), content: "Prvo odaberi kanal za ServerStats (dropdown)." });
            return;
          }
          state.panels.serverstats.messageId = null; // force re-post
          saveState();
          await interaction.deferReply(eph());
          const ch = await client.channels.fetch(channelId).catch(() => null);
          if (!ch || !ch.isTextBased()) {
            await interaction.editReply("Ne mogu otvoriti odabrani kanal.");
            return;
          }
          await upsertPanel("serverstats", ch);
          await interaction.editReply(`ServerStats panel deployan u <#${channelId}>.`);
          await upsertPanel("admin", interaction.channel);
          return;
        }

        // ONBOARDING toggles / modals
        // Verification admin shortcuts
        if (id === "admin:onboarding:verifyRoles") {
          setAdminView("VERIFY_ROLES");
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

        if (id === "admin:onboarding:verify:deployPanel") {
          ensureConfig();
          const sec = state.config.security ?? {};
          const chId = sec.verificationChannelId;
          if (!chId) {
            await interaction.reply({ ...eph(), content: "Prvo postavi Verification kanal u Onboarding." });
            return;
          }
          const ch = await client.channels.fetch(chId).catch(() => null);
          if (!ch || !ch.isTextBased()) {
            await interaction.reply({ ...eph(), content: "Verification kanal nije valjan ili bot nema pristup." });
            return;
          }
          await interaction.deferReply(eph());
          await upsertVerifyPanel(ch);
          await interaction.editReply(`Verify panel deployan u <#${chId}>.`);
          await upsertPanel("admin", interaction.channel);
          return;
        }

        if (id === "admin:onboarding:welcome:toggle") {
          state.config.welcome.enabled = !state.config.welcome.enabled;
          saveState();
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

if (id === "admin:onboarding:goodbye:toggle") {
          state.config.goodbye.enabled = !state.config.goodbye.enabled;
          saveState();
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

if (id === "admin:onboarding:welcome:message") {
          const modal = new ModalBuilder().setCustomId("admin:modal:welcomeMessage").setTitle("Welcome tekst");
          const input = new TextInputBuilder()
            .setCustomId("msg")
            .setLabel("Tekst (vars: {user} {server})")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1200)
            .setValue(String(state.config.welcome.message ?? "").slice(0, 1200));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:onboarding:goodbye:message") {
          const modal = new ModalBuilder().setCustomId("admin:modal:goodbyeMessage").setTitle("Goodbye tekst");
          const input = new TextInputBuilder()
            .setCustomId("msg")
            .setLabel("Tekst (vars: {username} {server})")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1200)
            .setValue(String(state.config.goodbye.message ?? "").slice(0, 1200));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:onboarding:roles") {
          const modal = new ModalBuilder().setCustomId("admin:modal:roles").setTitle("Role postavke");
          const q = new TextInputBuilder().setCustomId("quarantine").setLabel("Quarantine role ID").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(25).setValue(String(state.config.security.quarantineRoleId ?? ""));
          const m = new TextInputBuilder().setCustomId("member").setLabel("Member role ID (verified)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(25).setValue(String(state.config.security.memberRoleId ?? ""));
          modal.addComponents(new ActionRowBuilder().addComponents(q), new ActionRowBuilder().addComponents(m));
          return interaction.showModal(modal);
        }

if (id === "admin:onboarding:perms") {
  const modal = new ModalBuilder().setCustomId("admin:modal:perms").setTitle("Permisije (ID-jevi)");

  const owners = new TextInputBuilder()
    .setCustomId("owners")
    .setLabel("Owners (user IDs, zarez/razmak/newline)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(900)
    .setValue(String((state.config?.perms?.owners ?? []).join(", ")).slice(0, 900));

  const coOwners = new TextInputBuilder()
    .setCustomId("coOwners")
    .setLabel("Co-owners (user IDs)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(900)
    .setValue(String((state.config?.perms?.coOwners ?? []).join(", ")).slice(0, 900));

  const adminUsers = new TextInputBuilder()
    .setCustomId("adminUsers")
    .setLabel("Admin users (user IDs)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(900)
    .setValue(String((state.config?.perms?.adminUsers ?? []).join(", ")).slice(0, 900));

  const adminRoles = new TextInputBuilder()
    .setCustomId("adminRoles")
    .setLabel("Admin roles (role IDs)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(900)
    .setValue(String((state.config?.perms?.adminRoles ?? []).join(", ")).slice(0, 900));

  const modRoles = new TextInputBuilder()
    .setCustomId("modRoles")
    .setLabel("Moderator roles (role IDs)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(900)
    .setValue(String((state.config?.perms?.modRoles ?? []).join(", ")).slice(0, 900));

  modal.addComponents(
    new ActionRowBuilder().addComponents(owners),
    new ActionRowBuilder().addComponents(coOwners),
    new ActionRowBuilder().addComponents(adminUsers),
    new ActionRowBuilder().addComponents(adminRoles),
    new ActionRowBuilder().addComponents(modRoles),
  );

  return interaction.showModal(modal);
}

if (id === "admin:onboarding:minage") {
          const modal = new ModalBuilder().setCustomId("admin:modal:minage").setTitle("Min account age");
          const input = new TextInputBuilder()
            .setCustomId("days")
            .setLabel("Minimalno dana star account (0=off)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(4)
            .setValue(String(state.config.security.minAccountAgeDays ?? 0));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }


        // SECURITY: Player links (FS uniqueUserId -> Discord user)
        if (interaction.isStringSelectMenu() && interaction.customId === "admin:security:playerlinks:fs") {
          state.panels = state.panels ?? {};
          state.panels.admin = state.panels.admin ?? {};
          state.panels.admin.security = state.panels.admin.security ?? { section: "ANTISCAM" };
          state.panels.admin.security.playerLinksSel = state.panels.admin.security.playerLinksSel ?? { fsId: null, discordId: null };
          const v = interaction.values?.[0] ?? null;
          if (v && v !== "none") state.panels.admin.security.playerLinksSel.fsId = String(v);
          saveState();
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

        if (interaction.isUserSelectMenu() && interaction.customId === "admin:security:playerlinks:discord") {
          state.panels = state.panels ?? {};
          state.panels.admin = state.panels.admin ?? {};
          state.panels.admin.security = state.panels.admin.security ?? { section: "ANTISCAM" };
          state.panels.admin.security.playerLinksSel = state.panels.admin.security.playerLinksSel ?? { fsId: null, discordId: null };
          const v = interaction.values?.[0] ?? null;
          if (v) state.panels.admin.security.playerLinksSel.discordId = String(v);
          saveState();
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

        if (id === "admin:security:playerlinks:save") {
          ensurePlayerHoursState();
          const pls = state.panels?.admin?.security?.playerLinksSel ?? { fsId: null, discordId: null };
          const f = String(pls.fsId ?? "").trim();
          const d = String(pls.discordId ?? "").trim();
          if (f && d) {
            state.playerHours.links[f] = d;
            saveState();
          }
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);

          const phMeta = state.panels?.playerhours;
          if (phMeta?.channelId) {
            try {
              const ch = await client.channels.fetch(phMeta.channelId);
              if (ch && ch.isTextBased()) await upsertPanel("playerhours", ch);
            } catch {}
          }
          return;
        }

        if (id === "admin:security:playerlinks:clear") {
          ensurePlayerHoursState();
          const pls = state.panels?.admin?.security?.playerLinksSel ?? { fsId: null };
          const f = String(pls.fsId ?? "").trim();
          if (f && state.playerHours.links?.[f]) {
            delete state.playerHours.links[f];
            saveState();
          }
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

        // SECURITY toggles / modals
        if (id === "admin:security:antiscam:toggle") {
          state.config.security.antiScam.enabled = !state.config.security.antiScam.enabled;
          saveState();
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

if (id === "admin:security:antiscam:links") {
          state.config.security.antiScam.blockLinksForUnverified = !state.config.security.antiScam.blockLinksForUnverified;
          saveState();
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

if (id === "admin:security:antiscam:timeout") {
          const modal = new ModalBuilder().setCustomId("admin:modal:antiscamTimeout").setTitle("Anti-scam timeout");
          const input = new TextInputBuilder()
            .setCustomId("minutes")
            .setLabel("Timeout minutes")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(4)
            .setValue(String(state.config.security.antiScam.timeoutMinutes ?? 10));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:security:antiscam:keywords") {
          const modal = new ModalBuilder().setCustomId("admin:modal:antiscamKeywords").setTitle("Anti-scam keywords");
          const input = new TextInputBuilder()
            .setCustomId("keywords")
            .setLabel("Keywords (comma separated)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1200)
            .setValue(String((state.config.security.antiScam.keywords ?? []).join(", ")).slice(0, 1200));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:security:antiraid:toggle") {
          state.config.security.antiRaid.enabled = !state.config.security.antiRaid.enabled;
          saveState();
          await interaction.deferUpdate();
          await upsertPanel("admin", interaction.channel);
          return;
        }

if (id === "admin:security:antiraid:threshold") {
          const modal = new ModalBuilder().setCustomId("admin:modal:antiraidThreshold").setTitle("Anti-raid prag");
          const w = new TextInputBuilder().setCustomId("windowSec").setLabel("Window seconds").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setValue(String(state.config.security.antiRaid.windowSec ?? 30));
          const m = new TextInputBuilder().setCustomId("maxJoins").setLabel("Max joins u window").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setValue(String(state.config.security.antiRaid.maxJoins ?? 5));
          modal.addComponents(new ActionRowBuilder().addComponents(w), new ActionRowBuilder().addComponents(m));
          return interaction.showModal(modal);
        }

if (id === "admin:security:antiraid:lockdown") {
          const modal = new ModalBuilder().setCustomId("admin:modal:antiraidLockdown").setTitle("Anti-raid lockdown");
          const input = new TextInputBuilder()
            .setCustomId("minutes")
            .setLabel("Lockdown minutes")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(4)
            .setValue(String(state.config.security.antiRaid.lockdownMinutes ?? 10));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:paneltitle") {
          const modal = new ModalBuilder().setCustomId("admin:modal:paneltitle").setTitle("Naziv panela polja");
          const input = new TextInputBuilder()
            .setCustomId("title")
            .setLabel("Naslov (prikazuje se na panelu polja)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(60)
            .setValue(String(state.config?.fieldsPanelTitle ?? "FarmBudy – Polja").slice(0, 60));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:help") {
          const msg = [
            "**Admin Panel – tipke**",
            "- Deploy Admin/Workflow/Details/Activity: otvara modal, upišeš #channel ili channel ID",
            "- Set Log: kanal za DONE/cycle poruke",
            "- Set Details Ch: kanal u koji se auto-updatea Field Details (ako ne deployaš ručno)",
            "- Add/Remove Fields: upišeš `6,7,10-15`",
            "",
            "Tip: Deployaj **Details** u admin kanal i pinaj ga. Klik polja na boardu samo osvježava taj jedan message.",
          ].join("\n");
          return interaction.reply({ ...eph(), content: msg });
        }

if (id === "admin:colors") {
          const modal = new ModalBuilder().setCustomId("admin:modal:colors").setTitle("Boje embeda");

          const cAdmin = new TextInputBuilder()
            .setCustomId("admin")
            .setLabel("Admin panel (HEX, npr #5865F2)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(8)
            .setValue(`#${getEmbedColor("admin").toString(16).padStart(6, "0")}`);

          const cWorkflow = new TextInputBuilder()
            .setCustomId("workflow")
            .setLabel("Workflow board (HEX)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(8)
            .setValue(`#${getEmbedColor("workflow").toString(16).padStart(6, "0")}`);

          const cField = new TextInputBuilder()
            .setCustomId("fieldDetails")
            .setLabel("Field Details (HEX)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(8)
            .setValue(`#${getEmbedColor("fieldDetails").toString(16).padStart(6, "0")}`);

          const cActivity = new TextInputBuilder()
            .setCustomId("activity")
            .setLabel("Activity (HEX)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(8)
            .setValue(`#${getEmbedColor("activity").toString(16).padStart(6, "0")}`);

          modal.addComponents(
            new ActionRowBuilder().addComponents(cAdmin),
            new ActionRowBuilder().addComponents(cWorkflow),
            new ActionRowBuilder().addComponents(cField),
            new ActionRowBuilder().addComponents(cActivity)
          );
          return interaction.showModal(modal);
        }

if (id === "admin:setlog") {
          const modal = new ModalBuilder().setCustomId("admin:modal:setlog").setTitle("Set Log Channel");
          const input = new TextInputBuilder()
            .setCustomId("channel")
            .setLabel("Kanal (#mention ili ID)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:setdetailsch") {
          const modal = new ModalBuilder().setCustomId("admin:modal:setdetailsch").setTitle("Set Details Default Channel");
          const input = new TextInputBuilder()
            .setCustomId("channel")
            .setLabel("Kanal (#mention ili ID)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:sethistorych") {
          const modal = new ModalBuilder().setCustomId("admin:modal:sethistorych").setTitle("Set Task History Channel");
          const input = new TextInputBuilder()
            .setCustomId("channel")
            .setLabel("Kanal (#mention ili ID)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id.startsWith("admin:deploy:")) {
          const type = id.split(":")[2];
          const modal = new ModalBuilder().setCustomId(`admin:modal:deploy:${type}`).setTitle(`Deploy ${type}`);
          const input = new TextInputBuilder()
            .setCustomId("channel")
            .setLabel("Kanal (#mention ili ID)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

if (id === "admin:fields:add" || id === "admin:fields:remove") {
          const action = id.endsWith("add") ? "add" : "remove";
          const modal = new ModalBuilder().setCustomId(`admin:modal:fields:${action}`).setTitle(`Fields ${action}`);
          const input = new TextInputBuilder()
            .setCustomId("ids")
            .setLabel('IDs (npr. "6,7,10-15")')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(60);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        return;
      }

      // Verification button
      if (id === "verify:accept") {
        await interaction.deferReply(eph());
        ensureConfig();
        const sec = state.config?.security ?? {};
        const memberRoleId = sec.memberRoleId;
        const quarantineRoleId = sec.quarantineRoleId;

        try {
          if (quarantineRoleId) await interaction.member.roles.remove(quarantineRoleId, "Verified").catch(() => null);
          if (memberRoleId) await interaction.member.roles.add(memberRoleId, "Verified").catch(() => null);
        } catch {}

        return interaction.editReply({ content: "Verify OK." });
      }

      // Fallback: unknown button -> reply to avoid silent failure
      try {
        if (!interaction.replied && !interaction.deferred) {
          return interaction.reply({ ...eph(), content: `Nepoznat gumb (ID: ${id}). Molim redeployaj panel ili osvježi poruku.` });
        }
      } catch {}

      // Workflow board nav/mode
      // Workflow: finish selected task (basic users allowed)
      if (id.startsWith("wf:done:")) {
        if (!canBasic(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš ovlasti." });
        const taskId = id.split(":")[2];
        if (!taskId || taskId === "none") return interaction.deferUpdate();
        const res = completeTaskById(taskId, interaction.user.id);
        if (!res.ok) {
          const msg = res.reason === "not_found" ? "Zadatak ne postoji." :
            res.reason === "already_done" ? "Zadatak je već završen." :
            res.reason === "choice_required" ? "Za ovaj zadatak treba odabir (ne može se završiti ovdje)." :
            "Ne mogu završiti zadatak.";
          return interaction.reply({ ...eph(), content: msg });
        }
        const t = res.task;
        const nextK = nextStageKey(t.stageKey, t.fieldId);
        const nextTxt = nextK ? `${STAGES[nextK]?.emoji ?? "➡️"} ${STAGES[nextK]?.label ?? nextK}` : "—";
        await sendToTaskHistory({
          content: [
            `✅ Polje **${t.fieldId}** • **${formatTaskId(t.id)}** • ${STAGES[t.stageKey]?.emoji ?? ""} ${t.title ?? STAGES[t.stageKey]?.label ?? t.stageKey}`,
            `Završio: <@${interaction.user.id}> • Prioritet: **${String(t.priority || "LOW").toUpperCase()}**`,
            `Sljedeće: **${nextTxt}**${(nextK === "TILLAGE_CHOICE" || nextK === "SEED_PICK") ? " (odabir potreban)" : ""}`,
          ].join("\n"),
        });
        logActivity(`<@${interaction.user.id}> završio **${formatTaskId(t.id)}** (workflow).`);
        state.panels = state.panels ?? {};
        state.panels.workflow = state.panels.workflow ?? {};
        state.panels.workflow.selectedTaskId = (state.panels.workflow.selectedTaskId === String(taskId)) ? null : state.panels.workflow.selectedTaskId;
        saveState();
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

      if (id.startsWith("wf:board:")) {
        const parts = id.split(":");
        const action = parts[2];
        const currentPage = Number(parts[3] ?? 0);
        const mode = parts[4] ?? "ALL";

        if (action === "prev" || action === "next") {
          const delta = action === "prev" ? -1 : 1;
          const newPage = Math.max(0, Math.min(boardPages(mode) - 1, currentPage + delta));
          state.panels.workflow = state.panels.workflow ?? {};
          state.panels.workflow.page = newPage;
          state.panels.workflow.mode = mode;
          saveState();
          await interaction.deferUpdate();
          await refreshAllPanels();
          return;
        }

if (action === "mode") {
      const newMode = parts[3] ?? "ALL";
      const requestedPage = Number(parts[4] ?? 0);
      const maxPage = boardPages(newMode) - 1;
      const page = Math.max(0, Math.min(maxPage, requestedPage));

      state.panels.workflow = state.panels.workflow ?? {};
      state.panels.workflow.mode = String(newMode || "ALL").toUpperCase();
      state.panels.workflow.page = page;
      saveState();
          await interaction.deferUpdate();
          await refreshAllPanels();
          return;
        }
      }

      // Clicking a field: update the Field Details panel (no message spam)
      if (id.startsWith("wf:field:") && id.split(":").length === 3) {
        const fieldId = id.split(":")[2];

        // Ensure task context for better info
        ensureNextForField(fieldId, interaction.user.id);
        activateTask(getActiveTask(fieldId), interaction.user.id);

        await interaction.deferUpdate();
        await updateDetailsPanel(fieldId, interaction.channel);
        return;
      }

      // Field Details actions
      
      if (id.startsWith("fd:")) {
        // Unified Fields Panel (workflow + details in one message)
        // Custom IDs:
        //  - fd:pick:<fieldId>
        //  - fd:page:prev | fd:page:next
        //  - fd:filter:<ALL|ACTIVE|DONE|WAITING|URGENT>
        //  - fd:jump (modal)
        //  - fd:plan | fd:back (toggle crop picker view)
        //  - fd:crop:<fieldId>:<CROPKEY|CLEAR>
        //  - fd:priority | fd:notes | fd:done
        //  - fd:tillage:<PLOW|SUBSOIL|SKIP>

        // No-op placeholders for layout padding
        if (id.startsWith("fd:noop:")) {
          return interaction.deferUpdate();
        }

        // Ensure details meta exists
        state.panels = state.panels ?? {};
        state.panels.details = state.panels.details ?? {};
        const meta = state.panels.details;

        const fieldListAll = getFieldList();

        // Allow "no selection" (list view). Do NOT auto-select a field.
        if (!("fieldId" in meta)) meta.fieldId = null;

        if (!Number.isFinite(Number(meta.page))) meta.page = 0;
        if (!Number.isFinite(Number(meta.activePage))) meta.activePage = 0;

        if (!meta.view) meta.view = meta.fieldId ? "MAIN" : "LIST";

        const renderInPlace = async (fieldIdToRender) => {
          if (fieldIdToRender !== null && fieldIdToRender !== undefined) {
            ensureNextForField(fieldIdToRender, interaction.user?.id ?? null);
          }
          const embed = buildFieldDetailsEmbed(fieldIdToRender);
          const components = buildFieldDetailsComponents(fieldIdToRender);
          saveState();

          // More robust than interaction.update() alone (prevents "This interaction failed" in slow/error cases)
          try {
            if (interaction.deferred || interaction.replied) {
              return await interaction.editReply({ embeds: [embed], components });
            }
            return await interaction.update({ embeds: [embed], components });
          } catch (err) {
            try {
              if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
              return await interaction.editReply({ embeds: [embed], components });
            } catch {
              // swallow to avoid user-facing spam
              return null;
            }
          }
        };
        // Active list paging (list view)
        if (id === "fd:activePrev") {
          meta.activePage = Math.max(Number(meta.activePage ?? 0) - 1, 0);
          meta.fieldId = null;
          meta.view = "LIST";
          return renderInPlace(null);
        }

if (id === "fd:activeNext") {
          meta.activePage = Number(meta.activePage ?? 0) + 1;
          meta.fieldId = null;
          meta.view = "LIST";
          return renderInPlace(null);
        }

        // Fields paging (buttons row)
        if (id === "fd:fieldsPrev") {
          meta.page = Math.max(Number(meta.page ?? 0) - 1, 0);
          return renderInPlace(meta.fieldId ?? null);
        }

if (id === "fd:fieldsNext") {
          meta.page = Number(meta.page ?? 0) + 1;
          return renderInPlace(meta.fieldId ?? null);
        }

        // Select a field from buttons
        if (id.startsWith("fd:field:")) {
          const fid = id.split(":")[2];
          if (fid) {
            meta.fieldId = String(fid);
            meta.view = "MAIN";

            // Ensure the field page matches the selection
            const idx = fieldListAll.findIndex((x) => String(x) === String(fid));
            if (idx >= 0) meta.page = Math.floor(idx / 3);
          }
          return renderInPlace(meta.fieldId);
        }

        // Back to active list (deselect)
        if (id === "fd:back") {
          meta.fieldId = null;
          meta.view = "LIST";
          return renderInPlace(null);
        }

        const filteredFields = (() => {
          const filter = meta.filter ?? "ALL";
          return getFieldList()
            .filter((fid) => {
            const f = getField(fid);
            const tasks = listTasksForField(fid);
            const active = getActiveTask(fid);
            const hasActive = !!active && active.status === "ACTIVE";
            const hasOpen = tasks.some((t) => t.status === "OPEN");
            const waiting =
              f.stage === "TILLAGE_CHOICE" ||
              f.stage === "SEED_PICK" ||
              (active && (active.stageKey === "TILLAGE_CHOICE" || active.stageKey === "SEED_PICK"));
            const urgent = active && (active.priority ?? "MED") === "HIGH" && active.status === "ACTIVE";

            if (filter === "ACTIVE") return hasActive;
            if (filter === "DONE") return !hasActive && !hasOpen;
            if (filter === "WAITING") return waiting;
              if (filter === "URGENT") return urgent;
              return true;
            })
            .sort((a, b) => {
              if (filter === "ACTIVE" || filter === "URGENT") {
                const aa = getActiveTask(a);
                const bb = getActiveTask(b);
                const ar = priorityRank(aa?.priority ?? "MED");
                const br = priorityRank(bb?.priority ?? "MED");
                if (ar !== br) return ar - br;
                return Number(a) - Number(b);
              }

if (filter === "WAITING") {
                const fa = getField(a);
                const fb = getField(b);
                const ra = fa.stage === "TILLAGE_CHOICE" ? 0 : fa.stage === "SEED_PICK" ? 1 : 2;
                const rb = fb.stage === "TILLAGE_CHOICE" ? 0 : fb.stage === "SEED_PICK" ? 1 : 2;
                if (ra !== rb) return ra - rb;
                return Number(a) - Number(b);
              }
              return Number(a) - Number(b);
            });
        })();

        const clampPage = () => {
          const pageSize = 3;
          const totalPages = Math.max(1, Math.ceil(filteredFields.length / pageSize));
          meta.page = Math.max(0, Math.min(Number(meta.page ?? 0) || 0, totalPages - 1));
        };

        const ensureSelectionVisible = () => {
          const pageSize = 3;
          const idx = filteredFields.findIndex((x) => String(x) === String(meta.fieldId));
          if (idx >= 0) {
            meta.page = Math.floor(idx / pageSize);
          } else {
            meta.fieldId = String(filteredFields[0] ?? getFieldList()[0] ?? 1);
            meta.page = 0;
          }
        };

        // NAV: prev/next page
        if (id === "fd:page:prev" || id === "fd:page:next") {
          const delta = id === "fd:page:prev" ? -1 : 1;
          meta.page = (Number(meta.page ?? 0) || 0) + delta;
          clampPage();
          meta.view = "MAIN"; // keep navigation predictable
          return renderInPlace(meta.fieldId);
        }

// Pager: tasks view (selected field)
if (id === "fd:taskspage:prev" || id === "fd:taskspage:next") {
  const delta = id === "fd:taskspage:prev" ? -1 : 1;
  const count = listTasksForField(meta.fieldId).filter((t) => t.status === "ACTIVE" || t.status === "OPEN").length;
  const total = Math.max(1, Math.ceil(count / 10));
  meta.tasksPage = Math.max(0, Math.min((Number(meta.tasksPage ?? 0) || 0) + delta, total - 1));
  meta.view = "TASKS";
  return renderInPlace(meta.fieldId);
}

        // Filter
        if (id.startsWith("fd:filter:")) {
          const mode = id.split(":")[2] ?? "ALL";
          meta.filter = ["ALL", "ACTIVE", "DONE", "WAITING", "URGENT"].includes(mode) ? mode : "ALL";
          meta.view = "MAIN";
          meta.page = 0;
          meta.activePage = 0;
          meta.tasksPage = 0;
          ensureSelectionVisible();
          return renderInPlace(meta.fieldId);
        }

        // Pick a field
        if (id.startsWith("fd:pick:")) {
          const fid = id.split(":")[2];
          if (fid) meta.fieldId = String(fid);
          meta.view = "MAIN";
          meta.tasksPage = 0;
          ensureSelectionVisible();
          return renderInPlace(meta.fieldId);
        }

        // Jump to field (modal)
        if (id === "fd:jump") {
          const modal = new ModalBuilder().setCustomId("fd:modal:jump").setTitle("Odabir polja");
          const input = new TextInputBuilder()
            .setCustomId("fieldNumber")
            .setLabel("Upiši broj polja")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(6)
            .setValue(String(meta.fieldId ?? ""));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

// Plan seeding view toggle
if (id.startsWith("fd:plan:")) {
  const fid = id.split(":")[2];
  if (fid) meta.fieldId = String(fid);
  meta.view = "PLAN_PICK";
  meta.cropPage = 0;
  ensureSelectionVisible();
  return renderInPlace(meta.fieldId);
}

if (id.startsWith("fd:back:")) {
  const fid = id.split(":")[2];
  if (fid) meta.fieldId = String(fid);
  meta.view = "MAIN";
  ensureSelectionVisible();
  return renderInPlace(meta.fieldId);
}

// Crop picker pagination
if (id.startsWith("fd:croppage:")) {
  const parts = id.split(":");
  const dir = parts[2];
  const fid = parts[3];
  if (fid) meta.fieldId = String(fid);

  meta.cropPage = Number(meta.cropPage ?? 0) || 0;
  if (dir === "prev") meta.cropPage = Math.max(0, meta.cropPage - 1);
  else if (dir === "next") meta.cropPage = meta.cropPage + 1;

  meta.view = "PLAN_PICK";
  ensureSelectionVisible();
  return renderInPlace(meta.fieldId);
}

// Meadow optional skip (fertilize/lime)
if (id.startsWith("fd:skipopt:")) {
  const fid = id.split(":")[2];
  if (fid) meta.fieldId = String(fid);

  ensureNextForField(meta.fieldId);

  const active = getActiveTask(meta.fieldId) ?? getRunnableTaskForField(meta.fieldId);
  if (!active || active.status === "DONE") return interaction.deferUpdate();

  if (!(active.stageKey === "MEADOW_FERTILIZE" || active.stageKey === "MEADOW_LIME")) {
    return interaction.deferUpdate();
  }

  active.isRunning = false;
  active.status = "DONE";
  active.completedAt = nowISO();
  active.skipped = true;
  saveState();
  await refreshWorkflowPanel();

  logActivity(`<@${interaction.user.id}> preskočio opcionalni korak **${formatTaskId(active.id)}** (polje ${meta.fieldId}).`);
  advanceAfterDone(meta.fieldId, active);

  ensureNextForField(meta.fieldId, interaction.user?.id ?? null);
  meta.view = "MAIN";
  ensureSelectionVisible();
  return renderInPlace(meta.fieldId);
}
        // Crop selection
        if (id.startsWith("fd:crop:")) {
          const parts = id.split(":");
          const fid = parts[2];
          const pick = parts[3];

          // safety: update selection
          if (fid) meta.fieldId = String(fid);

          if (pick === "CLEAR") {
            const f = getField(meta.fieldId);
            f.plannedCrop = null;
            f.updatedAt = nowISO();
            saveState();
            meta.view = "MAIN";
            // if we're currently waiting for SEED_PICK, keep it waiting
            return renderInPlace(meta.fieldId);
          }

          const crop = CROPS.find((c) => c.key === resolveCropKey(pick));
          if (crop) {
            const f = getField(meta.fieldId);
            f.plannedCrop = crop.key;
            f.updatedAt = nowISO();
            saveState();

            // if we're at SEED_PICK stage, this will immediately create SEED task
            ensureNextForField(meta.fieldId, interaction.user?.id ?? null);

            meta.view = "MAIN";
            return renderInPlace(meta.fieldId);
          }

          return interaction.deferUpdate();
        }

        // Priority cycle
        if (id.startsWith("fd:priority:")) {
          const fid = id.split(":")[2];
          if (fid) meta.fieldId = String(fid);

          const active = getActiveTask(meta.fieldId);
          if (active) {
            const next = cyclePriority(active);
            saveState();
            logActivity(`<@${interaction.user.id}> promijenio prioritet **${formatTaskId(active.id)}** -> **${next}** (polje ${meta.fieldId}).`);
          }
          return renderInPlace(meta.fieldId);
        }

        // Tasks view toggle (task review)
        if (id.startsWith("fd:tasks:") && id.split(":").length === 3) {
          const fid = id.split(":")[2];
          if (fid) meta.fieldId = String(fid);

          meta.view = "TASKS";
          meta.tasksPage = 0;
          return renderInPlace(meta.fieldId);
        }

if (id.startsWith("fd:tasks:back:")) {
          const fid = id.split(":")[3];
          if (fid) meta.fieldId = String(fid);

          meta.view = "MAIN";
          return renderInPlace(meta.fieldId);
        }

        // Run/Pause toggle
        if (id.startsWith("fd:run:")) {
          const fid = id.split(":")[2];
          if (fid) meta.fieldId = String(fid);

          ensureNextForField(meta.fieldId);

          const runnable = getRunnableTaskForField(meta.fieldId);
          if (!runnable) return interaction.deferUpdate();

          if (runnable.stageKey === "TILLAGE_CHOICE" || runnable.stageKey === "SEED_PICK") {
            return interaction.deferUpdate();
          }

if (!runnable.isRunning) {
            activateTask(runnable, interaction.user?.id ?? null);
            const f = getField(meta.fieldId);
            if (f) f.activeTaskId = runnable.id;
            runnable.isRunning = true;
          } else {
            // Pause: remove from "active tasks" list by marking it as not running.
            // Keep it resumable by setting status back to OPEN.
            runnable.isRunning = false;
            if (runnable.status === "ACTIVE") runnable.status = "OPEN";
          }

          saveState();
          await refreshWorkflowPanel();
          meta.view = "MAIN";
          return renderInPlace(meta.fieldId);
        }

        // Notes modal
        if (id === "fd:notes") {
          const active = getActiveTask(meta.fieldId);
          if (!active) return interaction.deferUpdate();

          const modal = new ModalBuilder()
            .setCustomId(`fd:modal:notes:${meta.fieldId}:${active.id}`)
            .setTitle(`Bilješka – Polje ${meta.fieldId}`);

          const notesInput = new TextInputBuilder()
            .setCustomId("notes")
            .setLabel("Napomena")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(400)
            .setValue((active.notes ?? "").slice(0, 400));

          modal.addComponents(new ActionRowBuilder().addComponents(notesInput));
          return interaction.showModal(modal);
        }

        // Done
        if (id.startsWith("fd:done:")) {
          const fid = id.split(":")[2];
          if (fid) meta.fieldId = String(fid);

          ensureNextForField(meta.fieldId);

          const active = getActiveTask(meta.fieldId) ?? getRunnableTaskForField(meta.fieldId);
          if (!active || (active.status !== "ACTIVE" && active.status !== "OPEN")) {
            return interaction.deferUpdate();
          }

if (!active.isRunning) {
            return interaction.deferUpdate();
          }

if (active.stageKey === "TILLAGE_CHOICE" || active.stageKey === "SEED_PICK") {
            return interaction.deferUpdate();
          }

          active.isRunning = false;
          active.status = "DONE";
          active.completedAt = nowISO();
          saveState();
          await refreshWorkflowPanel();

          logActivity(`<@${interaction.user.id}> završio **${formatTaskId(active.id)}** (polje ${meta.fieldId}).`);
          const durMs = active.startedAt ? (Date.parse(active.completedAt) - Date.parse(active.startedAt)) : null;
          const durTxt = durMs !== null && Number.isFinite(durMs) ? formatDurationMs(durMs) : null;
          const nextK = nextStageKey(active.stageKey, meta.fieldId);
          const nextTxt = nextK ? `${STAGES[nextK]?.emoji ?? "➡️"} ${STAGES[nextK]?.label ?? nextK}` : "—";

          pushEvent({
            ts: Date.now(),
            type: "DONE",
            actorUserId: interaction.user.id,
            fieldId: String(meta.fieldId),
            taskId: active.id,
            stageKey: active.stageKey,
            priority: active.priority ?? "LOW",
            durationMs: durMs ?? null,
          });

          await sendToTaskHistory({
            content: [
              `✅ Polje **${meta.fieldId}** • **${formatTaskId(active.id)}** • ${STAGES[active.stageKey]?.emoji ?? ""} ${active.title ?? STAGES[active.stageKey]?.label ?? active.stageKey}`,
              `${durTxt ? `⏱ ${durTxt} • ` : ""}Završio: <@${interaction.user.id}> • Prioritet: **${String(active.priority || "LOW").toUpperCase()}**`,
              `Sljedeće: **${nextTxt}**${(nextK === "TILLAGE_CHOICE" || nextK === "SEED_PICK") ? " (odabir potreban)" : ""}`,
            ].join("\n"),
          });
advanceAfterDone(meta.fieldId, active);

          const nextTask = ensureNextForField(meta.fieldId, interaction.user?.id ?? null);

          // If the next step is a user choice, keep the field selected and show it immediately.
          if (nextTask && (nextTask.stageKey === "TILLAGE_CHOICE" || nextTask.stageKey === "SEED_PICK")) {
            meta.view = nextTask.stageKey === "SEED_PICK" ? "PLAN_PICK" : "MAIN";
            ensureSelectionVisible();
            return renderInPlace(meta.fieldId);
          }

          // Otherwise go back to the work list.
          meta.fieldId = null;
          meta.view = "LIST";
          return renderInPlace(null);

        }

        // Tillage choice
        if (id.startsWith("fd:tillage:")) {
          const choice = id.split(":")[2];

          // Close choice task if present
          const act = getActiveTask(meta.fieldId);
          if (act && act.stageKey === "TILLAGE_CHOICE" && act.status !== "DONE") {
            act.status = "DONE";
            act.completedAt = nowISO();
            saveState();
          }

if (choice === "PLOW") setFieldStage(meta.fieldId, "PLOW");
          else if (choice === "SUBSOIL") setFieldStage(meta.fieldId, "SUBSOIL");
          else setFieldStage(meta.fieldId, "CULTIVATE"); // SKIP -> go to cultivate

          const nextTask = ensureNextForField(meta.fieldId, interaction.user?.id ?? null);
          activateTask(nextTask, interaction.user?.id ?? null);

          meta.view = "MAIN";
          return renderInPlace(meta.fieldId);
        }

        return interaction.deferUpdate();
      }
    }

    // SELECT MENUS (planned seeding)
    
    // CHANNEL SELECT MENUS (Admin panel)
    if (interaction.isChannelSelectMenu()) {
      const id = interaction.customId;

      // Server stats panel
      if (id === "serverstats:refresh") {
        await interaction.deferUpdate();
        const ch = interaction.channel;
        if (ch && ch.isTextBased()) {
          await upsertPanel("serverstats", ch);
        }
        return;
      }

      // Verification (player) – quiz answer
      if (id.startsWith("verify:quiz:ans:")) {
        ensureConfig();
        const sec = state.config.security ?? {};

        const sess = runtime.verifyQuiz.sessions.get(interaction.user.id);
        if (!sess) {
          await interaction.reply({ ...eph(), content: "Nema aktivnog testa. Klikni **Započni provjeru**." });
          return;
        }

        const qid = id.split(":").pop();
        const qObj = REALISM_QUIZ_QUESTIONS.find((x) => x.id === qid);
        const picked = interaction.values?.[0] ?? null;
        const pickedIdx = picked !== null ? Number(picked) : NaN;

        if (!qObj || !Number.isFinite(pickedIdx)) {
          await interaction.reply({ ...eph(), content: "Greška: ne mogu obraditi odgovor." });
          return;
        }

        if (pickedIdx === qObj.correct) sess.score += 1;

        sess.index += 1;

        // Next question or finish
        if (sess.index < sess.qids.length) {
          runtime.verifyQuiz.sessions.set(interaction.user.id, sess);
          const payload = buildQuizQuestionPayload(
            interaction.user.id,
            interaction.guildId,
            sec.verificationChannelId,
            sec.verificationMessageId
          );
          await interaction.update(payload ?? { content: "Greška: ne mogu prikazati pitanje.", components: [], embeds: [] });
          return;
        }

        // Finish
        const score = sess.score;
        const pass = score >= 2;
        runtime.verifyQuiz.sessions.delete(interaction.user.id);

        const resultPayload = buildQuizResultPayload(
          pass,
          score,
          interaction.guildId,
          sec.verificationChannelId,
          sec.verificationMessageId
        );

        await interaction.update(resultPayload);

        if (pass) {
          try {
            await grantDefaultVerifiedRole(interaction.member);
          } catch {
            await interaction.followUp({ ...eph(), content: "Prošao si test, ali ne mogu dodijeliti rolu. Provjeri bot permisije i poziciju role." }).catch(() => {});
          }
        }
        return;
      }


      const channelId = interaction.values?.[0] ?? null;
      if (!channelId) {
        await interaction.deferUpdate();
        return;
      }

      // Admin-only selects
      if (!isAdmin(interaction.member)) {
        await interaction.reply({ ...eph(), content: "You do not have admin permissions." });
        return;
      }

      ensureConfig();

      // Panel deploy: remember selected channel for deploy action
      if (id === "admin:setup:selectchannel" || id === "admin:panels:selectchannel") {
        state.panels = state.panels ?? {};
        state.panels.admin = state.panels.admin ?? {};
        state.panels.admin.panelDeploy = state.panels.admin.panelDeploy ?? { panel: "details", channelId: state.config.detailsChannelId ?? null };
        state.panels.admin.panelDeploy.channelId = channelId;
        saveState();
        await interaction.deferUpdate();
        await upsertPanel("admin", interaction.channel);
        return;
      }

      if (id === "admin:backup:channel") {
        state.config.backupChannelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> set backup channel: <#${channelId}>.`);
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

if (id === "admin:ch:log" || id === "admin:setup:ch:log") {
  state.config.logChannelId = channelId;
  saveState();
  logActivity(`<@${interaction.user.id}> set log channel: <#${channelId}>.`);
  await interaction.deferUpdate();
  await refreshAllPanels();

  // Smoke-test so it's immediately obvious whether the bot can post there
  await sendToLog({ content: "✅ Log channel linked. (FarmBudy)" }).catch(() => null);
  await interaction.followUp({ ...eph(), content: `Log kanal testiran: <#${channelId}>.` }).catch(() => null);

  return;
}

      if (id === "admin:ch:detailsDefault" || id === "admin:setup:ch:detailsDefault") {
        state.config.detailsChannelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> set field details default channel: <#${channelId}>.`);
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

      if (id === "admin:ch:history" || id === "admin:setup:ch:history") {
        state.config.taskHistoryChannelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> set task history channel: <#${channelId}>.`);
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

      if (id === "admin:moderation:modlog") {
        state.config.modLogChannelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> set moderation log channel: <#${channelId}>.`);
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

      if (id === "admin:telemetry:serverstatsChannel") {
        state.panels = state.panels ?? {};
        state.panels.serverstats = state.panels.serverstats ?? {};
        state.panels.serverstats.channelId = channelId;
        // Do not force-repost on select; deploy button controls messageId.
        saveState();
        logActivity(`<@${interaction.user.id}> set ServerStats channel: <#${channelId}>.`);
        await interaction.deferUpdate();
        await upsertPanel("admin", interaction.channel);
        return;
      }

      if (id === "admin:onboarding:welcome:channel") {
        state.config.welcome = state.config.welcome ?? { enabled: false, channelId: null, message: "" };
        state.config.welcome.channelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> set welcome channel: <#${channelId}>.`);
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

      if (id === "admin:onboarding:goodbye:channel") {
        state.config.goodbye = state.config.goodbye ?? { enabled: false, channelId: null, message: "" };
        state.config.goodbye.channelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> set goodbye channel: <#${channelId}>.`);
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

      if (id === "admin:onboarding:verify:channel") {
        state.config.security = state.config.security ?? {};
        state.config.security.verificationChannelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> set verification channel: <#${channelId}>.`);
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

      if (id === "admin:setup:titlechannel") {
        state.panels = state.panels ?? {};
        state.panels.admin = state.panels.admin ?? {};
        state.panels.admin.panelTitle = state.panels.admin.panelTitle ?? { channelId: null };
        state.panels.admin.panelTitle.channelId = channelId;

        // Treat this as the active details/default channel so title changes affect the intended panel.
        state.config.detailsChannelId = channelId;
        // Keep deploy selection consistent
        state.panels.admin.panelDeploy = state.panels.admin.panelDeploy ?? { panel: "details", channelId: null };
        state.panels.admin.panelDeploy.channelId = channelId;

        saveState();
        await interaction.deferUpdate();
        await upsertPanel("admin", interaction.channel);
        return;
      }
      // Unknown select – just acknowledge
      await interaction.deferUpdate();
      return;
    }


    // USER SELECT MENUS (Fleet owner assignment)
    if (interaction.isUserSelectMenu()) {
      const id = interaction.customId;
      if (id === "fleet:ownerPick") {
        state.panels = state.panels ?? {};
        state.panels.fleet = state.panels.fleet ?? {};
        const userId = interaction.values?.[0] ? String(interaction.values[0]) : null;
        state.panels.fleet.selectedOwnerId = userId;
        saveState();

        await interaction.deferUpdate();
        const ch = interaction.channel;
        if (ch && ch.isTextBased()) await upsertPanel("fleet", ch);
        return;
      }

      await interaction.deferUpdate();
      return;
    }

if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      if (id === "fleet:select") {
	        const raw = interaction.values?.[0];
	        // Values may be suffixed with "::N" to keep select option values unique.
	        const valueRaw = raw && raw !== "none" ? String(raw) : null;
	        const value = valueRaw ? valueRaw.split("::")[0] : null;
        state.panels = state.panels ?? {};
        state.panels.fleet = state.panels.fleet ?? {};
        state.panels.fleet.selectedVehicleId = value ? String(value) : null;
        saveState();
        await interaction.deferUpdate();
        const ch = interaction.channel;
        if (ch && ch.isTextBased()) await upsertPanel("fleet", ch);
        return;
      }


      // Server stats panel
      if (id === "serverstats:refresh") {
        await interaction.deferUpdate();
        const ch = interaction.channel;
        if (ch && ch.isTextBased()) {
          await upsertPanel("serverstats", ch);
        }
        return;
      }

      // Workflow: pick a running task to finish
      if (id === "wf:donepick") {
        const value = interaction.values?.[0];
        state.panels = state.panels ?? {};
        state.panels.workflow = state.panels.workflow ?? {};
        state.panels.workflow.selectedTaskId = value && value !== "none" ? String(value) : null;
        saveState();
        await interaction.deferUpdate();
        await refreshAllPanels();
        return;
      }

      if (id === "admin:setup:section") {
  if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

  const value = interaction.values?.[0];
  if (!value) {
    await interaction.deferUpdate();
    return;
  }

  state.panels = state.panels ?? {};
  state.panels.admin = state.panels.admin ?? {};
  state.panels.admin.setup = state.panels.admin.setup ?? { section: "DEPLOY" };
  state.panels.admin.setup.section = value;
  saveState();

  await interaction.deferUpdate();
  await upsertPanel("admin", interaction.channel);
  return;
}

if (id === "admin:setup:selectpanel") {
  if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

  const value = interaction.values?.[0];
  if (!value) {
    await interaction.deferUpdate();
    return;
  }

  state.panels = state.panels ?? {};
  state.panels.admin = state.panels.admin ?? {};
  state.panels.admin.panelDeploy = state.panels.admin.panelDeploy ?? { panel: "details", channelId: state.config.detailsChannelId ?? null };
  state.panels.admin.panelDeploy.panel = value;
  saveState();

  await interaction.deferUpdate();
  await upsertPanel("admin", interaction.channel);
  return;
}

if (id === "admin:panels:selectpanel") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

        const value = interaction.values?.[0];
        if (!value) {
          await interaction.deferUpdate();
          return;
        }

        state.panels = state.panels ?? {};
        state.panels.admin = state.panels.admin ?? {};
        state.panels.admin.panelDeploy = state.panels.admin.panelDeploy ?? { panel: "details", channelId: state.config.detailsChannelId ?? null };
        state.panels.admin.panelDeploy.panel = value;
        saveState();

        await interaction.deferUpdate();
        await upsertPanel("admin", interaction.channel);
        return;
      }

      // Admin: Onboarding section select
      if (id === "admin:onboarding:section") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        const value = interaction.values?.[0];
        if (!value) { await interaction.deferUpdate(); return; }
        state.panels = state.panels ?? {};
        state.panels.admin = state.panels.admin ?? {};
        state.panels.admin.onboarding = state.panels.admin.onboarding ?? { section: "WELCOME" };
        state.panels.admin.onboarding.section = value;
        saveState();
        await interaction.deferUpdate();
        await upsertPanel("admin", interaction.channel);
        return;
      }

      // Admin: Security section select
      if (id === "admin:security:section") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        const value = interaction.values?.[0];
        if (!value) { await interaction.deferUpdate(); return; }
        state.panels = state.panels ?? {};
        state.panels.admin = state.panels.admin ?? {};
        state.panels.admin.security = state.panels.admin.security ?? { section: "ANTISCAM" };
        state.panels.admin.security.section = value;
        saveState();
        await interaction.deferUpdate();
        await upsertPanel("admin", interaction.channel);
        return;
      }

if (id.startsWith("fd:planselect:")) {
        const fieldId = id.split(":")[2];
        const value = interaction.values[0];

        const f = getField(fieldId);
        if (value === "CLEAR") {
          f.plannedCrop = null;
          saveState();
          logActivity(`<@${interaction.user.id}> očistio plan sjetve (polje ${fieldId}).`);
          await interaction.update({ ...eph(), content: "Plan sjetve je obrisan.", components: [] });
          await updateDetailsPanel(fieldId, interaction.channel);
          await refreshAllPanels();
          return;
        }

        const crop = CROPS.find((c) => c.key === resolveCropKey(value));
        if (!crop) return interaction.reply({ ...eph(), content: "Nepoznata kultura." });

        f.plannedCrop = value;
        saveState();
        logActivity(`<@${interaction.user.id}> postavio plan sjetve: **${crop.label}** (polje ${fieldId}).`);
        await interaction.update({ ...eph(), content: `Plan sjetve postavljen: ${crop.emoji} **${crop.label}**`, components: [] });

        // If we are already on SEED_PICK, apply immediately
        applyPlannedSeedingIfReady(fieldId, interaction.user.id);

        await updateDetailsPanel(fieldId, interaction.channel);
        await refreshAllPanels();
        return;
      }
    }

    // MODALS
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;

      // Server stats panel
      if (id === "serverstats:refresh") {
        await interaction.deferUpdate();
        const ch = interaction.channel;
        if (ch && ch.isTextBased()) {
          await upsertPanel("serverstats", ch);
        }
        return;
      }

      // Verification (player)

      // Onboarding / Security modals
      if (id === "admin:modal:welcomeMessage") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        state.config.welcome = state.config.welcome ?? {};
        state.config.welcome.message = interaction.fields.getTextInputValue("msg");
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Welcome tekst spremljen." });
      }

      if (id === "admin:modal:goodbyeMessage") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        state.config.goodbye = state.config.goodbye ?? {};
        state.config.goodbye.message = interaction.fields.getTextInputValue("msg");
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Goodbye tekst spremljen." });
      }

      // Telemetry config modals
      if (id === "admin:modal:telemetryBaseUrl") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        ensureConfig();
        const raw = String(interaction.fields.getTextInputValue("url") ?? "").trim();
        // Basic sanity: require https:// and strip trailing slash
        const url = raw.replace(/\/+$/, "");
        if (!/^https:\/\//i.test(url)) return interaction.reply({ ...eph(), content: "Base URL mora početi s https://" });
        state.config.telemetryBaseUrl = url;
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: `Telemetry Base URL spremljen: \`${url}\`` });
      }

      if (id === "admin:modal:telemetrySecret") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        ensureConfig();
        const secret = String(interaction.fields.getTextInputValue("secret") ?? "").trim();
        if (secret.length < 6) return interaction.reply({ ...eph(), content: "Secret je prekratak." });
        state.config.telemetrySecret = secret;
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Telemetry secret spremljen u state (ako env nije postavljen, ovaj će se koristiti)." });
      }

      if (id === "admin:modal:roles") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        const q = String(interaction.fields.getTextInputValue("quarantine") ?? "").trim();
        const m = String(interaction.fields.getTextInputValue("member") ?? "").trim();
        state.config.security = state.config.security ?? {};
        state.config.security.quarantineRoleId = q || null;
        state.config.security.memberRoleId = m || null;
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Role postavke spremljene." });
      }

      if (id === "admin:modal:perms") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

        ensureConfig();
        state.config.perms = state.config.perms ?? {};

        const owners = parseIdList(interaction.fields.getTextInputValue("owners"));
        const coOwners = parseIdList(interaction.fields.getTextInputValue("coOwners"));
        const adminUsers = parseIdList(interaction.fields.getTextInputValue("adminUsers"));
        const adminRoles = parseIdList(interaction.fields.getTextInputValue("adminRoles"));
        const modRoles = parseIdList(interaction.fields.getTextInputValue("modRoles"));

        state.config.perms.owners = owners;
        state.config.perms.coOwners = coOwners;
        state.config.perms.adminUsers = adminUsers;
        state.config.perms.adminRoles = adminRoles;
        state.config.perms.modRoles = modRoles;

        saveState();
        await refreshAllPanels();

        return interaction.reply({
          ...eph(),
          content: `Spremljeno. Owners: **${owners.length}**, Co-owners: **${coOwners.length}**, Admin users: **${adminUsers.length}**, Admin roles: **${adminRoles.length}**, Mod roles: **${modRoles.length}**.`,
        });
      }

      if (id === "admin:modal:minage") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        const raw = String(interaction.fields.getTextInputValue("days") ?? "0").trim();
        const days = Number(raw);
        state.config.security = state.config.security ?? {};
        state.config.security.minAccountAgeDays = Number.isFinite(days) ? Math.max(0, Math.min(3650, days)) : 0;
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Min account age spremljen." });
      }

      if (id === "admin:modal:antiscamTimeout") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        state.config.security = state.config.security ?? {};
        state.config.security.antiScam = state.config.security.antiScam ?? {};
        const raw = String(interaction.fields.getTextInputValue("minutes") ?? "10").trim();
        const minutes = Number(raw);
        state.config.security.antiScam.timeoutMinutes = Number.isFinite(minutes) ? Math.max(0, Math.min(1440, minutes)) : 10;
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Anti-scam timeout spremljen." });
      }

      if (id === "admin:modal:antiscamKeywords") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        state.config.security = state.config.security ?? {};
        state.config.security.antiScam = state.config.security.antiScam ?? {};
        const raw = String(interaction.fields.getTextInputValue("keywords") ?? "");
        const keywords = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
        state.config.security.antiScam.keywords = keywords;
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Keywords spremljeni." });
      }

      if (id === "admin:modal:antiraidThreshold") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        state.config.security = state.config.security ?? {};
        state.config.security.antiRaid = state.config.security.antiRaid ?? {};
        const windowSec = Number(String(interaction.fields.getTextInputValue("windowSec") ?? "30").trim());
        const maxJoins = Number(String(interaction.fields.getTextInputValue("maxJoins") ?? "5").trim());
        state.config.security.antiRaid.windowSec = Number.isFinite(windowSec) ? Math.max(5, Math.min(600, windowSec)) : 30;
        state.config.security.antiRaid.maxJoins = Number.isFinite(maxJoins) ? Math.max(2, Math.min(50, maxJoins)) : 5;
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Anti-raid prag spremljen." });
      }

      if (id === "admin:modal:antiraidLockdown") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        state.config.security = state.config.security ?? {};
        state.config.security.antiRaid = state.config.security.antiRaid ?? {};
        const minutes = Number(String(interaction.fields.getTextInputValue("minutes") ?? "10").trim());
        state.config.security.antiRaid.lockdownMinutes = Number.isFinite(minutes) ? Math.max(1, Math.min(180, minutes)) : 10;
        saveState();
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: "Lockdown spremljen." });
      }

      if (id === "admin:modal:setlog") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        const channelId = parseChannelId(interaction.fields.getTextInputValue("channel"));
        if (!channelId) return interaction.reply({ ...eph(), content: "Ne mogu parsati kanal. Upiši #mention ili ID." });

        state.config.logChannelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> postavio log kanal: <#${channelId}>.`);
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: `Log kanal postavljen na <#${channelId}>.` });
      }

if (id === "admin:modal:setdetailsch") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        const channelId = parseChannelId(interaction.fields.getTextInputValue("channel"));
        if (!channelId) return interaction.reply({ ...eph(), content: "Ne mogu parsati kanal. Upiši #mention ili ID." });

        state.config.detailsChannelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> postavio default details kanal: <#${channelId}>.`);
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: `Details default kanal postavljen na <#${channelId}>.` });
      }

if (id === "admin:modal:sethistorych") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        const channelId = parseChannelId(interaction.fields.getTextInputValue("channel"));
        if (!channelId) return interaction.reply({ ...eph(), content: "Ne mogu parsati kanal. Upiši #mention ili ID." });

        state.config.taskHistoryChannelId = channelId;
        saveState();
        logActivity(`<@${interaction.user.id}> postavio task history kanal: <#${channelId}>.`);
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: `Task history kanal postavljen na <#${channelId}>.` });
      }

if (id === "admin:modal:colors") {
        const a = interaction.fields.getTextInputValue("color_admin");
        const w = interaction.fields.getTextInputValue("color_workflow");
        const f = interaction.fields.getTextInputValue("color_fieldDetails");
        const act = interaction.fields.getTextInputValue("color_activity");

        state.config.embedColors = state.config.embedColors ?? {};
        state.config.embedColors.admin = parseHexColor(a, state.config.embedColors.admin ?? 0x5865F2);
        state.config.embedColors.workflow = parseHexColor(w, state.config.embedColors.workflow ?? 0x22aa22);
        state.config.embedColors.fieldDetails = parseHexColor(f, state.config.embedColors.fieldDetails ?? 0x22aa22);
        state.config.embedColors.activity = parseHexColor(act, state.config.embedColors.activity ?? 0x22aa22);

        saveState();
        await updateAllPanels(client);

        await interaction.reply({
          ...eph(),
          content: `Spremljeno. Admin: #${state.config.embedColors.admin.toString(16).padStart(6, "0")}, Workflow: #${state.config.embedColors.workflow.toString(16).padStart(6, "0")}, Detalji: #${state.config.embedColors.fieldDetails.toString(16).padStart(6, "0")}, Activity: #${state.config.embedColors.activity.toString(16).padStart(6, "0")}.`,
        });
        return;
      }

if (id.startsWith("admin:modal:deploy:")) {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

        const type = id.split(":")[3];
        const channelId = parseChannelId(interaction.fields.getTextInputValue("channel"));
        if (!channelId) return interaction.reply({ ...eph(), content: "Ne mogu parsati kanal. Upiši #mention ili ID." });

        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased()) return interaction.reply({ ...eph(), content: "Kanal nije valjan ili nije text channel." });

        const guild = interaction.guild;
        const me = guild?.members?.me ?? (await guild.members.fetchMe());
        if (!hasChannelSendPerms(ch, me)) return interaction.reply({ ...eph(), content: "Nemam permission za taj kanal (View/Send/Embed Links)." });

        await upsertPanel(type, ch);
        logActivity(`<@${interaction.user.id}> deployao panel **${type}** u <#${channelId}>.`);
        await refreshAllPanels();
        return interaction.reply({ ...eph(), content: `Deploy OK: **${type}** -> <#${channelId}>.` });
      }

if (id.startsWith("admin:modal:fields:")) {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });

        const action = id.split(":")[3];
        const ids = parseIds(interaction.fields.getTextInputValue("ids"));
        if (!ids.length) return interaction.reply({ ...eph(), content: "Nema validnih ID-eva." });

        if (action === "add") {
          const set = new Set(getFieldList());
          for (const n of ids) set.add(n);
          state.config.fields = [...set].sort((a, b) => a - b);
          saveState();
          logActivity(`<@${interaction.user.id}> dodao polja: ${ids.join(", ")}.`);
          await refreshAllPanels();
          await interaction.deferReply(eph());
          await ackAndDelete(interaction, `Added: ${ids.join(", ")}`);
          return;
        }

if (action === "remove") {
          const remove = new Set(ids);
          state.config.fields = getFieldList().filter((n) => !remove.has(n));
          saveState();
          logActivity(`<@${interaction.user.id}> maknuo polja: ${ids.join(", ")}.`);
          await refreshAllPanels();
          await interaction.deferReply(eph());
          await ackAndDelete(interaction, `Removed: ${ids.join(", ")}`);
          return;
        }
      }

if (id === "fd:modal:jump") {
        const raw = (interaction.fields.getTextInputValue("fieldNumber") ?? "").trim();
        const n = Number(raw.replace(/[^0-9]/g, ""));
        if (!Number.isFinite(n) || n <= 0) {
          return interaction.reply({ ...eph(), content: "Upiši valjani broj polja (npr. 2 ili 15)." });
        }

        // auto-add field if missing (practical default)
        state.config = state.config ?? {};
        state.config.fields = state.config.fields ?? [];
        if (!state.config.fields.includes(n)) state.config.fields.push(n);
        ensureConfig();

        state.panels = state.panels ?? {};
        state.panels.details = state.panels.details ?? {};
        const meta = state.panels.details;
        meta.fieldId = String(n);
        meta.view = "MAIN";

        // Ensure the field page selector shows the chosen field
        const list = getFieldList();
        const idx = list.findIndex((x) => String(x) === String(n));
        meta.page = idx >= 0 ? Math.floor(idx / 3) : 0;

        saveState();

        // silent confirmation (avoid popups)
        await interaction.deferReply(eph());
        await upsertPanel("details", interaction.channel, state.config?.fieldsPanelTitle ?? null);
        await interaction.deleteReply().catch(() => {});
        return;
      }

if (id === "admin:modal:paneltitle") {
        if (!isAdmin(interaction.member)) return interaction.reply({ ...eph(), content: "Nemaš admin ovlasti." });
        const title = (interaction.fields.getTextInputValue("title") ?? "").trim().slice(0, 60);
        if (!title) return interaction.reply({ ...eph(), content: "Naslov ne smije biti prazan." });

        ensureConfig();
        state.config.fieldsPanelTitle = title;
        saveState();

        await interaction.reply({ ...eph(), content: `Spremljeno. Novi naziv panela: **${title}**` });
        // If admin selected a specific channel for the field panel title, refresh the Details panel there
        try {
          const targetChId = state.panels?.admin?.panelTitle?.channelId ?? null;
          if (targetChId) {
            state.config.detailsChannelId = targetChId;
            saveState();
            const ch = await client.channels.fetch(targetChId).catch(() => null);
            if (ch && ch.isTextBased()) await upsertPanel("details", ch);
          }
        } catch {}

        await refreshAllPanels();
        return;
      }

if (id.startsWith("fd:modal:notes:")) {
        const parts = id.split(":");
        const fieldId = parts[3];
        const taskId = parts[4];

        const task = state.tasks?.[taskId];
        if (!task) return interaction.reply({ ...eph(), content: "Task više ne postoji." });

        task.notes = (interaction.fields.getTextInputValue("notes") ?? "").slice(0, 400);
        saveState();
        logActivity(`<@${interaction.user.id}> ažurirao napomenu za **${task.id}** (polje ${fieldId}).`);

        await interaction.reply({ ...eph(), content: "Spremljeno." });
        await updateDetailsPanel(fieldId, interaction.channel);
        await refreshAllPanels();
        return;
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ ...eph(), content: "Bot error (check logs)." });
      }
    } catch {}
  }

});

///////////////////////////////////////////////////////////////////////////////////////////////////
// READY
///////////////////////////////////////////////////////////////////////////////////////////////////

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
// Ensure log channel exists early (best-effort). If bot lacks Manage Channels, bind it manually in Admin → Kanali.
try {
  const guild = await client.guilds.fetch(ENV.guildId).catch(() => null);
  if (guild) {
    const logCh = await ensureLogChannel(guild).catch(() => null);
    if (logCh && logCh.isTextBased()) {
      await logCh.send({ content: "✅ FarmBudy online. Logging is active." }).catch(() => null);
    }
  }
} catch (e) {
  console.warn("[logs] Log channel init failed.", e);
}


  try {
    await registerSlashCommands();
  } catch (e) {
    console.error("Slash register error:", e);
  }

  // Refresh panels on boot (non-destructive)
  try {
    await refreshAllPanels();
  } catch {}

  // FS25 telemetry HTTP server (optional)
  try {
    telemetryServer = startTelemetryHttpServer();
  } catch {}
  // FS25 telemetry FTP ingest (optional)
  try {
    telemetryFtpTimer = startTelemetryFtpIngest();
  } catch {}

  // Low-noise daily summary (03:00 Zagreb window)
  try {
    startDailySummaryLoop();
  } catch {}

  // Scheduled backups (every 12h) to backup channel (or fallback log/history)
  try {
    startBackupLoop();
  } catch (err) {
    console.error('[interaction] handler error:', err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ flags: 64, content: 'Dogodila se greška pri obradi interakcije. Pogledaj Railway log.' }).catch(() => null);
      }
    } catch {}
  }
});

process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

client.login(ENV.token);