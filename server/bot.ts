import { 
  Client, 
  GatewayIntentBits, 
  Partials,
  SlashCommandBuilder, 
  EmbedBuilder,
  AttachmentBuilder,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  AuditLogEvent,
  PermissionFlagsBits,
  OverwriteType,
  ButtonStyle
} from 'discord.js';
import { Player, useMainPlayer, useQueue, QueueRepeatMode, Track, QueryType } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { YoutubeiExtractor } from 'discord-player-youtubei';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection } from '@discordjs/voice';
import ffmpegStatic from 'ffmpeg-static';
import { storage } from './storage';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { syncService } from './sync';
import { uploadInboxJson, uploadInboxXml, uploadPosloviInboxXml } from './ftpCommands';
import { Readable, PassThrough } from 'stream';
import { getWebStatsSummaryFromEnv } from './webstats';
import { getSyncStatus } from './syncStatus';
import { getPlayerHoursLeaderboard, formatHours, updatePlayerHoursFromPresenceSnapshot } from './playerHours';
import { getActiveServer } from './serverConfig';
import { getWhitelist, addToWhitelist, removeFromWhitelist } from './whitelist';
import { getPlayerHoursLeaderboard as getLeaderboardForAutoRole } from './playerHours';
import * as fs from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';

// ====== Unicode normalization helper (small caps, bold math, decorative → plain ASCII) ======
function normalizeUnicode(str: string): string {
  // Small caps → lowercase
  const smallCaps: Record<string, string> = {
    'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i',
    'ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ʀ':'r','ꜱ':'s',
    'ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','ʏ':'y','ᴢ':'z',
    'ɩ':'i','ǫ':'o','ɶ':'oe',  // extra Unicode variants
  };
  let result = '';
  for (const ch of str) {
    if (smallCaps[ch]) { result += smallCaps[ch]; continue; }
    const cp = ch.codePointAt(0)!;
    // Mathematical bold sans-serif capitals A-Z: U+1D5D4 to U+1D5ED
    if (cp >= 0x1D5D4 && cp <= 0x1D5ED) { result += String.fromCharCode(65 + cp - 0x1D5D4); continue; }
    // Mathematical bold sans-serif small a-z: U+1D5EE to U+1D607
    if (cp >= 0x1D5EE && cp <= 0x1D607) { result += String.fromCharCode(97 + cp - 0x1D5EE); continue; }
    // Mathematical bold capitals A-Z: U+1D400 to U+1D419
    if (cp >= 0x1D400 && cp <= 0x1D419) { result += String.fromCharCode(65 + cp - 0x1D400); continue; }
    // Mathematical bold small a-z: U+1D41A to U+1D433
    if (cp >= 0x1D41A && cp <= 0x1D433) { result += String.fromCharCode(97 + cp - 0x1D41A); continue; }
    result += ch;
  }
  return result;
}

/** Strip emoji, separators, decorative chars, normalize small caps → plain lowercase */
function plainName(name: string): string {
  // Split on ┃ and take the second part if present
  const parts = name.split('┃');
  const base = (parts.length > 1 ? parts[1] : parts[0]).trim();
  return normalizeUnicode(base)
    .replace(/[─—]/g, ' ')
    .replace(/[^\w\s\u0161\u010D\u0107\u017E\u0111\u0160\u010C\u0106\u017D\u0110-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// ====== Server Setup Definitions ======

const PLAYTIME_ROLES = [
  { name: '🌱 Sjeme',          hours: 10,  color: 0x7aba57 },
  { name: '🌿 Sadnica',        hours: 25,  color: 0x2ecc71 },
  { name: '🌾 Žetelac',        hours: 50,  color: 0xf1c40f },
  { name: '🚜 Farmer',         hours: 100, color: 0xe67e22 },
  { name: '⭐ Agronom',        hours: 250, color: 0xe91e63 },
  { name: '🏆 Zemljoposjednik', hours: 500, color: 0xffd700 },
];

// Roles that must NEVER be edited or deleted (owner-managed)
const PROTECTED_ROLE_IDS = new Set([
  '470617050482737165', // Gazda
  '994960078128029698', // Suvlasnik
]);

const STAFF_ROLES = [
  { name: '👑 Gazda',          color: 0xe8c41a, permissions: PermissionFlagsBits.Administrator, hoist: true },
  { name: '🏡 Suvlasnik',     color: 0xe67e22, permissions: PermissionFlagsBits.Administrator, hoist: true },
  { name: '🚜 Upravitelj',     color: 0xe74c3c, permissions: PermissionFlagsBits.Administrator, hoist: true },
  { name: '⚙️ Nadzornik',     color: 0x3498db, permissions: PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ManageGuild, hoist: true },
  { name: '🌿 Čuvar',          color: 0x2ecc71, permissions: PermissionFlagsBits.KickMembers | PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.MuteMembers, hoist: true },
];

const SPECIAL_ROLES = [
  { name: '🌾 Ratar',          color: 0x9b59b6, hoist: true },
  { name: '🏘️ Mještanin',    color: 0x95a5a6 },
  { name: ' NotifyMe',      color: 0xf1c40f, mentionable: true },
  { name: '‼️ BLACKLIST',     color: 0x1a1a1a },
  { name: '🚫 Unverified',    color: 0x546e7a },
];

interface ChannelDef {
  name: string;
  type: 'text' | 'voice' | 'forum';
  readOnly?: boolean;        // only bot/admin can write
  staffOnly?: boolean;       // only admin+ can see
  playerOnly?: boolean;      // need Player role
  farmOnly?: boolean;        // per-farm channel (visible only to that farm's role)
  freeWrite?: boolean;       // everyone can write (ZAJEDNICA channels)
  autoEmbed?: {              // auto-post embed with button on setup
    title: string;
    description: string;
    color: number;
    buttonLabel: string;
    buttonEmoji?: string;
    buttonUrlEnv?: string;   // env var name for the URL
    buttonUrl?: string;      // direct URL (takes priority over buttonUrlEnv)
    buttonStyle: 'link';
    thumbnail?: string;      // env var name for thumbnail
  };
}

interface CategoryDef {
  name: string;
  channels: ChannelDef[];
}

// Farm role prefix — dynamic roles created as "🌾 Farma 1", "🌾 Farma 2" etc.
const FARM_ROLE_PREFIX = '🌾 ';
const FARM_ROLE_COLORS = [0x2ecc71, 0x3498db, 0xe67e22, 0x9b59b6, 0xe91e63, 0x1abc9c, 0xf1c40f, 0xe74c3c];

// ====== Coop Market — Fallback Prices (used until sellingPrices.xml arrives from game) ======
const COOP_FALLBACK_PRICES: Record<string, number> = {
  WHEAT: 0.42, BARLEY: 0.38, OAT: 0.40, CANOLA: 0.72, CORN: 0.36,
  SOYBEAN: 0.55, SUNFLOWER: 0.95, SUGARBEET: 0.12, POTATO: 0.18,
  COTTON: 1.20, GRASS_WINDROW: 0.05, STRAW: 0.08, SILAGE: 0.15,
  CHAFF: 0.06, WOOD: 0.25, WOODCHIPS: 0.10, MILK: 0.45,
  WOOL: 1.10, EGG: 0.80, HONEY: 1.50, GRAPE: 0.65,
  OLIVE: 0.70, RICE: 0.50, SORGHUM: 0.35, POPLAR: 0.20,
};
const COOP_FILL_NAMES: Record<string, string> = {
  WHEAT: 'Pšenica', BARLEY: 'Ječam', OAT: 'Zob', CANOLA: 'Uljana repica', CORN: 'Kukuruz',
  SOYBEAN: 'Soja', SUNFLOWER: 'Suncokret', SUGARBEET: 'Šeć. repa', POTATO: 'Krumpir',
  COTTON: 'Pamuk', GRASS_WINDROW: 'Trava', STRAW: 'Slama', SILAGE: 'Silaža',
  CHAFF: 'Pljeva', WOOD: 'Drvo', WOODCHIPS: 'Sječka', MILK: 'Mlijeko',
  WOOL: 'Vuna', EGG: 'Jaja', HONEY: 'Med', GRAPE: 'Grožđe',
  OLIVE: 'Masline', RICE: 'Riža', SORGHUM: 'Sirak', POPLAR: 'Topola',
  LIME: 'Vapno', SEEDS: 'Sjeme', LIQUIDFERTILIZER: 'Tekuće gnojivo',
  FERTILIZER: 'Gnojivo', HERBICIDE: 'Herbicid', DIESEL: 'Dizel', WATER: 'Voda',
};
const COOP_SUPPLY_SATURATION = 200000; // supply degradation denominator
const COOP_MIN_PRICE_FACTOR = 0.7;     // price never drops below 70% of coop price
const COOP_BASE_MULTIPLIER = 1.15;     // 15% above best game selling point
const COOP_GREAT_DEMAND_MULTIPLIER = 1.05; // only 5% above if great demand already active

// In-memory cache for real game prices (updated from sellingPrices.xml via sync)
interface GamePriceEntry { basePrice: number; bestPrice: number; bestStation: string; greatDemand: boolean; }
const gamePricesCache: Map<string, GamePriceEntry> = new Map();

// Unicode Small Caps mapping for fancy channel/category names
const SMALL_CAPS: Record<string, string> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ',
  j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ',
  s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
  'č': 'č', 'ć': 'ć', 'đ': 'đ', 'š': 'š', 'ž': 'ž',
};

function progressBar(percent: number, length = 8): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * length);
  const empty = length - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function toSmallCaps(text: string): string {
  return text.split('').map(c => SMALL_CAPS[c.toLowerCase()] ?? c).join('');
}

// Unicode Bold (Mathematical Sans-Serif Bold)
function toBold(text: string): string {
  return text.split('').map(c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65)); // A-Z
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97)); // a-z
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48)); // 0-9
    return c;
  }).join('');
}

// Unicode Bold Italic (Mathematical Sans-Serif Bold Italic)
function toBoldItalic(text: string): string {
  return text.split('').map(c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D63C + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D656 + (code - 97));
    return c;
  }).join('');
}

// Find a farm's Discord category channel with robust fallback logic
function findFarmCategory(guild: any, farmName: string): any | null {
  const farmCatName = `── 🏡 ${toBold(farmName.toUpperCase())} ──`;
  const farmNameBold = toBold(farmName.toUpperCase());
  const farmNameSmall = toSmallCaps(farmName.toUpperCase());
  const farmCatPlain = plainName(farmCatName);

  // 1. Exact category name match
  let cat = guild.channels.cache.find((c: any) => c.type === 4 && c.name === farmCatName);
  if (cat) return cat;

  // 2. Includes bold or smallcaps + 🏡
  cat = guild.channels.cache.find((c: any) =>
    c.type === 4 && (c.name.includes(farmNameBold) || c.name.includes(farmNameSmall)) && c.name.includes('🏡')
  );
  if (cat) return cat;

  // 3. Normalized plainName match
  cat = guild.channels.cache.find((c: any) => c.type === 4 && plainName(c.name) === farmCatPlain);
  if (cat) return cat;

  // 4. Partial plainName match (farm name inside category name)
  cat = guild.channels.cache.find((c: any) => c.type === 4 && plainName(c.name).includes(plainName(farmNameBold)));
  if (cat) return cat;

  // 5. Fallback: category with 🏡 that has farm-specific child channels
  const farmChannelNames = FARM_CATEGORY_CHANNELS.map(ch => plainName(ch.name));
  cat = guild.channels.cache.find((c: any) => {
    if (c.type !== 4) return false;
    if (!c.name.includes('🏡')) return false;
    const children = guild.channels.cache.filter((ch: any) => ch.parentId === c.id);
    return children.some((ch: any) => farmChannelNames.includes(plainName(ch.name)));
  });
  return cat || null;
}

// Find a text channel by name (small caps)
function findChannelByName(guild: any, partialName: string) {
  // Try exact name match first (small caps)
  const exact = guild.channels.cache.find((c: any) => c.type === 0 && c.name === partialName);
  if (exact) return exact;
  // Fuzzy: normalize both sides via plainName — strict equality only
  if (partialName) {
    const target = plainName(partialName);
    if (target) {
      return guild.channels.cache.find((c: any) => {
        if (c.type !== 0) return false;
        const cp = plainName(c.name);
        return cp === target;
      }) || null;
    }
  }
  return null;
}

// Build logo URL from WEB_URL env
function getLogoUrl() {
  const webBase = process.env.WEB_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '';
  if (!webBase) return undefined;
  const base = webBase.startsWith('http') ? webBase : `https://${webBase}`;
  return `${base}/logo.png`;
}

// Resolve autoEmbed button URL with fallbacks
function resolveAutoEmbedUrl(envName: string): string | undefined {
  const direct = process.env[envName];
  if (direct) return direct;
  // If WEB_URL was requested, fall back to RAILWAY_PUBLIC_DOMAIN
  if (envName === 'WEB_URL') {
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (domain) return domain.startsWith('http') ? domain : `https://${domain}`;
  }
  return undefined;
}

// ─── Ticket System Configuration ────────────────────────────────────────
const TICKET_TYPES = [
  { id: 'bug',       label: 'Bug Report',        emoji: '🐛', priority: 'srednji' as const, color: 0xf59e0b, description: 'Prijavi bug ili grešku na serveru' },
  { id: 'prijava',   label: 'Prijava Igrača',     emoji: '👤', priority: 'visoki'  as const, color: 0xef4444, description: 'Prijavi igrača koji krši pravila' },
  { id: 'ban',       label: 'Ban Appeal',         emoji: '🔓', priority: 'visoki'  as const, color: 0xef4444, description: 'Žalba na ban — obrazloži situaciju' },
  { id: 'tech',      label: 'Tehnički Problem',   emoji: '🔧', priority: 'srednji' as const, color: 0x3b82f6, description: 'Problem s launcherom, modovima, povezivanjem' },
  { id: 'prijedlog', label: 'Prijedlog',           emoji: '📋', priority: 'niski'   as const, color: 0x22c55e, description: 'Predloži poboljšanje za server' },
  { id: 'ostalo',    label: 'Ostalo',              emoji: '❓', priority: 'niski'   as const, color: 0x6b7280, description: 'Sve ostalo što ne spada u gornje kategorije' },
];

const PRIORITY_CONFIG = {
  visoki: { label: '🔴 VISOKI', color: 0xef4444, pingStaff: true },
  srednji: { label: '🟡 SREDNJI', color: 0xf59e0b, pingStaff: false },
  niski:  { label: '🟢 NISKI', color: 0x22c55e, pingStaff: false },
};

// Per-category modal questions for ticket creation
const TICKET_MODAL_FIELDS: Record<string, Array<{ id: string; label: string; placeholder: string; style: 'short' | 'paragraph'; required: boolean }>> = {
  bug: [
    { id: 'tf_what', label: 'Što se dogodilo?', placeholder: 'Opiši bug — što si radio/la kad se pojavio?', style: 'paragraph', required: true },
    { id: 'tf_steps', label: 'Kako reproducirati?', placeholder: 'Korak po korak kako izazvati bug', style: 'paragraph', required: false },
    { id: 'tf_when', label: 'Kada se dogodilo?', placeholder: 'Npr. danas u 15:00, svaki put kad...', style: 'short', required: false },
  ],
  prijava: [
    { id: 'tf_player', label: 'Ime igrača kojeg prijavljuješ', placeholder: 'Točno ime igrača u igri', style: 'short', required: true },
    { id: 'tf_what', label: 'Što je napravio/la?', placeholder: 'Opiši situaciju u detalje', style: 'paragraph', required: true },
    { id: 'tf_when', label: 'Kada i gdje?', placeholder: 'Npr. danas u 16h na polju 23', style: 'short', required: true },
    { id: 'tf_proof', label: 'Imaš li dokaze?', placeholder: 'Screenshot, video, svjedoci...', style: 'short', required: false },
  ],
  ban: [
    { id: 'tf_ign', label: 'Tvoje ime u igri', placeholder: 'Ime pod kojim si igrao/la', style: 'short', required: true },
    { id: 'tf_reason', label: 'Zašto si baniran/a?', placeholder: 'Ako znaš razlog bana', style: 'paragraph', required: true },
    { id: 'tf_appeal', label: 'Zašto bi trebao/la biti odbaniran/a?', placeholder: 'Obrazloži svoju stranu priče', style: 'paragraph', required: true },
  ],
  tech: [
    { id: 'tf_what', label: 'Koji je problem?', placeholder: 'Opiši problem — launcher, modovi, povezivanje...', style: 'paragraph', required: true },
    { id: 'tf_tried', label: 'Što si već probao/la?', placeholder: 'Reinstall, restart, provjera modova...', style: 'paragraph', required: false },
    { id: 'tf_error', label: 'Error poruka (ako postoji)', placeholder: 'Kopiraj tekst greške ovdje', style: 'paragraph', required: false },
  ],
  prijedlog: [
    { id: 'tf_idea', label: 'Tvoj prijedlog', placeholder: 'Opiši svoju ideju za poboljšanje servera', style: 'paragraph', required: true },
    { id: 'tf_why', label: 'Zašto bi to bilo korisno?', placeholder: 'Kako bi to pomoglo serveru ili igračima?', style: 'paragraph', required: false },
  ],
  ostalo: [
    { id: 'tf_subject', label: 'Tema', placeholder: 'O čemu se radi?', style: 'short', required: true },
    { id: 'tf_details', label: 'Detalji', placeholder: 'Opiši što trebaš u detalje', style: 'paragraph', required: true },
  ],
};

// Ticket snippets that staff can quick-send inside tickets
const TICKET_SNIPPETS = [
  { id: 'ts_cekanje',  label: '⏳ Na čekanju',        value: 'ticket-cekanje' },
  { id: 'ts_info',     label: 'ℹ️ Treba više info',   value: 'ticket-info' },
  { id: 'ts_zatvoren', label: '🔒 Zatvori poruka',    value: 'ticket-zatvoren' },
  { id: 'ts_welcome',  label: '👋 Dobrodošlica',      value: 'dobrodosao' },
  { id: 'ts_pravila',  label: '📜 Pravila',           value: 'pravila' },
  { id: 'ts_launcher', label: '🚀 Launcher upute',    value: 'launcher' },
  { id: 'ts_modovi',   label: '📦 Modovi upute',      value: 'modovi' },
  { id: 'ts_problem',  label: '🔧 Tehnički problem',  value: 'problem' },
  { id: 'ts_povratak', label: '🔄 Povratak',          value: 'povratak' },
];

// ─── Snippets (used by !! commands and ticket quick-replies) ────────────
const SNIPPETS: Record<string, { title: string; description: string; color: number; fields?: { name: string; value: string; inline?: boolean }[]; buttons?: { label: string; url: string }[] }> = {
  'dobrodosao': {
    title: '🚜 Dobrodošao/la na Slavonsku Ravnicu!',
    description:
      'Bok i dobrodošao na Slavonsku Ravnicu! 🚜\n' +
      'Ticket ti je prošao i primljen/a si na server.\n\n' +
      'Za ulazak u igru idi u kanal <#1481028377489047613> i tamo skini naš launcher — unutra ti sve piše i to je glavni način za ulazak na server.\n\n' +
      'Ako želiš, modove možeš dodati i ručno preko ovog linka:\nhttp://176.57.169.250:8620/mods.html?lang=en\n\n' +
      'Samo imaj na umu da će se sva buduća ažuriranja prikazivati isključivo kroz launcher, tako da više nećemo posebno lijepiti linkove za nove ili ažurirane modove. Zato ti je launcher ubuduće glavno mjesto za sve updateove.\n\n' +
      'Ako ti bilo što zapne oko instalacije, modova ili ulaska u igru, slobodno se javi.\nVidimo se na farmi. 🌾',
    color: 0x22c55e,
  },
  'launcher': {
    title: '📥 Launcher — preuzimanje i instalacija',
    description:
      'Naš launcher je glavni način za ulazak na server.\n\n' +
      '**Gdje preuzeti?**\nKlikni gumb ispod ili idi u kanal <#1481028377489047613>.\n\n' +
      '**Instalacija:**\n' +
      '1. Preuzmi `SRManager.exe` klikom na gumb ispod\n' +
      '2. Pokreni preuzeti launcher\n' +
      '3. Prati upute u installeru\n\n' +
      '**Kako radi?**\n' +
      '• Pokreni launcher\n' +
      '• Automatski će preuzeti sve potrebne modove\n' +
      '• Klikni "Play" i igra te prebacuje na server\n\n' +
      '**Problemi?**\n' +
      '• Pokreni launcher kao Administrator\n' +
      '• Provjeri da ti antivirus ne blokira\n' +
      '• Ako ništa ne pomaže, javi se u support kanal',
    color: 0x3b82f6,
    buttons: [
      { label: '⬇️ Preuzmi Launcher', url: 'https://github.com/7oncha/SRManager-Installer/releases/latest/download/SRManager.exe' },
      { label: 'GitHub', url: 'https://github.com/7oncha/SRManager-Installer' },
    ],
  },
  'modovi': {
    title: '🔧 Modovi — ručna instalacija',
    description:
      'Ako želiš ručno dodati modove:\nhttp://176.57.169.250:8620/mods.html?lang=en\n\n' +
      '**Kako?**\n' +
      '1. Preuzmi modove s gornjeg linka\n' +
      '2. Smjesti ih u `Documents/My Games/FarmingSimulator2025/mods/`\n' +
      '3. Pokreni igru i spoji se na server\n\n' +
      '⚠️ **Važno:** Sva buduća ažuriranja idu isključivo kroz launcher. Ručna instalacija je samo za početno postavljanje ako ne koristiš launcher.',
    color: 0xf59e0b,
  },
  'pravila': {
    title: '📜 Pravila servera',
    description:
      'Molimo te da pročitaš pravila servera prije početka igre.\n\n' +
      '• Poštuj sve igrače na serveru\n' +
      '• Zabranjeno je uništavanje tuđe imovine\n' +
      '• Ne ostavljaj vozila na cesti\n' +
      '• Koristi samo svoja polja i farmu\n' +
      '• Exploit/cheat = trajni ban\n' +
      '• Slušaj upute admina i moderatora\n\n' +
      'Kršenje pravila rezultira opomenom, kickom ili banom. ⚠️',
    color: 0xef4444,
  },
  'farma': {
    title: '🌾 Kako odabrati farmu?',
    description:
      'Na serveru postoji nekoliko farmi u koje se možeš pridružiti.\n\n' +
      '**Kako se pridružiti?**\n' +
      '1. Uđi na server\n' +
      '2. U ESC meniju idi na "Farms"\n' +
      '3. Odaberi farmu koja te zanima\n' +
      '4. Pošalji zahtjev za pridruživanje\n\n' +
      '⚠️ **Ili** javi se adminu ili vlasniku farme da te doda direktno.\n\n' +
      'Ako želiš vlastitu farmu, kontaktiraj admina.',
    color: 0x22c55e,
  },
  'problem': {
    title: '🛠️ Imaš problem?',
    description:
      'Ako imaš tehničkih problema s ulaskom na server:\n\n' +
      '**1. Provjeri modove** — Jesu li svi instalirani? Koristi launcher.\n' +
      '**2. Verzija igre** — Mora biti najnovija verzija FS25.\n' +
      '**3. Restart** — Pokušaj restartati igru i launcher.\n' +
      '**4. Antivirus** — Dodaj launcher u iznimke antivirusa.\n' +
      '**5. Firewall** — Provjeri da port nije blokiran.\n\n' +
      'Ako ništa ne pomaže, opiši problem ovdje i netko od admina će ti pomoći. 🔧',
    color: 0xf59e0b,
  },
  'inactive': {
    title: '⏰ Obavijest o neaktivnosti',
    description:
      'Primijećeno je da duže vrijeme nisi bio/la aktivan/a na serveru.\n\n' +
      'Ako i dalje želiš igrati na serveru, molimo te da se javiš u roku od **48 sati**.\n\n' +
      'U protivnom, tvoje mjesto može biti dodijeljeno drugom igraču.\n\n' +
      'Hvala na razumijevanju! 🙏',
    color: 0xf59e0b,
  },
  'kick': {
    title: '⚠️ Uklonjen/a sa servera',
    description:
      'Zbog kršenja pravila, uklonjen/a si sa servera.\n\n' +
      'Ako smatraš da je došlo do greške, možeš otvoriti novi ticket i objasniti situaciju.\n\n' +
      'Molimo te da u budućnosti poštivaš pravila servera. 📜',
    color: 0xef4444,
  },
  'ban': {
    title: '🔨 Baniran/a sa servera',
    description:
      'Zbog ozbiljnog kršenja pravila, baniran/a si sa servera.\n\n' +
      'Ako želiš uložiti žalbu, možeš otvoriti ticket s obrazloženjem.\n\n' +
      'Ban se može razmotriti na zahtjev vlasnika.',
    color: 0xef4444,
  },
  'ticket-zatvoren': {
    title: '🔒 Ticket zatvoren',
    description:
      'Tvoj ticket je pregledan i zatvoren.\n\n' +
      'Ako imaš dodatnih pitanja, slobodno otvori novi ticket.\n\n' +
      'Hvala na strpljenju! ✅',
    color: 0x6b7280,
  },
  'ticket-cekanje': {
    title: '⏳ Ticket — na čekanju',
    description:
      'Tvoj ticket je primljen i na čekanju za pregled.\n\n' +
      'Molimo te za strpljenje — admin tim će pregledati tvoj zahtjev čim bude moguće.\n\n' +
      'U međuvremenu, pripremi sve informacije koje bi mogle pomoći (screenshots, opisi problema, itd.).',
    color: 0xf59e0b,
  },
  'ticket-info': {
    title: 'ℹ️ Ticket — potrebno više informacija',
    description:
      'Za obradu tvog ticketa potrebno je više informacija.\n\n' +
      'Molimo te navedi:\n' +
      '• Detaljniji opis problema/zahtjeva\n' +
      '• Screenshotove (ako je primjenjivo)\n' +
      '• Tvoj in-game naziv\n\n' +
      'Čim dobijemo sve podatke, nastavit ćemo s obradom. 📋',
    color: 0x3b82f6,
  },
  'reset': {
    title: '🔄 Server reset',
    description:
      'Server je restartiran / resetiran.\n\n' +
      'Ako si bio/la online, možeš se ponovno spojiti za par minuta.\n' +
      'Treba malo vremena da se server pokrene i sinkronizira.\n\n' +
      'Ako imaš problema s ulaskom nakon restarta, malo pričekaj i pokušaj ponovo. ⏳',
    color: 0x3b82f6,
  },
  'povratak': {
    title: '🔄 Povratak na server?',
    description:
      'Pozdrav! 👋\n\n' +
      'Vidimo da si ponovo zainteresiran/a za Slavonsku Ravnicu.\n\n' +
      'Prije nego nastavimo, zanima nas par stvari:\n\n' +
      '**1.** Jesi li prije igrao/la na našem serveru?\n' +
      '**2.** Ako da — pod kojim imenom?\n' +
      '**3.** Koji je bio razlog prestanka igranja?\n\n' +
      'Slobodno odgovori ovdje u ticketu, pa ćemo vidjeti kako dalje. 🙂',
    color: 0x8b5cf6,
  },
  'website': {
    title: '🌐 Naša web stranica',
    description:
      'Ne zaboravi posjetiti našu web stranicu! 🌐\n\n' +
      '🔗 **https://slavonska-ravnica.com/**\n\n' +
      'Stranica je još u izradi, ali uskoro ćeš tamo moći pronaći sve informacije o serveru, novosti i još puno toga.\n\n' +
      'Dodaj u bookmarke i prati nas! 📌',
    color: 0x3b82f6,
  },
  'help': {
    title: '📋 Dostupni snippeti',
    description:
      'Koristi `!!ime` za slanje snippet poruke:\n\n' +
      '• `!!dobrodosao` — Dobrodošlica nakon ticketa\n' +
      '• `!!launcher` — Upute za launcher\n' +
      '• `!!modovi` — Ručna instalacija modova\n' +
      '• `!!pravila` — Pravila servera\n' +
      '• `!!farma` — Kako odabrati farmu\n' +
      '• `!!problem` — Tehnički problemi\n' +
      '• `!!inactive` — Obavijest o neaktivnosti\n' +
      '• `!!kick` — Uklonjen sa servera\n' +
      '• `!!ban` — Baniran sa servera\n' +
      '• `!!ticket-zatvoren` — Ticket zatvoren\n' +
      '• `!!ticket-cekanje` — Ticket na čekanju\n' +
      '• `!!ticket-info` — Potrebno više info\n' +
      '• `!!reset` — Server reset info\n' +
      '• `!!povratak` — Pitanje za returning igrače\n' +
      '• `!!website` — Link na web stranicu\n\n' +
      '`!!?ime` — Preview snippet (samo ti vidiš, briše se za 30s)\n' +
      '`!tekst` — Pošalji admin-only bilješku (vidljivo samo Admin+)',
    color: 0x6b7280,
  },
};

// Static categories (always created)
const CATEGORIES: CategoryDef[] = [
  {
    name: '── 📌 𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗖𝗜𝗝𝗘 ──',
    channels: [
      { name: '👋┃ᴅᴏʙʀᴏᴅᴏšʟɩᴄᴀ', type: 'text', readOnly: true },
      { name: '✅┃ᴠᴇʀɪꜰɪᴋᴀᴄɪᴊᴀ', type: 'text', readOnly: true },
      { name: '📝┃ᴘʀɪᴊᴀᴠᴀ', type: 'text', readOnly: true },
      { name: 'ℹ️┃ɪɴꜰᴏ', type: 'text', readOnly: true },
      { name: '🔔┃ᴏʙᴀᴠɪᴊᴇꜱᴛɪ', type: 'text', readOnly: true },
    ]
  },
  {
    name: '── 💬 𝗭𝗔𝗝𝗘𝗗𝗡𝗜𝗖𝗔 ──',
    channels: [
      { name: '┃ᴘʀᴀᴠɪʟᴀ', type: 'text', readOnly: true },
      { name: '❓┃ᴘɪᴛᴀɴᴊᴀ', type: 'forum', freeWrite: true },
      { name: '💬┃ᴏᴘćᴇɴɪᴛᴏ', type: 'text', freeWrite: true },
      { name: '📸┃ꜰᴏᴛᴏɢʀᴀꜰɪᴊᴇ', type: 'text', freeWrite: true },
      { name: '🎫┃ᴛɪᴄᴋᴇᴛɪ', type: 'text', readOnly: true },
    ]
  },
  {
    name: '── 🌾 𝗦𝗟𝗔𝗩𝗢𝗡𝗦𝗞𝗔 𝗥𝗔𝗩𝗡𝗜𝗖𝗔 ──',
    channels: [
      { name: '🚀┃ʟᴀᴜɴᴄʜᴇʀ', type: 'text', readOnly: true, playerOnly: true, autoEmbed: {
        title: '🚀 Slavonska Ravnica Launcher',
        description: 'Preuzmi službeni launcher za automatsku instalaciju i ažuriranje modova.\n\nLauncher će automatski konfigurirati tvoj FS25 s potrebnim modovima za Slavonsku Ravnicu.',
        color: 0x2ecc71,
        buttonLabel: 'Preuzmi Launcher',
        buttonEmoji: '⬇️',
        buttonUrl: 'https://github.com/7oncha/SRManager-Installer/releases/latest/download/SRManager.exe',
        buttonUrlEnv: 'LAUNCHER_URL',
        buttonStyle: 'link',
        thumbnail: 'SERVER_ICON_URL',
      }},
      { name: '🌐┃ᴡᴇʙ', type: 'text', readOnly: true, playerOnly: true, autoEmbed: {
        title: '🌐 Slavonska Ravnica',
        description: 'Službena web stranica Slavonske Ravnice!\n\nPronađi sve informacije o serveru, novosti, pravila i još puno toga.',
        color: 0x3498db,
        buttonLabel: 'Otvori Web Stranicu',
        buttonEmoji: '🌐',
        buttonUrl: 'https://slavonska-ravnica.com/',
        buttonStyle: 'link',
        thumbnail: 'SERVER_ICON_URL',
      }},
      { name: '📦┃ᴍᴏᴅᴏᴠɪ', type: 'text', readOnly: true, playerOnly: true, autoEmbed: {
        title: '📦 Modovi',
        description: 'Popis svih modova koji se koriste na serveru **Slavonska Ravnica**.\n\n> 💡 *Sve modove automatski instalira launcher — ne trebaš ručno ništa skidati.*\n> 🔄 *Popis se automatski ažurira nakon svake sinkronizacije.*',
        color: 0xe67e22,
        buttonLabel: 'Preuzmi Launcher',
        buttonEmoji: '⬇️',
        buttonUrl: 'https://github.com/7oncha/SRManager-Installer/releases/latest/download/SRManager.exe',
        buttonStyle: 'link',
      }},
      { name: '💬┃ꜰᴀʀᴍ-ᴄʜᴀᴛ', type: 'text', playerOnly: true },
      { name: '🏆┃ʟᴇᴀᴅᴇʀʙᴏᴀʀᴅ', type: 'text', readOnly: true, playerOnly: true },
      { name: '🔔┃ꜰᴀʀᴍ-ᴏʙᴀᴠɪᴊᴇꜱᴛɪ', type: 'text', readOnly: true, playerOnly: true },
    ]
  },
  {
    name: '── 🔒 𝗦𝗧𝗔𝗙𝗙 ──',
    channels: [
      { name: '💬┃ꜱᴛᴀꜰꜰ-ᴄʜᴀᴛ', type: 'text', staffOnly: true },
      { name: '📋┃ᴍᴏᴅ-ʟᴏɢ', type: 'text', staffOnly: true },
      { name: '📊┃ʙᴏᴛ-ᴅᴀꜱʜʙᴏᴀʀᴅ', type: 'text', staffOnly: true, readOnly: true },
    ]
  },
  {
    name: '── 🎙️ 𝗚𝗟𝗔𝗦𝗢𝗩𝗡𝗜 𝗞𝗔𝗡𝗔𝗟𝗜 ──',
    channels: [
      { name: '🌾 ɴᴊɪᴠᴀ', type: 'voice' },
      { name: '🚜 ɢᴀʀᴀžᴀ', type: 'voice' },
      { name: '🏡 ᴅᴠᴏʀɪšᴛᴇ', type: 'voice' },
      { name: '🐄 šᴛᴀʟᴀ', type: 'voice' },
      { name: '🌻 ᴘʟᴀɴᴛᴀžᴀ', type: 'voice' },
      { name: '🏭 ᴛᴠᴏʀɴɪᴄᴀ', type: 'voice' },
      { name: '🛒 ᴛʀžɴɪᴄᴀ', type: 'voice' },
      { name: '🔒 ᴜʀᴇᴅ', type: 'voice', staffOnly: true },
      { name: '🚽 ᴘᴏʟᴊꜱᴋɪ ᴡᴄ', type: 'voice' },
    ]
  },
];

// Per-farm channel template — created once for each farm as its own category
const FARM_CATEGORY_CHANNELS: ChannelDef[] = [
  { name: '📊┃ꜱᴛᴀᴛɪꜱᴛɪᴋᴀ', type: 'text', readOnly: true, farmOnly: true },
  { name: '🏦┃ᴇᴋᴏɴᴏᴍɪᴊᴀ', type: 'text', readOnly: true, farmOnly: true },
  { name: '🐄┃žɪᴠᴏᴛɪɴᴊᴇ', type: 'text', readOnly: true, farmOnly: true },
  { name: '💬┃ᴄʜᴀᴛ', type: 'text', farmOnly: true },
];

// Welcome embeds for per-farm channels (posted on first creation)
const FARM_CHANNEL_EMBEDS: Record<string, { title: string; description: string; color: number; emoji: string }> = {
  'ꜱᴛᴀᴛɪꜱᴛɪᴋᴀ': {
    title: '📊 Statistika Farme',
    description:
      'Ovdje bot automatski objavljuje statistike tvoje farme:\n\n' +
      '🌾 **Polja** — status usjeva, veličine, vlasništvo\n' +
      '🚜 **Vozila** — popis vozila, korištenje, stanje\n' +
      '👥 **Igrači** — tko je online, playtime, aktivnost\n' +
      '📦 **Silosi** — razine punjenja po tipu\n\n' +
      '> Podaci se automatski ažuriraju svakih par minuta.',
    color: 0x3498db,
    emoji: '📊',
  },
  'ᴇᴋᴏɴᴏᴍɪᴊᴀ': {
    title: '🏦 Ekonomija Farme',
    description:
      'Ovdje bot automatski objavljuje financijske podatke tvoje farme:\n\n' +
      '💰 **Balans** — trenutno stanje računa\n' +
      '📈 **Prihodi** — prodaje, ugovori, subvencije\n' +
      '📉 **Rashodi** — kupovine, održavanje, plaće\n' +
      '🏭 **Produkcije** — ulaz/izlaz proizvodnih pogona\n\n' +
      '> Podaci se automatski ažuriraju nakon svake sinkronizacije.',
    color: 0xf1c40f,
    emoji: '🏦',
  },
  'žɪᴠᴏᴛɪɴᴊᴇ': {
    title: '🐄 Životinje na Farmi',
    description:
      'Ovdje bot automatski objavljuje stanje životinja na tvojoj farmi:\n\n' +
      '🐄 **Krave** — mlijeko, hrana, zdravlje\n' +
      '🐔 **Kokoši** — jaja, hrana, broj\n' +
      '🐑 **Ovce** — vuna, hrana, broj\n' +
      '🐴 **Konji** — jahanje, hrana, broj\n' +
      '🐝 **Pčele** — med, stanje košnica\n\n' +
      '> Podaci se automatski ažuriraju svakih par minuta.',
    color: 0x2ecc71,
    emoji: '🐄',
  },
  'ᴄʜᴀᴛ': {
    title: '💬 Farm Chat',
    description:
      'Ovdje možeš razgovarati s članovima svoje farme! 🌾\n\n' +
      '📌 **Pravila chata:**\n' +
      '> • Budi pristojan prema suigračima\n' +
      '> • Dogovaraj poslove, podjelu zadataka i strategiju\n' +
      '> • Pitaj za pomoć ako trebaš\n\n' +
      '> Samo članovi tvoje farme i staff mogu vidjeti ovaj kanal.',
    color: 0x5865f2,
    emoji: '💬',
  },
};
import * as path from 'node:path';

// ── Channel Config (dynamic, stored in JSON) ──
const CHANNEL_CONFIG_PATH = path.join(process.cwd(), 'src', 'storage', 'channel-config.json');

interface ChannelConfig {
  categories: CategoryDef_Saved[];
  farmChannels: ChannelDef_Saved[];
}
interface ChannelDef_Saved {
  name: string;
  type: 'text' | 'voice' | 'forum';
  readOnly?: boolean;
  staffOnly?: boolean;
  playerOnly?: boolean;
  freeWrite?: boolean;
  farmOnly?: boolean;
  autoEmbed?: ChannelDef['autoEmbed'];
}
interface CategoryDef_Saved {
  name: string;
  channels: ChannelDef_Saved[];
}

async function readChannelConfig(): Promise<ChannelConfig> {
  try {
    const raw = await fs.readFile(CHANNEL_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { categories: [], farmChannels: [] };
  }
}

async function writeChannelConfig(config: ChannelConfig): Promise<void> {
  await fs.mkdir(path.dirname(CHANNEL_CONFIG_PATH), { recursive: true });
  await fs.writeFile(CHANNEL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// ── Guild Settings (per-guild channel assignments, stored in JSON) ──
const GUILD_SETTINGS_PATH = path.join(process.cwd(), 'src', 'storage', 'guild-settings.json');

// Keys for configurable channels
const GUILD_CHANNEL_KEYS = {
  'mod-log':      { label: '📋 Mod Log',         desc: 'Kanal za moderacijski log (ban, kick, edit, delete...)' },
  'welcome':      { label: '👋 Dobrodošlica',    desc: 'Kanal za welcome/leave poruke' },
  'farm-chat':    { label: '💬 Farm Chat',        desc: 'Discord ↔ FS25 chat bridge' },
  'console':      { label: '🖥️ Konzola',         desc: 'Kanal za FS25 server komande' },
  'staff-chat':   { label: '🛡️ Staff Chat',      desc: 'Staff-only diskusija i prijave' },
  'bot-dashboard': { label: '📊 Bot Dashboard',   desc: 'Kanal s linkom na dashboard' },
  'log':          { label: '📡 Event Log',        desc: 'Kanal za join/leave/status logove' },
  'log-tracking': { label: '📊 Tracking Log',     desc: 'Kanal za player tracking podatke' },
  'tickets':      { label: '🎫 Ticketi',          desc: 'Kanal za ticket sustav' },
  'new-farmer':   { label: '🌾 Novi Ratar',       desc: 'Kanal za objavu kad novi igrač dobije Ratar ulogu' },
  'obavijesti':   { label: '🔔 Obavijesti',       desc: 'Kanal za /obavijest komandu (ping NotifyMe role)' },
  'leaderboard':  { label: '🏆 Leaderboard',      desc: 'Kanal za automatski leaderboard prikaz' },
  'launcher':     { label: '🚀 Launcher',         desc: 'Kanal s linkom na launcher za modove' },
  'pravila':      { label: '📜 Pravila',           desc: 'Kanal s pravilima servera' },
  'opcenito':     { label: '💬 Općenito',          desc: 'Javni chat kanal za rang-up obavijesti' },
  'vrijeme':      { label: '🌤️ Vrijeme',          desc: 'Kanal za automatski prikaz vremena u igri' },
  'karta':        { label: '🗺️ Karta',            desc: 'Kanal za automatski prikaz karte servera' },
  'farm-obavijesti': { label: '🔔 Farm Obavijesti', desc: 'Kanal za join/leave obavijesti igrača na serveru' },
  'market':        { label: '🏪 Market',           desc: 'Kanal za Coop tržnicu — cijene, ugovori, dropdown' },
  'poslovi':       { label: '📋 Poslovi',          desc: 'Kanal za obavijesti o poslovima na ugovor (Custom Contracts)' },
} as const;

type GuildChannelKey = keyof typeof GUILD_CHANNEL_KEYS;

interface GuildSettings {
  [guildId: string]: {
    [key in GuildChannelKey]?: string; // channelId
  };
}

async function readGuildSettings(): Promise<GuildSettings> {
  try {
    return await storage.getGuildSettings() as GuildSettings;
  } catch (e) {
    console.error('[GUILD-SETTINGS] Failed to read from MongoDB, falling back to file:', e);
    try {
      const raw = await fs.readFile(GUILD_SETTINGS_PATH, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}

async function writeGuildSettings(settings: GuildSettings): Promise<void> {
  try {
    await storage.saveGuildSettings(settings as any);
  } catch (e) {
    console.error('[GUILD-SETTINGS] Failed to write to MongoDB, falling back to file:', e);
    await fs.mkdir(path.dirname(GUILD_SETTINGS_PATH), { recursive: true });
    await fs.writeFile(GUILD_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  }
}

// Resolve a configured channel for a guild, with fallback to findChannelByName
const CHANNEL_KEY_TO_NAME: Record<GuildChannelKey, string> = {
  'mod-log':      'ᴍᴏᴅ-ʟᴏɢ',
  'welcome':      'ᴅᴏʙʀᴏᴅᴏšʟɪᴄᴀ',
  'farm-chat':    'ꜰᴀʀᴍ-ᴄʜᴀᴛ',
  'console':      'ᴋᴏɴᴢᴏʟᴀ',
  'staff-chat':   'ꜱᴛᴀꜰꜰ-ᴄʜᴀᴛ',
  'bot-dashboard': 'ʙᴏᴛ-ᴅᴀꜱʜʙᴏᴀʀᴅ',
  'log':          '',
  'log-tracking': '',
  'tickets':      'ᴛɪᴄᴋᴇᴛɪ',
  'new-farmer':   '',
  'obavijesti':   'ᴏʙᴀᴠɪᴊᴇꜱᴛɪ',
  'leaderboard':  'ʟᴇᴀᴅᴇʀʙᴏᴀʀᴅ',
  'launcher':     'ʟᴀᴜɴᴄʜᴇʀ',
  'pravila':      'ᴘʀᴀᴠɪʟᴀ',
  'opcenito':     'ᴏᴘćᴇɴɪᴛᴏ',
  'vrijeme':      'ᴠʀɪᴊᴇᴍᴇ',
  'karta':        'ᴋᴀʀᴛᴀ',
  'farm-obavijesti': 'ꜰᴀʀᴍ-ᴏʙᴀᴠɪᴊᴇꜱᴛɪ',
  'market':        'market',
  'poslovi':       'ᴘᴏꜱʟᴏᴠɪ',
};

let _guildSettingsCache: GuildSettings | null = null;

async function getGuildChannel(guild: any, key: GuildChannelKey): Promise<any | null> {
  if (!_guildSettingsCache) _guildSettingsCache = await readGuildSettings();
  const settings = _guildSettingsCache[guild.id];
  if (settings && settings[key]) {
    const ch = guild.channels.cache.get(settings[key]);
    if (ch) return ch;
  }
  // Fallback to name-based lookup
  const fallbackName = CHANNEL_KEY_TO_NAME[key];
  if (fallbackName) return findChannelByName(guild, fallbackName);
  return null;
}

function invalidateGuildSettingsCache() {
  _guildSettingsCache = null;
}

// Permission type labels
const PERM_LABELS: Record<string, string> = {
  readOnly: '🔒 Samo čitanje',
  staffOnly: '🛡️ Samo staff',
  playerOnly: '🌾 Samo igrači',
  freeWrite: '✏️ Svi pišu',
  farmOnly: '🚜 Samo farma',
};

// ChannelType enum for discord.js
const ChannelType = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GroupDM: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildForum: 15,
  GuildMedia: 16
};

// ButtonStyle is imported from discord.js

function escapeXml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type PanelFeatureFlags = {
  vehiclesAlerts: boolean;
  fieldsTaskHints: boolean;
};

type InboxQueueItem = {
  id: string;
  kind: 'chat' | 'bank_transfer' | 'game_command' | 'console';
  payloadType: 'xml' | 'json';
  filename: string;
  commandRef?: string;
  xml?: string;
  payload?: any;
  createdAt: string;
  nextAttemptAt: string;
  attempts: number;
  status: 'queued' | 'sent' | 'failed';
  sentAt?: string;
  lastError?: string;
};

export class DiscordBot {
  private client: Client;

  public getClient(): Client { return this.client; }
  private isConnected: boolean = false;
  private startTime: number = Date.now();
  private logEventSequence: number = 0;
  private lastGameServerOnlineState: boolean | null = null;
  private _slashCommands: any[] | null = null;

  // Runtime stats (iz playerTimeStats.xml + vehicleUsageStats.xml)
  // Napomena (hr): ovo je cache; mod ih vec sprema u savegame, pa se bot moze restartati bez gubitka.
  private runtimeUpdatedAt: Date | null = null;
  private runtimePlayerTimes: Map<string, {
    id: string;
    nickname: string;
    uniqueUserId?: string;
    farmId?: string;
    totalOnlineMs: number;
    totalAfkMs: number;
    lastOnlineAt?: string;
    lastSeenAtMs?: number;
    currentlyOnline?: boolean;
    lastActivityRealAt?: Date; // zadnji put kad smo vidjeli rast totalOnlineMs
  }> = new Map();
  // Kada smo igrača prvi put vidjeli u trenutnoj runtime prisutnosti (za "sesija HH:mm")
  private runtimeSessionStartedAtByPlayer: Map<string, Date> = new Map();
  private runtimeVehicleUsage: Map<string, {
    uniqueId: string;
    name: string;
    farmId?: string;
    totalMs: number;
    movingMs: number;
    idleMs: number;
    lastUsedAt?: string;
    players: Array<{ id: string; nickname: string; totalMs: number; movingMs: number; idleMs: number; lastUsedAt?: string }>;
  }> = new Map();

  // Player tracking (map trail + session analytics) from patched companion (playerTracks.xml / playerSessionHistory.xml)
  private playerTrackingUpdatedAt: Date | null = null;
  private playerTracks: Array<{ id: string; nickname: string; sessionStartMs?: number; lastMoveMs?: number; distanceM: number; activeMs: number; idleMs: number; points: Array<{ t: number; x: number; z: number; mode?: string }> }> = [];
  private playerSessionHistory: Array<{ id: string; nickname: string; startedAtMs?: number; endedAtMs?: number; distanceM: number; activeMs: number; idleMs: number; reason?: string }> = [];

  // UI state (pagination) for public panels
  private playerHoursPageByMessage: Map<string, number> = new Map();
  private mapTracksSelectedWindowByMessage: Map<string, '10m' | '30m' | '2h'> = new Map();
  private serverInfoWindowByMessage: Map<string, '10m' | '30m' | '2h' | '12h' | 'all'> = new Map();
  private serverInfoPlayerByMessage: Map<string, string> = new Map();
  private vehiclesCategoryByMessage: Map<string, string> = new Map();
  private vehiclesTypesByMessage: Map<string, string[]> = new Map();
  private vehiclesSelectedByMessage: Map<string, string[]> = new Map();
  private linkingSessions: Map<string, { discordUserId?: string; uniqueUserId?: string }> = new Map();
  // UI state (pagination) for list panels (silos/productions/etc.)
  private listPageByMessageAndPanel: Map<string, number> = new Map();
  private afkWarnLevelByPlayer: Map<string, number> = new Map();
  private logTrackWindowByMessage: Map<string, '10m' | '30m' | '2h' | '12h' | 'all'> = new Map();
  private logTrackPlayerByMessage: Map<string, { uniqueUserId: string; name: string; farmId: string | null }> = new Map();
  private lastLeaveTrackingAtByPlayer: Map<string, number> = new Map();
  private lastPresenceNotifyAt: Map<string, number> = new Map();
  private runtimePresenceStateByPlayer: Map<string, { online: boolean; name: string }> = new Map();
  private runtimePresenceInitialized: boolean = false;
  private lastRuntimePresenceEmitAtByPlayer: Map<string, number> = new Map();
  private inboxQueueTickBusy: boolean = false;
  private lastInboxQueueAlertAtMs: number = 0;
  private inboxQueueAlertActive: boolean = false;
  private embedDebugStatsByScope: Map<string, { count: number; missing: number; inferred: number; lastTitle: string }> = new Map();
  private lastEmbedDebugSummaryAtMs: number = 0;
  private activeChecks: Map<string, { adminId: string; attempt: number; timerId: ReturnType<typeof setTimeout>; guildId: string }> = new Map();
  public forceRestoreAbort: Map<string, boolean> = new Map();
  public forceRestoreProgress: Map<string, { phase: string; current: number; total: number; messagesPosted: number; totalMessages: number; cancelled?: boolean; done?: boolean; error?: string; result?: any }> = new Map();


  private musicPlayer!: Player;
  // Per-guild autoplay mode state (auto-plays similar songs)
  private autoplayMode: Map<string, boolean> = new Map();
  // Store the text channel where /play was last used per guild for Now Playing embeds
  private musicTextChannel: Map<string, string> = new Map();
  // Per-guild radio player state (uses @discordjs/voice directly for raw streams)
  private radioPlayers = new Map<string, { player: any; process: ChildProcess; stationName: string }>();
  // Store per-guild "now playing" message ID for single-embed approach
  private musicNowPlayingMsg: Map<string, string> = new Map();

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.AutoModerationExecution,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
    });

    this.initMusicPlayer().catch(e => console.error('[MUSIC] Init error:', e));
    this.setupListeners();
  }

  private async initMusicPlayer() {
    try {
      // Set ffmpeg path from ffmpeg-static before creating the player
      if (ffmpegStatic) {
        // Ensure ffmpeg-static binary is executable (some deploy environments strip permissions)
        try { const { chmodSync } = require('fs'); chmodSync(ffmpegStatic, 0o755); } catch {}
        process.env.FFMPEG_PATH = ffmpegStatic;
        console.log('[MUSIC] ffmpeg path set to:', ffmpegStatic);
        // Verify ffmpeg-static actually works
        try {
          const { execSync } = require('child_process');
          const ver = execSync(`"${ffmpegStatic}" -version`, { timeout: 5000, encoding: 'utf8' }).split('\n')[0];
          console.log('[MUSIC] ffmpeg-static version:', ver.trim());
        } catch (e: any) {
          console.warn('[MUSIC] ffmpeg-static binary BROKEN:', e.message?.slice(0, 100));
          // Fallback to system ffmpeg
          try {
            const { execSync } = require('child_process');
            const ver = execSync('ffmpeg -version', { timeout: 5000, encoding: 'utf8' }).split('\n')[0];
            process.env.FFMPEG_PATH = 'ffmpeg';
            console.log('[MUSIC] Falling back to system ffmpeg:', ver.trim());
          } catch {
            console.warn('[MUSIC] System ffmpeg also not available!');
          }
        }
      } else {
        console.warn('[MUSIC] ffmpeg-static not found, trying system ffmpeg');
        try {
          const { execSync } = require('child_process');
          execSync('ffmpeg -version', { timeout: 5000 });
          process.env.FFMPEG_PATH = 'ffmpeg';
          console.log('[MUSIC] Using system ffmpeg');
        } catch {
          console.warn('[MUSIC] No ffmpeg available — audio may not work');
        }
      }

      // Diagnostic: check available audio modules
      try { require('@discordjs/opus'); console.log('[MUSIC] @discordjs/opus: OK'); } catch { console.warn('[MUSIC] @discordjs/opus: NOT available (native module)'); }
      try { require('opusscript'); console.log('[MUSIC] opusscript: OK (JS fallback)'); } catch { console.warn('[MUSIC] opusscript: NOT available'); }
      try { const mp = require('mediaplex'); console.log('[MUSIC] mediaplex: OK, opus version:', mp.getOpusVersion?.()); } catch { console.warn('[MUSIC] mediaplex: NOT available (native module)'); }

      this.musicPlayer = new Player(this.client);

      // ── YoutubeiExtractor config ──
      // YouTube blocks streaming from datacenter IPs.
      // Strategy: Call Invidious API through a fetch-proxy (to bypass API IP blocks),
      // then return the Invidious-proxied audio URL (inv.thepixora.com/videoplayback)
      // which ffmpeg can download from without being blocked.
      const INVIDIOUS_HOST = process.env.INVIDIOUS_HOST || 'inv.thepixora.com';
      const FETCH_PROXIES = (process.env.FETCH_PROXIES || 'https://api.codetabs.com/v1/proxy?quest=').split(',').map(s => s.trim()).filter(Boolean);

      const ytExtractorOpts: any = {
        streamOptions: { useClient: 'ANDROID' as const },
        generateWithPoToken: false,
        createStream: async (track: any, _extractor: any) => {
          // Extract video ID from YouTube URL
          const url = track.url || '';
          let videoId = '';
          try {
            const u = new URL(url);
            videoId = u.searchParams.get('v') || u.pathname.split('/').pop()?.split('?')[0] || '';
          } catch {
            videoId = url.split('v=')[1]?.split('&')[0] || url.split('/').pop()?.split('?')[0] || '';
          }
          if (!videoId) throw new Error('Cannot extract video ID from ' + url);

          const invApiUrl = `https://${INVIDIOUS_HOST}/api/v1/videos/${videoId}?local=true`;
          let lastError = '';

          // Try direct first (might work from some hosts), then through fetch proxies
          const attempts = [
            { label: 'direct', url: invApiUrl },
            ...FETCH_PROXIES.map(p => ({ label: p.split('/')[2] || p, url: p + encodeURIComponent(invApiUrl) })),
          ];

          for (const attempt of attempts) {
            try {
              console.log(`[MUSIC] Invidious: trying ${attempt.label} for ${videoId} url: ${attempt.url.substring(0, 120)}`);
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 15_000);
              let resp: Response;
              try {
                resp = await fetch(attempt.url, { signal: controller.signal });
              } finally {
                clearTimeout(timer);
              }
              console.log(`[MUSIC] Invidious: ${attempt.label} responded ${resp.status}`);
              if (!resp.ok) {
                lastError = `${attempt.label}: HTTP ${resp.status}`;
                continue;
              }
              const text = await resp.text();
              console.log(`[MUSIC] Invidious: ${attempt.label} body length=${text.length}`);
              let data: any;
              try { data = JSON.parse(text); } catch { lastError = `${attempt.label}: invalid JSON`; console.log(`[MUSIC] ${lastError} body: ${text.substring(0, 200)}`); continue; }

              // Invidious returns adaptiveFormats with audio
              const audioFormats = (data.adaptiveFormats || [])
                .filter((f: any) => f.type?.startsWith('audio/') && f.url)
                .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

              if (audioFormats.length === 0) {
                lastError = `${attempt.label}: no audio formats (adaptiveFormats: ${(data.adaptiveFormats || []).length})`;
                console.log(`[MUSIC] Invidious: ${lastError}`);
                continue;
              }

              const best = audioFormats[0];
              // Ensure HTTPS
              const audioUrl = best.url.replace(/^http:\/\//, 'https://');
              console.log(`[MUSIC] Invidious: got audio via ${attempt.label} (${best.encoding || best.type} ${best.bitrate}bps)`);

              // Download audio — try direct first, then through fetch proxies
              // (Invidious may block Railway IP on videoplayback too)
              const audioAttempts = [
                { label: 'direct', url: audioUrl },
                ...FETCH_PROXIES.map(p => ({ label: 'proxy:' + (p.split('/')[2] || p), url: p + encodeURIComponent(audioUrl) })),
              ];

              for (const aa of audioAttempts) {
                try {
                  console.log(`[MUSIC] Downloading audio via ${aa.label}...`);
                  const audioResp = await fetch(aa.url, { signal: AbortSignal.timeout(60_000) });
                  if (!audioResp.ok || !audioResp.body) {
                    console.log(`[MUSIC] Audio ${aa.label}: HTTP ${audioResp.status}`);
                    continue;
                  }
                  const ct = audioResp.headers.get('content-type') || '';
                  console.log(`[MUSIC] Audio ${aa.label}: buffering full response (type: ${ct})...`);
                  const arrayBuf = await audioResp.arrayBuffer();
                  const buffer = Buffer.from(arrayBuf);
                  console.log(`[MUSIC] Audio ${aa.label}: buffered ${buffer.length} bytes`);
                  if (buffer.length < 50_000) {
                    console.log(`[MUSIC] Audio ${aa.label}: too small (${buffer.length}b), likely truncated — skipping`);
                    continue;
                  }
                  const pt = new PassThrough();
                  pt.end(buffer);
                  return pt;
                } catch (ae: any) {
                  console.log(`[MUSIC] Audio ${aa.label} error: ${ae.message?.slice(0, 100)}`);
                }
              }
              lastError = `${attempt.label}: all audio download attempts failed`;
              console.log(`[MUSIC] ${lastError}`);
            } catch (e: any) {
              lastError = `${attempt.label}: ${e.message?.slice(0, 120)}`;
              console.log(`[MUSIC] Invidious error: ${lastError}`);
            }
          }
          throw new Error(`All Invidious attempts failed for ${videoId}. Last: ${lastError}`);
        },
      };

      const ytCookie = process.env.YOUTUBE_COOKIE || '';
      if (ytCookie) {
        ytExtractorOpts.cookie = ytCookie;
      }
      console.log(`[MUSIC] YoutubeiExtractor: Invidious=${INVIDIOUS_HOST}, fetch proxies=${FETCH_PROXIES.length}`);
      await this.musicPlayer.extractors.register(YoutubeiExtractor, ytExtractorOpts);
      await this.musicPlayer.extractors.loadMulti(DefaultExtractors);
      const extractorNames = [...this.musicPlayer.extractors.store.keys()];
      console.log('[MUSIC] Player initialized with extractors:', extractorNames.join(', '));

      // ── Player events ──
      this.musicPlayer.events.on('playerStart', async (queue, track) => {
        console.log('[MUSIC] playerStart:', track.title, '| extractor:', track.extractor?.identifier || 'unknown', '| source:', track.source || 'unknown');
        const guildId = queue.guild.id;
        const channelId = this.musicTextChannel.get(guildId);
        if (!channelId) return;
        const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!channel) return;

        const embed = this.buildNowPlayingEmbed(queue, track);
        const row = this.buildMusicButtons(queue);

        // Try to edit existing now-playing message (single embed approach)
        const existingMsgId = this.musicNowPlayingMsg.get(guildId);
        if (existingMsgId) {
          try {
            const msg = await channel.messages.fetch(existingMsgId).catch(() => null);
            if (msg) {
              await msg.edit({ embeds: [embed], components: [row] });
              return;
            }
          } catch {}
        }
        // Send new message and store reference
        const sent = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
        if (sent) this.musicNowPlayingMsg.set(guildId, sent.id);
      });

      this.musicPlayer.events.on('playerSkip', async (queue, track) => {
        console.error('[MUSIC] Track skipped (extraction failed):', track.title, track.url);
        const guildId = queue.guild.id;
        const channelId = this.musicTextChannel.get(guildId);
        if (!channelId) return;
        const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!channel) return;
        await channel.send({ embeds: [
          new EmbedBuilder().setColor(0xed4245).setDescription(`⚠️ Preskočena **${track.title}** — nije moguće streamati. Pokušaj drugi link ili pretragu.`)
        ] }).catch(() => {});
      });

      this.musicPlayer.events.on('emptyQueue', async (queue) => {
        const guildId = queue.guild.id;
        if (this.autoplayMode.get(guildId)) return; // autoplay will handle it
        const channelId = this.musicTextChannel.get(guildId);
        if (!channelId) return;
        const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!channel) return;

        const finishedEmbed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setTitle('⏹ Reprodukcija završena')
          .setDescription('Red je prazan. Dodaj novu pjesmu s `/play` ili uključi `/autoplay`.')
          .setTimestamp();

        // Edit existing now-playing message
        const existingMsgId = this.musicNowPlayingMsg.get(guildId);
        if (existingMsgId) {
          try {
            const msg = await channel.messages.fetch(existingMsgId).catch(() => null);
            if (msg) {
              await msg.edit({ embeds: [finishedEmbed], components: [] });
              this.musicNowPlayingMsg.delete(guildId);
              return;
            }
          } catch {}
          this.musicNowPlayingMsg.delete(guildId);
        }
        await channel.send({ embeds: [finishedEmbed] }).catch(() => {});
      });

      this.musicPlayer.events.on('playerError', async (queue, error, track) => {
        console.error('[MUSIC] Player error:', error.message, 'Track:', track?.title);
        const guildId = queue.guild.id;
        const channelId = this.musicTextChannel.get(guildId);
        if (!channelId) return;
        const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!channel) return;
        await channel.send({ embeds: [
          new EmbedBuilder().setColor(0xed4245).setDescription(`❌ Greška pri reprodukciji: ${error.message.slice(0, 200)}`)
        ] }).catch(() => {});
      });

      this.musicPlayer.events.on('error', async (queue, error) => {
        console.error('[MUSIC] General error:', error.message);
        const guildId = queue.guild.id;
        const channelId = this.musicTextChannel.get(guildId);
        if (!channelId) return;
        const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!channel) return;
        await channel.send({ embeds: [
          new EmbedBuilder().setColor(0xed4245).setDescription(`❌ Greška glazbenog sustava: ${error.message.slice(0, 200)}`)
        ] }).catch(() => {});
      });

      this.musicPlayer.events.on('debug', async (_queue, message) => {
        console.log('[MUSIC][DEBUG]', message);
      });

      // When a track is added to queue, refresh the now-playing embed to show updated queue
      this.musicPlayer.events.on('audioTrackAdd', async (queue, track) => {
        const guildId = queue.guild.id;
        const channelId = this.musicTextChannel.get(guildId);
        if (!channelId) return;
        const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!channel) return;
        const existingMsgId = this.musicNowPlayingMsg.get(guildId);
        if (existingMsgId && queue.currentTrack) {
          try {
            const msg = await channel.messages.fetch(existingMsgId).catch(() => null);
            if (msg) {
              const embed = this.buildNowPlayingEmbed(queue, queue.currentTrack);
              const row = this.buildMusicButtons(queue);
              await msg.edit({ embeds: [embed], components: [row] });
            }
          } catch {}
        }
      });

    } catch (e: any) {
      console.error('[MUSIC] Failed to initialize player:', e?.message || e);
      this.musicPlayer = null as any;
    }
  }

  private buildMusicButtons(queue: any): ActionRowBuilder<ButtonBuilder> {
    const isPaused = queue.node?.isPaused?.() ?? false;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('music_previous').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music_pause').setEmoji(isPaused ? '▶️' : '⏸️').setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('music_queue').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    );
  }

  private buildNowPlayingEmbed(queue: any, track: any): EmbedBuilder {
    const guildId = queue.guild.id;
    const isPaused = queue.node?.isPaused?.() ?? false;
    const embed = new EmbedBuilder()
      .setColor(isPaused ? 0xfee75c : 0x1db954)
      .setTitle(isPaused ? '⏸️ Pauzirano' : '🎵 Sada svira')
      .setDescription(`**[${track.title}](${track.url})**`)
      .addFields(
        { name: '👤 Autor', value: track.author || 'Nepoznato', inline: true },
        { name: '⏱️ Trajanje', value: track.duration || '?', inline: true },
      )
      .setFooter({ text: `Zatražio/la: ${(track.requestedBy as any)?.username ?? 'Nepoznato'}` })
      .setTimestamp();
    if (track.thumbnail) embed.setThumbnail(track.thumbnail);

    // Queue preview
    const tracks = queue.tracks?.toArray?.()?.slice(0, 5) || [];
    if (tracks.length > 0) {
      const queueText = tracks.map((t: any, i: number) => `**${i + 1}.** ${t.title} (${t.duration})`).join('\n');
      const totalInQueue = queue.tracks?.size ?? tracks.length;
      embed.addFields({
        name: `📜 Red čekanja (${totalInQueue})`,
        value: queueText + (totalInQueue > 5 ? `\n... i još ${totalInQueue - 5}` : ''),
        inline: false,
      });
    } else if (this.autoplayMode.get(guildId)) {
      embed.addFields({ name: '🔁 Autoplay', value: 'Uključen — automatski će svirati slične pjesme', inline: false });
    }
    return embed;
  }

  public getPlayerTracksData() {
    return {
      tracks: (this.playerTracks || []).map(t => ({
        id: t.id,
        nickname: t.nickname,
        distanceM: t.distanceM,
        activeMs: t.activeMs,
        idleMs: t.idleMs,
        points: (t.points || []).slice(-500),
      })),
      updatedAt: this.playerTrackingUpdatedAt?.toISOString() || null,
      mapImageUrl: this.getTrackingImageUrl('player'),
      ...(() => {
        let wMinX = Number(process.env.MAP_WORLD_MIN_X || process.env.MAP_MIN_X || -1750);
        let wMaxX = Number(process.env.MAP_WORLD_MAX_X || process.env.MAP_MAX_X || 1750);
        let wMinZ = Number(process.env.MAP_WORLD_MIN_Z || process.env.MAP_MIN_Z || -1750);
        let wMaxZ = Number(process.env.MAP_WORLD_MAX_Z || process.env.MAP_MAX_Z || 1750);
        // Auto-fix: if min==max, treat value as half-size (e.g. 1750 → -1750..1750)
        if (wMinX >= wMaxX) { const half = Math.abs(wMaxX) || 1750; wMinX = -half; wMaxX = half; }
        if (wMinZ >= wMaxZ) { const half = Math.abs(wMaxZ) || 1750; wMinZ = -half; wMaxZ = half; }
        // Map image bounds — the extent the map image actually covers (may differ from world bounds)
        const imgMinX = Number(process.env.MAP_IMAGE_MIN_X ?? wMinX);
        const imgMaxX = Number(process.env.MAP_IMAGE_MAX_X ?? wMaxX);
        const imgMinZ = Number(process.env.MAP_IMAGE_MIN_Z ?? wMinZ);
        const imgMaxZ = Number(process.env.MAP_IMAGE_MAX_Z ?? wMaxZ);
        return {
          worldMinX: wMinX, worldMaxX: wMaxX, worldMinZ: wMinZ, worldMaxZ: wMaxZ,
          mapImageMinX: imgMinX, mapImageMaxX: imgMaxX, mapImageMinZ: imgMinZ, mapImageMaxZ: imgMaxZ,
        };
      })(),
    };
  }

  private isSendableChannel(channel: any): boolean {
    return !!channel && typeof channel.send === 'function';
  }

  private isEmbedDebugEnabled(): boolean {
    return ['1', 'true', 'yes', 'on']
      .includes(String(process.env.EMBED_DEBUG || process.env.DEBUG_EMBEDS || 'false').trim().toLowerCase());
  }

  private isChannelPickerDebugEnabled(): boolean {
    return ['1', 'true', 'yes', 'on']
      .includes(String(process.env.CHANNEL_PICKER_DEBUG || process.env.DEBUG_CHANNEL_PICKER || process.env.EMBED_DEBUG || 'false').trim().toLowerCase());
  }

  private getEmbedDebugSummaryIntervalMs(): number {
    const mins = Math.max(1, Number(process.env.EMBED_DEBUG_SUMMARY_MINUTES || '5') || 5);
    return mins * 60 * 1000;
  }

  private collectEmbedTextDiagnostics(embed: EmbedBuilder) {
    const data: any = (embed as any)?.toJSON?.() || (embed as any)?.data || {};
    const fields = Array.isArray(data.fields) ? data.fields : [];
    const chunks: Array<{ label: string; text: string }> = [];

    const pushChunk = (label: string, value: any) => {
      const text = String(value ?? '').trim();
      if (!text) return;
      chunks.push({ label, text });
    };

    pushChunk('title', data.title);
    pushChunk('description', data.description);
    pushChunk('footer', data?.footer?.text);
    pushChunk('author', data?.author?.name);
    for (let i = 0; i < fields.length; i += 1) {
      const f = fields[i] || {};
      pushChunk(`field:${String(f.name || i)}`, f.value);
    }

    const missingRe = /\b(n\/a|unknown|nema podataka|nije dostupno|nije linkan|bez podataka|\u2014|--|\(nema [^)]+\)|farma \?)\b/i;
    const inferredRe = /\b(fallback|latest route|procijenjeno|pretpostav|inferred|approx|estimat|f\?)\b/i;

    const missingIndicators = chunks
      .filter(c => missingRe.test(c.text))
      .slice(0, 12)
      .map(c => c.label);

    const inferredIndicators = chunks
      .filter(c => inferredRe.test(c.text))
      .slice(0, 12)
      .map(c => c.label);

    const emptyFieldNames = fields
      .filter((f: any) => !String(f?.value ?? '').trim())
      .map((f: any) => String(f?.name || 'unnamed'))
      .slice(0, 12);

    return {
      title: String(data.title || ''),
      fieldCount: fields.length,
      descriptionLength: String(data.description || '').length,
      hasLegend: String(data.description || '').includes('**Legenda**'),
      missingIndicators,
      inferredIndicators,
      emptyFieldNames,
    };
  }

  private recordEmbedDebugSummary(scope: string, diag: { missingIndicators: string[]; inferredIndicators: string[]; title: string }, meta?: Record<string, any>) {
    if (!this.isEmbedDebugEnabled()) return;
    const panel = String((meta as any)?.panelType || 'unknown');
    const key = `${scope}:${panel}`;
    const prev = this.embedDebugStatsByScope.get(key) || { count: 0, missing: 0, inferred: 0, lastTitle: '' };
    prev.count += 1;
    if ((diag.missingIndicators || []).length > 0) prev.missing += 1;
    if ((diag.inferredIndicators || []).length > 0) prev.inferred += 1;
    prev.lastTitle = String(diag.title || prev.lastTitle || '');
    this.embedDebugStatsByScope.set(key, prev);
  }

  private flushEmbedDebugSummary(force = false) {
    if (!this.isEmbedDebugEnabled()) return;
    const now = Date.now();
    const intervalMs = this.getEmbedDebugSummaryIntervalMs();
    if (!force && (now - this.lastEmbedDebugSummaryAtMs) < intervalMs) return;
    this.lastEmbedDebugSummaryAtMs = now;

    const entries = Array.from(this.embedDebugStatsByScope.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 30)
      .map(([key, v]) => ({ key, count: v.count, withMissing: v.missing, withInferred: v.inferred, lastTitle: v.lastTitle }));
    if (entries.length > 0) {
      console.log('[EMBED-DEBUG] Summary:', JSON.stringify(entries));
    }
  }

  private async analyzeChannelPickerVisibility(interaction: any, panelType: string) {
    const guild = interaction?.guild;
    if (!guild) {
      return { panelType, error: 'no-guild' };
    }

    await guild.channels.fetch().catch(() => null);
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const userMember = interaction.member ?? await guild.members.fetch(interaction.user?.id).catch(() => null);

    let total = 0;
    let sendable = 0;
    let userVisible = 0;
    let userSendable = 0;
    let botVisible = 0;
    let botSendable = 0;
    const hiddenByUser: string[] = [];
    const blockedForBot: string[] = [];

    for (const ch of guild.channels.cache.values()) {
      const channel: any = ch as any;
      const isSendable = this.isSendableChannel(channel);
      const userPerms = userMember ? channel.permissionsFor(userMember) : null;
      const botPerms = botMember ? channel.permissionsFor(botMember) : null;

      const userCanView = !!userPerms?.has?.('ViewChannel');
      const userCanSend = !!userPerms?.has?.('SendMessages');
      const botCanView = !!botPerms?.has?.('ViewChannel');
      const botCanSend = !!botPerms?.has?.('SendMessages');

      total += 1;
      if (isSendable) sendable += 1;
      if (userCanView) userVisible += 1;
      if (userCanView && userCanSend && isSendable) userSendable += 1;
      if (botCanView) botVisible += 1;
      if (botCanView && botCanSend && isSendable) botSendable += 1;

      if (!userCanView && hiddenByUser.length < 12) {
        hiddenByUser.push(String(channel.name || channel.id || 'unknown'));
      }
      if (userCanView && isSendable && (!botCanView || !botCanSend) && blockedForBot.length < 12) {
        blockedForBot.push(String(channel.name || channel.id || 'unknown'));
      }
    }

    return {
      panelType,
      guildId: guild.id,
      userId: interaction.user?.id,
      totalChannels: total,
      sendableChannels: sendable,
      userVisible,
      userSendable,
      botVisible,
      botSendable,
      hiddenByUser,
      blockedForBot,
    };
  }

  private async debugChannelPickerVisibility(interaction: any, panelType: string) {
    if (!this.isChannelPickerDebugEnabled()) return;
    try {
      const report = await this.analyzeChannelPickerVisibility(interaction, panelType);
      console.log('[DEBUG] Channel picker visibility:', JSON.stringify(report));
    } catch (e: any) {
      console.error('[DEBUG] Channel picker analysis failed:', e?.message || e);
    }
  }

  private debugEmbed(scope: string, embed: EmbedBuilder, meta?: Record<string, any>) {
    if (!this.isEmbedDebugEnabled()) return;
    try {
      const d = this.collectEmbedTextDiagnostics(embed);
      this.recordEmbedDebugSummary(scope, d, meta);
      const payload = {
        scope,
        ...meta,
        title: d.title,
        fieldCount: d.fieldCount,
        descriptionLength: d.descriptionLength,
        hasLegend: d.hasLegend,
        missingIndicators: d.missingIndicators,
        inferredIndicators: d.inferredIndicators,
        emptyFieldNames: d.emptyFieldNames,
      };
      this.flushEmbedDebugSummary(false);
    } catch (e) {
    }
  }

  private debugEmbedBatch(scope: string, embeds: EmbedBuilder[], meta?: Record<string, any>) {
    if (!this.isEmbedDebugEnabled()) return;
    for (let i = 0; i < embeds.length; i += 1) {
      this.debugEmbed(scope, embeds[i], { ...meta, index: i });
    }
  }

  private setupListeners() {
    this.client.on('clientReady', async () => {
      console.log(`Logged in as ${this.client.user?.tag}!`);
      this.isConnected = true;
      this.startTime = Date.now();
      this.lastEmbedDebugSummaryAtMs = 0;
      this.flushEmbedDebugSummary(true);

      // Po defaultu zadrži kontinuitet podataka nakon restarta.
      // Ako baš želiš hard reset sesija/online state-a, postavi RESET_SESSIONS_ON_START=true.
      const doHardResetOnStart = ['1', 'true', 'yes', 'on']
        .includes(String(process.env.RESET_SESSIONS_ON_START || 'false').trim().toLowerCase());
      if (doHardResetOnStart) {
        this.runtimeSessionStartedAtByPlayer.clear();
        this.runtimePresenceStateByPlayer.clear();
        this.lastRuntimePresenceEmitAtByPlayer.clear();
        this.lastLeaveTrackingAtByPlayer.clear();
        this.logTrackWindowByMessage.clear();
        this.logTrackPlayerByMessage.clear();
        try {
          await storage.setAllPlayersOffline();
        } catch (e) {
          console.error('Failed to reset players online state on startup:', e);
        }
      }
      
      await storage.log({
        type: 'info',
        message: `Bot started as ${this.client.user?.tag}`
      });

      const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;

      // Ensure "Poljski WC" voice channel is set as AFK channel
      if (guildId) {
        try {
          const guild = this.client.guilds.cache.get(guildId);
          if (guild) {
            const afkVc = guild.channels.cache.find(
              (ch: any) => ch.type === 2 && ch.name.toLowerCase().includes('poljski wc')
            );
            if (afkVc && guild.afkChannelId !== afkVc.id) {
              await guild.setAFKChannel(afkVc.id as any);
              await guild.setAFKTimeout(300); // 5 minutes
            }
          }
        } catch (e) {
          console.error('[AFK] Failed to set AFK channel:', e);
        }
      }

      // ── Resume incomplete restore if bot restarted mid-restore ──
      if (guildId) {
        try {
          const restoreState = await storage.getRestoreState(guildId);
          if (restoreState && restoreState.backupId) {
            console.log(`[RESTORE-RESUME] Found incomplete restore for guild ${guildId}: backup=${restoreState.backupId}, done=${restoreState.channelsDone?.length || 0} channels, ${restoreState.messagesPosted || 0} messages`);
            const guild = this.client.guilds.cache.get(restoreState.targetGuildId || guildId);
            if (guild) {
              // Resume in background
              this.restoreBackupFromDashboard(
                guildId,
                restoreState.backupId,
                restoreState.mode || 'messages',
                restoreState.channelNames || null,
                restoreState.targetGuildId || null,
                restoreState.targetChannelId || null,
              ).then((result) => {
                console.log(`[RESTORE-RESUME] Restore completed: ${result.messagesPosted} messages posted`);
              }).catch((err) => {
                console.error(`[RESTORE-RESUME] Restore failed:`, err.message);
              });
            }
          }
        } catch (e) {
          console.error('[RESTORE-RESUME] Error checking restore state:', e);
        }
      }

      // Reorder channels to match CATEGORIES config
      if (guildId) {
        try {
          const guild = this.client.guilds.cache.get(guildId);
          if (guild) {
            const config = await readChannelConfig();
            const cats = config.categories.length > 0 ? config.categories : CATEGORIES;
            const posUpdates: Array<{ channel: string; position: number; parent?: string }> = [];

            for (const catDef of cats) {
              const category = guild.channels.cache.find((c: any) => c.type === 4 && c.name === catDef.name);
              if (!category) continue;

              for (let i = 0; i < catDef.channels.length; i++) {
                const chDef = catDef.channels[i];
                const chType = chDef.type === 'voice' ? 2 : chDef.type === 'forum' ? 15 : 0;
                // Search in ALL channels (might be in wrong category)
                let ch = guild.channels.cache.find((c: any) => c.type === chType && c.name === chDef.name);
                if (!ch) {
                  const fallback = chDef.name.split('┃')[1]?.trim();
                  if (fallback) ch = guild.channels.cache.find((c: any) => c.type === chType && c.name.includes(fallback));
                }
                if (ch) {
                  posUpdates.push({ channel: ch.id, position: i, parent: category.id });
                }
              }
            }

            if (posUpdates.length > 0) {
              await guild.channels.setPositions(posUpdates);
            }
          }
        } catch (e) {
          console.error('[CHANNEL-SORT] Failed to reorder channels:', e);
        }
      }

      // Auto-post embeds in channels that have autoEmbed config but no bot messages
      // Run for ALL guilds the bot is in
      try {
        const config = await readChannelConfig();
        const cats: (CategoryDef | CategoryDef_Saved)[] = config.categories.length > 0 ? config.categories : CATEGORIES;
        // Merge autoEmbed from defaults if saved config lost them
        if (config.categories.length > 0) {
          const defaultAutoEmbeds = new Map<string, ChannelDef['autoEmbed']>();
          for (const cat of CATEGORIES) {
            for (const ch of cat.channels) {
              if (ch.autoEmbed) defaultAutoEmbeds.set(plainName(ch.name), ch.autoEmbed);
            }
          }
          for (const cat of cats) {
            for (const ch of cat.channels) {
              if (!(ch as ChannelDef).autoEmbed) {
                const embed = defaultAutoEmbeds.get(plainName(ch.name));
                if (embed) (ch as any).autoEmbed = embed;
              }
            }
          }
        }
        for (const [, guild] of this.client.guilds.cache) {
          for (const catDef of cats) {
            for (const chDef of catDef.channels) {
              if (!chDef.autoEmbed) continue;
              // Skip launcher channel — handled by updateLauncherChannel() which fetches live GitHub release URL
              if (plainName(chDef.name) === 'launcher') continue;
              // Fuzzy channel match: exact name OR normalized plain name
              const defPlain = plainName(chDef.name);
              const ch = guild.channels.cache.find((c: any) => {
                if (c.type !== 0) return false;
                if (c.name === chDef.name) return true;
                const cPlain = plainName(c.name);
                return cPlain === defPlain;
              });
              if (!ch || !('messages' in ch)) continue;
              try {
                const msgs = await (ch as any).messages.fetch({ limit: 10 });
                const hasBotEmbed = msgs.some((m: any) => m.author?.id === this.client.user?.id && m.embeds?.length > 0);
                if (!hasBotEmbed) {
                  await this.postAutoEmbed(guild.id, ch.id, chDef.autoEmbed);
                  console.log(`[AUTO-EMBED] Posted embed in ${chDef.name} (guild: ${guild.name})`);
                }
              } catch (e: any) {
                console.log(`[AUTO-EMBED] Skip ${chDef.name}: ${e.message}`);
              }
            }
          }
        }
      } catch (e) {
        console.error('[AUTO-EMBED] Failed:', e);
      }
      
      // Register commands on all guilds the bot is in
      const guildIds = new Set<string>();
      if (guildId) guildIds.add(guildId);
      const testGuildId = process.env.TEST_GUILD_ID;
      if (testGuildId) guildIds.add(testGuildId);
      // Also include any guild the bot is currently in
      for (const [id] of this.client.guilds.cache) guildIds.add(id);

      const slashCommands = [
            new SlashCommandBuilder()
              .setName('status')
              .setDescription('Provjeri status Slavonska Ravnica bota'),
            new SlashCommandBuilder()
              .setName('farms')
              .setDescription('Prikaži sve registrirane farme'),
            new SlashCommandBuilder()
              .setName('fields')
              .setDescription('Prikaži stanje polja'),
            new SlashCommandBuilder()
              .setName('vehicles')
              .setDescription('Prikaži vozila na farmi'),
            new SlashCommandBuilder()
              .setName('silos')
              .setDescription('Prikaži stanje silosa'),
            new SlashCommandBuilder()
              .setName('animals')
              .setDescription('Prikaži stanje životinja'),
            new SlashCommandBuilder()
              .setName('weather')
              .setDescription('Prikaži vremensku prognozu'),

            new SlashCommandBuilder()
              .setName('say')
              .setDescription('Pošalji poruku u FS25 chat')
              .addStringOption(o => o.setName('message').setDescription('Poruka').setRequired(true)),

new SlashCommandBuilder()
              .setName('sync')
              .setDescription('Ručno pokreni sinkronizaciju sa FS25 servera'),
            new SlashCommandBuilder()
              .setName('panel')
              .setDescription('Postavi panel u odabrani kanal')
              .addStringOption(option =>
                option.setName('tip')
                  .setDescription('Tip panela za postavljanje')
                  .setRequired(true)
                  .addChoices(
                    { name: 'Admin Panel', value: 'admin' },
                    { name: 'Server Info', value: 'server_info' },
                    { name: 'Status', value: 'status' },
                    { name: 'Polja', value: 'fields' },
                    { name: 'Vozila', value: 'vehicles' },
                    { name: 'Povijest vozila', value: 'vehicleHistory' },
                    { name: 'Silosi', value: 'silos' },
                    { name: 'Zivotinje', value: 'animals' },
                    { name: 'Vrijeme', value: 'weather' },
                    { name: 'Proizvodnje', value: 'productions' },
                    { name: 'Igraci', value: 'players' },
                    { name: 'Player Hours (javno)', value: 'player_hours' },
                    { name: 'Mapa kretanja (tracks)', value: 'map_tracks' },
                    { name: 'Poslovi', value: 'jobs' },
                    { name: 'Linkanje', value: 'linking' },
                    { name: 'Farme', value: 'farms' },
                    { name: 'Poslovi (ugovori)', value: 'custom_contracts' }
                  ))
              .addChannelOption(option =>
                option.setName('kanal')
                  .setDescription('Kanal u koji postavljas panel')
                  .setRequired(true))
              .addStringOption(option =>
                option.setName('farma')
                  .setDescription('Filtriraj po farmi (opcionalno)')
                  .setRequired(false)),
            new SlashCommandBuilder()
              .setName('admin')
              .setDescription('Postavi Admin Panel u trenutni kanal'),
            new SlashCommandBuilder()
              .setName('debugchannels')
              .setDescription('Debug prikaz vidljivosti kanala za deploy picker')
              .addStringOption(option =>
                option.setName('panel')
                  .setDescription('Opcionalno: tip panela (npr. players, status, vehicles)')
                  .setRequired(false)),
            new SlashCommandBuilder()
              .setName('provjera')
              .setDescription('Posalji provjeru aktivnosti korisniku putem DM-a')
              .addUserOption(option =>
                option.setName('user')
                  .setDescription('Korisnik kojem saljes provjeru')
                  .setRequired(true)),
            new SlashCommandBuilder()
              .setName('whitelist')
              .setDescription('Upravljaj whitelistom za launcher')
              .addSubcommand(sub => sub
                .setName('add')
                .setDescription('Dodaj igrača na whitelist')
                .addUserOption(o => o.setName('user').setDescription('Korisnik').setRequired(true)))
              .addSubcommand(sub => sub
                .setName('remove')
                .setDescription('Makni igrača s whiteliste')
                .addUserOption(o => o.setName('user').setDescription('Korisnik').setRequired(true)))
              .addSubcommand(sub => sub
                .setName('list')
                .setDescription('Prikaži sve whitelistane igrače')),
            new SlashCommandBuilder()
              .setName('server')
              .setDescription('Upravljaj Discord serverom')
              .addSubcommand(sub => sub
                .setName('setup')
                .setDescription('Kreiraj/ažuriraj sve kanale, role i permisije'))
              .addSubcommand(sub => sub
                .setName('roles')
                .setDescription('Ručno pokreni provjeru nagradnih rola'))
              .addSubcommand(sub => sub
                .setName('farmassign')
                .setDescription('Ručno dodijeli igrača farmi')
                .addUserOption(o => o.setName('user').setDescription('Korisnik').setRequired(true))
                .addStringOption(o => o.setName('farm').setDescription('Ime ili ID farme').setRequired(true))),
            new SlashCommandBuilder()
              .setName('moderacija')
              .setDescription('Moderacija za Discord i FS25 igrače')
              .addSubcommand(sub => sub
                .setName('find')
                .setDescription('Pronađi live ili arhivirani zapis igrača')
                .addStringOption(o => o.setName('target').setDescription('Discord ID, game ID, nick ili tag').setRequired(true)))
              .addSubcommand(sub => sub
                .setName('ban')
                .setDescription('Banaj člana na Discordu i/ili u igri')
                .addUserOption(o => o.setName('user').setDescription('Korisnik').setRequired(true))
                .addStringOption(o => o.setName('razlog').setDescription('Razlog bana').setRequired(true))
                .addBooleanOption(o => o.setName('discord').setDescription('Ban na Discordu (default: da)'))
                .addBooleanOption(o => o.setName('igra').setDescription('Ban u igri (default: da)'))
                .addBooleanOption(o => o.setName('brisi_poruke').setDescription('Obriši sve poruke ovog korisnika (default: ne)'))
                .addStringOption(o => o.setName('nick').setDescription('Ručno zadaj in-game nick ako link ne postoji')))
              .addSubcommand(sub => sub
                .setName('banoffline')
                .setDescription('Naknadni ban preko arhive ili linka')
                .addStringOption(o => o.setName('target').setDescription('Discord ID, game ID, nick ili tag').setRequired(true))
                .addStringOption(o => o.setName('razlog').setDescription('Razlog bana').setRequired(true))
                .addBooleanOption(o => o.setName('discord').setDescription('Ban na Discordu (default: da)'))
                .addBooleanOption(o => o.setName('igra').setDescription('Ban u igri (default: da)'))
                .addBooleanOption(o => o.setName('brisi_poruke').setDescription('Obriši sve poruke ovog korisnika (default: ne)'))
                .addStringOption(o => o.setName('nick').setDescription('Ručno zadaj in-game nick ako ga arhiva nema')))
              .addSubcommand(sub => sub
                .setName('kick')
                .setDescription('Kickaj člana s Discorda i/ili iz igre')
                .addUserOption(o => o.setName('user').setDescription('Korisnik').setRequired(true))
                .addStringOption(o => o.setName('razlog').setDescription('Razlog kicka').setRequired(false))
                .addBooleanOption(o => o.setName('discord').setDescription('Kick s Discorda (default: da)'))
                .addBooleanOption(o => o.setName('igra').setDescription('Kick iz igre (default: da)'))
                .addBooleanOption(o => o.setName('brisi_poruke').setDescription('Obriši sve poruke ovog korisnika (default: ne)'))
                .addStringOption(o => o.setName('nick').setDescription('Ručno zadaj in-game nick ako link ne postoji')))
              .addSubcommand(sub => sub
                .setName('timeout')
                .setDescription('Stavi timeout na Discord korisnika')
                .addUserOption(o => o.setName('user').setDescription('Korisnik').setRequired(true))
                .addIntegerOption(o => o.setName('minute').setDescription('Koliko minuta').setRequired(true).setMinValue(1).setMaxValue(40320))
                .addStringOption(o => o.setName('razlog').setDescription('Razlog timeouta').setRequired(false)))
              .addSubcommand(sub => sub
                .setName('unban-discord')
                .setDescription('Makni Discord ban po korisničkom ID-u')
                .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true)))
              .addSubcommand(sub => sub
                .setName('unban-igra')
                .setDescription('Makni in-game ban po nicku')
                .addStringOption(o => o.setName('nick').setDescription('In-game nickname').setRequired(true))),
            new SlashCommandBuilder()
              .setName('obavijest')
              .setDescription('Pošalji obavijest svima s NotifyMe rolom')
              .addStringOption(o => o.setName('poruka').setDescription('Tekst obavijesti').setRequired(true)),
            new SlashCommandBuilder()
              .setName('backup')
              .setDescription('Napravi backup kanala i poruka servera u MongoDB')
              .addStringOption(o => o.setName('name').setDescription('Naziv backupa (npr. "prije-reseta")').setRequired(true))
              .addChannelOption(o => o.setName('channel').setDescription('Odaberi kanal za backup (prazno = cijeli server)')),
            new SlashCommandBuilder()
              .setName('restore')
              .setDescription('Vrati backup iz MongoDB baze')
              .addStringOption(o => o.setName('mode').setDescription('messages = samo poruke, full = kanali + role + poruke').addChoices(
                { name: 'full — kanali, role i poruke', value: 'full' },
                { name: 'messages — samo poruke u postojeće kanale', value: 'messages' },
              ).setRequired(true))
              .addChannelOption(o => o.setName('channel').setDescription('Odaberi ciljni kanal za restore (prazno = po imenu kanala iz backupa)')),
            new SlashCommandBuilder()
              .setName('backups')
              .setDescription('Prikaži listu svih backupa spremljenih u bazi'),
            new SlashCommandBuilder()
              .setName('forcerestore')
              .setDescription('⚠️ Potpuni restore servera — briše SVE role/kanale i vraća iz backupa'),
            new SlashCommandBuilder()
              .setName('channels')
              .setDescription('Upravljaj kanalima — dodaj, ukloni, deployaj kanale interaktivno'),
            new SlashCommandBuilder()
              .setName('settings')
              .setDescription('Postavi koji kanal se koristi za logove, welcome, chat bridge itd.'),
            new SlashCommandBuilder()
              .setName('ai')
              .setDescription('Pitaj AI asistenta za pomoć')
              .addStringOption(o => o.setName('pitanje').setDescription('Što te zanima?').setRequired(true)),
            // ── Music commands ──
            new SlashCommandBuilder()
              .setName('play')
              .setDescription('Pusti pjesmu s YouTubea (link ili pretraga)')
              .addStringOption(o => o.setName('query').setDescription('YouTube link ili naziv pjesme').setRequired(true)),
            new SlashCommandBuilder()
              .setName('skip')
              .setDescription('Preskoči trenutnu pjesmu'),
            new SlashCommandBuilder()
              .setName('stop')
              .setDescription('Zaustavi reprodukciju i očisti red'),
            new SlashCommandBuilder()
              .setName('pause')
              .setDescription('Pauziraj ili nastavi reprodukciju'),
            new SlashCommandBuilder()
              .setName('queue')
              .setDescription('Prikaži red čekanja pjesama'),
            new SlashCommandBuilder()
              .setName('autoplay')
              .setDescription('Uključi/isključi autoplay — automatski svira slične pjesme'),
            new SlashCommandBuilder()
              .setName('radio')
              .setDescription('Slušaj hrvatski radio stream')
              .addStringOption(o => o.setName('stanica').setDescription('Odaberi radio stanicu').setRequired(true)
                .addChoices(
                  { name: '📻 Otvoreni', value: 'otvoreni' },
                  { name: '📻 Narodni', value: 'narodni' },
                  { name: '📻 Yammat FM', value: 'yammat' },
                  { name: '📻 Enter Zagreb', value: 'enter' },
                  { name: '📻 Gold FM', value: 'gold' },
                  { name: '📻 Antena Zagreb', value: 'antena' },
                  { name: '📻 Extra FM', value: 'extra' },
                  { name: '📻 Bravo', value: 'bravo' },
                )),
            new SlashCommandBuilder()
              .setName('np')
              .setDescription('Prikaži koja pjesma trenutno svira'),
            new SlashCommandBuilder()
              .setName('farme')
              .setDescription('Razvrstaj igrače po farmama — interaktivni prikaz'),
            new SlashCommandBuilder()
              .setName('poslovi')
              .setDescription('Prikaži aktivne poslove na ugovor (Custom Contracts)'),
          ];

      for (const gId of guildIds) {
        const guild = this.client.guilds.cache.get(gId);
        if (guild) {
          await guild.commands.set(slashCommands);
          console.log(`Slash commands registered on guild ${guild.name} (${gId})`);
        }
      }

      // Store for guildCreate reuse
      this._slashCommands = slashCommands;
    });

    // Auto-register commands when bot joins a new guild
    this.client.on('guildCreate', async (guild: any) => {
      console.log(`[GUILD_CREATE] Joined new guild: ${guild.name} (${guild.id})`);
      if (this._slashCommands) {
        try {
          await guild.commands.set(this._slashCommands);
          console.log(`Slash commands registered on new guild ${guild.name} (${guild.id})`);
        } catch (err) {
          console.error(`Failed to register commands on ${guild.name}:`, err);
        }
      }
    });

    this.client.on('interactionCreate', async (interaction) => {
      try {
      // Handle button clicks
      if (interaction.isButton()) {
        try {
          await this.handleButtonClick(interaction);
        } catch (error: any) {
          console.error('Button click error:', error);
          try {
            if (!(interaction as any).replied && !(interaction as any).deferred) {
              await (interaction as any).reply({ content: `Greška: ${error.message}`, ephemeral: true });
            }
          } catch {}
        }
        return;
      }

      // Handle select menus
      if (interaction.isStringSelectMenu()) {
        try {
          await this.handleSelectMenu(interaction);
        } catch (error: any) {
          console.error('Select menu error:', error);
        }
        return;
      }

      // Handle user select menus
      if (interaction.isUserSelectMenu()) {
        try {
          await this.handleUserSelectMenu(interaction);
        } catch (error: any) {
          console.error('User select error:', error);
        }
        return;
      }

      // Handle channel select menus
      if (interaction.isChannelSelectMenu()) {
        try {
          await this.handleChannelSelect(interaction);
        } catch (error: any) {
          console.error('Channel select error:', error);
        }
        return;
      }

      // Handle modal submissions
      if (interaction.isModalSubmit()) {
        try {
          await this.handleModalSubmit(interaction);
        } catch (error: any) {
          console.error('Modal submit error:', error);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      try {
        switch (interaction.commandName) {
          case 'status':
            await this.handleStatusCommand(interaction);
            break;
          case 'farms':
            await this.handleFarmsCommand(interaction);
            break;
          case 'fields':
            await this.handleFieldsCommand(interaction);
            break;
          case 'vehicles':
            await this.handleVehiclesCommand(interaction);
            break;
          case 'silos':
            await this.handleSilosCommand(interaction);
            break;
          case 'animals':
            await this.handleAnimalsCommand(interaction);
            break;
          case 'weather':
            await this.handleWeatherCommand(interaction);
            break;
          case 'say':
            await this.handleSayCommand(interaction);
            break;
          case 'sync':
            await this.handleSyncCommand(interaction);
            break;
          case 'panel':
            await this.handlePanelCommand(interaction);
            break;
          case 'admin':
            await this.handleAdminCommand(interaction);
            break;
          case 'debugchannels':
            await this.handleDebugChannelsCommand(interaction);
            break;
          case 'provjera':
            await this.handleProvjeraCommand(interaction);
            break;
          case 'whitelist':
            await this.handleWhitelistCommand(interaction);
            break;
          case 'server':
            await this.handleServerSetupCommand(interaction);
            break;
          case 'moderacija':
            await this.handleModeracijaCommand(interaction);
            break;
          case 'obavijest':
            await this.handleObavijestCommand(interaction);
            break;
          case 'backup':
            await this.handleBackupCommand(interaction);
            break;
          case 'restore':
            await this.handleRestoreCommand(interaction);
            break;
          case 'backups':
            await this.handleBackupsListCommand(interaction);
            break;
          case 'forcerestore':
            await this.handleForceRestoreCommand(interaction);
            break;
          case 'channels':
            await this.handleChannelsCommand(interaction);
            break;
          case 'settings':
            await this.handleSettingsCommand(interaction);
            break;
          case 'ai':
            await this.handleAiCommand(interaction);
            break;
          // ── Music commands ──
          case 'play':
            await this.handlePlayCommand(interaction);
            break;
          case 'skip':
            await this.handleSkipCommand(interaction);
            break;
          case 'stop':
            await this.handleStopCommand(interaction);
            break;
          case 'pause':
            await this.handlePauseCommand(interaction);
            break;
          case 'queue':
            await this.handleQueueCommand(interaction);
            break;
          case 'autoplay':
            await this.handleAutoplayCommand(interaction);
            break;
          case 'radio':
            await this.handleRadioCommand(interaction);
            break;
          case 'np':
            await this.handleNowPlayingCommand(interaction);
            break;
          case 'farme':
            await this.handleFarmeCommand(interaction);
            break;
          case 'poslovi':
            await this.handlePosloviCommand(interaction);
            break;
        }
      } catch (error: any) {
        console.error('Command error:', error);
        try {
          if (interaction.deferred) {
            await interaction.editReply({ content: 'Došlo je do greške pri izvršavanju naredbe.' });
          } else if (!interaction.replied) {
            await interaction.reply({ content: 'Došlo je do greške pri izvršavanju naredbe.', ephemeral: true });
          }
        } catch {}
      }
      } catch (outerError: any) {
        console.error('[INTERACTION] Unhandled error in interactionCreate:', outerError);
      }
    });

    // Discord -> FS25 chat bridge
    // Poruke koje počinju s "!" u farm-chat kanalu šalju se u in-game chat.
    this.client.on('messageCreate', async (message) => {
      try {
        if (!message || !message.guild) return;
        if ((message as any).author?.bot) return;

        // Find farm-chat channel
        const farmChatChannel = await getGuildChannel(message.guild, 'farm-chat');
        if (!farmChatChannel) return;
        if (String(message.channelId) !== farmChatChannel.id) return;

        const raw = String(message.content || '');
        if (!raw.startsWith('!')) return;

        const msg = raw.slice(1).trim();
        if (!msg) return;

        const fromUser = (message.member?.displayName || message.author?.username || 'DiscordUser').slice(0, 48);
        await this.sendChatToGame(msg, fromUser);

        // Add checkmark reaction to confirm it was sent
        await message.react('✅').catch(() => {});

      } catch (e) {
        console.error('Discord->FS25 bridge error:', e);
      }
    });

    // ─── Snippet system (!! = public snippet, ! = admin-only note) ──────
    // SNIPPETS is defined at module level (above) so ticket handlers can access it too

    this.client.on('messageCreate', async (message) => {
      try {
        if (!message || !message.guild) return;
        if (message.author?.bot) return;

        const raw = String(message.content || '');

        // Skip if this is the farm-chat bridge channel (handled by the bridge handler above)
        const farmChatCh = await getGuildChannel(message.guild, 'farm-chat');
        if (farmChatCh && String(message.channelId) === farmChatCh.id) return;

        // Check admin/owner permission
        const adminRoleId = String(process.env.ADMIN_ROLE_ID || '').trim();
        const isAdmin = this.isOwner(message.author.id)
          || (adminRoleId && message.member?.roles?.cache?.has(adminRoleId))
          || message.member?.permissions?.has('Administrator');
        if (!isAdmin) return;

        // !!? = snippet preview (ephemeral-like, self-deletes)
        if (raw.startsWith('!!?') || raw.startsWith('!!preview ')) {
          const snippetName = raw.replace(/^!!(\?|preview)\s*/, '').trim().toLowerCase();
          if (!snippetName) {
            await message.reply({ content: '❌ Navedi snippet: `!!?dobrodosao`' }).catch(() => null);
            return;
          }
          const snippet = SNIPPETS[snippetName];
          if (!snippet) {
            await message.reply({ content: `❌ Nepoznat snippet: \`${snippetName}\`\nKoristi \`!!help\` za listu.` }).catch(() => null);
            return;
          }

          await message.delete().catch(() => null);

          const embed = new EmbedBuilder()
            .setColor(snippet.color)
            .setTitle(`[PREVIEW] ${snippet.title}`)
            .setDescription(snippet.description)
            .setFooter({ text: `Preview — samo ti vidiš ovo (briše se za 30s)` })
            .setTimestamp();
          if (snippet.fields) embed.addFields(snippet.fields);

          const sendOpts: any = { embeds: [embed] };
          if (snippet.buttons?.length) {
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...snippet.buttons.map(b => new ButtonBuilder().setLabel(b.label).setStyle(ButtonStyle.Link).setURL(b.url))
            );
            sendOpts.components = [row];
          }

          const sent = await message.channel.send(sendOpts).catch(() => null);
          if (sent) {
            setTimeout(() => { sent.delete().catch(() => null); }, 30_000);
          }
          return;
        }

        // !! = public snippet
        if (raw.startsWith('!!')) {
          const snippetName = raw.slice(2).trim().toLowerCase();
          if (!snippetName) return;

          const snippet = SNIPPETS[snippetName];
          if (!snippet) {
            await message.reply({ content: `❌ Nepoznat snippet: \`${snippetName}\`\nKoristi \`!!help\` za listu.` }).catch(() => null);
            return;
          }

          // Delete the command message
          await message.delete().catch(() => null);

          const embed = new EmbedBuilder()
            .setColor(snippet.color)
            .setTitle(snippet.title)
            .setDescription(snippet.description)
            .setFooter({
              text: message.guild.name,
              iconURL: message.guild.iconURL({ size: 64 }) || undefined,
            })
            .setTimestamp();

          if (snippet.fields) {
            embed.addFields(snippet.fields);
          }

          const sendOpts2: any = { embeds: [embed] };
          if (snippet.buttons?.length) {
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...snippet.buttons.map(b => new ButtonBuilder().setLabel(b.label).setStyle(ButtonStyle.Link).setURL(b.url))
            );
            sendOpts2.components = [row];
          }

          await message.channel.send(sendOpts2).catch(() => null);
          return;
        }

        // ! = admin-only note (visible only in channel, deleted after sending summary)
        if (raw.startsWith('!') && !raw.startsWith('!!')) {
          const noteText = raw.slice(1).trim();
          if (!noteText) return;

          // Delete the original command
          await message.delete().catch(() => null);

          const embed = new EmbedBuilder()
            .setColor(0x6b7280)
            .setTitle('📌 Admin bilješka')
            .setDescription(noteText)
            .addFields(
              { name: '👮 Admin', value: `${message.author.tag}`, inline: true },
              { name: '📃 Kanal', value: `<#${message.channelId}>`, inline: true },
            )
            .setFooter({ text: 'Samo admini vide ovu poruku' })
            .setTimestamp();

          // Send as a reply that self-destructs after 30 seconds
          const sent = await message.channel.send({ embeds: [embed] }).catch(() => null);
          if (sent) {
            setTimeout(() => { sent.delete().catch(() => null); }, 30_000);
          }
          return;
        }
      } catch (e) {
        console.error('[SNIPPETS] Error:', e);
      }
    });

    // ─── Konzola — Direct game commands from Discord ────────────────────
    // Staff types commands in the KONZOLA channel → XML uploaded to companion inbox
    const KONZOLA_COMMANDS: Record<string, { desc: string; args: string[]; optionalArgs?: string[] }> = {
      sendChat:          { desc: 'Pošalji poruku u in-game chat',             args: ['content'] },
      sendPrivateMsg:    { desc: 'Pošalji privatnu poruku igraču',            args: ['uniqueUserId', 'content'] },
      kickUser:          { desc: 'Izbaci igrača sa servera',                  args: ['userNickname'] },
      banUser:           { desc: 'Baniraj igrača',                            args: ['userNickname'] },
      unBanUser:         { desc: 'Makni ban s igrača',                        args: ['userNickname'] },
      makeFarmManager:   { desc: 'Postavi igrača kao upravitelja farme',      args: ['userNickname', 'farmId'] },
      saveGame:          { desc: 'Spremi igru',                               args: [] },
      setTimeScale:      { desc: 'Postavi brzinu vremena (1-120)',            args: ['timeScale'] },
      setTargetTime:     { desc: 'Postavi ciljno vrijeme (sat:minuta)',       args: ['hour', 'minute'] },
      createFarm:        { desc: 'Kreiraj novu farmu',                        args: ['name'], optionalArgs: ['color', 'password'] },
      deleteFarm:        { desc: 'Obriši farmu',                              args: ['farmId'] },
      moneyTransfer:     { desc: 'Prebaci novac na farmu',                    args: ['farmId', 'amount'] },
      purchaseFarmland:  { desc: 'Kupi zemljište',                            args: ['farmlandId', 'farmId'] },
      sellFarmland:      { desc: 'Prodaj zemljište',                          args: ['farmlandId', 'farmId'] },
      transferVehicle:   { desc: 'Prebaci vozilo između farmi',               args: ['vehicleId', 'farmId'] },
      repairVehicle:     { desc: 'Popravi vozilo',                            args: ['vehicleId'] },
      coopSiloStore:     { desc: 'Dodaj resurse u coop silos',               args: ['farmId', 'fillType', 'amount'] },
      coopPalletStore:   { desc: 'Dodaj palete u coop',                      args: ['farmId', 'configFileName', 'fillTypeName'] },
      coopBaleStore:     { desc: 'Dodaj bale u coop',                        args: ['farmId', 'xmlFilename', 'fillLevel'] },
      setSetting:        { desc: 'Promijeni server postavke',                 args: ['settingName', 'settingValue', 'settingType'] },
      setFieldState:     { desc: 'Postavi stanje polja',                     args: ['fieldId', 'groundType'], optionalArgs: ['fruitType', 'growthState', 'plowLevel', 'sprayLevel', 'limeLevel', 'weedState', 'stoneLevel', 'rollerLevel', 'stubbleShredLevel'] },
    };

    this.client.on('messageCreate', async (message) => {
      try {
        if (!message || !message.guild || message.author?.bot) return;

        // Only process messages in KONZOLA channel
        const konzolaChannel = await getGuildChannel(message.guild, 'console');
        if (!konzolaChannel || message.channelId !== konzolaChannel.id) return;

        const raw = String(message.content || '').trim();
        if (!raw) return;

        // Check if user is staff
        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        const isStaff = member?.roles.cache.some((r: any) =>
          ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
        );
        if (!isStaff) {
          const deny = await message.reply({ content: '❌ Samo staff može koristiti konzolu.' });
          setTimeout(() => { deny.delete().catch(() => null); message.delete().catch(() => null); }, 5000);
          return;
        }

        // Parse: `help` shows help
        if (raw.toLowerCase() === 'help' || raw === '?') {
          const helpLines = Object.entries(KONZOLA_COMMANDS).map(([cmd, info]) => {
            const argStr = info.args.length ? ' ' + info.args.map(a => `<${a}>`).join(' ') : '';
            const optStr = info.optionalArgs?.length ? ' ' + info.optionalArgs.map(a => `[${a}]`).join(' ') : '';
            return `\`${cmd}${argStr}${optStr}\` — ${info.desc}`;
          });
          const embed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('🔧 Konzola — Pomoć')
            .setDescription(helpLines.join('\n'))
            .setFooter({ text: 'Piši komandu direktno u kanal' })
            .setTimestamp();
          await message.reply({ embeds: [embed] });
          return;
        }

        // Parse command: first word is command name, rest are args
        // Support quoted arguments: sendChat "Hello World" or sendChat Hello World
        const parts: string[] = [];
        const regex = /"([^"]+)"|(\S+)/g;
        let match;
        while ((match = regex.exec(raw)) !== null) {
          parts.push(match[1] || match[2]);
        }

        const cmdName = parts[0];
        const cmdArgs = parts.slice(1);

        const cmdDef = KONZOLA_COMMANDS[cmdName];
        if (!cmdDef) {
          await message.reply({ content: `❌ Nepoznata komanda: \`${escapeXml(cmdName)}\`\nKoristi \`help\` za popis komandi.` });
          return;
        }

        // For sendChat, join all remaining args as content
        if (cmdName === 'sendChat' && cmdArgs.length > 1) {
          cmdArgs[0] = cmdArgs.join(' ');
          cmdArgs.length = 1;
        }
        if (cmdName === 'sendPrivateMsg' && cmdArgs.length > 2) {
          cmdArgs[1] = cmdArgs.slice(1).join(' ');
          cmdArgs.length = 2;
        }

        // Validate required args
        if (cmdArgs.length < cmdDef.args.length) {
          const usage = `${cmdName} ${cmdDef.args.map(a => `<${a}>`).join(' ')}${cmdDef.optionalArgs?.length ? ' ' + cmdDef.optionalArgs.map(a => `[${a}]`).join(' ') : ''}`;
          await message.reply({ content: `❌ Nedovoljno argumenata.\n**Korištenje:** \`${usage}\`` });
          return;
        }

        // Build XML attributes
        const id = Date.now();
        const allArgNames = [...cmdDef.args, ...(cmdDef.optionalArgs || [])];
        let attrs = `id="${id}" command="${escapeXml(cmdName)}"`;

        // For sendChat add fromUser
        if (cmdName === 'sendChat') {
          const fromUser = (member?.displayName || message.author.username).slice(0, 48);
          attrs += ` fromUser="${escapeXml(fromUser)}"`;
        }
        if (cmdName === 'sendPrivateMsg') {
          const fromUser = (member?.displayName || message.author.username).slice(0, 48);
          attrs += ` fromUser="${escapeXml(fromUser)}"`;
        }

        for (let i = 0; i < cmdArgs.length && i < allArgNames.length; i++) {
          attrs += ` ${allArgNames[i]}="${escapeXml(cmdArgs[i])}"`;
        }

        const xml = `<?xml version="1.0" encoding="utf-8"?>\n<commands>\n  <command ${attrs} />\n</commands>\n`;
        const filename = `cmd-${cmdName}-${id}.xml`;

        // Enqueue and send
        await this.enqueueInboxCommand({
          kind: 'console',
          payloadType: 'xml',
          filename,
          commandRef: String(id),
          xml
        });
        await this.processInboxQueue(2).catch(() => {});

        // Confirmation embed
        const confirmEmbed = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle(`✅ ${cmdName}`)
          .setDescription(`Komanda poslana na server.`)
          .addFields(
            ...allArgNames.slice(0, cmdArgs.length).map((name, i) => ({
              name,
              value: String(cmdArgs[i]).slice(0, 100),
              inline: true
            }))
          )
          .setFooter({ text: `ID: ${id} • ${message.author.tag}` })
          .setTimestamp();

        await message.reply({ embeds: [confirmEmbed] });

        // Log to mod-log
        const modLog = await getGuildChannel(message.guild, 'mod-log');
        if (modLog) {
          const logEmbed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('🔧 Konzola Komanda')
            .addFields(
              { name: 'Komanda', value: `\`${cmdName}\``, inline: true },
              { name: 'Korisnik', value: `${message.author}`, inline: true },
              { name: 'Argumenti', value: cmdArgs.length > 0 ? cmdArgs.map((a, i) => `**${allArgNames[i]}:** ${a}`).join('\n') : '*nema*', inline: false },
            )
            .setTimestamp();
          await (modLog as any).send({ embeds: [logEmbed] }).catch(() => {});
        }

      } catch (e: any) {
        console.error('[KONZOLA] Error:', e);
        try { await message.reply({ content: `❌ Greška: ${e.message}` }); } catch {}
      }
    });

    // ─── Welcome / Leave embeds ─────────────────────────────────────────

    this.client.on('guildMemberAdd', async (member) => {
      try {
        const ch = await getGuildChannel(member.guild, 'welcome') as TextChannel | undefined;
        if (!ch) return;

        const memberCount = member.guild.memberCount;
        const created = member.user.createdAt;
        const createdStr = `<t:${Math.floor(created.getTime() / 1000)}:R>`;

        const logoUrl = getLogoUrl();

        const embed = new EmbedBuilder()
          .setColor(0x22c55e)
          .setAuthor({
            name: member.guild.name,
            iconURL: member.guild.iconURL({ size: 128 }) || undefined,
          })
          .setTitle('👋 Dobrodošao/la na server!')
          .setDescription(
            `Pozdrav ${member}!\n\n` +
            `Drago nam je što si se pridružio/la **${member.guild.name}**.\n` +
            `Nadamo se da ćeš uživati! 🎮`
          )
          .setThumbnail(logoUrl || null)
          .addFields(
            { name: '👤 Korisnik', value: `${member.user.tag}`, inline: true },
            { name: '📅 Račun kreiran', value: createdStr, inline: true },
            { name: '👥 Član broj', value: `#${memberCount}`, inline: true },
          )
          .setImage(member.user.displayAvatarURL({ size: 512 }))
          .setFooter({ text: `ID: ${member.id}` })
          .setTimestamp();

        await ch.send({ embeds: [embed] }).catch(() => null);
      } catch (e) {
        console.error('[WELCOME] Error:', e);
      }
    });

    this.client.on('guildMemberRemove', async (member) => {
      try {
        const ch = await getGuildChannel(member.guild, 'welcome') as TextChannel | undefined;
        if (!ch) return;

        const joinedAt = member.joinedAt;
        const joinedStr = joinedAt ? `<t:${Math.floor(joinedAt.getTime() / 1000)}:R>` : 'Nepoznato';
        const roles = member.roles?.cache
          ?.filter(r => r.id !== member.guild.id)
          ?.map(r => r.toString())
          ?.join(', ') || 'Nema';

        const logoUrl = getLogoUrl();

        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setAuthor({
            name: member.guild.name,
            iconURL: member.guild.iconURL({ size: 128 }) || undefined,
          })
          .setTitle('👋 Netko je napustio server')
          .setDescription(
            `**${member.user?.tag || 'Nepoznat'}** je napustio/la server.\n` +
            `Žao nam je što odlaziš! 😢`
          )
          .setThumbnail(logoUrl || null)
          .addFields(
            { name: '👤 Korisnik', value: `${member.user?.tag || 'Nepoznat'}`, inline: true },
            { name: '📅 Pridružio se', value: joinedStr, inline: true },
            { name: '🏷️ Role', value: roles.length > 1024 ? roles.slice(0, 1020) + '...' : roles, inline: false },
          )
          .setImage(member.user?.displayAvatarURL({ size: 512 }) || null)
          .setFooter({ text: `ID: ${member.id}` })
          .setTimestamp();

        await ch.send({ embeds: [embed] }).catch(() => null);
      } catch (e) {
        console.error('[LEAVE] Error:', e);
      }
    });

    // ─── Audit / Moderation log ─────────────────────────────────────────

    // Helper to send audit log embed
    const sendAuditLog = async (guild: any, embed: EmbedBuilder) => {
      try {
        const ch = await getGuildChannel(guild, 'mod-log') as TextChannel | undefined;
        if (!ch) {
          console.warn('[AUDIT] mod-log kanal nije pronađen u cache-u! Channels in cache:', guild.channels.cache.filter((c: any) => c.type === 0).map((c: any) => c.name).join(', '));
          return;
        }
        await ch.send({ embeds: [embed] }).catch((err: any) => console.error('[AUDIT] Greška pri slanju u mod-log:', err.message));
      } catch (e: any) {
        console.error('[AUDIT] sendAuditLog error:', e.message);
      }
    };

    // Message deleted
    this.client.on('messageDelete', async (message) => {
      try {
        if (!message.guild) return;
        if (message.author?.bot) return;
        const content = message.content || '*[prazan sadržaj / embed / attachment]*';

        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🗑️ Poruka obrisana')
          .addFields(
            { name: '👤 Autor', value: message.author ? `${message.author.tag} (<@${message.author.id}>)` : 'Nepoznat', inline: true },
            { name: '📃 Kanal', value: `<#${message.channelId}>`, inline: true },
            { name: '💬 Sadržaj', value: content.length > 1024 ? content.slice(0, 1020) + '...' : content, inline: false },
          )
          .setFooter({ text: `Message ID: ${message.id}` })
          .setTimestamp();

        if (message.attachments?.size) {
          const attList = message.attachments.map(a => a.url).join('\n');
          embed.addFields({ name: '📎 Privici', value: attList.length > 1024 ? attList.slice(0, 1020) + '...' : attList });
        }

        await sendAuditLog(message.guild, embed);
      } catch (e) {
        console.error('[AUDIT] messageDelete error:', e);
      }
    });

    // Message edited
    this.client.on('messageUpdate', async (oldMessage, newMessage) => {
      try {
        if (!newMessage.guild) return;
        if (newMessage.author?.bot) return;
        if (oldMessage.content === newMessage.content) return;

        const embed = new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle('✏️ Poruka uređena')
          .addFields(
            { name: '👤 Autor', value: newMessage.author ? `${newMessage.author.tag} (<@${newMessage.author.id}>)` : 'Nepoznat', inline: true },
            { name: '📃 Kanal', value: `<#${newMessage.channelId}>`, inline: true },
            { name: '📝 Prije', value: (oldMessage.content || '*[prazno]*').slice(0, 1024), inline: false },
            { name: '📝 Poslije', value: (newMessage.content || '*[prazno]*').slice(0, 1024), inline: false },
          )
          .setFooter({ text: `Message ID: ${newMessage.id}` })
          .setTimestamp();

        await sendAuditLog(newMessage.guild, embed);
      } catch (e) {
        console.error('[AUDIT] messageUpdate error:', e);
      }
    });

    // Member updated (role changes, nickname changes, avatar changes, timeout)
    this.client.on('guildMemberUpdate', async (oldMember, newMember) => {
      try {
        if (!newMember.guild) return;

        // Nickname change
        if (oldMember.nickname !== newMember.nickname) {
          const embed = new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle('📝 Nickname promijenjen')
            .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
            .addFields(
              { name: '👤 Korisnik', value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: false },
              { name: '📝 Prije', value: oldMember.nickname || '*[nema]*', inline: true },
              { name: '📝 Poslije', value: newMember.nickname || '*[nema]*', inline: true },
            )
            .setFooter({ text: `ID: ${newMember.id}` })
            .setTimestamp();
          await sendAuditLog(newMember.guild, embed);
        }

        // Role changes
        const oldRoles = oldMember.roles?.cache;
        const newRoles = newMember.roles?.cache;
        if (oldRoles && newRoles) {
          const added = newRoles.filter(r => !oldRoles.has(r.id) && r.id !== newMember.guild.id);
          const removed = oldRoles.filter(r => !newRoles.has(r.id) && r.id !== newMember.guild.id);
          if (added.size > 0 || removed.size > 0) {
            const embed = new EmbedBuilder()
              .setColor(0x8b5cf6)
              .setTitle('🏷️ Role promijenjene')
              .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
              .addFields(
                { name: '👤 Korisnik', value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: false },
              )
              .setFooter({ text: `ID: ${newMember.id}` })
              .setTimestamp();

            if (added.size > 0) {
              embed.addFields({ name: '➕ Dodane role', value: added.map(r => r.toString()).join(', '), inline: false });
            }
            if (removed.size > 0) {
              embed.addFields({ name: '➖ Uklonjene role', value: removed.map(r => r.toString()).join(', '), inline: false });
            }
            await sendAuditLog(newMember.guild, embed);
          }

          // Whitelist: auto-add/remove when "Player" role changes
          const playerRoleName = 'Player';
          const gotPlayerRole = added.some(r => r.name === playerRoleName);
          const lostPlayerRole = removed.some(r => r.name === playerRoleName);
          if (gotPlayerRole) {
            try {
              const wasAdded = await addToWhitelist(newMember.id, newMember.displayName);
              if (wasAdded) console.log(`[WHITELIST] Auto-added ${newMember.displayName} (${newMember.id}) — got Player role`);
            } catch (e) {
              console.error('[WHITELIST] Auto-add failed:', e);
            }
          } else if (lostPlayerRole) {
            try {
              const wasRemoved = await removeFromWhitelist(newMember.id);
              if (wasRemoved) console.log(`[WHITELIST] Auto-removed ${newMember.displayName} (${newMember.id}) — lost Player role`);
            } catch (e) {
              console.error('[WHITELIST] Auto-remove failed:', e);
            }
          }

          // Ratar role tracking: archive player link when Ratar is removed
          const lostRatarRole = removed.some(r => r.name === 'Ratar' || r.name === '🌾 Ratar');
          if (lostRatarRole) {
            try {
              const link = await storage.getPlayerLinkByDiscord(newMember.id);
              await storage.addRemovedPlayer({
                discordUserId: newMember.id,
                discordName: newMember.user.tag || newMember.displayName,
                uniqueUserId: link?.uniqueUserId || undefined,
                playerName: link?.playerName || newMember.displayName,
                defaultFarmId: link?.defaultFarmId || undefined,
                reason: 'Ratar rola uklonjena',
              });
              // Remove the active link
              if (link) {
                await storage.deletePlayerLinkByDiscord(newMember.id);
              }
              console.log(`[RATAR-REMOVED] ${newMember.displayName} (${newMember.id}) archived — Ratar role removed`);
              await storage.log({
                type: 'warning',
                message: `⚠️ Ratar rola uklonjena: ${newMember.displayName} (${newMember.user.tag}) — igrač arhiviran${link?.uniqueUserId ? ` (Game ID: ${link.uniqueUserId})` : ''}`,
              });
            } catch (e) {
              console.error('[RATAR-REMOVED] Archive failed:', e);
            }
          }
        }

        // Timeout (communication disabled)
        const oldTimeout = oldMember.communicationDisabledUntil;
        const newTimeout = newMember.communicationDisabledUntil;
        if (String(oldTimeout) !== String(newTimeout)) {
          if (newTimeout && newTimeout.getTime() > Date.now()) {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('🔇 Timeout primijenjen')
              .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
              .addFields(
                { name: '👤 Korisnik', value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: true },
                { name: '⏱️ Do', value: `<t:${Math.floor(newTimeout.getTime() / 1000)}:F>`, inline: true },
              )
              .setFooter({ text: `ID: ${newMember.id}` })
              .setTimestamp();
            await sendAuditLog(newMember.guild, embed);
          } else if (oldTimeout && (!newTimeout || newTimeout.getTime() <= Date.now())) {
            const embed = new EmbedBuilder()
              .setColor(0x22c55e)
              .setTitle('🔊 Timeout uklonjen')
              .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
              .addFields(
                { name: '👤 Korisnik', value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: false },
              )
              .setFooter({ text: `ID: ${newMember.id}` })
              .setTimestamp();
            await sendAuditLog(newMember.guild, embed);
          }
        }
      } catch (e) {
        console.error('[AUDIT] guildMemberUpdate error:', e);
      }
    });

    // Username / global avatar change
    this.client.on('userUpdate', async (oldUser, newUser) => {
      try {
        const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
        if (!guildId) return;
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) return;

        // Only log if user is in our guild
        const member = guild.members.cache.get(newUser.id);
        if (!member) return;

        // Username change
        if (oldUser.username !== newUser.username) {
          const embed = new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle('📝 Username promijenjen')
            .setThumbnail(newUser.displayAvatarURL({ size: 128 }))
            .addFields(
              { name: '👤 Korisnik', value: `<@${newUser.id}>`, inline: false },
              { name: '📝 Prije', value: oldUser.username, inline: true },
              { name: '📝 Poslije', value: newUser.username, inline: true },
            )
            .setFooter({ text: `ID: ${newUser.id}` })
            .setTimestamp();
          await sendAuditLog(guild, embed);
        }

        // Display name change
        if (oldUser.globalName !== newUser.globalName) {
          const embed = new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle('📝 Display name promijenjen')
            .setThumbnail(newUser.displayAvatarURL({ size: 128 }))
            .addFields(
              { name: '👤 Korisnik', value: `<@${newUser.id}>`, inline: false },
              { name: '📝 Prije', value: oldUser.globalName || '*[nema]*', inline: true },
              { name: '📝 Poslije', value: newUser.globalName || '*[nema]*', inline: true },
            )
            .setFooter({ text: `ID: ${newUser.id}` })
            .setTimestamp();
          await sendAuditLog(guild, embed);
        }

        // Avatar change
        if (oldUser.avatar !== newUser.avatar) {
          const embed = new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle('🖼️ Avatar promijenjen')
            .setThumbnail(newUser.displayAvatarURL({ size: 256 }))
            .addFields(
              { name: '👤 Korisnik', value: `${newUser.tag} (<@${newUser.id}>)`, inline: false },
            )
            .setFooter({ text: `ID: ${newUser.id}` })
            .setTimestamp();

          const oldUrl = oldUser.displayAvatarURL({ size: 256 });
          if (oldUrl) {
            embed.setImage(oldUrl);
            embed.addFields({ name: '🖼️ Stari avatar', value: '⬇️ Prikazan ispod', inline: false });
          }
          await sendAuditLog(guild, embed);
        }
      } catch (e) {
        console.error('[AUDIT] userUpdate error:', e);
      }
    });

    // Ban added
    this.client.on('guildBanAdd', async (ban) => {
      try {
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🔨 Korisnik baniran')
          .setThumbnail(ban.user.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: '👤 Korisnik', value: `${ban.user.tag} (<@${ban.user.id}>)`, inline: true },
            { name: '📝 Razlog', value: ban.reason || 'Nije naveden', inline: true },
          )
          .setFooter({ text: `ID: ${ban.user.id}` })
          .setTimestamp();
        await sendAuditLog(ban.guild, embed);
      } catch (e) {
        console.error('[AUDIT] guildBanAdd error:', e);
      }
    });

    // Ban removed
    this.client.on('guildBanRemove', async (ban) => {
      try {
        const embed = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('🔓 Ban uklonjen')
          .setThumbnail(ban.user.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: '👤 Korisnik', value: `${ban.user.tag} (<@${ban.user.id}>)`, inline: true },
          )
          .setFooter({ text: `ID: ${ban.user.id}` })
          .setTimestamp();
        await sendAuditLog(ban.guild, embed);
      } catch (e) {
        console.error('[AUDIT] guildBanRemove error:', e);
      }
    });

    // Channel created / deleted / updated
    // Helper: readable channel type
    const channelTypeName = (type: number): string => {
      const map: Record<number, string> = {
        0: '💬 Text', 2: '🔊 Voice', 4: '📂 Kategorija',
        5: '📢 Najave', 13: '🎙️ Stage', 15: '💭 Forum',
      };
      return map[type] || `Tip ${type}`;
    };

    // Helper: fetch audit log to find who made a channel change
    const getChannelAuditInfo = async (guild: any, actionType: number, channelId: string): Promise<{ who: string; source: string }> => {
      try {
        const logs = await guild.fetchAuditLogs({ limit: 3, type: actionType });
        const entry = logs.entries.find((e: any) => e.target?.id === channelId || e.targetId === channelId);
        if (!entry) return { who: 'Nepoznato', source: '' };
        const reason = entry.reason || '';
        const executor = entry.executor;
        const botUser = guild.client?.user;
        const isBot = executor && botUser && executor.id === botUser.id;
        if (isBot && reason.toLowerCase().includes('dashboard')) {
          return { who: '🌐 Dashboard', source: 'dashboard' };
        } else if (isBot && reason.toLowerCase().includes('ai')) {
          return { who: '🤖 AI Asistent', source: 'ai' };
        } else if (isBot) {
          return { who: '🤖 Bot', source: 'bot' };
        } else if (executor) {
          return { who: `👤 ${executor.tag || executor.username || executor.id}`, source: 'user' };
        }
        return { who: 'Nepoznato', source: '' };
      } catch {
        return { who: 'Nepoznato', source: '' };
      }
    };

    this.client.on('channelCreate', async (channel) => {
      try {
        if (!channel.guild) return;
        // Small delay to let audit log populate
        await new Promise(r => setTimeout(r, 1500));
        const audit = await getChannelAuditInfo(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
        const embed = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('📁 Kanal kreiran')
          .addFields(
            { name: '📃 Kanal', value: `${channel.name} (<#${channel.id}>)`, inline: true },
            { name: '📂 Tip', value: channelTypeName(channel.type), inline: true },
            { name: '👤 Tko', value: audit.who, inline: true },
          )
          .setFooter({ text: `ID: ${channel.id}` })
          .setTimestamp();
        await sendAuditLog(channel.guild, embed);
      } catch (e) {
        console.error('[AUDIT] channelCreate error:', e);
      }
    });

    this.client.on('channelDelete', async (channel) => {
      try {
        if (!('guild' in channel) || !(channel as any).guild) return;
        const guild = (channel as any).guild;
        // Small delay to let audit log populate
        await new Promise(r => setTimeout(r, 1500));
        const audit = await getChannelAuditInfo(guild, AuditLogEvent.ChannelDelete, channel.id);
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('📁 Kanal obrisan')
          .addFields(
            { name: '📃 Kanal', value: `${(channel as any).name || 'Nepoznat'}`, inline: true },
            { name: '📂 Tip', value: channelTypeName((channel as any).type), inline: true },
            { name: '👤 Tko', value: audit.who, inline: true },
          )
          .setFooter({ text: `ID: ${channel.id}` })
          .setTimestamp();
        await sendAuditLog(guild, embed);
      } catch (e) {
        console.error('[AUDIT] channelDelete error:', e);
      }
    });

    this.client.on('channelUpdate', async (oldChannel, newChannel) => {
      try {
        if (!('guild' in newChannel) || !(newChannel as any).guild) return;
        const changes: string[] = [];
        const oc = oldChannel as any;
        const nc = newChannel as any;

        if (oc.name !== nc.name) changes.push(`**Ime:** ${oc.name} → ${nc.name}`);
        if (oc.topic !== nc.topic) changes.push(`**Topic:** ${oc.topic || '*[prazno]*'} → ${nc.topic || '*[prazno]*'}`);
        if (oc.nsfw !== nc.nsfw) changes.push(`**NSFW:** ${oc.nsfw} → ${nc.nsfw}`);
        if (oc.rateLimitPerUser !== nc.rateLimitPerUser) changes.push(`**Slowmode:** ${oc.rateLimitPerUser || 0}s → ${nc.rateLimitPerUser || 0}s`);
        if (oc.parentId !== nc.parentId) changes.push(`**Kategorija:** ${oc.parent?.name || 'Nema'} → ${nc.parent?.name || 'Nema'}`);

        if (changes.length === 0) return;

        // Small delay to let audit log populate
        await new Promise(r => setTimeout(r, 1500));
        const audit = await getChannelAuditInfo(nc.guild, AuditLogEvent.ChannelUpdate, nc.id);

        const embed = new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle('⚙️ Kanal ažuriran')
          .addFields(
            { name: '📃 Kanal', value: `<#${nc.id}>`, inline: true },
            { name: '👤 Tko', value: audit.who, inline: true },
            { name: '🔧 Promjene', value: changes.join('\n').slice(0, 1024), inline: false },
          )
          .setFooter({ text: `ID: ${nc.id}` })
          .setTimestamp();
        await sendAuditLog(nc.guild, embed);
      } catch (e) {
        console.error('[AUDIT] channelUpdate error:', e);
      }
    });

    // Role created / deleted / updated
    this.client.on('roleCreate', async (role) => {
      try {
        const embed = new EmbedBuilder()
          .setColor(role.color || 0x3b82f6)
          .setTitle('🏷️ Rola kreirana')
          .addFields(
            { name: '🏷️ Rola', value: `${role.name} (${role})`, inline: true },
            { name: '🎨 Boja', value: `#${role.color.toString(16).padStart(6, '0')}`, inline: true },
          )
          .setFooter({ text: `ID: ${role.id}` })
          .setTimestamp();
        await sendAuditLog(role.guild, embed);
      } catch (e) {
        console.error('[AUDIT] roleCreate error:', e);
      }
    });

    this.client.on('roleDelete', async (role) => {
      try {
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🏷️ Rola obrisana')
          .addFields(
            { name: '🏷️ Rola', value: role.name, inline: true },
          )
          .setFooter({ text: `ID: ${role.id}` })
          .setTimestamp();
        await sendAuditLog(role.guild, embed);
      } catch (e) {
        console.error('[AUDIT] roleDelete error:', e);
      }
    });

    this.client.on('roleUpdate', async (oldRole, newRole) => {
      try {
        const changes: string[] = [];
        if (oldRole.name !== newRole.name) changes.push(`**Ime:** ${oldRole.name} → ${newRole.name}`);
        if (oldRole.color !== newRole.color) changes.push(`**Boja:** #${oldRole.color.toString(16).padStart(6, '0')} → #${newRole.color.toString(16).padStart(6, '0')}`);
        if (oldRole.hoist !== newRole.hoist) changes.push(`**Odvojena:** ${oldRole.hoist} → ${newRole.hoist}`);
        if (oldRole.mentionable !== newRole.mentionable) changes.push(`**Mencionable:** ${oldRole.mentionable} → ${newRole.mentionable}`);
        if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changes.push(`**Dozvole:** promijenjene`);

        if (changes.length === 0) return;

        const embed = new EmbedBuilder()
          .setColor(newRole.color || 0xf59e0b)
          .setTitle('⚙️ Rola ažurirana')
          .addFields(
            { name: '🏷️ Rola', value: `${newRole.name} (${newRole})`, inline: true },
            { name: '🔧 Promjene', value: changes.join('\n').slice(0, 1024), inline: false },
          )
          .setFooter({ text: `ID: ${newRole.id}` })
          .setTimestamp();
        await sendAuditLog(newRole.guild, embed);
      } catch (e) {
        console.error('[AUDIT] roleUpdate error:', e);
      }
    });

    // Guild member kicked (detected via audit log when member removed)
    this.client.on('guildAuditLogEntryCreate', async (entry, guild) => {
      try {
        if (entry.action === AuditLogEvent.MemberKick) {
          const embed = new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('👢 Korisnik kickan')
            .addFields(
              { name: '👤 Korisnik', value: entry.target ? `<@${entry.targetId}>` : 'Nepoznat', inline: true },
              { name: '👮 Moderator', value: entry.executor ? `${entry.executor.tag} (<@${entry.executorId}>)` : 'Nepoznat', inline: true },
              { name: '📝 Razlog', value: entry.reason || 'Nije naveden', inline: false },
            )
            .setFooter({ text: `ID: ${entry.targetId}` })
            .setTimestamp();
          await sendAuditLog(guild, embed);
        }

        if (entry.action === AuditLogEvent.MemberBanAdd) {
          // Extra detail from audit log (executor info)
          const embed = new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('🔨 Ban — detalji iz audit loga')
            .addFields(
              { name: '👤 Korisnik', value: entry.target ? `<@${entry.targetId}>` : 'Nepoznat', inline: true },
              { name: '👮 Moderator', value: entry.executor ? `${entry.executor.tag} (<@${entry.executorId}>)` : 'Nepoznat', inline: true },
              { name: '📝 Razlog', value: entry.reason || 'Nije naveden', inline: false },
            )
            .setFooter({ text: `ID: ${entry.targetId}` })
            .setTimestamp();
          await sendAuditLog(guild, embed);
        }
      } catch (e) {
        console.error('[AUDIT] guildAuditLogEntryCreate error:', e);
      }
    });

    // Emoji changes
    this.client.on('emojiCreate', async (emoji) => {
      try {
        if (!emoji.guild) return;
        const embed = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('😀 Emoji dodan')
          .setThumbnail(emoji.url)
          .addFields(
            { name: '😀 Emoji', value: `${emoji} \`:${emoji.name}:\``, inline: true },
          )
          .setFooter({ text: `ID: ${emoji.id}` })
          .setTimestamp();
        await sendAuditLog(emoji.guild, embed);
      } catch (e) {
        console.error('[AUDIT] emojiCreate error:', e);
      }
    });

    this.client.on('emojiDelete', async (emoji) => {
      try {
        if (!emoji.guild) return;
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('😀 Emoji uklonjen')
          .addFields(
            { name: '😀 Emoji', value: `:${emoji.name}:`, inline: true },
          )
          .setFooter({ text: `ID: ${emoji.id}` })
          .setTimestamp();
        await sendAuditLog(emoji.guild, embed);
      } catch (e) {
        console.error('[AUDIT] emojiDelete error:', e);
      }
    });

    // Bulk message delete
    this.client.on('messageDeleteBulk', async (messages, channel) => {
      try {
        const guild = (channel as any).guild;
        if (!guild) return;
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🗑️ Bulk brisanje poruka')
          .addFields(
            { name: '📃 Kanal', value: `<#${channel.id}>`, inline: true },
            { name: '🔢 Broj poruka', value: `${messages.size}`, inline: true },
          )
          .setFooter({ text: `Channel ID: ${channel.id}` })
          .setTimestamp();
        await sendAuditLog(guild, embed);
      } catch (e) {
        console.error('[AUDIT] messageDeleteBulk error:', e);
      }
    });
  }

  private async handleButtonClick(interaction: any) {
    const customId = interaction.customId;

    // ── Coop Contract: Refresh tracking ──
    if (customId.startsWith('coop_contract_refresh:')) {
      await interaction.deferUpdate();
      try {
        const parts = customId.split(':');
        const contractId = parts[1];
        const farmId = parts[2];

        const contracts = await storage.getActiveContracts();
        const allContracts = [...contracts];
        // Also check completed/expired
        const allC = await storage.getAllContracts();
        const contract = allC.find((c: any) => String(c._id) === contractId) || contracts.find((c: any) => String(c._id) === contractId);
        if (!contract) { await interaction.followUp({ content: '❌ Ugovor nije pronađen.', ephemeral: true }); return; }

        const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;
        const farms = await storage.getFarms();
        const farm = farms.find(f => String(f.farmId) === String(farmId));
        const farmName = farm?.name || `Farma ${farmId}`;

        // Get this farm's deliveries for this contract
        const deliveries = await storage.getRecentDeliveries(500);
        const farmDeliveries = deliveries.filter((d: any) => d.contractId === contractId && String(d.farmId) === String(farmId));
        const farmDelivered = farmDeliveries.reduce((s: number, d: any) => s + (d.amount || 0), 0);
        const farmEarned = farmDeliveries.reduce((s: number, d: any) => s + (d.totalEarned || 0), 0);

        // Overall contract progress
        const totalDelivered = contract.deliveredAmount || 0;
        const required = contract.requiredAmount || 1;
        const pct = Math.min(100, Math.round(totalDelivered / required * 100));
        const completionRatio = Math.min(1, totalDelivered / required);
        const effectiveBonusPct = +(contract.bonusPercent * completionRatio).toFixed(1);

        // Expected bonus for this farm
        const farmBonusEstimate = +(farmEarned * effectiveBonusPct / 100).toFixed(0);

        const market = await storage.getCoopMarket();
        const marketItem = market.find((m: any) => m.fillType === contract.fillType);
        const basePrice = marketItem ? this.calcActualPrice(marketItem.currentPrice, marketItem.supplyLevel || 0) : 0;
        const expiresH = contract.expiresAt ? Math.max(0, Math.ceil((new Date(contract.expiresAt).getTime() - Date.now()) / 3600000)) : 0;

        const statusStr = contract.status === 'completed' ? '✅ ISPUNJEN' : contract.status === 'expired' ? '⏰ ISTEKAO' : `⏳ Još ${expiresH}h`;
        const color = contract.status === 'completed' ? 0x2ecc71 : contract.status === 'expired' ? 0xe74c3c : 0xe67e22;

        const progressBar = this.buildProgressBar(pct);

        const updatedEmbed = new EmbedBuilder()
          .setColor(color)
          .setTitle(`📦 Ugovor: ${this.getFillTypeEmoji(contract.fillType)} ${cName}`)
          .setDescription(
            `**${farmName}** — Coop ugovor\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📊 **Napredak ugovora:**\n` +
            `${progressBar} **${pct}%**\n` +
            `Ukupno: **${totalDelivered.toLocaleString('hr-HR')}/${required.toLocaleString('hr-HR')}L**\n` +
            `Status: **${statusStr}**\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🏘️ **Tvoja farma (${farmName}):**\n` +
            `Isporučeno: **${farmDelivered.toLocaleString('hr-HR')}L**\n` +
            `Zarađeno: **$${farmEarned.toLocaleString('hr-HR')}**\n` +
            `Procjena bonusa: **~$${farmBonusEstimate.toLocaleString('hr-HR')}** (+${effectiveBonusPct}%)\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📋 **Detalji:**\n` +
            `Potrebno: **${required.toLocaleString('hr-HR')}L** ${cName}\n` +
            `Max bonus: **+${contract.bonusPercent}%**\n` +
            `Cijena: **$${(basePrice * 1000).toFixed(0)}/t**\n\n` +
            `💡 *Bonus raste proporcionalno ukupnoj isporuci svih farmi.*`
          )
          .setFooter({ text: `Ugovor ID: ${contractId} • Farma ${farmId} • Zadnje ažuriranje` })
          .setTimestamp();

        // Keep buttons unless contract is done
        if (contract.status === 'active') {
          await interaction.message.edit({ embeds: [updatedEmbed], components: interaction.message.components });
        } else {
          await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
        }
      } catch (e: any) {
        console.error('[COOP] Contract refresh error:', e);
      }
      return;
    }

    // ── Coop Contract: Finish / close channel ──
    if (customId.startsWith('coop_contract_finish:')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const parts = customId.split(':');
        const contractId = parts[1];
        const farmId = parts[2];
        const channelId = parts[3];
        const guild = interaction.guild;
        if (!guild) return;

        const activeContracts = await storage.getActiveContracts();
        const contract = activeContracts.find((c: any) => String(c._id) === contractId);
        const cName = COOP_FILL_NAMES[contract?.fillType || ''] || 'Ugovor';

        // Get delivery stats for this farm
        const deliveries = await storage.getRecentDeliveries(500);
        const farmDeliveries = deliveries.filter((d: any) => d.contractId === contractId && String(d.farmId) === String(farmId));
        const farmDelivered = farmDeliveries.reduce((s: number, d: any) => s + (d.amount || 0), 0);
        const farmEarned = farmDeliveries.reduce((s: number, d: any) => s + (d.totalEarned || 0), 0);

        const farms = await storage.getFarms();
        const farm = farms.find(f => String(f.farmId) === String(farmId));
        const farmName = farm?.name || `Farma ${farmId}`;

        // Calculate bonus payout
        let bonusPaid = 0;
        if (contract && farmEarned > 0) {
          const completionPct = Math.min(1, farmDelivered / (contract.requiredAmount || 1));
          const effectiveBonus = contract.bonusPercent * completionPct;
          bonusPaid = Math.round(farmEarned * effectiveBonus / 100);
        }

        // Send bonus money to farm in-game
        if (bonusPaid > 0) {
          await this.sendCoopMoneyToFarm(String(farmId), bonusPaid, `Coop ugovor završen — ${cName}`);
        }

        // Send summary before closing
        const summaryEmbed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('✅ Ugovor završen!')
          .setDescription(
            `**${farmName}** — Konačni rezultat:\n\n` +
            `📦 Isporučeno: **${farmDelivered.toLocaleString('hr-HR')}L** ${cName}\n` +
            `💰 Zarađeno: **$${farmEarned.toLocaleString('hr-HR')}**\n` +
            (bonusPaid > 0 ? `💸 Bonus poslan u igru: **$${bonusPaid.toLocaleString('hr-HR')}**\n\n` : '\n') +
            `Kanal se zatvara za 5 sekundi...`
          )
          .setTimestamp();

        await interaction.message.edit({ embeds: [summaryEmbed], components: [] });
        await interaction.editReply('✅ Ugovor završen. Kanal se zatvara...');

        // Log to mod-log
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          const logEmbed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('✅ COOP — Ugovor završen')
            .addFields(
              { name: '👤 Zatvorio', value: `<@${interaction.user.id}>`, inline: true },
              { name: '🏘️ Farma', value: farmName, inline: true },
              { name: '📦 Isporučeno', value: `${farmDelivered.toLocaleString('hr-HR')}L`, inline: true },
              { name: '💰 Zarađeno', value: `$${farmEarned.toLocaleString('hr-HR')}`, inline: true },
              ...(bonusPaid > 0 ? [{ name: '💸 Bonus poslan', value: `$${bonusPaid.toLocaleString('hr-HR')}`, inline: true }] : []),
            )
            .setTimestamp();
          await (modLog as any).send({ embeds: [logEmbed] }).catch(() => {});
        }

        // Mark contract as completed in DB so it doesn't return after restart
        await storage.completeContract(contractId);

        // Delete channel after 5 seconds (short delay so user sees the summary)
        setTimeout(async () => {
          try {
            const channel = guild.channels.cache.get(channelId);
            if (channel) await channel.delete('Coop ugovor završen');
          } catch (e: any) { console.error('[COOP] Channel delete error:', e.message); }
        }, 5000);
      } catch (e: any) {
        console.error('[COOP] Contract finish error:', e);
        try { await interaction.editReply(`❌ Greška: ${e.message}`); } catch {}
      }
      return;
    }

    // ── /farme assign button ──
    if (customId.startsWith('farme_assign_')) {
      const farmId = customId.replace('farme_assign_', '');
      const selectedUid = this.farmeSelectedPlayer.get(interaction.user.id);
      if (!selectedUid) {
        await interaction.reply({ content: '❌ Prvo odaberi igrača iz dropdowna gore!', ephemeral: true });
        return;
      }
      await interaction.deferUpdate();

      const guild = interaction.guild;
      if (!guild) return;

      const dbFarms = await storage.getFarms();
      const farm = dbFarms.find(f => f.farmId === farmId);
      const farmName = farm?.name || `Farma ${farmId}`;
      const player = (await storage.getPlayers()).find(p => p.uniqueUserId === selectedUid);
      const playerName = player?.name || selectedUid;

      // Update player's farmId in DB
      await storage.upsertPlayer({
        uniqueUserId: selectedUid,
        name: playerName,
        farmId: farmId,
      } as any);

      // Also try to assign the Discord farm role
      const roleName = `${FARM_ROLE_PREFIX}${farmName}`;
      const allFarmRoles = guild.roles.cache.filter((r: any) => r.name.startsWith(FARM_ROLE_PREFIX));
      const targetRole = guild.roles.cache.find((r: any) => r.name === roleName);

      // Try to find Discord member matching this player name
      let member: any = null;
      // Check for explicit player link first
      const links = await storage.getPlayerLinks();
      const link = links.find(l => l.uniqueUserId === selectedUid);
      if (link) {
        member = await guild.members.fetch(link.discordUserId).catch(() => null);
      }
      if (!member) {
        // Auto-match by name
        try {
          const members = await guild.members.fetch();
          for (const [, m] of members) {
            if (m.user.bot) continue;
            const candidates = [
              m.displayName.toLowerCase().trim(),
              m.user.username.toLowerCase().trim(),
              m.user.globalName?.toLowerCase().trim(),
            ].filter(Boolean) as string[];
            if (candidates.includes(playerName.toLowerCase().trim())) {
              member = m;
              break;
            }
          }
        } catch {}
      }

      let roleMsg = '';
      if (member && targetRole) {
        // Remove other farm roles
        for (const [, r] of allFarmRoles) {
          if (member.roles.cache.has(r.id) && r.id !== targetRole.id) {
            await member.roles.remove(r, `Farm reassign via /farme`).catch(() => {});
          }
        }
        if (!member.roles.cache.has(targetRole.id)) {
          await member.roles.add(targetRole, `Manual farm assignment via /farme`).catch(() => {});
        }
        roleMsg = ` + rola ${targetRole}`;
      } else if (!targetRole) {
        roleMsg = ' (rola ne postoji — pokreni /server setup)';
      } else {
        roleMsg = ' (Discord member nije pronađen)';
      }

      this.farmeSelectedPlayer.delete(interaction.user.id);

      // Refresh the embed with updated data
      await this.refreshFarmeEmbed(interaction, guild);

      await interaction.followUp({ content: `✅ **${playerName}** → **${farmName}**${roleMsg}`, ephemeral: true });
      return;
    }

    // Activity check buttons (DA / NE) - works in DM
    if (customId === 'actcheck:da' || customId === 'actcheck:ne') {
      const targetId = interaction.user.id;
      const check = this.activeChecks.get(targetId);
      if (!check) {
        await interaction.reply({ content: 'Ova provjera je vec istekla ili obradjena.' }).catch(() => null);
        return;
      }
      if (check.timerId) clearTimeout(check.timerId);
      this.activeChecks.delete(targetId);
      const answer = customId === 'actcheck:da' ? 'DA' : 'NE';
      await interaction.update({ content: `Hvala na odgovoru! Odgovorio/la si: **${answer}**`, components: [], embeds: [] }).catch(() => null);
      try {
        const admin = await this.client.users.fetch(check.adminId).catch(() => null);
        if (admin) {
          const guild = await this.client.guilds.fetch(check.guildId).catch(() => null);
          const member = guild ? await (guild as any).members.fetch(targetId).catch(() => null) : null;
          const displayName = member?.displayName ?? interaction.user.username;
          await (admin as any).send({ content: `📋 **Provjera aktivnosti** — odgovor primljen!\n**Korisnik:** ${displayName} (<@${targetId}>)\n**Odgovor:** ${answer}\n**Pokusaj:** ${check.attempt}/3` }).catch(() => null);
        }
      } catch {}
      return;
    }

    // ── Ticket button — show type selection menu ──
    if (customId === 'ticket_create') {
      try {
        const guild = interaction.guild;
        if (!guild) { await interaction.reply({ content: 'Greška — ne mogu kreirati ticket izvan servera.', ephemeral: true }); return; }

        // Check for existing open ticket by this user
        const existingThread = guild.channels.cache.find((c: any) =>
          c.isThread?.() && c.name.startsWith('🎫') && c.name.includes(interaction.user.username) && !c.archived
        );
        if (existingThread) {
          await interaction.reply({ content: `Već imaš otvoren ticket: ${existingThread}`, ephemeral: true });
          return;
        }

        const typeSelect = new StringSelectMenuBuilder()
          .setCustomId('ticket_type_select')
          .setPlaceholder('Odaberi vrstu ticketa...')
          .addOptions(TICKET_TYPES.map(t => ({
            label: t.label,
            value: t.id,
            description: t.description,
            emoji: t.emoji,
          })));

        const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(typeSelect);

        const selectEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📩 Odaberi vrstu ticketa')
          .setDescription(
            'Odaberi kategoriju iz izbornika ispod.\n' +
            'Nakon odabira otvorit će se **formular** za detalje.\n\n' +
            TICKET_TYPES.map(t => `${t.emoji} **${t.label}** — *${t.description}*`).join('\n') +
            '\n\n> Ispravna kategorija = brži odgovor staffa.'
          )
          .setFooter({ text: 'Korak 1/2 — Odabir kategorije' })
          .setTimestamp();

        await interaction.reply({ embeds: [selectEmbed], components: [selectRow], ephemeral: true });
      } catch (e: any) {
        console.error('[TICKET] Select error:', e);
        await interaction.reply({ content: `Greška: ${e.message}`, ephemeral: true }).catch(() => {});
      }
      return;
    }

    // ── Ticket claim ──
    if (customId === 'ticket_claim') {
      try {
        const guild = interaction.guild;
        const thread = interaction.channel;
        if (!guild || !thread?.isThread?.()) { await interaction.reply({ content: 'Greška.', ephemeral: true }); return; }

        // Only staff can claim
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff = member?.roles.cache.some((r: any) =>
          ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
        );
        if (!isStaff) {
          await interaction.reply({ content: '❌ Samo staff može preuzeti ticket.', ephemeral: true });
          return;
        }

        // Check if already claimed
        const messages = await thread.messages.fetch({ limit: 10 });
        const alreadyClaimed = messages.some((m: any) => m.embeds?.[0]?.title?.includes('Preuzet'));
        if (alreadyClaimed) {
          await interaction.reply({ content: '⚠️ Ovaj ticket je već preuzet.', ephemeral: true });
          return;
        }

        // Update thread name to show who claimed it
        const currentName = thread.name;
        await thread.setName(`${currentName} [${interaction.user.username}]`).catch(() => {});

        const claimEmbed = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('✋ Ticket Preuzet')
          .setDescription(
            `**Staff:** ${interaction.user}\n\n` +
            'Ticket je preuzet. Razgovor može početi.\n' +
            'Korisnik — slobodno opiši svoj problem u detalje.'
          )
          .setTimestamp();

        await interaction.reply({ embeds: [claimEmbed] });

        // Log to mod-log
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          const logEmbed = new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle('✋ Ticket Preuzet')
            .addFields(
              { name: 'Ticket', value: thread.name, inline: true },
              { name: 'Preuzeo', value: `${interaction.user}`, inline: true },
            )
            .setTimestamp();
          await (modLog as any).send({ embeds: [logEmbed] }).catch(() => {});
        }
      } catch (e: any) {
        console.error('[TICKET CLAIM] Error:', e);
        await interaction.reply({ content: `Greška: ${e.message}`, ephemeral: true }).catch(() => {});
      }
      return;
    }

    // ── Ticket staff note (private) ──
    if (customId === 'ticket_note') {
      try {
        const guild = interaction.guild;
        if (!guild) { await interaction.reply({ content: 'Greška.', ephemeral: true }); return; }

        // Only staff
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff = member?.roles.cache.some((r: any) =>
          ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
        );
        if (!isStaff) {
          await interaction.reply({ content: '❌ Samo staff može koristiti bilješke.', ephemeral: true });
          return;
        }

        // Show modal for note input
        const modal = new ModalBuilder()
          .setCustomId('ticket_note_modal')
          .setTitle('📝 Staff Bilješka');

        const noteInput = new TextInputBuilder()
          .setCustomId('note_content')
          .setLabel('Bilješka (vidljiva samo staffu)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Zapiši internu bilješku o ovom ticketu...')
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput));
        await interaction.showModal(modal);
      } catch (e: any) {
        console.error('[TICKET NOTE] Error:', e);
      }
      return;
    }

    // ── Ticket close button ──
    if (customId === 'ticket_close') {
      try {
        const guild = interaction.guild;
        const thread = interaction.channel;
        if (!guild || !thread?.isThread?.()) { await interaction.reply({ content: 'Ovo nije ticket thread.', ephemeral: true }); return; }

        // Only staff or ticket opener can close
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff = member?.roles.cache.some((r: any) =>
          ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
        );
        // Check if user is the ticket opener (username in thread name)
        const isOpener = thread.name.includes(interaction.user.username);

        if (!isStaff && !isOpener) {
          await interaction.reply({ content: '❌ Samo staff ili ticket autor može zatvoriti ticket.', ephemeral: true });
          return;
        }

        // ── Generate transcript ──
        let transcript = '';
        let msgCount = 0;
        const structuredMessages: any[] = [];
        try {
          const allMessages: any[] = [];
          let lastId: string | undefined;
          // Fetch messages in batches
          for (let i = 0; i < 10; i++) { // max 1000 messages
            const batch = await thread.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
            if (batch.size === 0) break;
            allMessages.push(...batch.values());
            lastId = batch.last()?.id;
            if (batch.size < 100) break;
          }
          allMessages.reverse(); // chronological order
          msgCount = allMessages.length;

          for (const msg of allMessages) {
            const time = new Date(msg.createdTimestamp).toLocaleString('hr-HR', { timeZone: 'Europe/Zagreb' });
            const author = msg.author?.tag || 'Unknown';
            const content = msg.content || '';
            const embeds = msg.embeds?.length ? `[${msg.embeds.length} embed(s)]` : '';
            const attachments = msg.attachments?.size ? `[${msg.attachments.size} prilog(a)]` : '';
            transcript += `[${time}] ${author}: ${content} ${embeds} ${attachments}\n`;

            // Structured message data for MongoDB
            structuredMessages.push({
              username: msg.author?.username || 'unknown',
              displayName: msg.author?.globalName || msg.author?.displayName || msg.author?.username || 'Unknown',
              authorId: msg.author?.id || '',
              avatarUrl: msg.author?.displayAvatarURL?.({ size: 128 }) || null,
              isBot: msg.author?.bot || false,
              content: msg.content || '',
              embeds: msg.embeds?.map((e: any) => ({
                title: e.title || null,
                description: e.description || null,
                color: e.color ?? null,
                fields: e.fields || [],
              })) || [],
              attachments: msg.attachments?.map((a: any) => ({
                name: a.name,
                url: a.url,
                size: a.size,
                contentType: a.contentType || null,
              })) || [],
              timestamp: msg.createdAt?.toISOString(),
            });
          }
        } catch (e: any) {
          transcript = `[Greška pri generiranju transkripta: ${e.message}]`;
        }

        // ── Save transcript to MongoDB ──
        let transcriptSaved = false;
        try {
          await storage.saveTranscript({
            guildId: guild.id,
            ticketName: thread.name,
            closedBy: interaction.user.tag || interaction.user.username,
            closedById: interaction.user.id,
            messageCount: msgCount,
            content: transcript,
            messages: structuredMessages,
          });
          transcriptSaved = true;
        } catch (e: any) {
          console.error('[TICKET] Failed to save transcript to MongoDB:', e);
        }

        // ── Close embed ──
        const closeEmbed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🔒 Ticket Zatvoren')
          .setDescription(
            `**Zatvorio:** ${interaction.user}\n` +
            `**Poruka:** ${msgCount}\n` +
            `**Trajanje:** od ${thread.createdAt ? `<t:${Math.floor(thread.createdAt.getTime() / 1000)}:R>` : 'N/A'}\n` +
            (transcriptSaved ? '**📋 Transcript spremljen u bazu podataka.**' : '') + '\n\n' +
            'Ticket je arhiviran. Za novi zahtjev otvori novi ticket.'
          )
          .setTimestamp();

        await interaction.reply({ embeds: [closeEmbed] });

        // ── Log to mod-log ──
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          const logEmbed = new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('🔒 Ticket Zatvoren — Arhiva')
            .addFields(
              { name: 'Ticket', value: thread.name, inline: true },
              { name: 'Zatvorio', value: `${interaction.user}`, inline: true },
              { name: 'Poruka', value: String(msgCount), inline: true },
              { name: '📋 Transcript', value: transcriptSaved ? '✅ Spremljen u MongoDB bazu' : '❌ Greška pri spremanju', inline: true },
            )
            .setTimestamp();

          await (modLog as any).send({ embeds: [logEmbed] }).catch(() => {});
        }

        // Archive thread
        await thread.setArchived(true).catch(() => {});
      } catch (e: any) {
        console.error('[TICKET CLOSE] Error:', e);
        await interaction.reply({ content: `Greška: ${e.message}`, ephemeral: true }).catch(() => {});
      }
      return;
    }

    // ── Verification button — assign Mještanin role ──
    if (customId === 'verify_member') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const guild = interaction.guild;
        if (!guild) { await interaction.editReply({ content: 'Greška.' }); return; }
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) { await interaction.editReply({ content: 'Ne mogu te pronaći na serveru.' }); return; }

        const mjestanin = guild.roles.cache.find((r: any) => r.name.includes('Mještanin'));
        if (!mjestanin) { await interaction.editReply({ content: 'Rola Mještanin ne postoji — pokreni /setup.' }); return; }

        if (member.roles.cache.has(mjestanin.id)) {
          await interaction.editReply({ content: '✅ Već si verificiran/a!' });
          return;
        }

        await member.roles.add(mjestanin);
        // Remove Unverified role
        const unverifiedRole = guild.roles.cache.find((r: any) => r.name.includes('Unverified'));
        if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
          await member.roles.remove(unverifiedRole, 'Verificiran').catch(() => {});
        }
        // Also assign NotifyMe role
        const notifyRole = guild.roles.cache.find((r: any) => r.name.includes('NotifyMe'));
        if (notifyRole && !member.roles.cache.has(notifyRole.id)) {
          await member.roles.add(notifyRole).catch(() => {});
        }
        await interaction.editReply({ content: '✅ Verificiran/a si! Dobrodošao/la u zajednicu! 🎉' });

        // Log to mod-log
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          const logEmbed = new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle('✅ Novi Verificirani Član')
            .addFields(
              { name: 'Korisnik', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
            )
            .setTimestamp();
          await (modLog as any).send({ embeds: [logEmbed] }).catch(() => {});
        }
      } catch (e: any) {
        console.error('[VERIFY] Error:', e);
        await interaction.editReply({ content: `Greška: ${e.message}` }).catch(() => {});
      }
      return;
    }

    // ── Farm Application — show modal with 5 questions ──
    if (customId === 'farm_apply') {
      try {
        const guild = interaction.guild;
        if (!guild) { await interaction.reply({ content: 'Greška.', ephemeral: true }); return; }
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) { await interaction.reply({ content: 'Greška.', ephemeral: true }); return; }

        const ratarRole = guild.roles.cache.find((r: any) => r.name.includes('Ratar'));
        if (ratarRole && member.roles.cache.has(ratarRole.id)) {
          await interaction.reply({ content: '✅ Već imaš pristup farmi! Imaš **Ratar** ulogu.', ephemeral: true });
          return;
        }

        // Check for existing pending application
        const staffChat = await getGuildChannel(guild, 'staff-chat');
        if (staffChat) {
          const existingThread = guild.channels.cache.find((c: any) =>
            c.isThread?.() && c.name.startsWith('📝') && c.name.includes(interaction.user.username) && !c.archived
          );
          if (existingThread) {
            await interaction.reply({ content: '⏳ Već imaš aktivnu prijavu koja čeka pregled staffa.', ephemeral: true });
            return;
          }
        }

        const modal = new ModalBuilder()
          .setCustomId('farm_apply_modal')
          .setTitle('📝 Prijava za Farmu');

        const imeInput = new TextInputBuilder()
          .setCustomId('app_ime')
          .setLabel('Kako se zoveš? (ime ili nadimak)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Tvoje ime ili nadimak')
          .setMaxLength(50)
          .setRequired(true);

        const godineInput = new TextInputBuilder()
          .setCustomId('app_godine')
          .setLabel('Koliko imaš godina?')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('npr. 25')
          .setMaxLength(3)
          .setRequired(true);

        const iskustvoInput = new TextInputBuilder()
          .setCustomId('app_iskustvo')
          .setLabel('Imaš li iskustva s FS igrama?')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Opiši svoje iskustvo s Farming Simulator igrama...')
          .setMaxLength(500)
          .setRequired(true);

        const aktivnostInput = new TextInputBuilder()
          .setCustomId('app_aktivnost')
          .setLabel('Koliko planiraš igrati tjedno?')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('npr. 10-15 sati tjedno')
          .setMaxLength(50)
          .setRequired(true);

        const razlogInput = new TextInputBuilder()
          .setCustomId('app_razlog')
          .setLabel('Zašto želiš igrati na našem serveru?')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Opiši zašto baš Slavonska Ravnica...')
          .setMaxLength(500)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(imeInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(godineInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(iskustvoInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(aktivnostInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(razlogInput),
        );

        await interaction.showModal(modal);
      } catch (e: any) {
        console.error('[FARM APPLY] Modal error:', e);
        await interaction.reply({ content: `Greška: ${e.message}`, ephemeral: true }).catch(() => {});
      }
      return;
    }

    // ── Farm Application — Approve ──
    if (customId.startsWith('farm_approve:')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const guild = interaction.guild;
        if (!guild) { await interaction.editReply({ content: 'Greška.' }); return; }

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff = member?.roles.cache.some((r: any) =>
          ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
        );
        if (!isStaff) { await interaction.editReply({ content: '❌ Samo staff može odobriti prijave.' }); return; }

        const applicantId = customId.split(':')[1];
        const applicant = await guild.members.fetch(applicantId).catch(() => null);
        if (!applicant) { await interaction.editReply({ content: '❌ Korisnik više nije na serveru.' }); return; }

        const ratarRole = guild.roles.cache.find((r: any) => r.name.includes('Ratar'));
        if (!ratarRole) { await interaction.editReply({ content: '❌ Ratar rola ne postoji — pokreni /setup.' }); return; }

        await applicant.roles.add(ratarRole);
        // Also assign NotifyMe role
        const notifyRole = guild.roles.cache.find((r: any) => r.name.includes('NotifyMe'));
        if (notifyRole && !applicant.roles.cache.has(notifyRole.id)) {
          await applicant.roles.add(notifyRole).catch(() => {});
        }

        // Update the thread embed to show approved
        const thread = interaction.channel;
        if (thread?.isThread?.()) {
          const approvedEmbed = new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle('✅ Prijava Odobrena')
            .setDescription(`${interaction.user} je odobrio/la prijavu za ${applicant}.`)
            .setTimestamp();
          await thread.send({ embeds: [approvedEmbed] });
          await thread.setArchived(true).catch(() => {});
        }

        // DM the applicant — modern welcome embed
        {
          const launcherCh = await getGuildChannel(guild, 'launcher');
          const farmChatCh = await getGuildChannel(guild, 'farm-chat');
          const rulesCh = await getGuildChannel(guild, 'pravila');
          const leaderCh = await getGuildChannel(guild, 'leaderboard');

          const welcomeEmbed = new EmbedBuilder()
            .setColor(0x22c55e)
            .setAuthor({ name: 'Slavonska Ravnica', iconURL: guild.iconURL({ dynamic: true }) || undefined })
            .setTitle('\u2705 Prijava Odobrena!')
            .setDescription(
              'Tvoja prijava za **Slavonsku Ravnicu** je odobrena! \uD83C\uDF89\n' +
              'Dobio/la si **\uD83C\uDF3E Ratar** ulogu \u2014 sada ima\u0161 pristup svim farm kanalima.'
            )
            .addFields(
              {
                name: '\uD83D\uDE80 Sljede\u0107i koraci',
                value:
                  `> **1.** ${launcherCh ? `Idi na ${launcherCh}` : 'Prona\u0111i **#launcher**'} i preuzmi launcher za modove\n` +
                  `> **2.** ${rulesCh ? `Pro\u010Ditaj ${rulesCh}` : 'Pro\u010Ditaj **#pravila**'} da zna\u0161 osnove\n` +
                  `> **3.** Pokreni FS25, odaberi Slavonsku Ravnicu i u\u0111i na server\n` +
                  `> **4.** ${farmChatCh ? `Javi se u ${farmChatCh}` : 'Javi se u **#farm-chat**'} i upoznaj ekipu!`,
              },
              {
                name: '\uD83C\uDF1F \u0160to ti je dostupno',
                value:
                  '\uD83D\uDCCA **Statistika farme** \u2014 prati prihode, usjeve i vozila\n' +
                  '\uD83C\uDFC6 **Leaderboard** \u2014 natje\u010Di se s drugim igra\u010Dima\n' +
                  '\uD83D\uDD14 **Farm obavijesti** \u2014 automatske obavijesti o doga\u0111ajima\n' +
                  '\uD83C\uDFA4 **Glasovni kanali** \u2014 pri\u010Daj s ekipom dok igra\u0161',
              }
            )
            .setFooter({ text: 'Vidimo se na njivi! \uD83D\uDE9C', iconURL: applicant.user.displayAvatarURL() })
            .setTimestamp();

          await applicant.send({ embeds: [welcomeEmbed] }).catch(() => {});
        }

        // Public welcome announcement in configured channel
        const newFarmerCh = await getGuildChannel(guild, 'new-farmer');
        if (newFarmerCh) {
          const farmChatCh = await getGuildChannel(guild, 'farm-chat');
          const announceEmbed = new EmbedBuilder()
            .setColor(0x57F287)
            .setAuthor({ name: 'Novi Ratar!', iconURL: guild.iconURL({ dynamic: true }) || undefined })
            .setThumbnail(applicant.user.displayAvatarURL({ size: 256 }))
            .setTitle(`\uD83C\uDF3E ${applicant.user.displayName || applicant.user.username} se pridru\u017Eio/la!`)
            .setDescription(
              `${applicant} je upravo postao/la novi **\uD83C\uDF3E Ratar** na Slavonskoj Ravnici!\n\n` +
              `Po\u017Eelite mu/joj dobrodo\u0161licu i sretno farmanje! \uD83D\uDE9C\uD83C\uDF3D`
            )
            .addFields(
              {
                name: '\uD83D\uDC4B Kako pomo\u0107i',
                value:
                  '> \uD83D\uDC4D Reagiraj s emojiem za dobrodo\u0161licu\n' +
                  `> \uD83D\uDCAC ${farmChatCh ? `Pozdravi u ${farmChatCh}` : 'Javi se u farm-chat'}\n` +
                  '> \uD83E\uDD1D Ponudi pomo\u0107 s prvim koracima',
              }
            )
            .setFooter({ text: `Odobrio/la: ${interaction.user.displayName || interaction.user.username}` })
            .setTimestamp();

          const msg = await (newFarmerCh as any).send({ embeds: [announceEmbed] }).catch(() => null);
          if (msg) {
            await msg.react('\uD83C\uDF3E').catch(() => {});
            await msg.react('\uD83D\uDC4B').catch(() => {});
            await msg.react('\uD83D\uDE9C').catch(() => {});
          }
        }

        // Log to mod-log
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          await (modLog as any).send({ embeds: [new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle('\u2705 Prijava Odobrena')
            .addFields(
              { name: 'Korisnik', value: `${applicant} (${applicant.user.tag})`, inline: true },
              { name: 'Odobrio/la', value: `${interaction.user}`, inline: true },
            )
            .setTimestamp()
          ] }).catch(() => {});
        }

        await interaction.editReply({ content: `✅ ${applicant} je primljen/a — Ratar rola dodijeljena.` });
      } catch (e: any) {
        console.error('[FARM APPROVE] Error:', e);
        await interaction.editReply({ content: `Greška: ${e.message}` }).catch(() => {});
      }
      return;
    }

    // ── Farm Application — Deny ──
    if (customId.startsWith('farm_deny:')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const guild = interaction.guild;
        if (!guild) { await interaction.editReply({ content: 'Greška.' }); return; }

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff = member?.roles.cache.some((r: any) =>
          ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
        );
        if (!isStaff) { await interaction.editReply({ content: '❌ Samo staff može odbiti prijave.' }); return; }

        const applicantId = customId.split(':')[1];
        const applicant = await guild.members.fetch(applicantId).catch(() => null);

        // Update the thread embed to show denied
        const thread = interaction.channel;
        if (thread?.isThread?.()) {
          const deniedEmbed = new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('❌ Prijava Odbijena')
            .setDescription(`${interaction.user} je odbio/la prijavu${applicant ? ` za ${applicant}` : ''}.`)
            .setTimestamp();
          await thread.send({ embeds: [deniedEmbed] });
          await thread.setArchived(true).catch(() => {});
        }

        // DM the applicant if still on server
        if (applicant) {
          await applicant.send({
            embeds: [new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('❌ Prijava Odbijena')
              .setDescription(
                'Nažalost, tvoja prijava za **Slavonsku Ravnicu** je odbijena.\n\n' +
                'Možeš se ponovno prijaviti nakon nekog vremena.\n' +
                'Za pitanja koristi ticket sustav.'
              )
              .setTimestamp()
            ]
          }).catch(() => {});
        }

        // Log to mod-log
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          await (modLog as any).send({ embeds: [new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('❌ Prijava Odbijena')
            .addFields(
              { name: 'Korisnik', value: applicant ? `${applicant} (${applicant.user.tag})` : `ID: ${applicantId}`, inline: true },
              { name: 'Odbio/la', value: `${interaction.user}`, inline: true },
            )
            .setTimestamp()
          ] }).catch(() => {});
        }

        await interaction.editReply({ content: `❌ Prijava odbijena${applicant ? ` za ${applicant.user.tag}` : ''}.` });
      } catch (e: any) {
        console.error('[FARM DENY] Error:', e);
        await interaction.editReply({ content: `Greška: ${e.message}` }).catch(() => {});
      }
      return;
    }

    if (interaction.customId?.startsWith('link_') && !this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Nemaš dozvolu za ovu radnju.', ephemeral: true });
      return;
    }

    // Linking panel buttons (admin-only)
    if (customId === 'link_refresh') {
      const embed = await this.buildPanelEmbed('linking', null);
      const components = await this.buildLinkingComponents();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    if (customId === 'link_confirm') {
      await interaction.deferReply({ ephemeral: true });
      const key = interaction.message.id;
      const sess = this.linkingSessions.get(key) || {};
      if (!sess.discordUserId || !sess.uniqueUserId) {
        await interaction.editReply({ content: 'Odaberi Discord korisnika i online FS25 igrača.' });
        return;
      }
      try {
        const onlinePlayers = await this.getOnlinePlayersForLinking();
        const players = await storage.getPlayers();
        const onlineMatch = onlinePlayers.find(x => String(x.uniqueUserId) === String(sess.uniqueUserId));
        const storageMatch = players.find(x => x.uniqueUserId === sess.uniqueUserId);
        const resolvedPlayer = onlineMatch || (storageMatch ? {
          uniqueUserId: storageMatch.uniqueUserId,
          name: storageMatch.name,
          farmId: (storageMatch.farmId as any) || null,
        } : null);

        const existingLinks = await storage.getPlayerLinks();
        const conflicting = existingLinks.find((l: any) =>
          String(l?.uniqueUserId || '').trim() === String(sess.uniqueUserId || '').trim()
          && String(l?.discordUserId || '').trim() !== String(sess.discordUserId || '').trim()
        );
        if (conflicting?.discordUserId) {
          await storage.deletePlayerLinkByDiscord(String(conflicting.discordUserId));
        }

        await storage.upsertPlayerLink({
          discordUserId: sess.discordUserId,
          uniqueUserId: sess.uniqueUserId,
          playerName: resolvedPlayer?.name || null,
          defaultFarmId: null  // Let game data be authoritative — don't snapshot farmId at link time
        } as any);

        const linkedUid = String(sess.uniqueUserId || '').trim();
        const runtimeMatch = Array.from(this.runtimePlayerTimes.values()).find((rp: any) =>
          String(rp?.uniqueUserId || rp?.id || '').trim() === linkedUid
        );
        if (linkedUid && runtimeMatch?.currentlyOnline) {
          this.runtimeSessionStartedAtByPlayer.set(linkedUid, new Date());
        }

        try {
          await this.forceRefreshAllPanels();
        } catch (e) {
          console.error('Post-link panel refresh failed:', e);
        }

        await interaction.editReply({ content: `✅ Povezano: <@${sess.discordUserId}> ↔ ${(resolvedPlayer?.name || sess.uniqueUserId)}` });
      } catch (e: any) {
        console.error('Link confirm failed:', e);
        await interaction.editReply({ content: `Greška pri linkanju: ${String(e?.message || e)}` });
      }
      return;
    }

    if (customId === 'link_unlink') {
      const key = interaction.message.id;
      const sess = this.linkingSessions.get(key) || {};
      if (!sess.discordUserId) {
        await interaction.reply({ content: 'Odaberi Discord korisnika kojeg želiš odspojiti.', ephemeral: true });
        return;
      }
      await storage.deletePlayerLinkByDiscord(sess.discordUserId);
      await interaction.reply({ content: `🧹 Odspojeno: <@${sess.discordUserId}>`, ephemeral: true });
      return;
    }

    
    // Handle setup farm channel button
    if (customId === 'setup_farm_channel') {
      await this.showFarmSelect(interaction);
      return;
    }

    if (customId.startsWith('select_channel_for_farm_manual:')) {
      const farmId = String(customId.split(':')[1] || '').trim();
      if (!farmId) {
        await interaction.reply({ content: 'Greška: nedostaje farm ID.', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`select_channel_for_farm_manual_submit:${farmId}`)
        .setTitle(`Panel kanal za farmu ${farmId}`);

      const channelInput = new TextInputBuilder()
        .setCustomId('farm_channel_id_or_mention')
        .setLabel('Channel ID ili #mention')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('npr. 123456789012345678 ili #kanal')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput)
      );

      await interaction.showModal(modal);
      return;
    }

    if (customId === 'setup_log_channel') {
      await this.showLogChannelSelect(interaction);
      return;
    }

    if (customId === 'setup_tracking_log_channel') {
      await this.showTrackingLogChannelSelect(interaction);
      return;
    }

    if (customId === 'toggle_log_channel') {
      try {
        const cfg = await this.getLogConfig();
        const trackingCfg = await this.getTrackingLogConfig();
        const resolvedChannelId = cfg.channelId || trackingCfg.channelId;

        if (!resolvedChannelId) {
          await interaction.reply({ content: 'Prvo postavi log kanal.', ephemeral: true });
          return;
        }

        const nextEnabled = !cfg.enabled;
        await storage.upsertDeployedPanel({
          channelId: resolvedChannelId,
          messageId: nextEnabled ? '1' : '0',
          panelType: 'log_channel',
          farmId: null
        } as any);

        const currentRows = interaction.message?.components || [];
        const topRow = currentRows[0] || null;
        const actionsRow = await this.buildAdminActionsRow();
        const toolsRow = await this.buildAdminToolsCollapsedRow();

        if (topRow) {
          await interaction.update({ components: [topRow as any, actionsRow as any, toolsRow as any] });
        } else {
          await interaction.deferUpdate();
        }

        try {
          await interaction.followUp({
            content: nextEnabled
              ? `✅ Log uključen`
              : `⏸️ Log isključen`,
            ephemeral: true
          });
        } catch {}
      } catch (e: any) {
        console.error('Toggle log channel error:', e);
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `Greška: ${e?.message || e}`, ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    if (customId === 'admin_server_info') {
      await this.showServerInfoChannelSelect(interaction);
      return;
    }

    if (customId.startsWith('admin_deploy_manual:')) {
      const panelType = String(customId.split(':')[1] || '').trim();
      if (!panelType) {
        await interaction.reply({ content: 'Greška: nedostaje panel tip.', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`admin_deploy_manual_submit:${panelType}`)
        .setTitle(`Deploy panela: ${panelType}`);

      const channelInput = new TextInputBuilder()
        .setCustomId('channel_id_or_mention')
        .setLabel('Channel ID ili #mention')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('npr. 123456789012345678 ili #kanal')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput)
      );

      await interaction.showModal(modal);
      return;
    }

    if (customId === 'logtrack_10m' || customId === 'logtrack_30m' || customId === 'logtrack_2h' || customId === 'logtrack_12h' || customId === 'logtrack_all') {
      try {
        await interaction.deferUpdate();
        const messageId = interaction.message?.id;
        if (!messageId) return;
        const trackState = this.logTrackPlayerByMessage.get(messageId);
        if (!trackState) return;

        const byCustomId: Record<string, '10m' | '30m' | '2h' | '12h' | 'all'> = {
          logtrack_10m: '10m',
          logtrack_30m: '30m',
          logtrack_2h: '2h',
          logtrack_12h: '12h',
          logtrack_all: 'all'
        };

        const nextWin = byCustomId[customId];
        if (!nextWin) return;

        this.logTrackWindowByMessage.set(messageId, nextWin);
        const payload = await this.buildPlayerExitTrackPayload(trackState, nextWin);
        await interaction.message.edit(payload as any);
      } catch (e) {
        console.error('logtrack button error:', e);
      }
      return;
    }


    // Handle job panel buttons
    if (customId === 'job_create') {
      await this.showJobCreateModal(interaction);
      return;
    }
    
    if (customId === 'job_refresh') {
      await this.refreshJobsPanel(interaction);
      return;
    }
    
    if (customId.startsWith('job_take_')) {
      const jobId = parseInt(customId.replace('job_take_', ''));
      await this.handleJobTake(interaction, jobId);
      return;
    }
    
    if (customId.startsWith('job_complete_')) {
      const jobId = parseInt(customId.replace('job_complete_', ''));
      await this.handleJobComplete(interaction, jobId);
      return;
    }
    

    // Bank panel buttons DISABLED
    // if (customId.startsWith('bank_refresh:')) {
    /*
      const farmId = customId.replace('bank_refresh:', '') || null;
      try {
        await interaction.deferUpdate();
        const fid = farmId === 'null' ? null : farmId;
        const embed = await this.buildBankEmbed(fid);
        const components = await this.buildBankComponents(fid);
        await interaction.message.edit({ embeds: [embed], components });
      } catch (error: any) {
        console.error('Bank refresh error:', error);
      }
      return;
    }
    */
    // BANK DISABLED - END OF bank_refresh HANDLER
    if (customId === 'playerhours_prev' || customId === 'playerhours_next') {
      try {
        await interaction.deferUpdate();
        const messageId = interaction.message?.id;
        if (!messageId) return;
        const current = this.playerHoursPageByMessage.get(messageId) || 0;
        const delta = customId === 'playerhours_next' ? 1 : -1;
        const nextPage = Math.max(0, current + delta);
        this.playerHoursPageByMessage.set(messageId, nextPage);
        const embed = await this.buildPanelEmbed('player_hours', null, { messageId });
        const components = await this.buildPlayerHoursComponents(messageId);
        await interaction.message.edit({ embeds: [embed], components });
      } catch (e) {
        console.error('Player hours pagination error:', e);
      }
      return;
    }

    // Map tracks quick window buttons (groundwork)
    if (customId === 'maptracks_10m' || customId === 'maptracks_30m' || customId === 'maptracks_2h' || customId === 'maptracks_refresh') {
      try {
        await interaction.deferUpdate();
        const messageId = interaction.message?.id;
        if (!messageId) return;
        if (customId === 'maptracks_10m') this.mapTracksSelectedWindowByMessage.set(messageId, '10m');
        if (customId === 'maptracks_30m') this.mapTracksSelectedWindowByMessage.set(messageId, '30m');
        if (customId === 'maptracks_2h') this.mapTracksSelectedWindowByMessage.set(messageId, '2h');
        const embed = await this.buildPanelEmbed('map_tracks', null, { messageId });
        const components = await this.buildMapTracksComponents(messageId);
        await interaction.message.edit({ embeds: [embed], components });
      } catch (e) {
        console.error('Map tracks button error:', e);
      }
      return;
    }

    if (customId === 'serverinfo_10m' || customId === 'serverinfo_30m' || customId === 'serverinfo_2h' || customId === 'serverinfo_12h' || customId === 'serverinfo_all' || customId === 'serverinfo_refresh') {
      try {
        await interaction.deferUpdate();
        const messageId = interaction.message?.id;
        if (!messageId) return;
        const byCustomId: Record<string, '10m' | '30m' | '2h' | '12h' | 'all'> = {
          serverinfo_10m: '10m',
          serverinfo_30m: '30m',
          serverinfo_2h: '2h',
          serverinfo_12h: '12h',
          serverinfo_all: 'all'
        };
        const next = byCustomId[customId];
        if (next) {
          this.serverInfoWindowByMessage.set(messageId, next);
        }
        const payload = await this.buildServerInfoPayload(messageId);
        await interaction.message.edit(payload as any);
      } catch (e) {
        console.error('Server info window button error:', e);
      }
      return;
    }

    // Generic list-panel pagination buttons
    // customId format: list:<panelType>:<action>:<farmIdOrAll>  (action = prev|next|refresh)
    if (customId?.startsWith('list:')) {
      try {
        await interaction.deferUpdate();
        const parts = String(customId).split(':');
        const panelType = parts[1];
        const action = parts[2];
        const farmToken = parts[3];
        const messageId = interaction.message?.id;
        if (!panelType || !action || !messageId) return;

        const farmId = (farmToken && farmToken !== 'all' && farmToken !== 'null') ? String(farmToken) : null;
        const key = this.getListPageKey(messageId, panelType, farmId);
        const current = this.listPageByMessageAndPanel.get(key) || 0;
        const delta = action === 'next' ? 1 : action === 'prev' ? -1 : 0;
        const nextPage = Math.max(0, current + delta);
        this.listPageByMessageAndPanel.set(key, nextPage);

        const embed = await this.buildPanelEmbed(panelType, farmId, { messageId });
        const components = await this.buildListPanelComponents(panelType, farmId, messageId);
        await interaction.message.edit({ embeds: [embed], components });
      } catch (e) {
        console.error('List panel pagination error:', e);
      }
      return;
    }

    // ── Backup delete button ──
    if (customId === 'backup_delete') {
      if (!this.isOwner(interaction.user.id)) {
        await interaction.reply({ content: '❌ Samo vlasnik bota.', ephemeral: true });
        return;
      }

      const guild = interaction.guild;
      if (!guild) return;

      const backups = await storage.listBackups(guild.id);
      if (backups.length === 0) {
        await interaction.reply({ content: '📂 Nema backupa za brisanje.', ephemeral: true });
        return;
      }

      const options = backups.slice(0, 25).map(b => {
        const date = b.createdAt.toLocaleDateString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        return {
          label: b.name.slice(0, 100),
          description: `${b.channelCount} kanala, ${b.messageCount} poruka — ${date}`.slice(0, 100),
          value: b.id,
        };
      });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('backup_delete_select')
        .setPlaceholder('Odaberi backup za brisanje...')
        .addOptions(options);

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
      await interaction.reply({ content: '🗑️ Odaberi backup koji želiš obrisati:', components: [row], ephemeral: true });
      return;
    }

    if (!customId.startsWith('admin_')) return;

    const dataType = customId.replace('admin_', '');

    if (dataType === 'tools_open' || dataType === 'tools_close') {
      try {
        const currentRows = interaction.message?.components || [];
        const topRow = currentRows[0] || null;
        if (!topRow) {
          if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
          return;
        }

        const actionsRow = await this.buildAdminActionsRow();
        if (dataType === 'tools_open') {
          const toolsExpandedRow = await this.buildAdminToolsExpandedRow();
          const toolsCloseRow = await this.buildAdminToolsCloseRow();
          await interaction.update({ components: [topRow as any, actionsRow as any, toolsExpandedRow as any, toolsCloseRow as any] });
        } else {
          const toolsCollapsedRow = await this.buildAdminToolsCollapsedRow();
          await interaction.update({ components: [topRow as any, actionsRow as any, toolsCollapsedRow as any] });
        }
      } catch (error: any) {
        console.error('Admin tools toggle error:', error);
        try {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    if (dataType === 'feature_flags') {
      try {
        const row = await this.buildFeatureFlagsFarmSelectRow();
        const lines = [
          'Odaberi mapu/farmu za uključivanje/isključivanje smart opcija:',
          '• Vozila: smart alerti (gorivo/šteta/spremnici)',
          '• Polja: task prioriteti i akcije'
        ];

        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: lines.join('\n'), components: [row], ephemeral: true });
        } else {
          await interaction.followUp({ content: lines.join('\n'), components: [row], ephemeral: true });
        }
      } catch (error: any) {
        console.error('Feature flags panel error:', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: `Greška: ${error.message}`, ephemeral: true });
          } else {
            await interaction.reply({ content: `Greška: ${error.message}`, ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    if (dataType === 'inbox_queue') {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ ephemeral: true });
        }

        const before = await this.getInboxQueueStatusSummary();
        const flush = await this.processInboxQueue(20);
        const after = await this.getInboxQueueStatusSummary();

        await interaction.editReply({
          content: [
            `📬 Inbox Queue`,
            `Prije: queued ${before.queued} | failed ${before.failed} | sent(24h) ${before.sent24h}`,
            `Flush: processed ${flush.processed} | sent ${flush.sent} | failed ${flush.failed}`,
            `Sada: queued ${after.queued} | failed ${after.failed} | due ${after.dueNow}`
          ].join('\n'),
          components: [this.buildInboxQueueActionsRow()]
        });
      } catch (error: any) {
        console.error('Inbox queue status error:', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `Greska: ${error.message}` });
          } else {
            await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    if (dataType === 'force_refresh_all' || dataType === 'vehicles_hard_refresh') {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ ephemeral: true });
        }

        const res = await this.forceRefreshAllPanels();
        const msg = `Force refresh završen. Osvježeno: ${res.refreshed}, Preskočeno: ${res.skipped}, Greške: ${res.failed}.`;
        await interaction.editReply({ content: msg });
      } catch (error: any) {
        console.error('Force refresh all error:', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `Greska: ${error.message}` });
          } else {
            await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    if (dataType === 'backup_panels') {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ ephemeral: true });
        }
        const res = await this.backupDeployedPanels();
        await interaction.editReply({
          content: `Backup spremljen. Panela: ${res.count}. Datoteka: ${res.file}`
        });
      } catch (error: any) {
        console.error('Backup panels error:', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `Greska: ${error.message}` });
          } else {
            await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    if (dataType === 'restore_panels') {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ ephemeral: true });
        }
        const res = await this.restoreDeployedPanelsFromBackup();
        await interaction.editReply({
          content: `Restore zavrsen. Osvjezeno: ${res.restored}, Preskoceno: ${res.skipped}, Greske: ${res.failed}.`
        });
      } catch (error: any) {
        console.error('Restore panels error:', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `Greska: ${error.message}` });
          } else {
            await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
          }
        } catch {}
      }
      return;
    }
    
    // Handle sync button separately
    if (dataType === 'sync') {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ ephemeral: true });
        }
        await this.runSyncWithVehiclesRefresh();
        await interaction.editReply({ content: `Sync pokrenut! Podaci se sinkroniziraju...` });
        await storage.log({ type: 'info', message: 'Sync pokrenut putem Admin Panel gumba' });
      } catch (error: any) {
        console.error('Sync button error:', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `Greska: ${error.message}` });
          } else {
            await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
          }
        } catch {}
      }
      return;
    }
    
    const allowedTypes = ['server_info', 'status', 'farms', 'fields', 'vehicles', 'silos', 'animals', 'weather', 'productions', 'players', 'jobs'];
    
    if (!allowedTypes.includes(dataType)) {
      try {
        await interaction.reply({ content: 'Nepoznat tip podataka.', ephemeral: true });
      } catch {}
      return;
    }

    const channelId = interaction.channelId;

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }

      // Check if panel exists for this data type in this channel
      const existingPanel = await storage.getDeployedPanel(channelId, dataType, null);
      const result = await this.sendOrRefreshPanel(channelId, dataType, null, existingPanel);
      
      const statusMsg = result.refreshed 
        ? `${dataType.charAt(0).toUpperCase() + dataType.slice(1)} panel osvjezen.`
        : `${dataType.charAt(0).toUpperCase() + dataType.slice(1)} panel postavljen.`;
      
      await interaction.editReply({ content: statusMsg });
    } catch (error: any) {
      console.error('Button click error:', error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: `Greska: ${error.message}` });
        } else {
          await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
        }
      } catch {}
    }

    // ── Channel Manager buttons ──
    if (customId === 'chm_add_category') {
      if (!this.isOwner(interaction.user.id)) return;
      const modal = new ModalBuilder()
        .setCustomId('chm_modal_add_category')
        .setTitle('Nova Kategorija');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('cat_name')
            .setLabel('Ime kategorije')
            .setPlaceholder('npr. ── 📌 INFORMACIJE ──')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (customId === 'chm_add_channel') {
      if (!this.isOwner(interaction.user.id)) return;
      const config = await readChannelConfig();
      if (config.categories.length === 0) {
        await interaction.reply({ content: '❌ Prvo dodaj kategoriju!', ephemeral: true });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId('chm_modal_add_channel')
        .setTitle('Novi Kanal');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_name')
            .setLabel('Ime kanala')
            .setPlaceholder('npr. 💬┃ᴏᴘćᴇɴɪᴛᴏ')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_category')
            .setLabel('Broj kategorije (1, 2, 3...)')
            .setPlaceholder('1')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_type')
            .setLabel('Tip kanala (text / voice / forum)')
            .setPlaceholder('text')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_perms')
            .setLabel('Permisije (readOnly, staffOnly, playerOnly, freeWrite)')
            .setPlaceholder('readOnly (ili prazno za default)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    if (customId === 'chm_remove') {
      if (!this.isOwner(interaction.user.id)) return;
      const config = await readChannelConfig();
      const options: any[] = [];
      for (let ci = 0; ci < config.categories.length; ci++) {
        const cat = config.categories[ci];
        options.push({
          label: `📁 ${cat.name}`.slice(0, 100),
          value: `rmcat_${ci}`,
          description: `Ukloni kategoriju (${cat.channels.length} kanala)`,
        });
        for (let chi = 0; chi < cat.channels.length; chi++) {
          options.push({
            label: `#${cat.channels[chi].name}`.slice(0, 100),
            value: `rmch_${ci}_${chi}`,
            description: cat.name.replace(/[─── ]/g, '').slice(0, 50),
          });
        }
      }
      if (options.length === 0) {
        await interaction.reply({ content: 'Nema kanala za ukloniti.', ephemeral: true });
        return;
      }
      const selectOptions = options.slice(0, 25);
      const removeSelect = new StringSelectMenuBuilder()
        .setCustomId('chm_remove_select')
        .setPlaceholder('Odaberi kanal ili kategoriju za ukloniti...')
        .addOptions(selectOptions);
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(removeSelect);
      await interaction.reply({ content: '🗑️ Odaberi što želiš ukloniti iz konfiguracije:', components: [row], ephemeral: true });
      return;
    }

    if (customId === 'chm_deploy') {
      if (!this.isOwner(interaction.user.id)) return;
      const config = await readChannelConfig();
      const options = config.categories.map((cat, i) => ({
        label: cat.name.replace(/[─── ]/g, '').slice(0, 50),
        value: `deploy_${i}`,
        description: `${cat.channels.length} kanala`,
      }));
      options.push({ label: '🚀 Deploy SVE', value: 'deploy_all', description: 'Kreiraj sve kanale i kategorije' });
      const deploySelect = new StringSelectMenuBuilder()
        .setCustomId('chm_deploy_select')
        .setPlaceholder('Odaberi kategoriju za deploy...')
        .addOptions(options.slice(0, 25));
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(deploySelect);
      await interaction.reply({ content: '🚀 Odaberi kategoriju za kreirati na serveru:', components: [row], ephemeral: true });
      return;
    }

    // ── Settings: Reset all ──
    if (customId === 'settings_reset') {
      if (!this.isOwner(interaction.user.id)) return;
      await interaction.deferUpdate();
      const guildId = interaction.guild?.id;
      if (!guildId) return;
      const settings = await readGuildSettings();
      delete settings[guildId];
      await writeGuildSettings(settings);
      invalidateGuildSettingsCache();
      await this.sendSettingsPanel(interaction, true);
      return;
    }

    // ── Music buttons ──
    if (customId.startsWith('music_')) {
      const guildId = interaction.guild?.id;
      if (!guildId) {
        await interaction.reply({ content: '❌ Greška — ne mogu odrediti server.', ephemeral: true }).catch(() => {});
        return;
      }
      try {
        const queue = this.musicPlayer?.queues?.get(guildId);

      if (customId === 'music_pause') {
        if (!queue || !queue.isPlaying()) {
          await interaction.reply({ content: '❌ Ništa ne svira trenutno.', ephemeral: true }).catch(() => {});
          return;
        }
        queue.node.setPaused(!queue.node.isPaused());
        // Update the embed to reflect paused/playing state
        const currentTrack = queue.currentTrack;
        if (currentTrack) {
          const embed = this.buildNowPlayingEmbed(queue, currentTrack);
          const row = this.buildMusicButtons(queue);
          await interaction.update({ embeds: [embed], components: [row] }).catch(() => {});
        } else {
          await interaction.deferUpdate().catch(() => {});
        }
        return;
      }

      if (customId === 'music_skip') {
        if (!queue || !queue.isPlaying()) {
          await interaction.reply({ content: '❌ Ništa ne svira trenutno.', ephemeral: true }).catch(() => {});
          return;
        }
        queue.node.skip();
        // playerStart event will update the embed when next song starts
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      if (customId === 'music_previous') {
        if (!queue || !queue.history || queue.history.isEmpty()) {
          await interaction.reply({ content: '❌ Nema prethodne pjesme.', ephemeral: true }).catch(() => {});
          return;
        }
        await queue.history.previous();
        // playerStart event will update the embed
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      if (customId === 'music_stop') {
        if (queue) {
          this.autoplayMode.delete(guildId);
          queue.delete();
        }
        this.stopRadio(guildId);
        this.musicNowPlayingMsg.delete(guildId);
        const stoppedEmbed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setTitle('⏹ Zaustavljeno')
          .setDescription('Reprodukcija je zaustavljena i red očišćen.')
          .setTimestamp();
        await interaction.update({ embeds: [stoppedEmbed], components: [] }).catch(() => {});
        return;
      }

      if (customId === 'music_queue') {
        if (!queue || queue.isEmpty()) {
          const current = queue?.currentTrack;
          if (current) {
            await interaction.reply({ embeds: [
              new EmbedBuilder().setColor(0x5865f2).setTitle('📜 Red čekanja')
                .setDescription(`🎵 **Sada svira:** ${current.title} (${current.duration})\n\n*Red je prazan — dodaj pjesme s \`/play\`*`)
            ], ephemeral: true }).catch(() => {});
          } else {
            await interaction.reply({ content: '📜 Red je prazan.', ephemeral: true }).catch(() => {});
          }
          return;
        }
        const current = queue.currentTrack;
        const tracks = queue.tracks.toArray().slice(0, 10);
        let desc = current ? `🎵 **Sada svira:** [${current.title}](${current.url}) (${current.duration})\n\n` : '';
        desc += tracks.map((t: any, i: number) => `**${i + 1}.** [${t.title}](${t.url}) (${t.duration})`).join('\n');
        if (queue.tracks.size > 10) desc += `\n\n... i još ${queue.tracks.size - 10} pjesama`;
        await interaction.reply({ embeds: [
          new EmbedBuilder().setColor(0x5865f2).setTitle('📜 Red čekanja').setDescription(desc)
        ], ephemeral: true }).catch(() => {});
        return;
      }

      // Catch-all for unhandled music button
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Nepoznata akcija.', ephemeral: true }).catch(() => {});
      }
      } catch (musicErr: any) {
        console.error('[MUSIC] Button error:', musicErr?.message || musicErr);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `❌ Greška: ${(musicErr?.message || 'Nepoznata').slice(0, 150)}`, ephemeral: true }).catch(() => {});
        }
      }
    }
  }

  private async showFarmSelect(interaction: any) {
    try {
      const farms = (await storage.getFarms()).filter(f => !String(f.farmId || '').startsWith('U:'));
      
      if (farms.length === 0) {
        await interaction.reply({ 
          content: '[ERROR] Nema registriranih farmi. Pokreni /sync prvo.', 
          ephemeral: true 
        });
        return;
      }

      const options = farms.map(farm => ({
        label: (farm.name || `Farma ${farm.farmId}`).slice(0, 100),
        value: String(farm.farmId),
        description: `Vlasnik: ${(farm.owner || 'N/A').slice(0, 90)}`
      }));

      const selectMenu = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_farm_for_channel')
            .setPlaceholder('Odaberi farmu...')
            .addOptions(options)
        );

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Odaberi farmu za koju zelis postaviti kanal:',
          components: [selectMenu],
          ephemeral: true
        });
      }
    } catch (error: any) {
      console.error('Show farm select error:', error);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
        }
      } catch {}
    }
  }

  
  private async showLogChannelSelect(interaction: any) {
    try {
      const modal = new ModalBuilder()
        .setCustomId('modal_log_channel')
        .setTitle('Event Log Kanal');
      const channelInput = new TextInputBuilder()
        .setCustomId('log_channel_id')
        .setLabel('ID kanala za join/leave + online/offline')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('npr. 1239288670872272956');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput)
      );
      await interaction.showModal(modal);
    } catch (error: any) {
      console.error('Show log channel modal error:', error);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
        }
      } catch {}
    }
  }

  private async showTrackingLogChannelSelect(interaction: any) {
    try {
      const modal = new ModalBuilder()
        .setCustomId('modal_tracking_channel')
        .setTitle('Tracking Log Kanal');
      const channelInput = new TextInputBuilder()
        .setCustomId('tracking_channel_id')
        .setLabel('ID kanala za tracking igraca i opreme')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('npr. 1271570784866799718');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput)
      );
      await interaction.showModal(modal);
    } catch (error: any) {
      console.error('Show tracking channel modal error:', error);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
        }
      } catch {}
    }
  }

  private async showServerInfoChannelSelect(interaction: any) {
    try {
      const channelSelect = new ActionRowBuilder<ChannelSelectMenuBuilder>()
        .addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('select_channel_for_server_info')
            .setPlaceholder('Odaberi kanal za Server Info embed...')
        );

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Odaberi kanal u koji želiš deployati Server Info embed:',
          components: [channelSelect],
          ephemeral: true
        });
      }
    } catch (error: any) {
      console.error('Show server info channel select error:', error);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `Greska: ${error.message}`, ephemeral: true });
        }
      } catch {}
    }
  }

  private async handleSelectMenu(interaction: any) {
    const customId = interaction.customId;

    // ── Poslovi na ugovor — select menu handlers ──
    if (customId === 'poslovi_select_accept' || customId === 'poslovi_select_complete' || customId === 'poslovi_select_cancel') {
      await interaction.deferUpdate();
      try {
        const gameId = parseInt(interaction.values[0]);
        const contracts = await storage.getCustomContracts();
        const contract = contracts.find((c: any) => c.gameId === gameId);
        if (!contract) {
          await interaction.followUp({ content: '❌ Ugovor nije pronađen.', ephemeral: true });
          return;
        }

        const farms = await storage.getFarms();
        const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
        let userFarmId = '1';
        if (member && farms.length > 0) {
          for (const farm of farms) {
            const farmName = farm.name || `Farma ${farm.farmId}`;
            const farmRole = interaction.guild.roles.cache.find((r: any) => r.name === `🌾 ${farmName}`);
            if (farmRole && member.roles.cache.has(farmRole.id)) {
              userFarmId = String(farm.farmId);
              break;
            }
          }
        }

        const actionMap: Record<string, string> = {
          'poslovi_select_accept': 'acceptContract',
          'poslovi_select_complete': 'completeContract',
          'poslovi_select_cancel': 'cancelContract',
        };
        const labelMap: Record<string, string> = {
          'poslovi_select_accept': '🟢 Prihvaćen',
          'poslovi_select_complete': '✅ Dovršen',
          'poslovi_select_cancel': '❌ Otkazan',
        };
        const type = actionMap[customId];
        await this.sendPosloviCommand(type, { contractId: gameId, farmId: parseInt(userFarmId) });

        const wt = this.POSLOVI_WORK_TYPES[contract.workType] || contract.workType;
        await interaction.followUp({
          content: `${labelMap[customId]} ugovor **#${gameId}** (${wt}, Polje ${contract.fieldId})\n⏳ Naredba poslana u igru — promjena će se primjeniti na sljedećem syncu.`,
          ephemeral: true,
        });

        // Refresh panel if it exists
        try {
          const panels = await storage.getDeployedPanels();
          const ccPanel = panels.find((p: any) => p.panelType === 'custom_contracts');
          if (ccPanel && interaction.guild) {
            const ch = await interaction.guild.channels.fetch(ccPanel.channelId).catch(() => null) as any;
            if (ch) {
              const msg = await ch.messages.fetch(ccPanel.messageId).catch(() => null);
              if (msg) {
                const embed = await this.buildPanelEmbed('custom_contracts', null);
                const components = await this.buildCustomContractsComponents();
                await msg.edit({ embeds: [embed], components });
              }
            }
          }
        } catch {}
      } catch (e: any) {
        console.error('[POSLOVI] Select action error:', e);
        try { await interaction.followUp({ content: `❌ Greška: ${e.message}`, ephemeral: true }); } catch {}
      }
      return;
    }

    // ── Coop Contract Select — player picks a contract from dropdown ──
    if (customId === 'coop_contract_select') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const contractId = interaction.values[0];
        const guild = interaction.guild;
        if (!guild) { await interaction.editReply('❌ Greška — guild nije dostupan.'); return; }

        // Get contract
        const contracts = await storage.getActiveContracts();
        const contract = contracts.find((c: any) => String(c._id) === contractId);
        if (!contract) { await interaction.editReply('❌ Ugovor nije pronađen ili je istekao.'); return; }

        // Find user's farm via Discord role
        const farms = await storage.getFarms();
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) { await interaction.editReply('❌ Greška kod dohvaćanja profila.'); return; }

        let userFarm: any = null;
        for (const farm of farms) {
          const farmName = farm.name || `Farma ${farm.farmId}`;
          const farmRole = guild.roles.cache.find((r: any) => r.name === `🌾 ${farmName}`);
          if (farmRole && member.roles.cache.has(farmRole.id)) {
            userFarm = farm;
            break;
          }
        }
        if (!userFarm) { await interaction.editReply('❌ Nemaš dodijeljenu farmu! Traži admina da te dodijeli na farmu.'); return; }

        const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;
        const farmName = userFarm.name || `Farma ${userFarm.farmId}`;

        // Check if contract already claimed by another farm
        if (contract.claimedByFarmId && String(contract.claimedByFarmId) !== String(userFarm.farmId)) {
          const claimFarm = farms.find(f => String(f.farmId) === String(contract.claimedByFarmId));
          const claimFarmName = claimFarm?.name || `Farma ${contract.claimedByFarmId}`;
          await interaction.editReply(`❌ Ovaj ugovor je već preuzela **${claimFarmName}**! Odaberi drugi.`); return;
        }

        // Check if farm already has 2 active claimed contracts
        const farmContracts = await storage.getContractsByFarm(String(userFarm.farmId));
        if (farmContracts.length >= 2) {
          const names = farmContracts.map((c: any) => COOP_FILL_NAMES[c.fillType] || c.fillType).join(', ');
          await interaction.editReply(`❌ Tvoja farma već ima **2 aktivna ugovora** (${names})! Završi jedan prije nego uzmeš novi.`); return;
        }

        // Check if this farm already has a channel for this contract
        const channelName = `📦┃${cName.toLowerCase().replace(/[^a-zA-Zščćžđ0-9]/g, '-').replace(/-+/g, '-')}-f${userFarm.farmId}`;
        const existingChannel = guild.channels.cache.find((c: any) => c.type === 0 && c.name === channelName);
        if (existingChannel) {
          await interaction.editReply(`⚠️ Već imaš otvoren kanal za ovaj ugovor: <#${existingChannel.id}>`);
          return;
        }

        // Claim the contract for this farm (atomic — prevents race conditions)
        if (!contract.claimedByFarmId) {
          const claimed = await storage.claimContract(contractId, String(userFarm.farmId));
          if (!claimed) {
            await interaction.editReply('❌ Ugovor je upravo preuzela druga farma! Pokušaj drugi.'); return;
          }
        }

        // Find farm category (robust fallback)
        const farmCat = findFarmCategory(guild, farmName);
        if (!farmCat) { await interaction.editReply('❌ Kategorija farme nije pronađena! Pokreni /server setup.'); return; }

        // Create channel under farm category, next to POSLOVI/CHAT
        const farmRole = guild.roles.cache.find((r: any) => r.name === `🌾 ${farmName}`);
        const botMember = guild.members.me;
        const permOverwrites: any[] = [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        ];
        if (farmRole) permOverwrites.push({ id: farmRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        if (botMember) permOverwrites.push({ id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] });
        // Staff roles
        const staffRoleNames = ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'];
        for (const srName of staffRoleNames) {
          const sr = guild.roles.cache.find((r: any) => r.name === srName);
          if (sr) permOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
        }

        const contractChannel = await guild.channels.create({
          name: channelName,
          type: 0,
          parent: farmCat.id,
          permissionOverwrites: permOverwrites.filter((p: any) => p.id),
          reason: `Coop Ugovor — ${cName} za ${farmName}`,
        });

        // Calculate expected earnings
        const market = await storage.getCoopMarket();
        const marketItem = market.find((m: any) => m.fillType === contract.fillType);
        const basePrice = marketItem ? this.calcActualPrice(marketItem.currentPrice, marketItem.supplyLevel || 0) : 0;
        const fullEarnings = +(basePrice * contract.requiredAmount).toFixed(0);
        const bonusAmount = +(fullEarnings * contract.bonusPercent / 100).toFixed(0);
        const totalWithBonus = fullEarnings + bonusAmount;
        const expiresH = contract.expiresAt ? Math.max(0, Math.ceil((new Date(contract.expiresAt).getTime() - Date.now()) / 3600000)) : 24;
        const tier = contract.bonusPercent >= 35 ? '🔴 VELIKI' : contract.bonusPercent >= 25 ? '🟡 SREDNJI' : '🟢 MALI';

        const trackingEmbed = new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle(`📦 Ugovor: ${this.getFillTypeEmoji(contract.fillType)} ${cName}`)
          .setDescription(
            `**${farmName}** — Coop ugovor u tijeku\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📋 **Detalji ugovora:**\n` +
            `${this.getFillTypeEmoji(contract.fillType)} Materijal: **${cName}**\n` +
            `📦 Potrebno: **${contract.requiredAmount?.toLocaleString('hr-HR')}L**\n` +
            `🏷️ Tip: **${tier}**\n` +
            `💰 Bonus: **+${contract.bonusPercent}%**\n` +
            `⏳ Rok: **${expiresH}h**\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💵 **Očekivana zarada (puna isporuka):**\n` +
            `Osnovna zarada: **$${fullEarnings.toLocaleString('hr-HR')}**\n` +
            `Bonus (+${contract.bonusPercent}%): **$${bonusAmount.toLocaleString('hr-HR')}**\n` +
            `Ukupno: **$${totalWithBonus.toLocaleString('hr-HR')}**\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📊 **Napredak:**\n` +
            `Isporučeno: **0/${contract.requiredAmount?.toLocaleString('hr-HR')}L** (0%)\n\n` +
            `💡 *Dovezite robu u Coop Silo (outbound). Stavite koliko želite — bonus je proporcionalan!*\n` +
            `*Ako stavite manje, dobivate manji bonus ali i dalje zarađujete.*`
          )
          .setFooter({ text: `Ugovor ID: ${contractId} • Farma ${userFarm.farmId}` })
          .setTimestamp();

        const finishBtn = new ButtonBuilder()
          .setCustomId(`coop_contract_finish:${contractId}:${userFarm.farmId}:${contractChannel.id}`)
          .setLabel('✅ Završi ugovor')
          .setStyle(ButtonStyle.Success);

        const refreshBtn = new ButtonBuilder()
          .setCustomId(`coop_contract_refresh:${contractId}:${userFarm.farmId}:${contractChannel.id}`)
          .setLabel('🔄 Osvježi stanje')
          .setStyle(ButtonStyle.Secondary);

        const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(refreshBtn, finishBtn);

        await contractChannel.send({ embeds: [trackingEmbed], components: [btnRow] });

        await interaction.editReply(`✅ Ugovor pokrenut! Otvoren kanal: <#${contractChannel.id}>\nDovezi robu u Coop Silo i prati napredak tamo.`);

        // Log to mod-log
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          const logEmbed = new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle('📦 COOP — Ugovor pokrenut')
            .addFields(
              { name: '👤 Igrač', value: `<@${interaction.user.id}>`, inline: true },
              { name: '🏘️ Farma', value: farmName, inline: true },
              { name: '📦 Ugovor', value: `${cName} — ${contract.requiredAmount?.toLocaleString('hr-HR')}L`, inline: true },
              { name: '💰 Bonus', value: `+${contract.bonusPercent}%`, inline: true },
            )
            .setTimestamp();
          await (modLog as any).send({ embeds: [logEmbed] }).catch(() => {});
        }
      } catch (e: any) {
        console.error('[COOP] Contract select error:', e);
        try { await interaction.editReply(`❌ Greška: ${e.message}`); } catch {}
      }
      return;
    }

    // ── /farme player select ──
    if (customId === 'farme_player_select') {
      const selectedUid = interaction.values[0];
      this.farmeSelectedPlayer.set(interaction.user.id, selectedUid);
      const player = (await storage.getPlayers()).find(p => p.uniqueUserId === selectedUid);
      const name = player?.name || selectedUid;
      await interaction.deferUpdate();
      await interaction.followUp({ content: `✅ Odabran igrač: **${name}**\nSada klikni farmu ispod da ga premjestiš.`, ephemeral: true });
      return;
    }

    // ── Channel Manager: Remove select ──
    if (customId === 'chm_remove_select') {
      if (!this.isOwner(interaction.user.id)) return;
      await interaction.deferUpdate();
      const val = interaction.values[0] as string;
      const config = await readChannelConfig();
      let removed = '';

      if (val.startsWith('rmcat_')) {
        const catIdx = parseInt(val.replace('rmcat_', ''));
        if (catIdx >= 0 && catIdx < config.categories.length) {
          removed = `📁 Kategorija **${config.categories[catIdx].name}** (${config.categories[catIdx].channels.length} kanala)`;
          config.categories.splice(catIdx, 1);
        }
      } else if (val.startsWith('rmch_')) {
        const parts = val.replace('rmch_', '').split('_');
        const catIdx = parseInt(parts[0]);
        const chIdx = parseInt(parts[1]);
        if (catIdx >= 0 && catIdx < config.categories.length && chIdx >= 0 && chIdx < config.categories[catIdx].channels.length) {
          removed = `# **${config.categories[catIdx].channels[chIdx].name}**`;
          config.categories[catIdx].channels.splice(chIdx, 1);
        }
      }

      if (removed) {
        await writeChannelConfig(config);
        await interaction.editReply({ content: `✅ Uklonjeno: ${removed}`, components: [] });
      } else {
        await interaction.editReply({ content: '❌ Nije pronađeno.', components: [] });
      }
      return;
    }

    // ── Backup delete select ──
    if (customId === 'backup_delete_select') {
      if (!this.isOwner(interaction.user.id)) return;
      await interaction.deferUpdate();
      const backupId = interaction.values[0];
      try {
        const deleted = await storage.deleteBackup(backupId);
        if (deleted) {
          await interaction.editReply({ content: `✅ Backup obrisan (ID: \`${backupId}\`).`, components: [] });
        } else {
          await interaction.editReply({ content: '❌ Backup nije pronađen.', components: [] });
        }
      } catch (e: any) {
        await interaction.editReply({ content: `❌ Greška: ${e.message}`, components: [] });
      }
      return;
    }

    // ── Channel Manager: Deploy select ──
    if (customId === 'chm_deploy_select') {
      if (!this.isOwner(interaction.user.id)) return;
      await interaction.deferUpdate();
      const val = interaction.values[0] as string;
      const config = await readChannelConfig();
      const guild = interaction.guild;
      if (!guild) { await interaction.editReply({ content: 'Greška — nema guild.', components: [] }); return; }

      const log: string[] = [];
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

      // Resolve roles from cache for permissions
      const staffRoles = guild.roles.cache.filter((r: any) => 
        STAFF_ROLES.some(sr => r.name.includes(sr.name.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}]/gu, '').trim()))
      );
      const playerRole = guild.roles.cache.find((r: any) => r.name.includes('Ratar'));
      const memberRole = guild.roles.cache.find((r: any) => r.name.includes('Mještanin'));
      const blacklistRole = guild.roles.cache.find((r: any) => r.name.includes('BLACKLIST'));
      const botMember = guild.members.cache.get(this.client.user?.id);

      const deployCategory = async (cat: CategoryDef_Saved) => {
        // Find or create category
        let category = guild.channels.cache.find((c: any) => c.name === cat.name && c.type === 4);
        if (!category) {
          category = await guild.channels.create({ name: cat.name, type: 4, reason: 'Channel Manager Deploy' });
          log.push(`📂 Kategorija kreirana: ${cat.name}`);
          await delay(1500);
        } else {
          log.push(`📂 Kategorija postoji: ${cat.name}`);
        }

        for (const ch of cat.channels) {
          const chType = ch.type === 'voice' ? 2 : ch.type === 'forum' ? 15 : 0;
          let channel = guild.channels.cache.find((c: any) =>
            c.type === chType && c.name === ch.name && c.parentId === category.id
          );
          if (!channel) {
            const fallbackName = ch.name.split('┃')[1]?.trim();
            if (fallbackName) {
              channel = guild.channels.cache.find((c: any) =>
                c.type === chType && c.parentId === category.id && c.name.includes(fallbackName)
              );
            }
          }

          // Build permission overwrites
          const permOverwrites: any[] = [];
          const isVoice = ch.type === 'voice';

          if (ch.staffOnly) {
            permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel, ...(isVoice ? [PermissionFlagsBits.Connect] : [])] });
            for (const [, sr] of staffRoles) {
              permOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, ...(isVoice ? [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] : [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages])] });
            }
          } else if (ch.playerOnly) {
            permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
            if (playerRole) {
              if (ch.readOnly) {
                permOverwrites.push({ id: playerRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] });
              } else {
                permOverwrites.push({ id: playerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
              }
            }
            for (const [, sr] of staffRoles) {
              permOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
            }
            if (memberRole) {
              permOverwrites.push({ id: memberRole.id, deny: [PermissionFlagsBits.ViewChannel] });
            }
          } else if (ch.freeWrite) {
            if (ch.type === 'forum') {
              permOverwrites.push({ id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.ReadMessageHistory] });
            }
          } else if (ch.readOnly) {
            permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.SendMessages] });
          } else if (isVoice) {
            permOverwrites.push({ id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });
          } else {
            permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.SendMessages] });
            for (const [, sr] of staffRoles) {
              permOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
            }
          }

          if (blacklistRole) {
            permOverwrites.push({ id: blacklistRole.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect] });
          }
          if (botMember) {
            permOverwrites.push({ id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] });
          }

          if (!channel) {
            const createOpts: any = {
              name: ch.name,
              type: chType,
              parent: category.id,
              permissionOverwrites: permOverwrites.filter((p: any) => p.id),
              reason: 'Channel Manager Deploy',
            };
            if (ch.type === 'forum') {
              createOpts.topic = 'Postavi pitanje — otvori novu temu!';
              createOpts.defaultAutoArchiveDuration = 4320;
            }
            channel = await guild.channels.create(createOpts);
            log.push(`  ✨ ${ch.type === 'voice' ? '🔊' : ch.type === 'forum' ? '💬' : '#'} ${ch.name}`);
            await delay(1500);
          } else {
            log.push(`  ✅ ${ch.name} — postoji`);
          }
        }
      };

      try {
        if (val === 'deploy_all') {
          await interaction.editReply({ content: '🚀 Deploy svih kanala u tijeku...', components: [] });
          for (const cat of config.categories) {
            await deployCategory(cat);
          }
        } else if (val.startsWith('deploy_')) {
          const catIdx = parseInt(val.replace('deploy_', ''));
          if (catIdx >= 0 && catIdx < config.categories.length) {
            await interaction.editReply({ content: `🚀 Deploy kategorije **${config.categories[catIdx].name}**...`, components: [] });
            await deployCategory(config.categories[catIdx]);
          }
        }

        const resultEmbed = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('✅ Deploy Završen')
          .setDescription(log.join('\n') || 'Nema promjena.')
          .setTimestamp();
        await interaction.editReply({ content: null, embeds: [resultEmbed], components: [] });
      } catch (e: any) {
        console.error('[CHANNEL_MANAGER] Deploy error:', e);
        await interaction.editReply({ content: `❌ Greška: ${e.message}`, components: [] }).catch(() => {});
      }
      return;
    }

    // ── Settings: Pick which channel key to configure ──
    if (customId === 'settings_pick_key') {
      if (!this.isOwner(interaction.user.id)) return;
      const selectedKey = interaction.values[0] as GuildChannelKey;
      const meta = GUILD_CHANNEL_KEYS[selectedKey];
      if (!meta) {
        await interaction.reply({ content: '❌ Nepoznata postavka.', ephemeral: true });
        return;
      }

      // Show a channel select menu for this key
      const { ChannelSelectMenuBuilder } = require('discord.js');
      const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(`settings_channel_pick:${selectedKey}`)
        .setPlaceholder(`Odaberi kanal za ${meta.label}`)
        .addChannelTypes(0, 5); // GuildText & GuildAnnouncement

      const row = new ActionRowBuilder().addComponents(channelSelect);
      await interaction.reply({
        content: `${meta.label}\n${meta.desc}\n\nOdaberi kanal:`,
        components: [row],
        ephemeral: true,
      });
      return;
    }

    // ── Ticket type selected — create the actual ticket thread ──
    if (customId === 'ticket_type_select') {
      try {
        const guild = interaction.guild;
        const selectedType = (interaction as any).values?.[0];
        const ticketType = TICKET_TYPES.find(t => t.id === selectedType);
        if (!guild || !ticketType) { await interaction.reply({ content: 'Greška — neispravan odabir.', ephemeral: true }); return; }

        // Check for existing open ticket
        const existingThread = guild.channels.cache.find((c: any) =>
          c.isThread?.() && c.name.startsWith('🎫') && c.name.includes(interaction.user.username) && !c.archived
        );
        if (existingThread) {
          await interaction.reply({ content: `Već imaš otvoren ticket: ${existingThread}`, ephemeral: true });
          return;
        }

        // Build modal with category-specific questions
        const modalFields = TICKET_MODAL_FIELDS[ticketType.id] || TICKET_MODAL_FIELDS.ostalo;
        const modal = new ModalBuilder()
          .setCustomId(`ticket_form_${ticketType.id}`)
          .setTitle(`${ticketType.emoji} ${ticketType.label}`);

        for (const field of modalFields.slice(0, 5)) { // Discord limit: 5 fields per modal
          const input = new TextInputBuilder()
            .setCustomId(field.id)
            .setLabel(field.label)
            .setPlaceholder(field.placeholder)
            .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(field.required);
          if (field.style === 'paragraph') input.setMaxLength(1000);
          if (field.style === 'short') input.setMaxLength(200);
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        }

        await interaction.showModal(modal);
      } catch (e: any) {
        console.error('[TICKET] Modal show error:', e);
        await interaction.reply({ content: `Greška: ${e.message}`, ephemeral: true }).catch(() => {});
      }
      return;
    }

    // ── Ticket snippet select ──
    if (customId === 'ticket_snippet') {
      try {
        const guild = interaction.guild;
        if (!guild) { await interaction.reply({ content: 'Greška.', ephemeral: true }); return; }

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff = member?.roles.cache.some((r: any) =>
          ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
        );
        if (!isStaff) {
          await interaction.reply({ content: '❌ Samo staff može koristiti snippete.', ephemeral: true });
          return;
        }

        const selectedSnippet = (interaction as any).values?.[0];
        const snippet = SNIPPETS[selectedSnippet];
        if (!snippet) { await interaction.reply({ content: '❌ Nepoznat snippet.', ephemeral: true }); return; }

        const embed = new EmbedBuilder()
          .setColor(snippet.color)
          .setTitle(snippet.title)
          .setDescription(snippet.description)
          .setFooter({ text: `Poslao: ${interaction.user.tag}` })
          .setTimestamp();
        if (snippet.fields) embed.addFields(snippet.fields);

        const replyOpts: any = { embeds: [embed] };
        if (snippet.buttons?.length) {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...snippet.buttons.map(b => new ButtonBuilder().setLabel(b.label).setStyle(ButtonStyle.Link).setURL(b.url))
          );
          replyOpts.components = [row];
        }

        await interaction.reply(replyOpts);
      } catch (e: any) {
        console.error('[TICKET SNIPPET] Error:', e);
        await interaction.reply({ content: `Greška: ${e.message}`, ephemeral: true }).catch(() => {});
      }
      return;
    }

    if (customId === 'link_game_user') {
      try {
        const messageId = interaction.message?.id;
        const selected = String(interaction.values?.[0] || '').trim();
        if (!messageId || !selected || selected === 'none') {
          await interaction.reply({ content: 'Odaberi valjanog FS25 igrača.', ephemeral: true });
          return;
        }

        const prev = this.linkingSessions.get(messageId) || {};
        this.linkingSessions.set(messageId, { ...prev, uniqueUserId: selected });
        await interaction.reply({ content: `✅ Odabran FS25 igrač: ${selected}`, ephemeral: true });
      } catch (error: any) {
        console.error('Link game user select error:', error);
      }
      return;
    }

    if (customId === 'serverinfo_player_select') {
      try {
        await interaction.deferUpdate();
        const messageId = interaction.message?.id;
        if (!messageId) return;
        const selected = String(interaction.values?.[0] || 'latest');
        this.serverInfoPlayerByMessage.set(messageId, selected);
        const payload = await this.buildServerInfoPayload(messageId);
        await interaction.message.edit(payload as any);
      } catch (error: any) {
        console.error('Server info player select error:', error);
      }
      return;
    }

    if (customId === 'vehicles_category_select') {
      try {
        await interaction.deferUpdate();
        const messageId = interaction.message?.id;
        if (!messageId) return;

        const selected = String(interaction.values?.[0] || 'ALL');
        this.vehiclesCategoryByMessage.set(messageId, selected);

        for (const key of this.listPageByMessageAndPanel.keys()) {
          if (key.startsWith(`${messageId}:vehicles:`)) {
            this.listPageByMessageAndPanel.set(key, 0);
          }
        }

        const panel = (await storage.getDeployedPanels()).find((p: any) => String(p.messageId) === String(messageId));
        const farm = panel?.farmId ? String(panel.farmId) : null;
        const embed = await this.buildPanelEmbed('vehicles', farm, { messageId });
        const components = await this.buildListPanelComponents('vehicles', farm, messageId);
        await interaction.message.edit({ embeds: [embed], components });
      } catch (error: any) {
        console.error('Vehicles category select error:', error);
      }
      return;
    }

    if (customId === 'vehicles_types_select') {
      try {
        await interaction.deferUpdate();
        const messageId = interaction.message?.id;
        if (!messageId) return;

        const prev = this.vehiclesTypesByMessage.get(messageId) || ['ALL'];
        let selected = (interaction.values || []).map((v: any) => String(v || 'ALL'));
        if (!selected.length) selected = ['ALL'];
        if (selected.includes('ALL') && selected.length > 1) {
          selected = selected.filter((v: string) => v !== 'ALL');
        }
        if (!selected.length) selected = ['ALL'];

        const prevKey = [...prev].sort().join('|');
        const nextKey = [...selected].sort().join('|');
        const changed = prevKey !== nextKey;

        this.vehiclesTypesByMessage.set(messageId, selected);
        if (changed) {
          this.vehiclesSelectedByMessage.set(messageId, ['ALL']);
        }

        if (changed) {
          for (const key of this.listPageByMessageAndPanel.keys()) {
            if (key.startsWith(`${messageId}:vehicles:`)) {
              this.listPageByMessageAndPanel.set(key, 0);
            }
          }
        }

        const panel = (await storage.getDeployedPanels()).find((p: any) => String(p.messageId) === String(messageId));
        const farm = panel?.farmId ? String(panel.farmId) : null;
        const embed = await this.buildPanelEmbed('vehicles', farm, { messageId });
        const components = await this.buildListPanelComponents('vehicles', farm, messageId);
        await interaction.message.edit({ embeds: [embed], components });
      } catch (error: any) {
        console.error('Vehicles types select error:', error);
      }
      return;
    }

    if (customId === 'vehicles_item_select') {
      try {
        await interaction.deferUpdate();
        const messageId = interaction.message?.id;
        if (!messageId) return;

        let selected = (interaction.values || []).map((v: any) => String(v || 'ALL'));
        if (!selected.length) selected = ['ALL'];
        if (selected.includes('ALL') && selected.length > 1) {
          selected = selected.filter((v: string) => v !== 'ALL');
        }
        if (!selected.length) selected = ['ALL'];
        this.vehiclesSelectedByMessage.set(messageId, selected);

        for (const key of this.listPageByMessageAndPanel.keys()) {
          if (key.startsWith(`${messageId}:vehicles:`)) {
            this.listPageByMessageAndPanel.set(key, 0);
          }
        }

        const panel = (await storage.getDeployedPanels()).find((p: any) => String(p.messageId) === String(messageId));
        const farm = panel?.farmId ? String(panel.farmId) : null;
        const embed = await this.buildPanelEmbed('vehicles', farm, { messageId });
        const components = await this.buildListPanelComponents('vehicles', farm, messageId);
        await interaction.message.edit({ embeds: [embed], components });
      } catch (error: any) {
        console.error('Vehicles item select error:', error);
      }
      return;
    }

    if (customId === 'admin_features_farm_select') {
      try {
        const farmKey = String(interaction.values?.[0] || 'all');
        const farmId = farmKey === 'all' ? null : farmKey;
        const flags = await this.getFarmFeatureFlags(farmId);
        const row = this.buildFeatureFlagsToggleRow(farmKey, flags);
        const header = farmKey === 'all' ? '🌍 Sve mape' : `🗺️ Farma ${farmKey}`;

        await interaction.update({
          content: [
            `${header} — Feature opcije`,
            `Odaberi koje opcije su uključene (označeno = ON).`,
            `• Vozila alerti: ${flags.vehiclesAlerts ? 'ON' : 'OFF'}`,
            `• Polja task hints: ${flags.fieldsTaskHints ? 'ON' : 'OFF'}`
          ].join('\n'),
          components: [row]
        });
      } catch (error: any) {
        console.error('Feature farm select error:', error);
        try { await interaction.reply({ content: `Greška: ${error.message}`, ephemeral: true }); } catch {}
      }
      return;
    }

    if (customId.startsWith('admin_features_toggle:')) {
      try {
        const farmKey = String(customId.split(':')[1] || 'all');
        const farmId = farmKey === 'all' ? null : farmKey;
        const selected = new Set((interaction.values || []).map((v: any) => String(v || '')));

        const flags = await this.setFarmFeatureFlags(farmId, {
          vehiclesAlerts: selected.has('vehiclesAlerts'),
          fieldsTaskHints: selected.has('fieldsTaskHints')
        });

        const row = this.buildFeatureFlagsToggleRow(farmKey, flags);
        const header = farmKey === 'all' ? '🌍 Sve mape' : `🗺️ Farma ${farmKey}`;

        await interaction.update({
          content: [
            `✅ Spremljeno za ${header}`,
            `• Vozila alerti: ${flags.vehiclesAlerts ? 'ON' : 'OFF'}`,
            `• Polja task hints: ${flags.fieldsTaskHints ? 'ON' : 'OFF'}`
          ].join('\n'),
          components: [row]
        });
      } catch (error: any) {
        console.error('Feature toggle save error:', error);
        try { await interaction.reply({ content: `Greška: ${error.message}`, ephemeral: true }); } catch {}
      }
      return;
    }

    if (customId === 'inbox_queue_actions') {
      try {
        const action = String(interaction.values?.[0] || 'status');
        let actionMsg = 'Status osvježen.';

        if (action === 'process_now') {
          const res = await this.processInboxQueue(30);
          actionMsg = `Flush: processed ${res.processed} | sent ${res.sent} | failed ${res.failed}`;
        } else if (action === 'retry_failed') {
          const changed = await this.retryFailedInboxQueue();
          actionMsg = `Retry failed: ${changed} zapisa vraćeno u queue.`;
        } else if (action === 'clear_sent') {
          const removed = await this.clearSentInboxQueue();
          actionMsg = `Clear sent: obrisano ${removed} zapisa.`;
        } else if (action === 'clear_failed') {
          const removed = await this.clearFailedInboxQueue();
          actionMsg = `Clear failed: obrisano ${removed} zapisa.`;
        }

        const status = await this.getInboxQueueStatusSummary();
        await this.maybeNotifyInboxQueueIssue(status);
        const row = this.buildInboxQueueActionsRow();

        await interaction.update({
          content: [
            `📬 Inbox Queue`,
            actionMsg,
            `Stanje: queued ${status.queued} | failed ${status.failed} | due ${status.dueNow} | sent(24h) ${status.sent24h}`
          ].join('\n'),
          components: [row]
        });
      } catch (error: any) {
        console.error('Inbox queue actions error:', error);
        try { await interaction.reply({ content: `Greška: ${error.message}`, ephemeral: true }); } catch {}
      }
      return;
    }
    
    if (customId === 'select_farm_for_channel') {
      const selectedFarmId = interaction.values[0];

      const manualRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`select_channel_for_farm_manual:${selectedFarmId}`)
            .setLabel('Unesi ID kanala')
            .setStyle(ButtonStyle.Secondary)
        );

      await interaction.update({
        content: `Farma odabrana: **${selectedFarmId}**\nKlikni **Unesi ID kanala** i zalijepi kanal u koji se postavljaju svi paneli za ovu farmu.`,
        components: [manualRow]
      });

    }

    if (customId === 'admin_deploy_select') {
      const panelType = interaction.values[0];

      // For consistency, map 'silos' option to internal 'silos'
      const normalized = panelType === 'silos' ? 'silos' : panelType;

      await this.debugChannelPickerVisibility(interaction, normalized);

      try {
        const manualRow = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`admin_deploy_manual:${normalized}`)
              .setLabel('Unesi ID kanala')
              .setStyle(ButtonStyle.Secondary)
          );

        await interaction.reply({
          content: `Deploy panela **${normalized}** ide preko ručnog unosa kanala. Klikni **Unesi ID kanala** i zalijepi channel ID ili #mention.`,
          components: [manualRow],
          ephemeral: true
        });
      } catch (error: any) {
        console.error('Admin deploy select error:', error);
        try { await interaction.followUp({ content: `Greška: ${error.message}`, ephemeral: true }); } catch {}
      }
      return;
    }


    // Bank panel DISABLED - action select
    if (false && customId.startsWith('bank_action:')) {
      const farmId = customId.replace('bank_action:', '');
      const action = interaction.values[0];

      try {
        await interaction.deferUpdate();

        const baseComponents = await this.buildBankComponents(farmId === 'null' ? null : farmId);
        const rows: any[] = [baseComponents[0]];

        if (action === 'pay_user') {
          const members = await interaction.guild.members.fetch();
          const options = [...members.values()]
            .filter((m: any) => !m.user.bot)
            .slice(0, 25)
            .map((m: any) => ({
              label: (m.displayName || m.user.username || 'User').slice(0, 100),
              value: String(m.id),
              description: (`Discord: ${m.user.username}`).slice(0, 100)
            }));

          const targetRow = new ActionRowBuilder<StringSelectMenuBuilder>()
            .addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`bank_target:${farmId}:user`)
                .setPlaceholder('Odaberi igrača za isplatu...')
                .addOptions(options.length ? options : [{ label: 'Nema igrača', value: 'none' }])
            );
          rows.push(targetRow);
        } else if (action === 'pay_farm') {
          const farms = (await storage.getFarms()).filter(f => !String(f.farmId || '').startsWith('U:'));
          const options = farms
            .filter(f => String(f.farmId) !== String(farmId))
            .slice(0, 25)
            .map(f => ({
              label: (f.name || `Farma ${f.farmId}`).slice(0, 100),
              value: String(f.farmId),
              description: (`Saldo: ${this.fmtMoney(Number(f.balance || 0))} €`).slice(0, 100)
            }));

          const targetRow = new ActionRowBuilder<StringSelectMenuBuilder>()
            .addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`bank_target:${farmId}:farm`)
                .setPlaceholder('Odaberi farmu...')
                .addOptions(options.length ? options : [{ label: 'Nema farmi', value: 'none' }])
            );
          rows.push(targetRow);
        }

        rows.push(baseComponents[1]);

        await interaction.message.edit({
          embeds: [await this.buildBankEmbed(farmId === 'null' ? null : farmId)],
          components: rows
        });
      } catch (error: any) {
        console.error('Bank action select error:', error);
      }
      return;
    }

    // Bank panel DISABLED - target select -> show modal
    if (false && customId.startsWith('bank_target:')) {
      const parts = String(customId).split(':'); // bank_target:<farmId>:<type>
      const farmId = parts[1];
      const targetType = parts[2]; // user|farm
      const targetId = interaction.values[0];

      if (targetId === 'none') {
        await interaction.deferUpdate();
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`bank_pay_submit:${farmId}:${targetType}:${targetId}`)
        .setTitle('💸 Bank transfer');

      const amountInput = new TextInputBuilder()
        .setCustomId('bank_amount')
        .setLabel('Iznos (€)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('npr. 12000')
        .setRequired(true);

      const reasonInput = new TextInputBuilder()
        .setCustomId('bank_reason')
        .setLabel('Razlog')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('npr. posao, najam, dogovor...')
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // ── Poslovi na ugovor (Custom Contracts) panel buttons ──
    if (customId === 'poslovi_refresh') {
      await interaction.deferUpdate();
      try {
        const embed = await this.buildPanelEmbed('custom_contracts', null);
        const components = await this.buildCustomContractsComponents();
        await interaction.message.edit({ embeds: [embed], components });
      } catch (e: any) {
        console.error('[POSLOVI] Refresh error:', e);
      }
      return;
    }

    if (customId === 'poslovi_accept') {
      const contracts = await storage.getCustomContracts();
      const open = contracts.filter((c: any) => c.status === 'OTVORENO');
      if (open.length === 0) {
        await interaction.reply({ content: '❌ Nema otvorenih ugovora za prihvaćanje.', ephemeral: true });
        return;
      }
      const farms = await storage.getFarms();
      const options = open.slice(0, 25).map((c: any) => {
        const wt = this.POSLOVI_WORK_TYPES[c.workType] || c.workType;
        const creator = farms.find((f: any) => String(f.farmId) === String(c.creatorFarmId))?.name || `Farma ${c.creatorFarmId}`;
        return { label: `#${c.gameId} ${c.workType} - Polje ${c.fieldId}`.slice(0, 100), description: `${creator} | ${c.reward?.toLocaleString() || 0}€`.slice(0, 100), value: String(c.gameId) };
      });
      const row = new ActionRowBuilder<any>().addComponents(
        new StringSelectMenuBuilder().setCustomId('poslovi_select_accept').setPlaceholder('Odaberi ugovor za prihvaćanje').addOptions(options)
      );
      await interaction.reply({ content: '🟢 Odaberi ugovor koji želiš prihvatiti:', components: [row], ephemeral: true });
      return;
    }

    if (customId === 'poslovi_complete') {
      const contracts = await storage.getCustomContracts();
      const accepted = contracts.filter((c: any) => c.status === 'PRIHVAĆENO');
      if (accepted.length === 0) {
        await interaction.reply({ content: '❌ Nema prihvaćenih ugovora za dovršavanje.', ephemeral: true });
        return;
      }
      const farms = await storage.getFarms();
      const options = accepted.slice(0, 25).map((c: any) => {
        const wt = this.POSLOVI_WORK_TYPES[c.workType] || c.workType;
        const contractor = c.contractorFarmId ? (farms.find((f: any) => String(f.farmId) === String(c.contractorFarmId))?.name || `Farma ${c.contractorFarmId}`) : 'N/A';
        return { label: `#${c.gameId} ${c.workType} - Polje ${c.fieldId}`.slice(0, 100), description: `${contractor} | ${c.reward?.toLocaleString() || 0}€`.slice(0, 100), value: String(c.gameId) };
      });
      const row = new ActionRowBuilder<any>().addComponents(
        new StringSelectMenuBuilder().setCustomId('poslovi_select_complete').setPlaceholder('Odaberi ugovor za dovršavanje').addOptions(options)
      );
      await interaction.reply({ content: '✅ Odaberi ugovor koji želiš dovršiti:', components: [row], ephemeral: true });
      return;
    }

    if (customId === 'poslovi_cancel') {
      const contracts = await storage.getCustomContracts();
      const cancellable = contracts.filter((c: any) => c.status === 'OTVORENO' || c.status === 'PRIHVAĆENO');
      if (cancellable.length === 0) {
        await interaction.reply({ content: '❌ Nema ugovora za otkazivanje.', ephemeral: true });
        return;
      }
      const farms = await storage.getFarms();
      const options = cancellable.slice(0, 25).map((c: any) => {
        const wt = this.POSLOVI_WORK_TYPES[c.workType] || c.workType;
        const creator = farms.find((f: any) => String(f.farmId) === String(c.creatorFarmId))?.name || `Farma ${c.creatorFarmId}`;
        return { label: `#${c.gameId} ${c.workType} - Polje ${c.fieldId}`.slice(0, 100), description: `${creator} | ${c.reward?.toLocaleString() || 0}€`.slice(0, 100), value: String(c.gameId) };
      });
      const row = new ActionRowBuilder<any>().addComponents(
        new StringSelectMenuBuilder().setCustomId('poslovi_select_cancel').setPlaceholder('Odaberi ugovor za otkazivanje').addOptions(options)
      );
      await interaction.reply({ content: '❌ Odaberi ugovor koji želiš otkazati:', components: [row], ephemeral: true });
      return;
    }

  }

  private async handleUserSelectMenu(interaction: any) {
    const customId = interaction.customId;
    if (customId !== 'link_discord_user') return;

    const messageId = interaction.message?.id;
    const selected = String(interaction.values?.[0] || '').trim();
    if (!messageId || !selected) {
      await interaction.reply({ content: 'Odaberi valjanog Discord korisnika.', ephemeral: true });
      return;
    }

    const prev = this.linkingSessions.get(messageId) || {};
    this.linkingSessions.set(messageId, { ...prev, discordUserId: selected });
    await interaction.reply({ content: `✅ Odabran Discord korisnik: <@${selected}>`, ephemeral: true });
  }

  private async handleChannelSelect(interaction: any) {
    const customId = interaction.customId;

    // ── Settings: Channel picked for a key ──
    if (customId.startsWith('settings_channel_pick:')) {
      if (!this.isOwner(interaction.user.id)) return;
      const key = customId.split(':')[1] as GuildChannelKey;
      const selectedChannelId = interaction.values[0];
      const guildId = interaction.guild?.id;
      if (!guildId || !key || !selectedChannelId) {
        await interaction.update({ content: '❌ Greška — nedostaju podaci.', components: [] });
        return;
      }

      const settings = await readGuildSettings();
      if (!settings[guildId]) settings[guildId] = {};
      settings[guildId][key] = selectedChannelId;
      await writeGuildSettings(settings);
      invalidateGuildSettingsCache();

      const meta = GUILD_CHANNEL_KEYS[key];
      await interaction.update({
        content: `✅ **${meta?.label || key}** postavljen na <#${selectedChannelId}>`,
        components: [],
      });
      return;
    }

    if (customId.startsWith('admin_deploy_channel_select:')) {
      const panelType = String(customId.split(':')[1] || '').trim();
      const selectedChannelId = interaction.values[0];

      if (!panelType || !selectedChannelId) {
        await interaction.update({ content: 'Greška: nedostaje panel ili kanal.', components: [] });
        return;
      }

      await interaction.update({
        content: `Deployam panel **${panelType}** u <#${selectedChannelId}>...`,
        components: []
      });

      try {
        const existingPanel = await storage.getDeployedPanel(selectedChannelId, panelType, null);
        const result = await this.sendOrRefreshPanel(selectedChannelId, panelType, null, existingPanel);
        const msg = result.refreshed
          ? `✅ Panel **${panelType}** osvježen u <#${selectedChannelId}>.`
          : `✅ Panel **${panelType}** postavljen u <#${selectedChannelId}>.`;
        await interaction.editReply({ content: msg, components: [] });
      } catch (error: any) {
        console.error('Admin deploy channel select error:', error);
        await interaction.editReply({ content: `Greška: ${error.message}`, components: [] });
      }
      return;
    }

    if (customId === 'select_log_channel') {
      // Legacy dropdown handler (kept for compatibility)
      const selectedChannelId = interaction.values[0];

      await interaction.update({
        content: `✅ Event log kanal postavljen u <#${selectedChannelId}> (join/leave + online/offline)`,
        components: []
      });

      try {
        await storage.upsertDeployedPanel({
          channelId: selectedChannelId,
          messageId: '1',
          panelType: 'log_channel',
          farmId: null
        } as any);

        await storage.upsertDeployedPanel({
          channelId: selectedChannelId,
          messageId: '1',
          panelType: 'log_presence_channel',
          farmId: null
        } as any);

        await storage.upsertDeployedPanel({
          channelId: selectedChannelId,
          messageId: '1',
          panelType: 'log_server_status_channel',
          farmId: null
        } as any);

        await storage.log({ type: 'info', message: `Event log kanal postavljen: ${selectedChannelId}` });
      } catch (e: any) {
        console.error('Save event log channel error:', e);
      }
      return;
    }

    if (customId === 'select_tracking_log_channel') {
      // Legacy dropdown handler (kept for compatibility)
      const selectedChannelId = interaction.values[0];

      await interaction.update({
        content: `✅ Tracking log kanal postavljen u <#${selectedChannelId}>`,
        components: []
      });

      try {
        await storage.upsertDeployedPanel({
          channelId: selectedChannelId,
          messageId: '1',
          panelType: 'log_tracking_channel',
          farmId: null
        } as any);

        await storage.log({ type: 'info', message: `Tracking log kanal postavljen: ${selectedChannelId}` });
      } catch (e: any) {
        console.error('Save tracking log channel error:', e);
      }
      return;
    }
    
    if (customId.startsWith('select_channel_for_farm_')) {
      const farmId = customId.replace('select_channel_for_farm_', '');
      const selectedChannelId = interaction.values[0];
      
      await interaction.update({
        content: `Postavljam panele za farmu ${farmId} u kanal <#${selectedChannelId}>...`,
        components: []
      });

      try {
        const resultMessage = await this.deployFarmPanelsToChannel(farmId, selectedChannelId);
        await interaction.editReply({ content: resultMessage, components: [] });
      } catch (error: any) {
        console.error('Deploy farm panels error:', error);
        await interaction.editReply({
          content: `[ERROR] Greska pri postavljanju panela: ${error.message}`,
          components: []
        });
      }
    }

    if (customId === 'select_channel_for_server_info') {
      const selectedChannelId = interaction.values[0];

      await interaction.update({
        content: `Deployam Server Info embed u <#${selectedChannelId}>...`,
        components: []
      });

      try {
        const existingPanel = await storage.getDeployedPanel(selectedChannelId, 'server_info', null);
        const result = await this.sendOrRefreshPanel(selectedChannelId, 'server_info', null, existingPanel);
        const msg = result.refreshed
          ? `✅ Server Info embed osvježen u <#${selectedChannelId}>.`
          : `✅ Server Info embed postavljen u <#${selectedChannelId}>.`;

        await interaction.editReply({ content: msg, components: [] });
      } catch (error: any) {
        console.error('Deploy server_info by channel select error:', error);
        await interaction.editReply({ content: `Greška: ${error.message}`, components: [] });
      }
      return;
    }
  }

  private async deployFarmPanelsToChannel(farmId: string, selectedChannelId: string): Promise<string> {
    const panelTypes = ['fields', 'vehicles', 'silos', 'productions', 'animals', 'weather', 'players'];
    const failures: Array<{ panelType: string; error: string }> = [];

    for (const panelType of panelTypes) {
      try {
        const existingPanel = await storage.getDeployedPanel(selectedChannelId, panelType, farmId);
        await this.sendOrRefreshPanel(selectedChannelId, panelType, farmId, existingPanel);
      } catch (e: any) {
        failures.push({ panelType, error: String(e?.message || e) });
        console.error(`Deploy panel failed [farm ${farmId}] [${panelType}]:`, e);
      }
    }

    const baseMsg = `[OK] Paneli za farmu ${farmId} postavljeni u <#${selectedChannelId}>!`;
    const listMsg = `\n\nPostavljeno:\n- Polja\n- Vozila\n- Silosi\n- Proizvodnje\n- Zivotinje\n- Vrijeme\n- Igraci`;
    const failMsg = failures.length
      ? `\n\n[WARN] Neki paneli nisu uspjeli (ne prekidam deploy):\n${failures.map(f => `- ${f.panelType}: ${f.error}`).slice(0, 8).join('\n')}${failures.length > 8 ? '\n- ...' : ''}`
      : '';

    await storage.log({
      type: 'info',
      message: `Svi paneli za farmu ${farmId} postavljeni u kanal`
    });

    return baseMsg + listMsg + failMsg;
  }

  private async handleStatusCommand(interaction: any) {
    const status = this.getStatus();
    const fields = await storage.getFields();
    const vehicles = await storage.getVehicles();
    const silos = await storage.getSilos();
    const animals = await storage.getAnimals();
    const readyCount = fields.filter(f => f.fruitStatus?.toLowerCase().includes('ready')).length;

    const embed = new EmbedBuilder()
      .setTitle('Slavonska Ravnica - Status')
      .setColor(0x22c55e)
      .addFields(
        { name: 'Status Bota', value: status.status === 'online' ? '[Online]' : '[Offline]', inline: true },
        { name: 'Uptime', value: `${Math.floor(status.uptime / 60000)} min`, inline: true },
        { name: 'Ping', value: status.lastPing || 'N/A', inline: true },
        { name: 'Polja', value: fields.length.toString(), inline: true },
        { name: 'Vozila', value: vehicles.length.toString(), inline: true },
        { name: 'Silosi', value: silos.length.toString(), inline: true },
        { name: 'Zivotinje', value: animals.length.toString(), inline: true },
        { name: 'Spremno za zetvu', value: readyCount.toString(), inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Slavonska Ravnica' });
    
    await interaction.reply({ embeds: [embed] });
  }

  private async handleFarmsCommand(interaction: any) {
    const farms = (await storage.getFarms()).filter(f => !String(f.farmId || '').startsWith('U:'));
    
    if (farms.length === 0) {
      await interaction.reply('Nema registriranih farmi. Pokreni `/sync` za sinkronizaciju.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Farme - Slavonska Ravnica')
      .setColor(0x3b82f6);

    for (const farm of farms) {
      embed.addFields({
        name: `${farm.name}`,
        value: `ID: ${farm.farmId}\nVlasnik: ${farm.owner || 'N/A'}\nBalans: ${farm.balance?.toLocaleString() || 0}€`,
        inline: true
      });
    }

    await interaction.reply({ embeds: [embed] });
  }

  private async handleFieldsCommand(interaction: any) {
    const fields = await storage.getFields();
    
    if (fields.length === 0) {
      await interaction.reply('Nema podataka o poljima. Pokreni `/sync` za sinkronizaciju.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Polja - Slavonska Ravnica')
      .setColor(0x22c55e);

    const fieldsList = fields.slice(0, 15).map(f => {
      const status = f.fruitStatus || 'Unknown';
      const statusLabel = status.toLowerCase().includes('ready') ? '[READY]' : 
                          status.toLowerCase().includes('growing') ? '[RAST]' : '[--]';
      return `**Polje ${f.fieldId}**: ${statusLabel} ${f.fruitName || 'Prazno'} (${status})`;
    }).join('\n');

    embed.setDescription(fieldsList || 'Nema polja');
    
    if (fields.length > 15) {
      embed.setFooter({ text: `Prikazano 15/${fields.length} polja` });
    }

    await interaction.reply({ embeds: [embed] });
  }

  private async handleVehiclesCommand(interaction: any) {
    const vehicles = await storage.getVehicles();
    
    if (vehicles.length === 0) {
      await interaction.reply('Nema podataka o vozilima. Pokreni `/sync` za sinkronizaciju.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Vozila - Slavonska Ravnica')
      .setColor(0xf59e0b);

    const vehiclesList = vehicles.slice(0, 15).map(v => {
      const fuelLabel = (v.fuelLevel || 0) > 50 ? '[OK]' : (v.fuelLevel || 0) > 20 ? '[LOW]' : '[EMPTY]';
      return `**${v.name}**: ${fuelLabel} Gorivo: ${Math.round(v.fuelLevel || 0)}% | Ostecenje: ${Math.round((v.damage || 0) * 100)}%`;
    }).join('\n');

    embed.setDescription(vehiclesList || 'Nema vozila');
    
    if (vehicles.length > 15) {
      embed.setFooter({ text: `Prikazano 15/${vehicles.length} vozila` });
    }

    await interaction.reply({ embeds: [embed] });
  }

  private async handleSilosCommand(interaction: any) {
    const silos = await storage.getSilos();
    
    if (silos.length === 0) {
      await interaction.reply('Nema podataka o silosima. Pokreni `/sync` za sinkronizaciju.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Silosi - Slavonska Ravnica')
      .setColor(0x8b5cf6);

    const ordered = silos.slice().sort((a: any, b: any) => {
      const aHas = (Number(a?.totalFill || 0) > 0 || Number(a?.percent || 0) > 0) ? 1 : 0;
      const bHas = (Number(b?.totalFill || 0) > 0 || Number(b?.percent || 0) > 0) ? 1 : 0;
      return (bHas - aHas)
        || (Number(b?.totalFill || 0) - Number(a?.totalFill || 0))
        || (Number(b?.percent || 0) - Number(a?.percent || 0));
    });

    const silosList = ordered.slice(0, 10).map(s => {
      const percent = (Number.isFinite(Number(s.percent)) && Number(s.percent) > 0)
        ? Number(s.percent)
        : ((Number(s.capacity) > 0 && Number(s.totalFill) >= 0) ? (Number(s.totalFill) / Number(s.capacity)) * 100 : 0);
      // Ako ima barem 5 litara, prva kockica je odmah obojana
      let filledCubes = Math.floor(percent / 10);
      if (filledCubes === 0 && Number(s.totalFill) >= 5) filledCubes = 1;
      const bar = '█'.repeat(filledCubes) + '░'.repeat(10 - filledCubes);
      return `**${s.name}**: [${bar}] ${Math.round(percent)}%\nKapacitet: ${s.totalFill?.toLocaleString() || 0}/${s.capacity?.toLocaleString() || 0}L`;
    }).join('\n\n');

    embed.setDescription(silosList || 'Nema silosa');

    await interaction.reply({ embeds: [embed] });
  }

  private async handleAnimalsCommand(interaction: any) {
    const animals = await storage.getAnimals();
    
    if (animals.length === 0) {
      await interaction.reply('Nema podataka o životinjama. Pokreni `/sync` za sinkronizaciju.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Zivotinje - Slavonska Ravnica')
      .setColor(0xec4899);

    for (const animal of animals.slice(0, 10)) {
      const healthLabel = (animal.health || 0) > 80 ? '[DOBRO]' : (animal.health || 0) > 50 ? '[OK]' : '[LOSE]';
      embed.addFields({
        name: `${animal.animalType || animal.name}`,
        value: `Broj: ${animal.numAnimals || 0}/${animal.maxAnimals || 0}\n${healthLabel} Zdravlje: ${Math.round(animal.health || 0)}%\nProduktivnost: ${Math.round(animal.productivity || 0)}%`,
        inline: true
      });
    }

    await interaction.reply({ embeds: [embed] });
  }

  private async handleWeatherCommand(interaction: any) {
    const weather = await storage.getWeather();
    
    if (!weather) {
      await interaction.reply('Nema podataka o vremenu. Pokreni `/sync` za sinkronizaciju.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Vremenska Prognoza - Slavonska Ravnica')
      .setColor(0x0ea5e9);

    const current = weather.current as any;
    if (current && typeof current === 'object') {
      embed.addFields({
        name: 'Trenutno',
        value: `${current.weatherType || 'N/A'}\nTemperatura: ${current.temperature || 'N/A'}C`,
        inline: false
      });
    }

    const daily = weather.daily as any[];
    if (Array.isArray(daily) && daily.length > 0) {
      const forecast = daily.slice(0, 5).map((d, i) => 
        `Dan ${i + 1}: ${d.weatherType || 'N/A'} (${d.minTemp || 'N/A'}°C - ${d.maxTemp || 'N/A'}°C)`
      ).join('\n');
      embed.addFields({
        name: 'Prognoza',
        value: forecast,
        inline: false
      });
    }

    await interaction.reply({ embeds: [embed] });
  }

  private async handleSyncCommand(interaction: any) {
    await interaction.reply('[SYNC] Pokrenuta sinkronizacija sa FS25 servera...');
    
    try {
      await this.runSyncWithVehiclesRefresh();
      await interaction.editReply('[OK] Sinkronizacija zavrsena! Koristi druge naredbe za pregled podataka.');
    } catch (error: any) {
      await interaction.editReply(`[ERROR] Greska pri sinkronizaciji: ${error.message}`);
    }
  }

  private async handleDebugChannelsCommand(interaction: any) {
    const panelType = String(interaction.options.getString('panel') || 'deploy').trim().toLowerCase();

    const adminRoleId = String(process.env.ADMIN_ROLE_ID || '').trim();
    const isAdminRole = !!(adminRoleId && interaction.member?.roles?.cache?.has?.(adminRoleId));
    const isAllowed = this.isOwner(interaction.user?.id) || isAdminRole;

    if (!isAllowed) {
      await interaction.reply({ content: 'Nemaš dozvolu za ovu komandu (OWNER ili ADMIN role).', ephemeral: true });
      return;
    }

    try {
      const report: any = await this.analyzeChannelPickerVisibility(interaction, panelType);
      console.log(`[CHANNEL-PICKER-DEBUG] ${JSON.stringify(report)}`);

      if (report?.error) {
        await interaction.reply({ content: `Channel debug greška: ${report.error}`, ephemeral: true });
        return;
      }

      const hidden = Array.isArray(report.hiddenByUser) && report.hiddenByUser.length
        ? report.hiddenByUser.join(', ')
        : 'none';
      const blocked = Array.isArray(report.blockedForBot) && report.blockedForBot.length
        ? report.blockedForBot.join(', ')
        : 'none';

      const lines = [
        `panel: ${report.panelType}`,
        `guild: ${report.guildId}`,
        `user: ${report.userId}`,
        `totalChannels: ${report.totalChannels}`,
        `sendableChannels: ${report.sendableChannels}`,
        `userVisible: ${report.userVisible}`,
        `userSendable: ${report.userSendable}`,
        `botVisible: ${report.botVisible}`,
        `botSendable: ${report.botSendable}`,
        `hiddenByUser: ${hidden}`,
        `blockedForBot: ${blocked}`,
      ];

      const txt = lines.join('\n');
      const clipped = txt.length > 1850 ? `${txt.slice(0, 1850)}...` : txt;
      await interaction.reply({ content: `\`\`\`yaml\n${clipped}\n\`\`\``, ephemeral: true });
    } catch (error: any) {
      console.error('debugchannels command error:', error);
      await interaction.reply({ content: `Greška: ${error?.message || 'unknown error'}`, ephemeral: true });
    }
  }

  // DISABLED - Job command (Posao) feature
  /*
  private async handleJobCommand(interaction: any) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const userName = interaction.user.username;

    try {
      await interaction.deferReply();

      switch (subcommand) {
        case 'kreiraj': {
          const jobType = interaction.options.getString('tip');
          const description = interaction.options.getString('opis');
          const payment = interaction.options.getInteger('plata') || 0;
          const fieldId = interaction.options.getInteger('polje');

          const job = await storage.createJob({
            jobId: `job_${Date.now()}_${userId.slice(-4)}`,
            jobType,
            title: this.getJobTypeLabel(jobType),
            description,
            payment,
            fieldId: fieldId ? String(fieldId) : null,
            status: 'open',
            createdByFarmId: '1', // Default farm ID
            createdByUserId: userId,
            assignedToFarmId: null,
            assignedToUserId: null,
            completedAt: null,
            paidAt: null
          });

          const jobLabel = this.getJobTypeLabel(jobType);
          const embed = new EmbedBuilder()
            .setTitle('Novi Posao Kreiran!')
            .setColor(0x22c55e)
            .setDescription(`\`\`\`fix\n${jobLabel}\n\`\`\``)
            .addFields(
              { name: 'ID Posla', value: `#${job.id}`, inline: true },
              { name: 'Plata', value: payment ? `${payment.toLocaleString('hr-HR')} €` : 'Dogovor', inline: true },
              { name: 'Kreirao', value: userName, inline: true },
              { name: 'Opis', value: description || 'Nema opisa' }
            )
            .setTimestamp()
            .setFooter({ text: 'Koristi /posao preuzmi za preuzimanje' });

          if (fieldId) {
            embed.addFields({ name: 'Polje', value: `#${fieldId}`, inline: true });
          }

          await interaction.editReply({ embeds: [embed] });
          await storage.log({ type: 'info', message: `Posao #${job.id} kreiran od ${userName}` });
          break;
        }

        case 'preuzmi': {
          const jobId = interaction.options.getInteger('id');
          const job = await storage.getJob(jobId);

          if (!job) {
            await interaction.editReply('[ERROR] Posao s tim ID-om ne postoji!');
            return;
          }

          if (job.status !== 'open') {
            await interaction.editReply('[ERROR] Posao je već preuzet ili završen!');
            return;
          }

          await storage.updateJob(jobId, {
            status: 'in_progress',
            assignedToFarmId: '1',
            assignedToUserId: userId
          });

          const jobLabel = this.getJobTypeLabel(job.jobType);
          const embed = new EmbedBuilder()
            .setTitle('Posao Preuzet!')
            .setColor(0xf59e0b)
            .setDescription(`\`\`\`fix\n${jobLabel}\n\`\`\``)
            .addFields(
              { name: 'ID Posla', value: `#${jobId}`, inline: true },
              { name: 'Preuzeo', value: userName, inline: true },
              { name: 'Status', value: 'U tijeku', inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'Koristi /posao zavrsi kada završiš' });

          await interaction.editReply({ embeds: [embed] });
          await storage.log({ type: 'info', message: `Posao #${jobId} preuzeo ${userName}` });
          break;
        }

        case 'zavrsi': {
          const jobId = interaction.options.getInteger('id');
          const job = await storage.getJob(jobId);

          if (!job) {
            await interaction.editReply('[ERROR] Posao s tim ID-om ne postoji!');
            return;
          }

          if (job.status === 'completed') {
            await interaction.editReply('[ERROR] Posao je već završen!');
            return;
          }

          if (job.assignedToUserId !== userId && job.createdByUserId !== userId) {
            await interaction.editReply('[ERROR] Samo osoba koja je preuzela ili kreirala posao može ga završiti!');
            return;
          }

          await storage.updateJob(jobId, {
            status: 'completed',
            completedAt: new Date()
          });

          const jobLabel = this.getJobTypeLabel(job.jobType);
          const embed = new EmbedBuilder()
            .setTitle('Posao Završen!')
            .setColor(0x22c55e)
            .setDescription(`\`\`\`diff\n+ ${jobLabel} ZAVRŠEN\n\`\`\``)
            .addFields(
              { name: 'ID Posla', value: `#${jobId}`, inline: true },
              { name: 'Završio', value: userName, inline: true },
              { name: 'Plata', value: job.payment ? `${job.payment.toLocaleString('hr-HR')} €` : 'Dogovor', inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'Slavonska Ravnica - Poslovi' });

          await interaction.editReply({ embeds: [embed] });
          await storage.log({ type: 'info', message: `Posao #${jobId} završen od ${userName}` });
          break;
        }

        case 'lista': {
          const jobs = await storage.getJobs();
          const openJobs = jobs.filter(j => j.status === 'open');
          const inProgressJobs = jobs.filter(j => j.status === 'in_progress');

          const embed = new EmbedBuilder()
            .setTitle('Oglasna Ploca - Dostupni Poslovi')
            .setColor(0x6366f1)
            .setTimestamp()
            .setFooter({ text: 'Slavonska Ravnica - Poslovi' });

          if (openJobs.length === 0 && inProgressJobs.length === 0) {
            embed.setDescription('```\nNema dostupnih poslova.\n\nKoristi /posao kreiraj za dodavanje novog!\n```');
          } else {
            let desc = `\`\`\`yaml\nOtvoreno: ${openJobs.length} | U tijeku: ${inProgressJobs.length}\n\`\`\`\n`;

            if (openJobs.length > 0) {
              desc += `\`\`\`diff\n+ OTVORENI POSLOVI\n\`\`\``;
              for (const job of openJobs.slice(0, 8)) {
                const jobLabel = this.getJobTypeLabel(job.jobType);
                const payment = job.payment ? `${job.payment.toLocaleString('hr-HR')} €` : 'Dogovor';
                desc += `\`\`\`yaml\n#${job.id} ${jobLabel}\nPlata: ${payment} | Polje: ${job.fieldId || 'Bilo koje'}\n\`\`\``;
              }
            }

            if (inProgressJobs.length > 0) {
              desc += `\`\`\`yaml\n= U TIJEKU\n\`\`\``;
              for (const job of inProgressJobs.slice(0, 4)) {
                const jobLabel = this.getJobTypeLabel(job.jobType);
                desc += `\`\`\`\n#${job.id} ${jobLabel} - Farma ${job.assignedToFarmId || 'N/A'}\n\`\`\``;
              }
            }

            embed.setDescription(desc);
          }

          await interaction.editReply({ embeds: [embed] });
          break;
        }
      }
    } catch (error: any) {
      console.error('Job command error:', error);
      await interaction.editReply(`[ERROR] Greska: ${error.message}`);
    }
  }
  */
  // END OF DISABLED handleJobCommand

  private async handleAdminCommand(interaction: any) {
    const channel = interaction.channel;
    
    if (!channel || !this.isSendableChannel(channel)) {
      await interaction.reply({ content: '[ERROR] Koristi ovu komandu u tekstualnom kanalu!', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      const textChannel = channel as TextChannel;
      const existingPanel = await storage.getDeployedPanel(channel.id, 'admin', null);
      
      const embed = new EmbedBuilder()
        .setTitle('Slavonska Ravnica - Admin Panel')
        .setDescription('Koristi gumbe ispod za slanje podataka u ovaj kanal.')
        .setColor(0x6366f1)
        .addFields(
          { name: 'Upute', value: 'Klikni gumb za prikaz podataka. Koristi /panel za postavljanje panela u druge kanale.', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Slavonska Ravnica' });

      
      // Admin Panel UI (compact): one select menu + a few actions
      const deploySelect = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('admin_deploy_select')
            .setPlaceholder('Odaberi panel za deploy/refresh u ovaj kanal...')
            .addOptions(
              { label: 'Server Info', value: 'server_info', description: 'Javni info embed servera' },
              { label: 'Status', value: 'status', description: 'Server status + last sync' },
              { label: 'Farme', value: 'farms', description: 'Balansi, polja, vozila, produkcije' },
              { label: 'Polja', value: 'fields', description: 'Pregled polja i stanja' },
              { label: 'Vozila', value: 'vehicles', description: 'Statistika vozila' },
              { label: 'Silosi', value: 'silos', description: 'Prioritetni silosi' },
              { label: 'Životinje', value: 'animals', description: 'Staje i broj' },
              { label: 'Vrijeme', value: 'weather', description: 'Danas (satno) + ostali dani' },
              { label: 'Proizvodnje', value: 'productions', description: 'Input/Output + %' },
              { label: 'Igrači', value: 'players', description: 'Online + sati' },
              { label: 'Poslovi', value: 'jobs', description: 'Task board' },
              { label: 'Banka', value: 'bank', description: 'Virtualna banka' }
            )
        );

      const actions = await this.buildAdminActionsRow();
      const tools = await this.buildAdminToolsCollapsedRow();

      let message;
      if (existingPanel) {
        try {
          const existingMessage = await textChannel.messages.fetch(existingPanel.messageId);
          await existingMessage.edit({ embeds: [embed], components: [deploySelect, actions, tools] });
          message = existingMessage;
          await interaction.editReply(`[REFRESH] Admin Panel osvjezen u #${channel.name}`);
        } catch {
          message = await textChannel.send({ embeds: [embed], components: [deploySelect, actions, tools] });
          await interaction.editReply(`[OK] Admin Panel postavljen u #${channel.name}`);
        }
      } else {
        message = await textChannel.send({ embeds: [embed], components: [deploySelect, actions, tools] });
        await interaction.editReply(`[OK] Admin Panel postavljen u #${channel.name}`);
      }
      
      await storage.upsertDeployedPanel({
        channelId: channel.id,
        messageId: message.id,
        panelType: 'admin',
        farmId: null
      });

      await storage.log({ type: 'info', message: `Panel admin postavljen u #${channel.name}` });
    } catch (error: any) {
      console.error('Admin command error:', error);
      await interaction.editReply(`[ERROR] Greska: ${error.message}`);
    }
  }

  private async handlePanelCommand(interaction: any) {
    const panelType = interaction.options.getString('tip');
    const channel = interaction.options.getChannel('kanal');
    const farmId = interaction.options.getString('farma') || null;

    if (!channel || !this.isSendableChannel(channel)) {
      await interaction.reply({ content: '[ERROR] Odaberi tekstualni kanal!', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      const textChannel = channel as TextChannel;
      
      // Check if panel already exists for refresh
      const existingPanel = await storage.getDeployedPanel(channel.id, panelType, farmId);
      
      if (panelType === 'admin') {
        // Admin panel - poruka s gumbima
        const embed = new EmbedBuilder()
          .setTitle('Slavonska Ravnica - Admin Panel')
          .setDescription('Koristi gumbe ispod za slanje podataka u ovaj kanal.')
          .setColor(0x6366f1)
          .addFields(
            { name: 'Upute', value: 'Klikni gumb za prikaz podataka. Koristi /panel za postavljanje panela u druge kanale.', inline: false }
          )
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        const row1 = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('admin_status')
              .setLabel('Status')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('admin_farms')
              .setLabel('Farme')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('admin_fields')
              .setLabel('Polja')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('admin_vehicles')
              .setLabel('Vozila')
              .setStyle(ButtonStyle.Primary)
          );

        const row2 = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('admin_silos')
              .setLabel('Silosi')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('admin_animals')
              .setLabel('Zivotinje')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('admin_weather')
              .setLabel('Vrijeme')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('admin_productions')
              .setLabel('Proizvodnje')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('admin_players')
              .setLabel('Igraci')
              .setStyle(ButtonStyle.Primary)
          );

        const row3 = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('admin_jobs')
              .setLabel('Poslovi')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('admin_bank')
              .setLabel('Banka')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('admin_linking')
              .setLabel('Linkanje')
              .setStyle(2),
            new ButtonBuilder()
              .setCustomId('admin_sync')
              .setLabel('Sync Sada')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('setup_farm_channel')
              .setLabel('Postavi Kanal')
              .setStyle(4)
          );

        const deploySelect = new ActionRowBuilder<StringSelectMenuBuilder>()
          .addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('admin_deploy_select')
              .setPlaceholder('Odaberi panel za deploy/refresh u ovaj kanal...')
              .addOptions(
                { label: 'Server Info', value: 'server_info', description: 'Javni info embed servera' },
                { label: 'Status', value: 'status', description: 'Server status + last sync' },
                { label: 'Farme', value: 'farms', description: 'Balansi, polja, vozila, produkcije' },
                { label: 'Polja', value: 'fields', description: 'Pregled polja i stanja' },
                { label: 'Vozila', value: 'vehicles', description: 'Statistika vozila' },
                { label: 'Silosi', value: 'silos', description: 'Prioritetni silosi' },
                { label: 'Životinje', value: 'animals', description: 'Staje i broj' },
                { label: 'Vrijeme', value: 'weather', description: 'Danas (satno) + ostali dani' },
                { label: 'Proizvodnje', value: 'productions', description: 'Input/Output + %' },
                { label: 'Igrači', value: 'players', description: 'Online + sati' },
                { label: 'Poslovi', value: 'jobs', description: 'Task board' },
                { label: 'Banka', value: 'bank', description: 'Virtualna banka' }
              )
          );

        const actions = await this.buildAdminActionsRow();
        const tools = await this.buildAdminToolsCollapsedRow();

        let message;
        if (existingPanel) {
          // Refresh existing panel
          try {
            const existingMessage = await textChannel.messages.fetch(existingPanel.messageId);
            await existingMessage.edit({ embeds: [embed], components: [deploySelect, actions, tools] });
            message = existingMessage;
            await interaction.editReply(`[REFRESH] Admin Panel osvjezen u #${channel.name}`);
          } catch {
            // Message was deleted, create new one
            message = await textChannel.send({ embeds: [embed], components: [deploySelect, actions, tools] });
            await interaction.editReply(`[OK] Admin Panel postavljen u #${channel.name}`);
          }
        } else {
          message = await textChannel.send({ embeds: [embed], components: [deploySelect, actions, tools] });
          await interaction.editReply(`[OK] Admin Panel postavljen u #${channel.name}`);
        }
        
        // Save/update panel reference
        await storage.upsertDeployedPanel({
          channelId: channel.id,
          messageId: message.id,
          panelType: 'admin',
          farmId: null
        });
      } else {
        // Ostali paneli - koristi sendToChannel s refresh logikom
        const result = await this.sendOrRefreshPanel(channel.id, panelType, farmId, existingPanel);
        const farmLabel = farmId ? ` (Farma: ${farmId})` : '';
        if (result.refreshed) {
          await interaction.editReply(`[REFRESH] ${panelType.charAt(0).toUpperCase() + panelType.slice(1)} panel osvjezen u #${result.channel}${farmLabel}`);
        } else {
          await interaction.editReply(`[OK] ${panelType.charAt(0).toUpperCase() + panelType.slice(1)} panel postavljen u #${result.channel}${farmLabel}`);
        }
      }

      await storage.log({ type: 'info', message: `Panel ${panelType} postavljen u #${channel.name}` });
    } catch (error: any) {
      console.error('Panel command error:', error);
      await interaction.editReply(`[ERROR] Greska: ${error.message}`);
    }
  }

  /**
   * Resolve Discord user IDs to usernames/display names.
   */
  public async resolveDiscordUsers(userIds: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const id of userIds) {
      try {
        // Try guild members first for display name
        for (const guild of this.client.guilds.cache.values()) {
          const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
          if (member) {
            result[id] = member.displayName || member.user.username;
            break;
          }
        }
        // Fall back to user fetch
        if (!result[id]) {
          const user = await this.client.users.fetch(id).catch(() => null);
          if (user) result[id] = user.username;
        }
      } catch {}
    }
    return result;
  }

  /**
   * Get role names for a Discord user across all guilds the bot is in.
   */
  public async getUserRoles(userId: string): Promise<string[]> {
    const roles: string[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      try {
        const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
        console.log(`[AUTH] getUserRoles: guild=${guild.name} (${guild.id}), member=${member?.user?.username || 'NOT FOUND'}`);
        if (member) {
          member.roles.cache.forEach(r => { if (r.name !== '@everyone') roles.push(r.name); });
          console.log(`[AUTH] getUserRoles: ${guild.name} roles:`, member.roles.cache.map(r => r.name).filter(n => n !== '@everyone'));
        }
      } catch (e: any) {
        console.warn(`[AUTH] getUserRoles: guild fetch failed for ${userId}:`, e?.message || e);
      }
    }
    console.log(`[AUTH] getUserRoles: ALL roles for ${userId}:`, roles);
    return roles;
  }

  /**
   * Send a notification to Discord when a new feature request is submitted.
   */
  public async notifyFeatureRequest(request: { title: string; description: string; priority: string; author: string }) {
    try {
      const priorityEmoji: Record<string, string> = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
      const embed = new EmbedBuilder()
        .setTitle(`📋 Novi zahtjev: ${request.title}`)
        .setDescription(request.description.slice(0, 4000))
        .addFields(
          { name: 'Prioritet', value: `${priorityEmoji[request.priority] || '⚪'} ${request.priority}`, inline: true },
          { name: 'Autor', value: request.author, inline: true }
        )
        .setColor(0x5865F2)
        .setTimestamp()
        .setFooter({ text: 'FarmBuddy Zahtjevi' });

      for (const guild of this.client.guilds.cache.values()) {
        try {
          const gs = await readGuildSettings();
          const logChId = gs[guild.id]?.['log'];
          const channel = logChId
            ? guild.channels.cache.get(logChId)
            : guild.channels.cache.find(c => c.name.includes('bot-log') || c.name.includes('event-log'));
          if (channel && 'send' in channel) {
            await (channel as any).send({ embeds: [embed] });
          }
        } catch {}
      }
    } catch (e) {
      console.error('[Bot] Failed to send feature request notification:', e);
    }
  }

  /**
   * Send a crash/error report to all configured log channels.
   * Called by global uncaughtException / unhandledRejection handlers.
   */
  public async sendCrashReport(title: string, error: any) {
    try {
      const errMsg = error instanceof Error
        ? `${error.message}\n\`\`\`${(error.stack || '').slice(0, 800)}\`\`\``
        : String(error).slice(0, 800);

      const embed = new EmbedBuilder()
        .setTitle(`🚨 ${title}`)
        .setDescription(errMsg.slice(0, 4000))
        .setColor(0xFF0000)
        .setTimestamp()
        .setFooter({ text: 'FarmBuddy Crash Reporter' });

      // Try to send to all guilds' log channels
      for (const guild of this.client.guilds.cache.values()) {
        try {
          // Check guild settings for 'log' channel
          const gs = await readGuildSettings();
          const logChId = gs[guild.id]?.['log'];
          const channel = logChId
            ? guild.channels.cache.get(logChId)
            : guild.channels.cache.find(c => c.name.includes('bot-log') || c.name.includes('event-log'));
          if (channel && 'send' in channel) {
            await (channel as any).send({ embeds: [embed] });
          }
        } catch {}
      }

      // Also try the default log channel
      try {
        const logConfig = await this.getLogConfig();
        if (logConfig.channelId) {
          const ch = this.client.channels.cache.get(logConfig.channelId);
          if (ch && 'send' in ch) {
            await (ch as any).send({ embeds: [embed] });
          }
        }
      } catch {}
    } catch (e) {
      console.error('[CrashReporter] Failed to send crash report to Discord:', e);
    }
  }

  public async start() {
    if (!process.env.DISCORD_TOKEN) {
      console.error('[BOT] No DISCORD_TOKEN found, bot will not start.');
      await storage.log({ type: 'error', message: 'No DISCORD_TOKEN found' });
      return;
    }
    
    try {
      await this.client.login(process.env.DISCORD_TOKEN);
      // Start auto-sync (presence-sensitive polling)
      const configuredSyncIntervalSec = Number(process.env.FS25_SYNC_INTERVAL_SEC || '15') || 15;
      const syncIntervalSec = Math.min(60, Math.max(10, configuredSyncIntervalSec));
      if (configuredSyncIntervalSec !== syncIntervalSec) {
        console.warn(`FS25_SYNC_INTERVAL_SEC clamped from ${configuredSyncIntervalSec}s to ${syncIntervalSec}s to reduce event delay.`);
      }
      setInterval(async () => {
        try {
          await this.runSyncWithVehiclesRefresh();
        } catch (e: any) {
          console.error('Auto-sync failed:', e);
        }
      }, syncIntervalSec * 1000);

      setInterval(async () => {
        try {
          await this.processInboxQueue(8);
        } catch (e: any) {
          console.error('Inbox queue tick failed:', e);
        }
      }, 20 * 1000);

      // Auto-role assignment based on playtime + farm (every 15 minutes)
      setInterval(async () => {
        try {
          await this.autoAssignPlaytimeRoles();
          await this.autoAssignFarmRoles();
        } catch (e: any) {
          console.error('[AUTO-ROLE] Tick failed:', e);
        }
      }, 15 * 60 * 1000);

      // Auto-update leaderboard channel (every 15 minutes)
      setInterval(async () => {
        try { await this.updateLeaderboardChannel(); } catch (e: any) { console.error('[LEADERBOARD] Tick failed:', e); }
      }, 15 * 60 * 1000);

      // Auto-update weather channel (every 15 minutes)
      setInterval(async () => {
        try { await this.updateWeatherChannel(); } catch (e: any) { console.error('[WEATHER-CH] Tick failed:', e); }
      }, 15 * 60 * 1000);

      // Auto-update karta/map channel (every 15 minutes)
      setInterval(async () => {
        try { await this.updateKartaChannel(); } catch (e: any) { console.error('[KARTA-CH] Tick failed:', e); }
      }, 15 * 60 * 1000);

      // Auto-update launcher channel (every 30 minutes)
      setInterval(async () => {
        try { await this.updateLauncherChannel(); } catch (e: any) { console.error('[LAUNCHER-CH] Tick failed:', e); }
      }, 30 * 60 * 1000);

      // Auto-update farm stat channels (every 10 minutes)
      setInterval(async () => {
        try { await this.updateFarmStatChannels(); } catch (e: any) { console.error('[FARM-STATS] Tick failed:', e); }
      }, 10 * 60 * 1000);

      // ── Daily auto-backup (every 24 hours) ──
      setInterval(async () => {
        try { await this.runDailyAutoBackup(); } catch (e: any) { console.error('[AUTO-BACKUP] Tick failed:', e); }
      }, 24 * 60 * 60 * 1000);

      // ── Weekly DB prune (every 7 days) — removes old logs, deliveries, transcripts ──
      setInterval(async () => {
        try {
          const results = await storage.pruneOldData(30);
          if (results.length > 0) {
            const summary = results.map(r => `${r.collection}: ${r.deleted}`).join(', ');
            console.log(`[DB-PRUNE] Cleaned up: ${summary}`);
          }
        } catch (e: any) { console.error('[DB-PRUNE] Failed:', e); }
      }, 7 * 24 * 60 * 60 * 1000);

      // Initial daily backup check after 2 minutes (checks if one was done today)
      setTimeout(async () => {
        try { await this.runDailyAutoBackup(); } catch (e: any) { console.error('[AUTO-BACKUP] Initial:', e); }
      }, 2 * 60 * 1000);

      // Initial auto-role check after 30 seconds
      setTimeout(async () => {
        try {
          await this.autoAssignPlaytimeRoles();
          await this.autoAssignFarmRoles();
        } catch (e: any) {
          console.error('[AUTO-ROLE] Initial check failed:', e);
        }
      }, 30000);

      // Initial leaderboard + farm stats + weather + karta update after 60 seconds
      setTimeout(async () => {
        try { await this.updateLeaderboardChannel(); } catch (e: any) { console.error('[LEADERBOARD] Initial:', e); }
        try { await this.updateFarmStatChannels(); } catch (e: any) { console.error('[FARM-STATS] Initial:', e); }
        try { await this.updateWeatherChannel(); } catch (e: any) { console.error('[WEATHER-CH] Initial:', e); }
        try { await this.updateKartaChannel(); } catch (e: any) { console.error('[KARTA-CH] Initial:', e); }
        try { await this.updateLauncherChannel(); } catch (e: any) { console.error('[LAUNCHER-CH] Initial:', e); }
      }, 60000);

      // Initial sync after 5 seconds
      setTimeout(async () => {
        try {
          await this.runSyncWithVehiclesRefresh();
        } catch (e: any) {
          console.error('Initial sync failed:', e);
        }
      }, 5000);

      setTimeout(async () => {
        try {
          await this.processInboxQueue(12);
        } catch (e: any) {
          console.error('Initial inbox queue flush failed:', e);
        }
      }, 12000);

      // ── Coop Market System ──
      // Seed market on startup after 90 seconds
      setTimeout(async () => {
        try {
          await this.seedCoopMarket();
          console.log('[COOP] Market seeded');
        } catch (e: any) { console.error('[COOP] Seed failed:', e); }
      }, 90 * 1000);

      // Daily demand shuffle + contracts + market report (every 24 hours)
      setInterval(async () => {
        try {
          await this.shuffleCoopDemand();
          await this.generateCoopContracts();
          await this.sendCoopMarketReport();
        } catch (e: any) { console.error('[COOP] Daily reset failed:', e); }
      }, 24 * 60 * 60 * 1000);

      // Initial contract generation + market report after 2 minutes
      setTimeout(async () => {
        try {
          await this.generateCoopContracts();
          await this.sendCoopMarketReport();
        } catch (e: any) { console.error('[COOP] Initial:', e); }
      }, 2 * 60 * 1000);

      // Contract expiry warnings — check every 2 hours
      setInterval(async () => {
        try { await this.sendContractExpiryWarnings(); } catch (e: any) { console.error('[COOP] Warning check failed:', e); }
      }, 2 * 60 * 60 * 1000);

      // Refresh market embed every 10 minutes (persistent edit)
      setInterval(async () => {
        try { await this.sendCoopMarketReport(); } catch (e: any) { console.error('[COOP] Market refresh failed:', e); }
      }, 10 * 60 * 1000);

    } catch (error: any) {
      console.error("Login failed:", error);
      await storage.log({ type: 'error', message: `Bot login failed: ${error.message}` });
    }
  }

  public getStatus() {
    return {
      status: this.isConnected ? 'online' : 'offline',
      uptime: this.isConnected ? Date.now() - this.startTime : 0,
      lastPing: this.client.ws.ping ? `${this.client.ws.ping}ms` : null
    };
  }

  /** Get all guilds the bot is in with detailed info */
  public getGuilds() {
    if (!this.isConnected) return [];
    return this.client.guilds.cache.map((g: any) => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL({ size: 128 }) || null,
      memberCount: g.memberCount || 0,
      boostTier: g.premiumTier || 0,
      boostCount: g.premiumSubscriptionCount || 0,
      ownerId: g.ownerId,
      createdAt: g.createdAt?.toISOString() || null,
      roles: g.roles.cache.size,
      channels: g.channels.cache.size,
      isMain: g.id === (process.env.DISCORD_GUILD_ID || process.env.GUILD_ID),
      isTest: g.id === process.env.TEST_GUILD_ID,
    }));
  }

  /** Get detailed info for a specific guild */
  public getGuildDetail(guildId: string) {
    if (!this.isConnected) return null;
    const g = this.client.guilds.cache.get(guildId);
    if (!g) return null;
    return {
      id: g.id,
      name: g.name,
      icon: g.iconURL({ size: 256 }) || null,
      banner: g.bannerURL({ size: 512 }) || null,
      memberCount: g.memberCount || 0,
      boostTier: g.premiumTier || 0,
      boostCount: g.premiumSubscriptionCount || 0,
      ownerId: g.ownerId,
      createdAt: g.createdAt?.toISOString() || null,
      description: g.description || null,
      vanityURLCode: g.vanityURLCode || null,
      isMain: g.id === (process.env.DISCORD_GUILD_ID || process.env.GUILD_ID),
      isTest: g.id === process.env.TEST_GUILD_ID,
      roles: g.roles.cache
        .sort((a: any, b: any) => b.position - a.position)
        .map((r: any) => ({
          id: r.id,
          name: r.name,
          color: r.hexColor,
          members: r.members.size,
          hoist: r.hoist,
          position: r.position,
        })),
      channels: {
        text: g.channels.cache.filter((c: any) => c.type === 0).size,
        voice: g.channels.cache.filter((c: any) => c.type === 2).size,
        categories: g.channels.cache.filter((c: any) => c.type === 4).size,
        total: g.channels.cache.size,
      },
    };
  }

  // ── Guild channel settings API (for web dashboard) ──
  public getChannelKeys() {
    return Object.entries(GUILD_CHANNEL_KEYS).map(([key, val]) => ({
      key, label: val.label, desc: val.desc,
    }));
  }

  public async getGuildSettings(guildId: string) {
    const settings = await readGuildSettings();
    const guildSettings = settings[guildId] || {};
    const guild = this.client.guilds.cache.get(guildId);
    
    // Build list of channels for the guild
    const channels = guild ? guild.channels.cache
      .filter((c: any) => [0, 2, 4, 5, 15].includes(c.type))
      .sort((a: any, b: any) => (a.position || 0) - (b.position || 0))
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        parentId: c.parentId || null,
        parentName: c.parent?.name || null,
      })) : [];

    // Build current assignments with resolved channel names
    const assignments: Record<string, { channelId: string | null; channelName: string | null }> = {};
    for (const key of Object.keys(GUILD_CHANNEL_KEYS)) {
      const channelId = guildSettings[key as GuildChannelKey] || null;
      let channelName: string | null = null;
      if (channelId && guild) {
        const ch = guild.channels.cache.get(channelId);
        if (ch) channelName = (ch as any).name;
      }
      assignments[key] = { channelId, channelName };
    }

    return { assignments, channels };
  }

  public async setGuildChannelSetting(guildId: string, key: string, channelId: string | null) {
    if (!(key in GUILD_CHANNEL_KEYS)) return false;
    const settings = await readGuildSettings();
    if (!settings[guildId]) settings[guildId] = {};
    if (channelId) {
      settings[guildId][key as GuildChannelKey] = channelId;
    } else {
      delete settings[guildId][key as GuildChannelKey];
    }
    await writeGuildSettings(settings);
    invalidateGuildSettingsCache();
    return true;
  }

  /**
   * Post in-game chat into Discord.
   * Finds the farm-chat channel by name, or falls back to env FS25_GAME_CHAT_CHANNEL_ID.
   */
  async postGameChatMessage(payload: { sender: string; msg: string; farmId?: string; uniqueUserId?: string; timestamp?: string; }) {
    let channel: any = null;

    // Try to find farm-chat channel by name first
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (guildId) {
      const guild = this.client.guilds.cache.get(guildId);
      if (guild) {
        channel = await getGuildChannel(guild, 'farm-chat');
      }
    }

    // Fallback to env var
    if (!channel) {
      const channelId = process.env.FS25_GAME_CHAT_CHANNEL_ID;
      if (channelId) channel = await this.client.channels.fetch(channelId).catch(() => null);
    }

    if (!channel || !this.isSendableChannel(channel)) return;

    const sender = payload.sender || 'Unknown';
    const content = String(payload.msg || '').slice(0, 1800);

    // Plain text format — 🎮 prefix = in-game, 💬 prefix = from Discord
    const prefix = '🎮';
    const text = `${prefix} **${sender}:** ${content}`;
    await (channel as TextChannel).send({ content: text }).catch(() => {});
  }


  // Update runtime stats cache from sync service
  // Napomena (hr): koristimo rast totalOnlineMs kao "aktivan u zadnjem sync intervalu".
  public setRuntimeStats(runtime: {
    playerTimes?: Array<{ id: string; nickname: string; uniqueUserId?: string; farmId?: string; totalOnlineMs: number; totalAfkMs: number; lastOnlineAt?: string; lastSeenAtMs?: number }>;
    vehicleUsage?: Array<{ uniqueId: string; name: string; farmId?: string; totalMs: number; movingMs: number; idleMs: number; players: Array<{ id: string; nickname: string; totalMs: number; movingMs: number; idleMs: number; lastUsedAt?: string }> }>;
  }, webStatsOnlineNames?: string[] | null) {
    const now = new Date();
    this.runtimeUpdatedAt = now;

    // Build WebStats name set for authoritative presence (case-insensitive)
    // IMPORTANT: empty array [] means webstats is reachable but 0 players online — use empty Set, NOT null
    const wsNames: Set<string> | null = Array.isArray(webStatsOnlineNames)
      ? new Set(webStatsOnlineNames.map(n => n.toLowerCase().trim()))
      : null;

    // Players
    if (Array.isArray(runtime.playerTimes)) {
      const onlineWindowSec = Math.max(10, Number(process.env.RUNTIME_ONLINE_WINDOW_SEC || '45') || 45);
      const onlineWindowMs = onlineWindowSec * 1000;
      const maxSeenAtMs = runtime.playerTimes
        .map((p: any) => Number(p?.lastSeenAtMs))
        .filter((n: number) => Number.isFinite(n))
        .reduce((m: number, n: number) => Math.max(m, n), 0);

      const isLikelyEpochMs = (value: number) => Number.isFinite(value) && value > 946684800000;

      for (const p of runtime.playerTimes) {
        if (!p?.id) continue;
        const playerName = String((p as any).nickname || '').trim();
        if (playerName.toLowerCase() === 'server') continue;
        const prev = this.runtimePlayerTimes.get(p.id);
        const sessionKey = String(p.uniqueUserId || p.id || p.nickname || '');

        const hasGrowth = !!(prev && typeof prev.totalOnlineMs === 'number' && typeof p.totalOnlineMs === 'number' && p.totalOnlineMs > prev.totalOnlineMs);
        const seen = Number((p as any).lastSeenAtMs);
        const bySeen = Number.isFinite(seen)
          ? (isLikelyEpochMs(seen)
            ? ((now.getTime() - seen) <= onlineWindowMs && (now.getTime() - seen) >= -5000)
            : (maxSeenAtMs > 0 ? (maxSeenAtMs - seen) <= onlineWindowMs : false))
          : false;

        const lastOnlineMs = (p as any).lastOnlineAt ? Date.parse(String((p as any).lastOnlineAt)) : NaN;
        const byLastOnline = Number.isFinite(lastOnlineMs)
          ? (now.getTime() - lastOnlineMs) <= onlineWindowMs
          : false;

        // WebStats is authoritative when available; fall back to heuristics otherwise
        const byWebStats = wsNames
          ? wsNames.has(String(p.nickname || '').toLowerCase().trim())
          : null;
        const currentlyOnline = byWebStats !== null ? byWebStats : (bySeen || byLastOnline || hasGrowth);

        if (sessionKey) {
          const prevStarted = this.runtimeSessionStartedAtByPlayer.get(sessionKey);
          if (currentlyOnline) {
            if (!prevStarted) {
              this.runtimeSessionStartedAtByPlayer.set(sessionKey, now);
            }
          }
        }

        const next = {
          ...p,
          currentlyOnline,
          lastActivityRealAt: prev?.lastActivityRealAt,
        } as any;

        if (hasGrowth) {
          next.lastActivityRealAt = now;
        }

        this.runtimePlayerTimes.set(p.id, next);

        const upsertId = String((p as any).uniqueUserId || (p as any).id || '').trim();
        if (upsertId) {
          const farmFromRuntime = (p as any).farmId != null ? String((p as any).farmId) : undefined;
          const totalOnMs = Number(p.totalOnlineMs) || 0;
          const totalAfkMs = Number(p.totalAfkMs) || 0;
          const totalHours = (totalOnMs + totalAfkMs) / 3600000;
          const upsertData: any = {
            uniqueUserId: upsertId,
            name: String((p as any).nickname || (p as any).id || upsertId),
            // Always write playTime from runtime stats (real-time ms) — this corrects
            // any inflated values previously stored from playerStats.xml game-time.
            playTime: isFinite(totalHours) ? totalHours : 0,
            isOnline: currentlyOnline,
          };
          // Only set farmId if runtime data has it — don't overwrite
          // the correct value from parseAndStorePlayers/farmPlayers.xml
          if (farmFromRuntime != null) upsertData.farmId = farmFromRuntime;
          void storage.upsertPlayer(upsertData).catch((e: any) => {
            console.error('Runtime player upsert failed:', e);
          });
        }
      }

      // Update in-memory leaderboard from runtime stats (includes AFK)
      try {
        updatePlayerHoursFromPresenceSnapshot({
          users: runtime.playerTimes.map((p: any) => {
            const totalOnMs = Number(p.totalOnlineMs) || 0;
            const totalAfkMs = Number(p.totalAfkMs) || 0;
            const totalHours = (totalOnMs + totalAfkMs) / 3600000;
            const afkHours = totalAfkMs / 3600000;
            return {
              userId: String(p.uniqueUserId || p.id || ''),
              name: String(p.nickname || p.id || ''),
              playTime: totalHours,
              afkTime: afkHours,
            };
          }),
        });
      } catch {}

      try {
        const nextPresence = new Map<string, { online: boolean; name: string }>();
        for (const p of runtime.playerTimes) {
          const key = String((p as any).uniqueUserId || (p as any).id || '').trim();
          if (!key) continue;
          const name = String((p as any).nickname || (p as any).id || key);
          // Skip phantom "Server" entries
          if (name.toLowerCase() === 'server') continue;
          const cached = this.runtimePlayerTimes.get((p as any).id);
          const online = !!cached?.currentlyOnline;
          nextPresence.set(key, { online, name });
        }

        if (!this.runtimePresenceInitialized) {
          // On first sync after bot start, seed state with current players
          // so we don't re-announce everyone as "joined"
          this.runtimePresenceStateByPlayer = new Map(nextPresence);
          this.runtimePresenceInitialized = true;
          console.log(`[PRESENCE] First sync — seeded ${nextPresence.size} players, skipping join notifications`);
          return; // Skip emitting join/leave on first sync
        }

        const nowMs = Date.now();
        const emitCooldownSec = Math.max(0, Number(process.env.RUNTIME_PRESENCE_EMIT_COOLDOWN_SEC || '2') || 2);
        const joined: Array<{ uniqueUserId: string; name: string; farmId: string | null }> = [];
        const left: Array<{ uniqueUserId: string; name: string; farmId: string | null }> = [];

        for (const [key, cur] of nextPresence.entries()) {
          const prev = this.runtimePresenceStateByPlayer.get(key);
          if (!prev) {
            if (cur.online) {
              const lastAt = this.lastRuntimePresenceEmitAtByPlayer.get(key) || 0;
              if ((nowMs - lastAt) >= emitCooldownSec * 1000) {
                joined.push({ uniqueUserId: key, name: cur.name, farmId: null });
                this.lastRuntimePresenceEmitAtByPlayer.set(key, nowMs);
              }
            }
            continue;
          }
          if (!prev.online && cur.online) {
            const lastAt = this.lastRuntimePresenceEmitAtByPlayer.get(key) || 0;
            if ((nowMs - lastAt) >= emitCooldownSec * 1000) {
              joined.push({ uniqueUserId: key, name: cur.name, farmId: null });
              this.lastRuntimePresenceEmitAtByPlayer.set(key, nowMs);
            }
          }
          if (prev.online && !cur.online) {
            const lastAt = this.lastRuntimePresenceEmitAtByPlayer.get(key) || 0;
            if ((nowMs - lastAt) >= emitCooldownSec * 1000) {
              left.push({ uniqueUserId: key, name: cur.name || prev.name, farmId: null });
              this.lastRuntimePresenceEmitAtByPlayer.set(key, nowMs);
            }
          }
        }

        for (const [key, prev] of this.runtimePresenceStateByPlayer.entries()) {
          if (!nextPresence.has(key) && prev.online) {
            const lastAt = this.lastRuntimePresenceEmitAtByPlayer.get(key) || 0;
            if ((nowMs - lastAt) >= emitCooldownSec * 1000) {
              left.push({ uniqueUserId: key, name: prev.name, farmId: null });
              this.lastRuntimePresenceEmitAtByPlayer.set(key, nowMs);
            }
          }
        }

        if (joined.length || left.length) {
          this.notifyPlayerPresence({ joined, left }).catch((e) => {
            console.error('Runtime presence notify error:', e);
          });

          for (const l of left) {
            const key = String(l.uniqueUserId || '').trim();
            if (key) {
              // Accumulate session play time before clearing session start
              const sessionStart = this.runtimeSessionStartedAtByPlayer.get(key);
              if (sessionStart) {
                const sessionHours = Math.max(0, (Date.now() - sessionStart.getTime()) / 3600000);
                if (sessionHours > 0 && sessionHours < 24) {
                  void storage.addSessionPlayTime(key, sessionHours).catch((e: any) => {
                    console.error(`[PRESENCE] addSessionPlayTime failed for ${key}:`, e);
                  });
                }
              }
              this.runtimeSessionStartedAtByPlayer.delete(key);
            }
          }
        }

        this.runtimePresenceStateByPlayer = nextPresence;
      } catch (e) {
        console.error('Runtime presence fallback error:', e);
      }
    }

    // Vehicles
    if (Array.isArray(runtime.vehicleUsage)) {
      for (const v of runtime.vehicleUsage) {
        if (!v?.uniqueId && !v?.name) continue;
        const key = v.uniqueId || `${v.farmId || '0'}|${v.name}`;
        this.runtimeVehicleUsage.set(key, v);
      }
    }
  }



  // hr: dohvat runtime usage-a za vozilo po farmi+imenu (koristi se za povijest kad se vozilo ukloni/proda)
  public setPlayerTracking(tracking: {
    tracks?: Array<{ id: string; nickname: string; sessionStartMs?: number; lastMoveMs?: number; distanceM: number; activeMs: number; idleMs: number; points: Array<{ t: number; x: number; z: number; mode?: string }> }>;
    sessions?: Array<{ id: string; nickname: string; startedAtMs?: number; endedAtMs?: number; distanceM: number; activeMs: number; idleMs: number; reason?: string }>;
  }) {
    this.playerTrackingUpdatedAt = new Date();
    if (Array.isArray(tracking.tracks)) this.playerTracks = tracking.tracks;
    if (Array.isArray(tracking.sessions)) this.playerSessionHistory = tracking.sessions;
  }


  public getVehicleUsage(farmId: string, name: string) {
    const target = `${farmId || ''}|${(name || '').toLowerCase()}`;
    for (const u of this.runtimeVehicleUsage.values()) {
      const k = `${u.farmId || ''}|${(u.name || '').toLowerCase()}`;
      if (k === target) {
        return {
          totalMs: u.totalMs || 0,
          movingMs: u.movingMs || 0,
          idleMs: u.idleMs || 0,
          lastUsedAt: (u.lastUsedAt || null)
        };
      }
    }
    return null;
  }

  // hr: ocisti runtime statistiku za vozila koja vise nisu u snapshot-u (prodana/uklonjena)
  public pruneRuntimeVehicleUsage(activeFarmNameKeys: Set<string>) {
    if (!activeFarmNameKeys || activeFarmNameKeys.size === 0) return;
    for (const [key, u] of this.runtimeVehicleUsage.entries()) {
      const k = `${u.farmId || ''}|${(u.name || '').toLowerCase()}`;
      if (!activeFarmNameKeys.has(k)) {
        this.runtimeVehicleUsage.delete(key);
      }
    }
  }

  // Refresh all deployed panels after sync
  public async refreshAllPanels() {
    if (!this.isConnected) return;
    
    try {
      const panels = await storage.getDeployedPanels();
      const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
      if (!guildId) return;
      
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return;
      

      
      for (const panel of panels) {
        try {
          const channel = await guild.channels.fetch(panel.channelId).catch(() => null) as any;
          if (!channel || !('messages' in channel)) continue;
          
          let message;
          try {
            message = await channel.messages.fetch(panel.messageId);
          } catch (err: any) {
            const code = err?.code ?? err?.rawError?.code;
            if (code === 10008) {
              // Stored messageId no longer exists -> remove deployed panel entry (do NOT re-deploy/spam)
              if (panel.id != null) {
                await storage.deleteDeployedPanel(panel.id);
              }
              console.warn(`Panel message missing (10008). Removed deployed panel ${panel.panelType} in channel ${panel.channelId} (messageId=${panel.messageId}).`);
            } else if (code === 50013) {
              console.warn(`Missing permissions to fetch panel message for ${panel.panelType} in channel ${panel.channelId}. Ensure View Channel + Read Message History.`);
            } else {
              console.warn(`Failed to fetch panel message for ${panel.panelType} in channel ${panel.channelId} (messageId=${panel.messageId}):`, err);
            }
            continue;
          }
          // Build fresh embed for this panel type
          if (false && (panel.panelType === 'jobs' || panel.panelType === 'bank')) {
            const embed = panel.panelType === 'jobs'
              ? await this.buildJobsEmbed(panel.farmId)
              : await this.buildBankEmbed(panel.farmId);

            const components = panel.panelType === 'jobs'
              ? await this.buildJobsComponents(panel.farmId)
              : await this.buildBankComponents(panel.farmId);

            await message.edit({ embeds: [embed], components });
          } else if (panel.panelType === 'custom_contracts') {
            const embed = await this.buildPanelEmbed('custom_contracts', null);
            const components = await this.buildCustomContractsComponents();
            await message.edit({ embeds: [embed], components });
          } else if (panel.panelType === 'player_hours') {
            const embed = await this.buildPanelEmbed('player_hours', null, { messageId: panel.messageId });
            const components = await this.buildPlayerHoursComponents(panel.messageId);
            await message.edit({ embeds: [embed], components });
          } else if (panel.panelType === 'map_tracks') {
            const embed = await this.buildPanelEmbed('map_tracks', null, { messageId: panel.messageId });
            const components = await this.buildMapTracksComponents(panel.messageId);
            await message.edit({ embeds: [embed], components });
          } else if (panel.panelType === 'server_info') {
            const payload = await this.buildServerInfoPayload(panel.messageId);
            await message.edit(payload as any);
          } else if (panel.panelType === 'admin') {
            // Skip admin panel - it's just buttons
            continue;
          } else {
            const isList = this.isListPanel(panel.panelType);
            if (isList) {
              const embed = await this.buildPanelEmbed(panel.panelType, panel.farmId, { messageId: panel.messageId });
              const components = await this.buildListPanelComponents(panel.panelType, panel.farmId, panel.messageId);
              await message.edit({ embeds: [embed], components });
            } else {
              const embed = await this.buildPanelEmbed(panel.panelType, panel.farmId);
              await message.edit({ embeds: [embed] });
            }
          }
} catch (err: any) {
  // If the panel message was deleted between fetch->edit, re-deploy it instead of silently failing forever.
  const code = err?.code ?? err?.rawError?.code;
  if (code === 10008) {
    try {
      const payload: any = {};
      if (panel.panelType === 'jobs' || panel.panelType === 'bank') {
        const embed = panel.panelType === 'jobs'
          ? await this.buildJobsEmbed(panel.farmId)
          : await this.buildBankEmbed(panel.farmId);

        const components = panel.panelType === 'jobs'
          ? await this.buildJobsComponents(panel.farmId)
          : await this.buildBankComponents(panel.farmId);

        payload.embeds = [embed];
        payload.components = components;
      } else if (panel.panelType === 'custom_contracts') {
        const embed = await this.buildPanelEmbed('custom_contracts', null);
        const components = await this.buildCustomContractsComponents();
        payload.embeds = [embed];
        payload.components = components;
      } else if (panel.panelType === 'player_hours') {
        const embed = await this.buildPanelEmbed('player_hours', null, { messageId: panel.messageId });
        const components = await this.buildPlayerHoursComponents(panel.messageId);
        payload.embeds = [embed];
        payload.components = components;
      } else if (panel.panelType === 'map_tracks') {
        const embed = await this.buildPanelEmbed('map_tracks', null, { messageId: panel.messageId });
        const components = await this.buildMapTracksComponents(panel.messageId);
        payload.embeds = [embed];
        payload.components = components;
      } else if (panel.panelType === 'server_info') {
        const embed = await this.buildPanelEmbed('server_info', null, { messageId: panel.messageId });
        const components = await this.buildServerInfoComponents(panel.messageId);
        payload.embeds = [embed];
        payload.components = components;
      } else if (panel.panelType === 'admin') {
        continue;
      } else {
        const isList = this.isListPanel(panel.panelType);
        if (isList) {
          const embed = await this.buildPanelEmbed(panel.panelType, panel.farmId, { messageId: panel.messageId });
          const components = await this.buildListPanelComponents(panel.panelType, panel.farmId, panel.messageId);
          payload.embeds = [embed];
          payload.components = components;
        } else {
          const embed = await this.buildPanelEmbed(panel.panelType, panel.farmId);
          payload.embeds = [embed];
        }
      }

      const channel = await guild.channels.fetch(panel.channelId).catch(() => null) as any;
      if (!channel || !('send' in channel)) continue;

      const sent = await channel.send(payload);
      if (panel.panelType === 'server_info') {
        try {
          const finalPayload = await this.buildServerInfoPayload(sent.id);
          await sent.edit(finalPayload as any);
        } catch (e) {
          console.error('Failed to finalize server_info payload after redeploy:', e);
        }
      }
      await storage.upsertDeployedPanel({
        channelId: panel.channelId,
        messageId: sent.id,
        panelType: panel.panelType,
        farmId: panel.farmId ?? null
      });

      console.log(`Re-deployed panel after Unknown Message (${panel.panelType}) in channel ${panel.channelId} -> new message ${sent.id}`);
      continue;
    } catch (redeployErr) {
      console.error(`Failed to re-deploy panel after Unknown Message (${panel.panelType}) in channel ${panel.channelId}:`, redeployErr);
    }
  }

  console.error(`Failed to refresh panel ${panel.panelType} in channel ${panel.channelId}:`, err);
}
      }
      
      await this.maybeNotifyServerStatusChange();
      await this.maybeNotifyAfkWarnings();
    } catch (err) {
      console.error('Error refreshing panels:', err);
    }
  }

  
  // =========================
  // LOG KANAL (join/leave, server status)
  // =========================
  private async getLogConfig(): Promise<{ channelId: string | null; enabled: boolean }> {
    try {
      // Check guild settings first
      const gs = await readGuildSettings();
      for (const [gId, s] of Object.entries(gs)) {
        if (s['log']) return { channelId: s['log'], enabled: true };
      }

      const panels = await storage.getDeployedPanels();
      const configs = panels.filter(p => p.panelType === 'log_channel' || p.panelType === 'log_presence_channel' || p.panelType === 'log_server_status_channel');
      if (!configs.length) {
        const envChannelId = process.env.LOG_CHANNEL_ID || '1239288670872272956';
        return { channelId: envChannelId, enabled: !!envChannelId };
      }

      const cfg = [...configs].sort((a, b) => {
        const aMs = a.updatedAt ? new Date(a.updatedAt as any).getTime() : 0;
        const bMs = b.updatedAt ? new Date(b.updatedAt as any).getTime() : 0;
        return bMs - aMs;
      })[0];

      const enabled = String(cfg.messageId ?? '1') !== '0';
      return { channelId: cfg.channelId || process.env.LOG_CHANNEL_ID || '1239288670872272956', enabled };
    } catch {
      const envChannelId = process.env.LOG_CHANNEL_ID || '1239288670872272956';
      return { channelId: envChannelId, enabled: !!envChannelId };
    }
  }

  private async getLogChannelId(): Promise<string | null> {
    const cfg = await this.getLogConfig();
    return cfg.channelId;
  }

  private async getTrackingLogConfig(): Promise<{ channelId: string | null; enabled: boolean }> {
    const base = await this.getLogConfig();
    const envChannelId = process.env.LOG_TRACKING_CHANNEL_ID || '1271570784866799718';

    try {
      // Check guild settings first
      const gs = await readGuildSettings();
      for (const [gId, s] of Object.entries(gs)) {
        if (s['log-tracking']) return { channelId: s['log-tracking'], enabled: true };
      }

      const panels = await storage.getDeployedPanels();
      const rows = panels.filter((p: any) => p.panelType === 'log_tracking_channel');
      if (!rows.length) {
        return { channelId: envChannelId || base.channelId, enabled: base.enabled };
      }

      const latest = [...rows].sort((a: any, b: any) => {
        const aMs = a.updatedAt ? new Date(a.updatedAt as any).getTime() : 0;
        const bMs = b.updatedAt ? new Date(b.updatedAt as any).getTime() : 0;
        return bMs - aMs;
      })[0];

      return {
        channelId: latest?.channelId || envChannelId || base.channelId,
        enabled: base.enabled
      };
    } catch {
      return { channelId: envChannelId || base.channelId, enabled: base.enabled };
    }
  }

  private async nextPersistentLogEventId(channelIdHint?: string): Promise<number> {
    try {
      const panels = await storage.getDeployedPanels();
      const seqRows = panels.filter(p => p.panelType === 'log_sequence');
      const latest = [...seqRows].sort((a, b) => {
        const aMs = a.updatedAt ? new Date(a.updatedAt as any).getTime() : 0;
        const bMs = b.updatedAt ? new Date(b.updatedAt as any).getTime() : 0;
        return bMs - aMs;
      })[0];

      let current = Number(latest?.messageId ?? this.logEventSequence ?? 0);
      if (!Number.isFinite(current) || current < 0) current = 0;
      const next = current + 1;

      await storage.upsertDeployedPanel({
        channelId: channelIdHint || latest?.channelId || 'log',
        messageId: String(next),
        panelType: 'log_sequence',
        farmId: null
      } as any);

      this.logEventSequence = next;
      return next;
    } catch {
      this.logEventSequence = Math.max(0, this.logEventSequence) + 1;
      return this.logEventSequence;
    }
  }

  private async buildAdminActionsRow(): Promise<ActionRowBuilder<ButtonBuilder>> {
    const logCfg = await this.getLogConfig();
    const logLabel = logCfg.enabled ? '🟢 Log ON' : '🔴 Log OFF';
    const logStyle = logCfg.enabled ? ButtonStyle.Success : ButtonStyle.Danger;

    return new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('setup_farm_channel')
          .setLabel('🗂 Panel kanal')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('setup_log_channel')
          .setLabel('📣 Event log')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('setup_tracking_log_channel')
          .setLabel('🗺 Tracking log')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('toggle_log_channel')
          .setLabel(logLabel)
          .setStyle(logStyle)
      );
  }

  private async buildAdminToolsCollapsedRow(): Promise<ActionRowBuilder<ButtonBuilder>> {
    return new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('admin_tools_open')
          .setLabel('🧰 Alati')
          .setStyle(ButtonStyle.Secondary)
      );
  }

  private async buildAdminToolsExpandedRow(): Promise<ActionRowBuilder<ButtonBuilder>> {
    return new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('admin_sync')
          .setLabel('⚡ Sync')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('admin_feature_flags')
          .setLabel('⚙ Mapa opcije')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('admin_inbox_queue')
          .setLabel('📬 Inbox')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('admin_force_refresh_all')
          .setLabel('🔄 Refresh sve')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('admin_backup_panels')
          .setLabel('💾 Backup')
          .setStyle(ButtonStyle.Secondary)
      );
  }

  private async buildAdminToolsCloseRow(): Promise<ActionRowBuilder<ButtonBuilder>> {
    return new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('admin_server_info')
          .setLabel('🖥 Server')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin_restore_panels')
          .setLabel('♻ Restore')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('admin_tools_close')
          .setLabel('✖ Zatvori')
          .setStyle(ButtonStyle.Secondary)
      );
  }

  private getInboxQueueFilePath(): string {
    return path.join(process.cwd(), 'src', 'storage', 'backups', 'inbox-command-queue.json');
  }

  private async readInboxQueue(): Promise<{ items: InboxQueueItem[] }> {
    const file = this.getInboxQueueFilePath();
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      return { items };
    } catch {
      return { items: [] };
    }
  }

  private async writeInboxQueue(store: { items: InboxQueueItem[] }): Promise<void> {
    const file = this.getInboxQueueFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });

    const nowMs = Date.now();
    const compacted = (store.items || []).filter((it: InboxQueueItem) => {
      if (it.status !== 'sent') return true;
      const sentMs = it.sentAt ? Date.parse(String(it.sentAt)) : 0;
      return Number.isFinite(sentMs) && (nowMs - sentMs) <= (24 * 60 * 60 * 1000);
    });

    await fs.writeFile(file, JSON.stringify({
      updatedAt: new Date().toISOString(),
      items: compacted
    }, null, 2), 'utf8');
  }

  private async enqueueInboxCommand(item: Omit<InboxQueueItem, 'id' | 'createdAt' | 'nextAttemptAt' | 'attempts' | 'status'>): Promise<string> {
    const queue = await this.readInboxQueue();
    const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    queue.items.push({
      ...item,
      id,
      createdAt: now,
      nextAttemptAt: now,
      attempts: 0,
      status: 'queued'
    });

    await this.writeInboxQueue(queue);
    return id;
  }

  private async processInboxQueue(limit: number = 10): Promise<{ processed: number; sent: number; failed: number }> {
    if (this.inboxQueueTickBusy) return { processed: 0, sent: 0, failed: 0 };
    this.inboxQueueTickBusy = true;
    try {
      const queue = await this.readInboxQueue();
      const nowMs = Date.now();
      const maxAttempts = Math.max(2, Number(process.env.INBOX_QUEUE_MAX_ATTEMPTS || '6') || 6);

      const candidates = queue.items
        .filter((it: InboxQueueItem) => {
          if (it.status === 'sent') return false;
          const at = Date.parse(String(it.nextAttemptAt || ''));
          return !Number.isFinite(at) || at <= nowMs;
        })
        .sort((a: InboxQueueItem, b: InboxQueueItem) => Date.parse(String(a.createdAt || '')) - Date.parse(String(b.createdAt || '')))
        .slice(0, Math.max(1, limit));

      let processed = 0;
      let sent = 0;
      let failed = 0;

      for (const c of candidates) {
        processed += 1;
        const idx = queue.items.findIndex((x: InboxQueueItem) => x.id === c.id);
        if (idx < 0) continue;

        try {
          if (c.payloadType === 'xml') {
            await uploadInboxXml(c.filename, String(c.xml || ''));
          } else {
            await uploadInboxJson(c.filename, c.payload || {});
          }

          queue.items[idx] = {
            ...queue.items[idx],
            status: 'sent',
            sentAt: new Date().toISOString(),
            lastError: undefined
          };
          sent += 1;
        } catch (e: any) {
          const nextAttempts = Number(queue.items[idx].attempts || 0) + 1;
          const backoffSec = Math.min(600, Math.max(5, Math.pow(2, Math.min(nextAttempts, 8)) * 3));
          const terminal = nextAttempts >= maxAttempts;
          queue.items[idx] = {
            ...queue.items[idx],
            attempts: nextAttempts,
            status: terminal ? 'failed' : 'queued',
            nextAttemptAt: new Date(Date.now() + backoffSec * 1000).toISOString(),
            lastError: String(e?.message || e)
          };
          failed += 1;
        }
      }

      await this.writeInboxQueue(queue);
      await this.maybeNotifyInboxQueueIssue(await this.getInboxQueueStatusSummary());
      return { processed, sent, failed };
    } finally {
      this.inboxQueueTickBusy = false;
    }
  }

  private async getInboxQueueStatusSummary(): Promise<{ queued: number; failed: number; dueNow: number; sent24h: number }> {
    const queue = await this.readInboxQueue();
    const nowMs = Date.now();
    const dayAgo = nowMs - 24 * 60 * 60 * 1000;

    let queued = 0;
    let failed = 0;
    let dueNow = 0;
    let sent24h = 0;

    for (const it of queue.items) {
      if (it.status === 'queued') {
        queued += 1;
        const at = Date.parse(String(it.nextAttemptAt || ''));
        if (!Number.isFinite(at) || at <= nowMs) dueNow += 1;
      }
      if (it.status === 'failed') failed += 1;
      if (it.status === 'sent') {
        const s = Date.parse(String(it.sentAt || ''));
        if (Number.isFinite(s) && s >= dayAgo) sent24h += 1;
      }
    }

    return { queued, failed, dueNow, sent24h };
  }

  private async maybeNotifyInboxQueueIssue(summary?: { queued: number; failed: number; dueNow: number; sent24h: number }): Promise<void> {
    try {
      const cfg = await this.getLogConfig();
      if (!cfg.enabled || !cfg.channelId) return;

      const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
      if (!guildId) return;
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return;

      const ch = guild.channels.cache.get(cfg.channelId) as TextChannel;
      if (!ch) return;

      const stat = summary || await this.getInboxQueueStatusSummary();
      const failedThreshold = Math.max(1, Number(process.env.INBOX_QUEUE_ALERT_FAILED_THRESHOLD || '3') || 3);
      const dueThreshold = Math.max(1, Number(process.env.INBOX_QUEUE_ALERT_DUE_THRESHOLD || '8') || 8);
      const cooldownSec = Math.max(30, Number(process.env.INBOX_QUEUE_ALERT_COOLDOWN_SEC || '300') || 300);
      const nowMs = Date.now();

      const unhealthy = stat.failed >= failedThreshold || stat.dueNow >= dueThreshold;

      if (unhealthy) {
        if ((nowMs - this.lastInboxQueueAlertAtMs) < cooldownSec * 1000) return;
        this.lastInboxQueueAlertAtMs = nowMs;
        this.inboxQueueAlertActive = true;

        const embed = new EmbedBuilder()
          .setTitle('📬 Inbox Queue Alert')
          .setColor(0xef4444)
          .setDescription([
            `Queue izgleda zapelo iznad praga.`,
            `• queued: **${stat.queued}**`,
            `• failed: **${stat.failed}** (prag ${failedThreshold})`,
            `• due now: **${stat.dueNow}** (prag ${dueThreshold})`,
            `• sent(24h): **${stat.sent24h}**`
          ].join('\n'))
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        await ch.send({ embeds: [embed] }).catch(() => {});
        return;
      }

      if (this.inboxQueueAlertActive) {
        this.inboxQueueAlertActive = false;
        this.lastInboxQueueAlertAtMs = nowMs;
        const embed = new EmbedBuilder()
          .setTitle('✅ Inbox Queue Recovery')
          .setColor(0x22c55e)
          .setDescription([
            `Queue se vratio ispod praga.`,
            `• queued: **${stat.queued}**`,
            `• failed: **${stat.failed}**`,
            `• due now: **${stat.dueNow}**`
          ].join('\n'))
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        await ch.send({ embeds: [embed] }).catch(() => {});
      }
    } catch (e) {
      console.error('maybeNotifyInboxQueueIssue error:', e);
    }
  }

  private buildInboxQueueActionsRow(): ActionRowBuilder<StringSelectMenuBuilder> {
    return new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('inbox_queue_actions')
          .setPlaceholder('Inbox queue akcije...')
          .addOptions(
            { label: 'Process now', value: 'process_now', description: 'Odmah pokušaj poslati queued komande' },
            { label: 'Retry failed', value: 'retry_failed', description: 'Vrati failed zapise u queue' },
            { label: 'Clear sent', value: 'clear_sent', description: 'Obriši sent povijest iz queue datoteke' },
            { label: 'Clear failed', value: 'clear_failed', description: 'Obriši trajno failed zapise' }
          )
      );
  }

  private async retryFailedInboxQueue(): Promise<number> {
    const queue = await this.readInboxQueue();
    let changed = 0;
    const now = new Date().toISOString();

    queue.items = queue.items.map((it: InboxQueueItem) => {
      if (it.status !== 'failed') return it;
      changed += 1;
      return {
        ...it,
        status: 'queued',
        nextAttemptAt: now,
        attempts: 0,
        lastError: undefined
      };
    });

    await this.writeInboxQueue(queue);
    return changed;
  }

  private async clearSentInboxQueue(): Promise<number> {
    const queue = await this.readInboxQueue();
    const before = queue.items.length;
    queue.items = queue.items.filter((it: InboxQueueItem) => it.status !== 'sent');
    await this.writeInboxQueue(queue);
    return before - queue.items.length;
  }

  private async clearFailedInboxQueue(): Promise<number> {
    const queue = await this.readInboxQueue();
    const before = queue.items.length;
    queue.items = queue.items.filter((it: InboxQueueItem) => it.status !== 'failed');
    await this.writeInboxQueue(queue);
    return before - queue.items.length;
  }

  public async applyInboxAck(input: { commandRef?: string; filename?: string; status?: string; error?: string; }): Promise<boolean> {
    const ref = String(input.commandRef || '').trim();
    const filename = String(input.filename || '').trim();
    if (!ref && !filename) return false;

    const queue = await this.readInboxQueue();
    const idx = queue.items.findIndex((it: InboxQueueItem) => {
      const cmdRef = String(it.commandRef || '').trim();
      if (ref && cmdRef && cmdRef === ref) return true;
      if (ref && String(it.filename || '').includes(ref)) return true;
      if (filename && String(it.filename || '') === filename) return true;
      return false;
    });
    if (idx < 0) return false;

    const st = String(input.status || 'ok').toLowerCase();
    const ok = st === 'ok' || st === 'success' || st === 'sent' || st === 'done';

    queue.items[idx] = {
      ...queue.items[idx],
      status: ok ? 'sent' : 'failed',
      sentAt: ok ? new Date().toISOString() : queue.items[idx].sentAt,
      lastError: ok ? undefined : (String(input.error || input.status || 'ack-failed'))
    };

    await this.writeInboxQueue(queue);
    return true;
  }

  public async ingestGameplayEvents(events: any[]): Promise<number> {
    const list = Array.isArray(events) ? events : [];
    if (!list.length) return 0;

    let stored = 0;
    for (const ev of list.slice(0, 200)) {
      try {
        const typ = String(ev?.type || ev?.eventType || 'gameplay_event').trim() || 'gameplay_event';
        await storage.log({
          type: typ,
          message: JSON.stringify(ev || {})
        } as any);
        stored += 1;
      } catch {}
    }

    return stored;
  }

  // ====== Coop Market System ======

  /** Receive real game prices from sellingPrices.xml (called by sync.ts) */
  public async updateGamePrices(
    fillTypes: Array<{ name: string; basePrice: number }>,
    bestPrices: Array<{ fillType: string; price: number; station: string; greatDemand: boolean }>
  ): Promise<void> {
    const bestMap = new Map(bestPrices.map(bp => [bp.fillType, bp]));

    for (const ft of fillTypes) {
      const best = bestMap.get(ft.name);
      gamePricesCache.set(ft.name, {
        basePrice: ft.basePrice,
        bestPrice: best?.price ?? ft.basePrice,
        bestStation: best?.station ?? '',
        greatDemand: best?.greatDemand ?? false,
      });
    }
    // Also add bestPrices that weren't in fillTypes list
    for (const bp of bestPrices) {
      if (!gamePricesCache.has(bp.fillType)) {
        gamePricesCache.set(bp.fillType, {
          basePrice: bp.price,
          bestPrice: bp.price,
          bestStation: bp.station,
          greatDemand: bp.greatDemand,
        });
      }
    }

    // Update market DB with real game prices
    const market = await storage.getCoopMarket();
    for (const item of market) {
      const gp = gamePricesCache.get(item.fillType);
      if (gp) {
        const coopPrice = this.calcCoopBasePrice(gp);
        await storage.upsertCoopMarketItem({
          fillType: item.fillType,
          basePrice: gp.basePrice,
          demandLevel: gp.greatDemand ? 1.5 : 1.0,
          supplyLevel: item.supplyLevel || 0,
          currentPrice: coopPrice,
          lastDemandReset: item.lastDemandReset,
        });
      }
    }

    console.log(`[COOP] Game prices updated: ${gamePricesCache.size} fill types cached`);
  }

  /** Calculate coop base price from game price data */
  private calcCoopBasePrice(gp: GamePriceEntry): number {
    const multiplier = gp.greatDemand ? COOP_GREAT_DEMAND_MULTIPLIER : COOP_BASE_MULTIPLIER;
    return +(gp.bestPrice * multiplier).toFixed(4);
  }

  /** Get the effective coop base price for a fill type (game price or fallback) */
  private getCoopBasePrice(fillType: string): number {
    const gp = gamePricesCache.get(fillType);
    if (gp) return this.calcCoopBasePrice(gp);
    return COOP_FALLBACK_PRICES[fillType] ?? 0.10;
  }

  /** Ensure all known fill types are seeded in DB */
  public async seedCoopMarket(): Promise<void> {
    const existing = await storage.getCoopMarket();
    const existingSet = new Set(existing.map((m: any) => m.fillType));
    // Use game prices if available, otherwise fallback
    const allFillTypes = gamePricesCache.size > 0
      ? Array.from(gamePricesCache.keys())
      : Object.keys(COOP_FALLBACK_PRICES);
    for (const fillType of allFillTypes) {
      if (!existingSet.has(fillType)) {
        const coopPrice = this.getCoopBasePrice(fillType);
        const gp = gamePricesCache.get(fillType);
        await storage.upsertCoopMarketItem({
          fillType,
          basePrice: gp?.basePrice ?? COOP_FALLBACK_PRICES[fillType] ?? 0.10,
          demandLevel: gp?.greatDemand ? 1.5 : 1.0,
          supplyLevel: 0,
          currentPrice: coopPrice,
          lastDemandReset: new Date(),
        });
      }
    }
  }

  /** Refresh coop prices from game data (no more random shuffle — prices follow game) */
  public async shuffleCoopDemand(): Promise<void> {
    const market = await storage.getCoopMarket();
    for (const item of market) {
      const gp = gamePricesCache.get(item.fillType);
      const coopPrice = this.getCoopBasePrice(item.fillType);
      await storage.upsertCoopMarketItem({
        fillType: item.fillType,
        basePrice: gp?.basePrice ?? item.basePrice ?? 0.10,
        demandLevel: gp?.greatDemand ? 1.5 : 1.0,
        supplyLevel: 0, // reset daily supply
        currentPrice: coopPrice,
        lastDemandReset: new Date(),
      });
    }
    console.log('[COOP] Prices refreshed for', market.length, 'items (game prices:', gamePricesCache.size > 0 ? 'YES' : 'fallback', ')');
  }

  /** Calculate actual price with supply pressure */
  private calcActualPrice(currentPrice: number, supplyLevel: number): number {
    const factor = Math.max(COOP_MIN_PRICE_FACTOR, 1.0 - supplyLevel / COOP_SUPPLY_SATURATION);
    return +(currentPrice * factor).toFixed(4);
  }

  /** Send coop payout log to mod-log channel */
  private async sendCoopModLog(data: { farmName: string; farmId: string; fillType: string; amount: number; pricePerUnit: number; totalEarned: number; bonusEarned?: number; reason: string }): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;
    const modLog = await getGuildChannel(guild, 'mod-log');
    if (!modLog) return;

    const emoji = this.getFillTypeEmoji(data.fillType);
    const cName = COOP_FILL_NAMES[data.fillType] || data.fillType;
    const per1k = (data.pricePerUnit * 1000).toFixed(0);
    const totalPaid = data.totalEarned + (data.bonusEarned || 0);

    const fields: { name: string; value: string; inline: boolean }[] = [
      { name: '🏘️ Farma', value: `**${data.farmName}** (ID: ${data.farmId})`, inline: true },
      { name: `${emoji} Materijal`, value: `${cName} (${data.fillType})`, inline: true },
      { name: '📦 Količina', value: `${data.amount.toLocaleString('hr-HR')}L`, inline: true },
      { name: '💲 Cijena/t', value: `$${per1k}`, inline: true },
      { name: '💰 Zarada', value: `$${data.totalEarned.toLocaleString('hr-HR')}`, inline: true },
    ];

    if (data.bonusEarned && data.bonusEarned > 0) {
      fields.push({ name: '🎁 Bonus', value: `+$${data.bonusEarned.toLocaleString('hr-HR')}`, inline: true });
    }

    fields.push({ name: '💵 UKUPNO ISPLAĆENO', value: `**$${totalPaid.toLocaleString('hr-HR')}**`, inline: false });

    const logEmbed = new EmbedBuilder()
      .setColor(data.bonusEarned ? 0xffd700 : 0x2ecc71)
      .setTitle(`💸 COOP ISPLATA — ${data.reason}`)
      .addFields(...fields)
      .setTimestamp();

    await (modLog as any).send({ embeds: [logEmbed] }).catch(() => {});
  }

  /** Send money to a farm via game command (moneyTransfer inbox XML) */
  private async sendCoopMoneyToFarm(farmId: string, amount: number, reason: string): Promise<void> {
    if (!farmId || amount <= 0) return;
    const roundedAmount = Math.round(amount);
    if (roundedAmount <= 0) return;

    const cmdId = Date.now().toString();
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<commands>\n  <command id="${escapeXml(cmdId)}" command="moneyTransfer" farmId="${escapeXml(String(farmId))}" amount="${escapeXml(String(roundedAmount))}" />\n</commands>`;

    await this.enqueueInboxCommand({
      kind: 'bank_transfer',
      payloadType: 'xml',
      filename: `cmd-coopPayout-${cmdId}.xml`,
      commandRef: cmdId,
      xml,
    });

    await this.processInboxQueue(2).catch(() => {});
    console.log(`[COOP] Payout queued: $${roundedAmount} to farm ${farmId} — ${reason}`);
  }

  private async returnCoopOverflowToFarm(farmId: string, fillType: string, amount: number): Promise<void> {
    const roundedAmount = Math.floor(Number(amount) || 0);
    if (!farmId || !fillType || roundedAmount <= 0) return;

    await this.sendGameAdminCommand('coopSiloStore', {
      farmId: String(farmId),
      fillType: String(fillType),
      amount: String(roundedAmount),
    });

    console.log(`[COOP] Overflow returned: ${roundedAmount}L ${fillType} -> farm ${farmId}`);
  }

  /** Process an outbound coop delivery from game (outbox XML) */
  public async processCoopDelivery(data: { command: string; farmId: string; fillType: string; amount: number; transactionId?: string; timestamp?: string }): Promise<void> {
    const { farmId, fillType, amount, transactionId } = data;
    if (!farmId || !fillType || !amount || amount <= 0) return;

    // Deduplicate by transactionId — prevent double-counting if FTP delete fails
    if (transactionId && transactionId.length > 0) {
      const existing = await storage.getRecentDeliveries(200);
      if (existing.some((d: any) => d.transactionId === transactionId)) {
        console.log(`[COOP] Skipped duplicate delivery: txId=${transactionId}`);
        return;
      }
    }

    const upperFill = fillType.toUpperCase();

    // Get or create market entry
    let market = await storage.getCoopMarket();
    let item = market.find((m: any) => m.fillType === upperFill);
    if (!item) {
      const coopPrice = this.getCoopBasePrice(upperFill);
      const gp = gamePricesCache.get(upperFill);
      await storage.upsertCoopMarketItem({
        fillType: upperFill,
        basePrice: gp?.basePrice ?? COOP_FALLBACK_PRICES[upperFill] ?? 0.10,
        demandLevel: gp?.greatDemand ? 1.5 : 1.0,
        supplyLevel: 0,
        currentPrice: coopPrice,
      });
      market = await storage.getCoopMarket();
      item = market.find((m: any) => m.fillType === upperFill);
    }
    if (!item) return;

    const actualPrice = this.calcActualPrice(item.currentPrice, item.supplyLevel || 0);

    // Check active contracts — only match contracts claimed by this farm
    const contracts = await storage.getActiveContracts();
    let matchedContract: any = null;
    for (const c of contracts) {
      if (c.fillType === upperFill && c.status === 'active' && c.claimedByFarmId === String(farmId)) {
        matchedContract = c;
        break;
      }
    }

    let contractId: string | undefined;
    let contractCompleted = false;
    let bonusEarned = 0;
    let acceptedAmount = amount;
    let overflowAmount = 0;
    let totalEarned = +(actualPrice * acceptedAmount).toFixed(2);
    let totalContractBaseEarned = 0;

    if (matchedContract) {
      contractId = String(matchedContract._id);
      const alreadyDelivered = matchedContract.deliveredAmount || 0;
      const requiredAmount = matchedContract.requiredAmount || 0;
      const remainingAmount = Math.max(0, requiredAmount - alreadyDelivered);

      acceptedAmount = Math.min(amount, remainingAmount);
      overflowAmount = Math.max(0, amount - acceptedAmount);

      if (overflowAmount > 0) {
        await this.returnCoopOverflowToFarm(String(farmId), upperFill, overflowAmount);
      }

      if (acceptedAmount <= 0) {
        await this.sendCoopDeliveryNotification({
          farmId: String(farmId),
          fillType: upperFill,
          amount: 0,
          pricePerUnit: actualPrice,
          totalEarned: 0,
          overflowAmount,
        });
        return;
      }

      totalEarned = +(actualPrice * acceptedAmount).toFixed(2);
      await storage.updateCoopSupply(upperFill, acceptedAmount);

      const updated = await storage.updateContractDelivery(contractId, acceptedAmount);
      if (updated && (updated.deliveredAmount || 0) >= matchedContract.requiredAmount) {
        await storage.completeContract(contractId);
        contractCompleted = true;

        const deliveries = await storage.getRecentDeliveries(500);
        const previousBaseEarned = deliveries
          .filter((d: any) => d.contractId === contractId)
          .reduce((sum: number, d: any) => sum + (d.totalEarned || 0), 0);

        totalContractBaseEarned = +(previousBaseEarned + totalEarned).toFixed(2);
        bonusEarned = +(totalContractBaseEarned * (matchedContract.bonusPercent / 100)).toFixed(2);
      }
    } else {
      await storage.updateCoopSupply(upperFill, acceptedAmount);
    }

    // Record delivery — store only base earnings (bonus tracked separately)
    await storage.recordDelivery({
      farmId: String(farmId),
      fillType: upperFill,
      amount: acceptedAmount,
      pricePerUnit: actualPrice,
      totalEarned,
      contractId,
      transactionId: transactionId || undefined,
    });

    // Non-contract coop sales are paid immediately. Contract payouts are deferred until completion/expiry.
    if (!matchedContract && totalEarned > 0) {
      const cName = COOP_FILL_NAMES[upperFill] || upperFill;
      await this.sendCoopMoneyToFarm(String(farmId), totalEarned, `Prodaja — ${cName}`);
    }

    // Auto-update contract channel embed if delivery matched a contract
    if (matchedContract && !contractCompleted) {
      await this.autoUpdateContractChannel(matchedContract, String(farmId)).catch(() => {});
    }

    // Discord notification — delivery (skip if completing contract, completion embed has all info)
    if (!contractCompleted) {
      await this.sendCoopDeliveryNotification({
        farmId: String(farmId),
        fillType: upperFill,
        amount: acceptedAmount,
        pricePerUnit: actualPrice,
        totalEarned,
        overflowAmount: overflowAmount > 0 ? overflowAmount : undefined,
      });
    }

    // Discord notification — contract completed
    if (contractCompleted && matchedContract) {
      await this.sendCoopContractCompletedNotification(matchedContract, totalContractBaseEarned, bonusEarned, overflowAmount > 0 ? overflowAmount : undefined);

      const totalPayout = +(totalContractBaseEarned + bonusEarned).toFixed(2);
      if (totalPayout > 0) {
        const cName = COOP_FILL_NAMES[upperFill] || upperFill;
        await this.sendCoopMoneyToFarm(String(farmId), totalPayout, `Coop ugovor završen — ${cName}`);
      }

      // Delete the contract channel since contract is completed
      await this.deleteContractChannel(matchedContract, String(farmId));
    }

    // Mod-log — payout record
    const farms = await storage.getFarms();
    const farmObj = farms.find(f => String(f.farmId) === String(farmId));
    const farmNameLog = farmObj?.name || `Farma ${farmId}`;
    const reason = contractCompleted ? 'Isporuka + Ugovor ispunjen' : contractId ? 'Isporuka (ugovor u tijeku)' : 'Isporuka';
    await this.sendCoopModLog({
      farmName: farmNameLog,
      farmId: String(farmId),
      fillType: upperFill,
      amount: acceptedAmount,
      pricePerUnit: actualPrice,
      totalEarned: matchedContract && contractCompleted ? totalContractBaseEarned : totalEarned,
      bonusEarned: bonusEarned > 0 ? bonusEarned : undefined,
      reason,
    });

    console.log(`[COOP] Delivery: Farm ${farmId} sold ${acceptedAmount}L ${upperFill} @ $${actualPrice}/L = $${totalEarned}${overflowAmount > 0 ? ` | overflow returned ${overflowAmount}L` : ''}${contractCompleted ? ` | contract payout $${(totalContractBaseEarned + bonusEarned).toFixed(2)}` : ''}`);
  }

  // ─── Poslovi na ugovor (Custom Contracts) ─────────────────────────────

  private readonly POSLOVI_WORK_TYPES: Record<string, string> = {
    'Kultiviranje': '🔄 Kultiviranje',
    'Oranje': '🚜 Oranje',
    'Sijanje': '🌱 Sijanje',
    'Gnojenje': '💩 Gnojenje',
    'Žetva': '🌾 Žetva',
    'Valjanje': '🛞 Valjanje',
    'Plijevljenje': '🌿 Plijevljenje',
    'Vapnjenje': '⬜ Vapnjenje',
    'Mulčiranje': '🍂 Mulčiranje',
    'Skupljanje kamenja': '🪨 Skupljanje kamenja',
    'Uklanjanje lišća': '🍃 Uklanjanje lišća',
    'Košnja': '✂️ Košnja',
    'Prevrtanje': '🔃 Prevrtanje',
    'Grabljanje': '🧹 Grabljanje',
    'Baliranje': '📦 Baliranje',
    'Omatanje bala': '🎁 Omatanje bala',
    'Prskanje': '💧 Prskanje',
    'Ostalo': '📋 Ostalo',
  };

  private readonly POSLOVI_STATUS_EMOJI: Record<string, string> = {
    'OTVORENO': '🟢',
    'PRIHVAĆENO': '🟡',
    'DOVRŠENO': '✅',
    'OTKAZANO': '❌',
    'ISTEKAO': '⏰',
  };

  /** Sync custom contracts state from game outbox XML */
  public async processCustomContracts(contracts: Array<{
    id: number; creatorFarmId: number; contractorFarmId: number;
    fieldId: number; workType: string; reward: number; status: string;
    description: string; startPeriod: number; startDay: number;
    duePeriod: number; dueDay: number;
  }>): Promise<void> {
    const mapped = contracts.map(c => ({
      gameId: c.id,
      creatorFarmId: String(c.creatorFarmId),
      contractorFarmId: c.contractorFarmId > 0 ? String(c.contractorFarmId) : null,
      fieldId: c.fieldId,
      workType: c.workType,
      reward: c.reward,
      status: c.status,
      description: c.description || '',
      startPeriod: c.startPeriod,
      startDay: c.startDay,
      duePeriod: c.duePeriod,
      dueDay: c.dueDay,
    }));

    const diff = await storage.bulkSyncCustomContracts(mapped);

    // Send Discord notifications for changes
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    const guild = guildId ? this.client.guilds.cache.get(guildId) : null;
    if (!guild) return;

    const channel = await getGuildChannel(guild, 'poslovi');
    if (!channel || !channel.isTextBased()) return;

    const farms = await storage.getFarms();
    const farmName = (fid: string | null) => {
      if (!fid) return 'Nepoznato';
      const f = farms.find(fm => String(fm.farmId) === fid);
      return f?.name || `Farma ${fid}`;
    };

    // New contracts
    for (const c of diff.created) {
      const wtLabel = this.POSLOVI_WORK_TYPES[c.workType] || c.workType;
      const embed = new EmbedBuilder()
        .setTitle('📋 Novi posao objavljen')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Vrsta posla', value: wtLabel, inline: true },
          { name: 'Polje', value: `#${c.fieldId}`, inline: true },
          { name: 'Nagrada', value: `$${c.reward.toLocaleString('hr-HR')}`, inline: true },
          { name: 'Objavila', value: farmName(c.creatorFarmId), inline: true },
        );
      if (c.description) embed.addFields({ name: 'Opis', value: c.description });
      if (c.duePeriod > 0) embed.addFields({ name: 'Rok', value: `Mj. ${c.duePeriod}, dan ${c.dueDay}`, inline: true });
      try { await (channel as any).send({ embeds: [embed] }); } catch (e) { console.error('[POSLOVI] Send error:', e); }
    }

    // Status changes
    for (const { old: oldC, new: newC } of diff.updated) {
      const statusEmoji = this.POSLOVI_STATUS_EMOJI[newC.status] || '🔄';
      const wtLabel = this.POSLOVI_WORK_TYPES[newC.workType] || newC.workType;

      let description = '';
      if (newC.status === 'PRIHVAĆENO') {
        description = `**${farmName(newC.contractorFarmId)}** je prihvatila posao.`;
      } else if (newC.status === 'DOVRŠENO') {
        description = `Posao je završen! Isplaćeno **$${newC.reward.toLocaleString('hr-HR')}**.`;
      } else if (newC.status === 'OTKAZANO') {
        description = `Posao je otkazan.`;
      } else if (newC.status === 'ISTEKAO') {
        description = `Posao je istekao.`;
      } else if (oldC.status !== newC.status) {
        description = `Status: ${oldC.status} → ${newC.status}`;
      }

      if (!description) continue;

      const embed = new EmbedBuilder()
        .setTitle(`${statusEmoji} Posao ažuriran`)
        .setColor(newC.status === 'DOVRŠENO' ? 0x27ae60 : newC.status === 'OTKAZANO' || newC.status === 'ISTEKAO' ? 0xe74c3c : 0xf39c12)
        .setDescription(description)
        .addFields(
          { name: 'Vrsta posla', value: wtLabel, inline: true },
          { name: 'Polje', value: `#${newC.fieldId}`, inline: true },
          { name: 'Nagrada', value: `$${newC.reward.toLocaleString('hr-HR')}`, inline: true },
          { name: 'Objavila', value: farmName(newC.creatorFarmId), inline: true },
        );
      try { await (channel as any).send({ embeds: [embed] }); } catch (e) { console.error('[POSLOVI] Send error:', e); }
    }

    // Deleted contracts
    for (const c of diff.removed) {
      const wtLabel = this.POSLOVI_WORK_TYPES[c.workType] || c.workType;
      const embed = new EmbedBuilder()
        .setTitle('🗑️ Posao obrisan')
        .setColor(0x95a5a6)
        .addFields(
          { name: 'Vrsta posla', value: wtLabel, inline: true },
          { name: 'Polje', value: `#${c.fieldId}`, inline: true },
          { name: 'Nagrada', value: `$${(c.reward || 0).toLocaleString('hr-HR')}`, inline: true },
        );
      try { await (channel as any).send({ embeds: [embed] }); } catch (e) { console.error('[POSLOVI] Send error:', e); }
    }

    if (diff.created.length || diff.updated.length || diff.removed.length) {
      console.log(`[POSLOVI] Sync: +${diff.created.length} new, ~${diff.updated.length} updated, -${diff.removed.length} removed`);
    }
  }

  /** Send a command to the Poslovi mod inbox via FTP */
  public async sendPosloviCommand(type: string, data: Record<string, string | number>): Promise<void> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let attrs = '';
    for (const [k, v] of Object.entries(data)) {
      attrs += ` ${k}="${escapeXml(String(v))}"`;
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<FTPCommand transactionId="${id}" type="${escapeXml(type)}">\n  <contract${attrs} />\n</FTPCommand>`;
    const filename = `cmd-poslovi-${type}-${id}.xml`;
    await uploadPosloviInboxXml(filename, xml);
  }

  /** Generate daily contracts (5 random, 24h, bonus 15-50% scaling with quantity) */
  public async generateCoopContracts(): Promise<number> {
    // Expire old contracts first — process proportional bonus payouts
    await this.expireContractsWithPayout();

    // One-time migration: assign unclaimed contracts with deliveries to the delivering farm + create channel
    const guildIdMigrate = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    const guildMigrate = guildIdMigrate ? this.client.guilds.cache.get(guildIdMigrate) : null;
    // Clean up orphan contract channels for completed/expired contracts
    if (guildMigrate) {
      const contractChannels = guildMigrate.channels.cache.filter((ch: any) => ch.type === 0 && ch.name.startsWith('📦┃'));
      const allActiveContracts = await storage.getActiveContracts();
      for (const [, ch] of contractChannels) {
        // Check if any active contract matches this channel name
        const hasActive = allActiveContracts.some((c: any) => {
          if (!c.claimedByFarmId) return false;
          const cName = COOP_FILL_NAMES[c.fillType] || c.fillType;
          const expected = `📦┃${cName.toLowerCase().replace(/[^a-zA-Zščćžđ0-9]/g, '-').replace(/-+/g, '-')}-f${c.claimedByFarmId}`;
          return ch.name === expected;
        });
        if (!hasActive) {
          try {
            await ch.delete('Coop ugovor završen/istekao — čišćenje');
            console.log(`[COOP] Cleaned up orphan contract channel: ${ch.name}`);
          } catch (e: any) { console.error(`[COOP] Failed to delete orphan channel ${ch.name}:`, e.message); }
        }
      }
    }

    // Cap any legacy contracts (old expiry) to 48h from now
    const maxExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000 + 60000);
    const allActive = await storage.getActiveContracts();
    for (const c of allActive) {
      if (c.expiresAt > maxExpiry) {
        const col = await (storage as any).collection("coopContracts");
        await col.updateOne({ _id: c._id }, { $set: { expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) } });
      }
    }

    // Check how many active contracts exist
    const active = await storage.getActiveContracts();
    if (active.length >= 5) return 0;

    // Available fill types: prefer game prices, fallback to known types
    const fillTypes = gamePricesCache.size > 0
      ? Array.from(gamePricesCache.keys()).filter(ft => COOP_FILL_NAMES[ft])
      : Object.keys(COOP_FALLBACK_PRICES);
    const activeFillTypes = new Set(active.map((c: any) => c.fillType));
    const available = fillTypes.filter(f => !activeFillTypes.has(f));
    if (!available.length) return 0;

    const count = Math.min(5 - active.length, 5);
    let created = 0;

    for (let i = 0; i < count && available.length > 0; i++) {
      const idx = Math.floor(Math.random() * available.length);
      const fillType = available.splice(idx, 1)[0];
      // Larger amounts = higher bonus (scaling system)
      // Small: 30-60k → 15-25% bonus | Medium: 60-120k → 25-35% | Large: 120-200k → 35-50%
      const tier = Math.random();
      let requiredAmount: number;
      let bonusPercent: number;
      if (tier < 0.4) {
        // Small contracts (40% chance)
        requiredAmount = Math.round((30000 + Math.random() * 30000) / 1000) * 1000;
        bonusPercent = Math.round(15 + Math.random() * 10);
      } else if (tier < 0.75) {
        // Medium contracts (35% chance)
        requiredAmount = Math.round((60000 + Math.random() * 60000) / 1000) * 1000;
        bonusPercent = Math.round(25 + Math.random() * 10);
      } else {
        // Large contracts (25% chance) — high risk, high reward
        requiredAmount = Math.round((120000 + Math.random() * 80000) / 1000) * 1000;
        bonusPercent = Math.round(35 + Math.random() * 15);
      }
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

      await storage.createContract({ fillType, requiredAmount, bonusPercent, expiresAt });
      created++;
    }

    if (created > 0) {
      console.log(`[COOP] Generated ${created} new daily contracts`);
      await this.sendCoopNewContractsNotification();
    }
    return created;
  }

  /** Expire contracts and pay proportional bonus to contributing farms */
  private async expireContractsWithPayout(): Promise<void> {
    // Get contracts that are about to be expired
    const active = await storage.getActiveContracts();
    const now = new Date();
    const expiring = active.filter((c: any) => c.expiresAt && new Date(c.expiresAt) <= now);

    for (const contract of expiring) {
      const contractId = String(contract._id);
      const delivered = contract.deliveredAmount || 0;
      const required = contract.requiredAmount || 1;
      const completionPct = Math.min(1, delivered / required);
      const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;

      if (completionPct > 0 && completionPct < 1) {
        // Proportional bonus: bonusPercent * completion%
        const effectiveBonus = +(contract.bonusPercent * completionPct).toFixed(1);

        // Notify about partial completion
        await this.sendCoopContractExpiredNotification(contract, effectiveBonus, completionPct);

        // Mod-log payout — single farm (exclusive contract)
        if (contract.claimedByFarmId) {
          const deliveries = await storage.getRecentDeliveries(500);
          const contractDeliveries = deliveries.filter((d: any) => d.contractId === contractId);
          const totalEarned = contractDeliveries.reduce((s: number, d: any) => s + (d.totalEarned || 0), 0);
          const totalBonus = +(totalEarned * effectiveBonus / 100).toFixed(0);
          const farms = await storage.getFarms();
          const farm = farms.find(f => String(f.farmId) === String(contract.claimedByFarmId));

          await this.sendCoopModLog({
            farmName: farm?.name || `Farma ${contract.claimedByFarmId}`,
            farmId: contract.claimedByFarmId,
            fillType: contract.fillType,
            amount: delivered,
            pricePerUnit: totalEarned / (delivered || 1),
            totalEarned,
            bonusEarned: totalBonus > 0 ? totalBonus : undefined,
            reason: `Ugovor istekao (${Math.round(completionPct * 100)}%) — ${cName}`,
          });

          // Send partial contract payout in-game on expiry: base + proportional bonus.
          const totalPayout = +(totalEarned + totalBonus).toFixed(0);
          if (totalPayout > 0) {
            await this.sendCoopMoneyToFarm(String(contract.claimedByFarmId), totalPayout, `Coop ugovor istekao (${Math.round(completionPct * 100)}%) — ${cName}`);
          }
        }
      }

      // Clean up contract channel if it exists
      const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
      if (guildId && contract.claimedByFarmId) {
        const guild = this.client.guilds.cache.get(guildId);
        if (guild) {
          const channelPrefix = `📦┃${cName.toLowerCase().replace(/[^a-zA-Zščćžđ0-9]/g, '-').replace(/-+/g, '-')}-f${contract.claimedByFarmId}`;
          const contractChannel = guild.channels.cache.find((ch: any) => ch.type === 0 && ch.name === channelPrefix);
          if (contractChannel) {
            try {
              const expiredEmbed = new EmbedBuilder()
                .setColor(0xe74c3c)
                .setTitle('⏰ Ugovor istekao!')
                .setDescription(`Ovaj ugovor je istekao. Kanal se zatvara za 5 sekundi...`)
                .setTimestamp();
              await (contractChannel as any).send({ embeds: [expiredEmbed] });
              setTimeout(async () => {
                try { await contractChannel.delete('Coop ugovor istekao'); } catch {}
              }, 5000);
            } catch {}
          }
        }
      }
    }

    // Now actually expire them in DB
    const expired = await storage.expireContracts();
    if (expired > 0) console.log(`[COOP] Expired ${expired} contracts (with payouts)`);
  }

  /** Send warnings for contracts expiring soon */
  private async sendContractExpiryWarnings(): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const contracts = await storage.getActiveContracts();
    const now = Date.now();

    for (const contract of contracts) {
      if (!contract.claimedByFarmId || !contract.expiresAt) continue;
      const hoursLeft = Math.max(0, (new Date(contract.expiresAt).getTime() - now) / 3600000);
      // Warn at ~8h and ~3h remaining
      if (hoursLeft > 8 || hoursLeft <= 0) continue;

      const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;
      const channelPrefix = `📦┃${cName.toLowerCase().replace(/[^a-zA-Zščćžđ0-9]/g, '-').replace(/-+/g, '-')}-f${contract.claimedByFarmId}`;
      const contractChannel = guild.channels.cache.find((ch: any) => ch.type === 0 && ch.name === channelPrefix);
      if (!contractChannel) continue;

      const pct = contract.requiredAmount > 0 ? Math.round((contract.deliveredAmount || 0) / contract.requiredAmount * 100) : 0;
      const urgent = hoursLeft <= 3;
      const warnEmbed = new EmbedBuilder()
        .setColor(urgent ? 0xe74c3c : 0xe67e22)
        .setTitle(urgent ? '🚨 HITNO — Ugovor uskoro istječe!' : '⚠️ Upozorenje — Ugovor istječe')
        .setDescription(
          `${this.getFillTypeEmoji(contract.fillType)} **${cName}** — preostalo **${Math.ceil(hoursLeft)}h**!\n\n` +
          `📊 Napredak: **${(contract.deliveredAmount || 0).toLocaleString('hr-HR')}/${contract.requiredAmount?.toLocaleString('hr-HR')}L** (${pct}%)\n` +
          `${this.buildProgressBar(pct)} **${pct}%**\n\n` +
          (pct < 100 ? `💡 *Požurite s isporukom da maksimalizirate bonus!*` : `✅ *Ugovor ispunjen — čeka zatvaranje.*`)
        )
        .setTimestamp();

      await (contractChannel as any).send({ embeds: [warnEmbed] }).catch(() => {});
    }
  }

  /** Send / update persistent market report to Discord */
  public async sendCoopMarketReport(): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    // Use 'market' channel ONLY
    const ch = await getGuildChannel(guild, 'market');
    if (!ch) return;

    const market = await storage.getCoopMarket();
    if (!market.length) return;

    const contracts = await storage.getActiveContracts();

    // Show items — filter to positive bonus only when game prices are available
    const hasPriceData = gamePricesCache.size > 0;
    const profitable: string[] = [];

    for (const m of market) {
      const gp = gamePricesCache.get(m.fillType);
      const emoji = this.getFillTypeEmoji(m.fillType);
      const name = COOP_FILL_NAMES[m.fillType] || m.fillType;
      const coopPer1k = ((m.currentPrice || 0) * 1000).toFixed(0);
      const gamePer1k = gp ? (gp.bestPrice * 1000).toFixed(0) : null;
      const bonusPct = gp && gp.bestPrice > 0 ? Math.round(((m.currentPrice || 0) / gp.bestPrice - 1) * 100) : 0;

      // When price data available, skip items with no positive bonus (unless great demand)
      if (hasPriceData && bonusPct <= 0 && !gp?.greatDemand) continue;

      const bonusStr = bonusPct > 0 ? `(+${bonusPct}% vs mapa)` : '';
      const gdStr = gp?.greatDemand ? ' 🔥' : '';
      const line = `${emoji} **${name}**: $${coopPer1k}/t ${bonusStr}${gdStr}${gamePer1k ? ` *(mapa: $${gamePer1k}/t)*` : ''}`;
      profitable.push(line);
    }

    let desc = '';
    if (profitable.length) {
      desc += `💰 **COOP CIJENE${hasPriceData ? ' — Isplative' : ''}:**\n${profitable.join('\n')}\n\n`;
    } else {
      desc += `📉 Trenutno nema materijala s pozitivnim coop bonusom.\n\n`;
    }

    if (contracts.length) {
      const farms = await storage.getFarms();
      desc += `📦 **AKTIVNI UGOVORI:** ${contracts.length}\n`;
      contracts.forEach((c: any, i: number) => {
        const pct = c.requiredAmount > 0 ? Math.round((c.deliveredAmount || 0) / c.requiredAmount * 100) : 0;
        const expiresH = c.expiresAt ? Math.max(0, Math.ceil((new Date(c.expiresAt).getTime() - Date.now()) / 3600000)) : 0;
        const cName = COOP_FILL_NAMES[c.fillType] || c.fillType;
        const claimStatus = c.claimedByFarmId
          ? `🔒 ${farms.find((f: any) => String(f.farmId) === String(c.claimedByFarmId))?.name || `Farma ${c.claimedByFarmId}`}`
          : '🟢 Slobodan';
        const warnStr = expiresH <= 6 ? ' ⚠️' : '';
        desc += `${i + 1}. ${this.getFillTypeEmoji(c.fillType)} **${c.requiredAmount?.toLocaleString('hr-HR')}L ${cName}** — ${(c.deliveredAmount || 0).toLocaleString('hr-HR')}/${c.requiredAmount?.toLocaleString('hr-HR')} (${pct}%) — +${c.bonusPercent}% — ${claimStatus} — ${expiresH}h${warnStr}\n`;
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🏪 COOP TRŽNICA' + (hasPriceData ? ' — Isplative cijene' : ''))
      .setDescription(desc.trim().slice(0, 4000))
      .setFooter({ text: `Cijene su po toni (1000L)${hasPriceData ? ' • Samo isplative cijene' : ''} • Coop = bonus vs mapa${hasPriceData ? ' ✓' : ' (fallback)'} • Ažurirano` })
      .setTimestamp();

    // Only show unclaimed contracts in dropdown
    const components: any[] = [];
    const unclaimedContracts = contracts.filter((c: any) => !c.claimedByFarmId);
    if (unclaimedContracts.length) {
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('coop_contract_select')
        .setPlaceholder('📦 Odaberi ugovor za svoju farmu...')
        .addOptions(unclaimedContracts.map((c: any, i: number) => {
          const cName = COOP_FILL_NAMES[c.fillType] || c.fillType;
          const tier = c.bonusPercent >= 35 ? '🔴 Veliki' : c.bonusPercent >= 25 ? '🟡 Srednji' : '🟢 Mali';
          return {
            label: `${c.requiredAmount?.toLocaleString('hr-HR')}L ${cName}`,
            value: String(c._id),
            description: `${tier} — Bonus: +${c.bonusPercent}%`,
            emoji: this.getFillTypeEmoji(c.fillType),
          };
        }));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
    }

    // Persistent embed — try to edit existing message, otherwise send new
    const payload = { embeds: [embed], components };
    try {
      // Look for stored market message ID in deployed panels
      const panels = await storage.getDeployedPanels();
      const marketPanel = panels.find((p: any) => p.panelType === 'coop_market' && p.channelId === ch.id);

      if (marketPanel?.messageId) {
        try {
          const existingMsg = await ch.messages.fetch(marketPanel.messageId);
          if (existingMsg) {
            await existingMsg.edit(payload);
            console.log('[COOP] Market embed updated (edited existing)');
            return;
          }
        } catch {
          // Message was deleted — will send new one below
        }
      }

      // Delete old market panel record if channel changed
      const oldPanel = panels.find((p: any) => p.panelType === 'coop_market');
      if (oldPanel && oldPanel.channelId !== ch.id) {
        // Clean up old message if possible
        try {
          const oldCh = guild.channels.cache.get(oldPanel.channelId);
          if (oldCh) {
            const oldMsg = await (oldCh as any).messages.fetch(oldPanel.messageId).catch(() => null);
            if (oldMsg) await oldMsg.delete().catch(() => {});
          }
        } catch {}
      }

      // Send new message and store its ID
      const newMsg = await (ch as any).send(payload);
      await storage.upsertDeployedPanel({
        channelId: ch.id,
        messageId: newMsg.id,
        panelType: 'coop_market',
      });
      console.log('[COOP] Market embed sent (new message)');
    } catch (e: any) {
      console.error('[COOP] Market report failed:', e.message);
    }
  }

  /** Delivery notification */
  private async sendCoopDeliveryNotification(data: { farmId: string; fillType: string; amount: number; pricePerUnit: number; totalEarned: number; contractBonusEarned?: number; overflowAmount?: number }): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const ch = await getGuildChannel(guild, 'farm-obavijesti') || await getGuildChannel(guild, 'opcenito');
    if (!ch) return;

    const farms = await storage.getFarms();
    const farm = farms.find(f => String(f.farmId) === String(data.farmId));
    const farmName = farm?.name || `Farma ${data.farmId}`;
    const emoji = this.getFillTypeEmoji(data.fillType);

    // Check contract progress — only show for contract claimed by this farm
    const contracts = await storage.getActiveContracts();
    const contract = contracts.find((c: any) => c.fillType === data.fillType && c.claimedByFarmId === String(data.farmId));
    let contractLine = '';
    if (contract) {
      const delivered = contract.deliveredAmount || 0;
      const required = contract.requiredAmount || 1;
      const pct = Math.min(100, Math.round(delivered / required * 100));
      const completionRatio = Math.min(1, delivered / required);
      const effectiveBonusPct = +(contract.bonusPercent * completionRatio).toFixed(1);
      const potentialBonus = +(data.totalEarned * effectiveBonusPct / 100).toFixed(0);
      contractLine = `\n📦 **Ugovor:** ${delivered.toLocaleString('hr-HR')}/${required.toLocaleString('hr-HR')}L (${pct}%)` +
        `\n📊 Trenutni bonus: **+${effectiveBonusPct}%** od max +${contract.bonusPercent}%` +
        (pct < 100 ? `\n💡 *Ispuni do ${required.toLocaleString('hr-HR')}L za puni bonus +${contract.bonusPercent}%*` : '');
    }

    const name = COOP_FILL_NAMES[data.fillType] || data.fillType;
    const per1k = (data.pricePerUnit * 1000).toFixed(0);
    const bonusLine = data.contractBonusEarned && data.contractBonusEarned > 0
      ? `\n🎁 Bonus ugovora: **+$${data.contractBonusEarned.toLocaleString('hr-HR')}**`
      : '';
    const overflowLine = data.overflowAmount && data.overflowAmount > 0
      ? `\n↩️ Višak vraćen u storage: **${data.overflowAmount.toLocaleString('hr-HR')}L**`
      : '';
    const payoutLine = contract ? `\n⏳ Isplata ide tek po završetku ili isteku ugovora.` : '';

    const embed = new EmbedBuilder()
      .setColor(data.contractBonusEarned ? 0xffd700 : 0x3498db)
      .setDescription(
        `🏪 Farma **"${farmName}"** prodala **${data.amount.toLocaleString('hr-HR')}L** ${emoji} ${name}\n` +
        `💰 Cijena: **$${per1k}/t** — Osnovica: **$${data.totalEarned.toLocaleString('hr-HR')}**` +
        bonusLine +
        overflowLine +
        contractLine +
        payoutLine
      )
      .setTimestamp();

    await (ch as any).send({ embeds: [embed] }).catch(() => {});
  }

  /** Contract completed notification */
  private async sendCoopContractCompletedNotification(contract: any, totalEarned: number, bonusEarned: number, overflowAmount?: number): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const ch = await getGuildChannel(guild, 'farm-obavijesti') || await getGuildChannel(guild, 'opcenito');
    if (!ch) return;

    // Get delivery stats — exclusive contract (single farm)
    const deliveries = await storage.getRecentDeliveries(500);
    const contractDeliveries = deliveries.filter((d: any) => d.contractId === String(contract._id));
    const totalDelivered = contractDeliveries.reduce((s: number, d: any) => s + (d.amount || 0), 0);
    const farms = await storage.getFarms();
    const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;
    const claimFarm = farms.find(f => String(f.farmId) === String(contract.claimedByFarmId));
    const farmName = claimFarm?.name || `Farma ${contract.claimedByFarmId || '?'}`;
    const overflowLine = overflowAmount && overflowAmount > 0
      ? `\n↩️ Višak vraćen u storage: **${overflowAmount.toLocaleString('hr-HR')}L**`
      : '';

    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('🎉 UGOVOR ISPUNJEN — ISPLATA!')
      .setDescription(
        `${this.getFillTypeEmoji(contract.fillType)} **${cName}** — ${contract.requiredAmount?.toLocaleString('hr-HR')}L\n` +
        `🏘️ Farma: **${farmName}**\n` +
        `💰 Bonus: **+${contract.bonusPercent}%** ($${bonusEarned.toLocaleString('hr-HR')})\n\n` +
        `📊 **Rezultat:**\n` +
        `• Isporučeno: **${totalDelivered.toLocaleString('hr-HR')}L**\n` +
        `• Osnovica: **$${totalEarned.toLocaleString('hr-HR')}**\n` +
        `• Bonus: **$${bonusEarned.toLocaleString('hr-HR')}**\n\n` +
        `💵 **UKUPNO:** $${(totalEarned + bonusEarned).toLocaleString('hr-HR')}\n` +
        `✅ Cijeli iznos poslan u igru po završetku ugovora!` +
        overflowLine
      )
      .setTimestamp();

    await (ch as any).send({ embeds: [embed] }).catch(() => {});
  }

  /** Contract expired with partial completion — proportional bonus notification */
  private async sendCoopContractExpiredNotification(contract: any, effectiveBonus: number, completionPct: number): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const ch = await getGuildChannel(guild, 'farm-obavijesti') || await getGuildChannel(guild, 'opcenito');
    if (!ch) return;

    const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;
    const deliveredAmt = contract.deliveredAmount || 0;
    const pctStr = Math.round(completionPct * 100);

    // Get delivery stats — exclusive contract (single farm)
    const deliveries = await storage.getRecentDeliveries(500);
    const contractDeliveries = deliveries.filter((d: any) => d.contractId === String(contract._id));
    const totalEarned = contractDeliveries.reduce((s: number, d: any) => s + (d.totalEarned || 0), 0);
    const totalBonus = +(totalEarned * effectiveBonus / 100).toFixed(0);

    const farms = await storage.getFarms();
    const claimFarm = farms.find(f => String(f.farmId) === String(contract.claimedByFarmId));
    const farmName = claimFarm?.name || `Farma ${contract.claimedByFarmId || '?'}`;

    const desc =
      `${this.getFillTypeEmoji(contract.fillType)} **${cName}** — ${deliveredAmt.toLocaleString('hr-HR')}/${contract.requiredAmount?.toLocaleString('hr-HR')}L (${pctStr}%)\n` +
      `🏘️ Farma: **${farmName}**\n` +
      `💰 Proporcionalni bonus: **+${effectiveBonus.toFixed(1)}%** (od max +${contract.bonusPercent}%)\n\n` +
      `📊 **Rezultat:**\n` +
      `• Zarada: **$${totalEarned.toLocaleString('hr-HR')}**\n` +
      `• Bonus: **$${totalBonus.toLocaleString('hr-HR')}**\n\n` +
      `💵 **UKUPNO:** $${(totalEarned + totalBonus).toLocaleString('hr-HR')}\n` +
      `✅ Zarada isplaćena po isporukama.` + (totalBonus > 0 ? ` 💸 Bonus poslan u igru!` : '');

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('⏰ UGOVOR ISTEKAO — Djelomična isplata')
      .setDescription(desc)
      .setTimestamp();

    await (ch as any).send({ embeds: [embed] }).catch(() => {});
  }

  /** New contracts notification */
  private async sendCoopNewContractsNotification(): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const ch = await getGuildChannel(guild, 'market');
    if (!ch) return;

    const contracts = await storage.getActiveContracts();
    if (!contracts.length) return;

    const market = await storage.getCoopMarket();

    const lines = contracts.map((c: any, i: number) => {
      const expiresH = c.expiresAt ? Math.max(0, Math.ceil((new Date(c.expiresAt).getTime() - Date.now()) / 3600000)) : 24;
      const cName = COOP_FILL_NAMES[c.fillType] || c.fillType;
      const tier = c.bonusPercent >= 35 ? '🔴' : c.bonusPercent >= 25 ? '🟡' : '🟢';
      const marketItem = market.find((m: any) => m.fillType === c.fillType);
      const basePrice = marketItem ? this.calcActualPrice(marketItem.currentPrice, marketItem.supplyLevel || 0) : 0;
      const fullEarnings = +(basePrice * c.requiredAmount).toFixed(0);
      const bonusAmount = +(fullEarnings * c.bonusPercent / 100).toFixed(0);
      const totalWithBonus = fullEarnings + bonusAmount;
      const earningsLine = basePrice > 0 ? `\n   💵 Puna isporuka: **$${fullEarnings.toLocaleString('hr-HR')}** + bonus **$${bonusAmount.toLocaleString('hr-HR')}** = **$${totalWithBonus.toLocaleString('hr-HR')}**` : '';
      return `${i + 1}. ${this.getFillTypeEmoji(c.fillType)} **${c.requiredAmount?.toLocaleString('hr-HR')}L ${cName}** — ${tier} Bonus: **+${c.bonusPercent}%** — Rok: ${expiresH}h${earningsLine}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('📋 Novi Coop Ugovori!')
      .setDescription(
        `Dostupno je **${contracts.length} ugovora** — svaka farma može imati **max 2** aktivna:\n\n` +
        `${lines.join('\n\n')}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 **KAKO FUNKCIONIRA:**\n` +
        `1️⃣ Odaberite ugovor iz padajućeg izbornika ispod ⬇️\n` +
        `2️⃣ Ugovor se **zaključava** za vašu farmu (nitko drugi ga ne može uzeti!)\n` +
        `3️⃣ Dovezite robu u Coop Silo — višestruke isporuke su dozvoljene\n` +
        `4️⃣ Bonus se isplaćuje **proporcionalno** isporučenom\n\n` +
        `⏳ Rok za izvršenje: **48h** — upozorenja kad se bliži kraju!\n` +
        `🔒 Svaka farma može imati max **2 ugovora** istovremeno\n\n` +
        `🟢 Mali | 🟡 Srednji | 🔴 Veliki`
      )
      .setTimestamp();

    // Build dropdown — only unclaimed contracts
    const unclaimedContracts = contracts.filter((c: any) => !c.claimedByFarmId);
    const components: any[] = [];
    if (unclaimedContracts.length) {
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('coop_contract_select')
        .setPlaceholder('📦 Odaberi ugovor za svoju farmu...')
        .addOptions(unclaimedContracts.map((c: any, i: number) => {
          const cName = COOP_FILL_NAMES[c.fillType] || c.fillType;
          const tier = c.bonusPercent >= 35 ? '🔴 Veliki' : c.bonusPercent >= 25 ? '🟡 Srednji' : '🟢 Mali';
          return {
            label: `${c.requiredAmount?.toLocaleString('hr-HR')}L ${cName}`,
            value: String(c._id),
            description: `${tier} — Bonus: +${c.bonusPercent}%`,
            emoji: this.getFillTypeEmoji(c.fillType),
          };
        }));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
    }

    await (ch as any).send({ embeds: [embed], components }).catch(() => {});
  }

  /** Helper: emoji for fill type */
  private getFillTypeEmoji(fillType: string): string {
    const map: Record<string, string> = {
      WHEAT: '🌾', BARLEY: '🌾', OAT: '🌾', CANOLA: '🌻', CORN: '🌽',
      SOYBEAN: '🫘', SUNFLOWER: '🌻', SUGARBEET: '🥬', POTATO: '🥔',
      COTTON: '🧶', GRASS_WINDROW: '🌿', STRAW: '🟡', SILAGE: '🟢',
      CHAFF: '🟤', WOOD: '🪵', WOODCHIPS: '🪵', LIME: '⚪',
      FERTILIZER: '💊', SEEDS: '🌱', LIQUIDFERTILIZER: '💧',
      HERBICIDE: '🧪', DIESEL: '⛽', WATER: '💧', MILK: '🥛',
      WOOL: '🐑', EGG: '🥚', HONEY: '🍯', GRAPE: '🍇',
      OLIVE: '🫒', RICE: '🍚', SORGHUM: '🌾', POPLAR: '🌳',
    };
    return map[fillType?.toUpperCase()] || '📦';
  }

  /** Helper: visual progress bar */
  private buildProgressBar(pct: number): string {
    const filled = Math.round(pct / 10);
    const empty = 10 - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty);
  }

  /** Helper: create a contract tracking channel under the farm category */
  private async createContractChannel(guild: any, contract: any, farmId: string): Promise<any> {
    const farms = await storage.getFarms();
    const farm = farms.find(f => String(f.farmId) === String(farmId));
    const farmName = farm?.name || `Farma ${farmId}`;
    const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;
    const contractId = String(contract._id);

    const channelName = `📦┃${cName.toLowerCase().replace(/[^a-zA-Zščćžđ0-9]/g, '-').replace(/-+/g, '-')}-f${farmId}`;

    // Check if already exists
    const existing = guild.channels.cache.find((c: any) => c.type === 0 && c.name === channelName);
    if (existing) return existing;

    // Find farm category (robust fallback)
    const farmCat = findFarmCategory(guild, farmName);
    if (!farmCat) return null;

    // Permissions
    const farmRole = guild.roles.cache.find((r: any) => r.name === `🌾 ${farmName}`);
    const botMember = guild.members.me;
    const permOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (farmRole) permOverwrites.push({ id: farmRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    if (botMember) permOverwrites.push({ id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] });
    const staffRoleNames = ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'];
    for (const srName of staffRoleNames) {
      const sr = guild.roles.cache.find((r: any) => r.name === srName);
      if (sr) permOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
    }

    const contractChannel = await guild.channels.create({
      name: channelName,
      type: 0,
      parent: farmCat.id,
      permissionOverwrites: permOverwrites.filter((p: any) => p.id),
      reason: `Coop Ugovor — ${cName} za ${farmName}`,
    });

    // Build tracking embed with current progress
    const delivered = contract.deliveredAmount || 0;
    const required = contract.requiredAmount || 1;
    const pct = Math.min(100, Math.round(delivered / required * 100));
    const expiresH = contract.expiresAt ? Math.max(0, Math.ceil((new Date(contract.expiresAt).getTime() - Date.now()) / 3600000)) : 48;
    const tier = contract.bonusPercent >= 35 ? '🔴 VELIKI' : contract.bonusPercent >= 25 ? '🟡 SREDNJI' : '🟢 MALI';

    const market = await storage.getCoopMarket();
    const marketItem = market.find((m: any) => m.fillType === contract.fillType);
    const basePrice = marketItem ? this.calcActualPrice(marketItem.currentPrice, marketItem.supplyLevel || 0) : 0;
    const fullEarnings = +(basePrice * required).toFixed(0);
    const bonusAmount = +(fullEarnings * contract.bonusPercent / 100).toFixed(0);
    const totalWithBonus = fullEarnings + bonusAmount;

    const trackingEmbed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(`📦 Ugovor: ${this.getFillTypeEmoji(contract.fillType)} ${cName}`)
      .setDescription(
        `**${farmName}** — Coop ugovor u tijeku\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 **Detalji ugovora:**\n` +
        `${this.getFillTypeEmoji(contract.fillType)} Materijal: **${cName}**\n` +
        `📦 Potrebno: **${required.toLocaleString('hr-HR')}L**\n` +
        `🏷️ Tip: **${tier}**\n` +
        `💰 Bonus: **+${contract.bonusPercent}%**\n` +
        `⏳ Rok: **${expiresH}h**\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💵 **Očekivana zarada (puna isporuka):**\n` +
        `Osnovna zarada: **$${fullEarnings.toLocaleString('hr-HR')}**\n` +
        `Bonus (+${contract.bonusPercent}%): **$${bonusAmount.toLocaleString('hr-HR')}**\n` +
        `Ukupno: **$${totalWithBonus.toLocaleString('hr-HR')}**\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 **Napredak:**\n` +
        `${this.buildProgressBar(pct)} **${pct}%**\n` +
        `Isporučeno: **${delivered.toLocaleString('hr-HR')}/${required.toLocaleString('hr-HR')}L**\n\n` +
        `💡 *Dovezite robu u Coop Silo. Bonus je proporcionalan isporuci!*`
      )
      .setFooter({ text: `Ugovor ID: ${contractId} • Farma ${farmId}` })
      .setTimestamp();

    const refreshBtn = new ButtonBuilder()
      .setCustomId(`coop_contract_refresh:${contractId}:${farmId}:${contractChannel.id}`)
      .setLabel('🔄 Osvježi stanje')
      .setStyle(ButtonStyle.Secondary);
    const finishBtn = new ButtonBuilder()
      .setCustomId(`coop_contract_finish:${contractId}:${farmId}:${contractChannel.id}`)
      .setLabel('✅ Završi ugovor')
      .setStyle(ButtonStyle.Success);
    const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(refreshBtn, finishBtn);

    await contractChannel.send({ embeds: [trackingEmbed], components: [btnRow] });
    return contractChannel;
  }

  /** Auto-update existing contract channel embed after a delivery */
  private async autoUpdateContractChannel(contract: any, farmId: string): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;
    const channelName = `📦┃${cName.toLowerCase().replace(/[^a-zA-Zščćžđ0-9]/g, '-').replace(/-+/g, '-')}-f${farmId}`;
    const contractChannel = guild.channels.cache.find((ch: any) => ch.type === 0 && ch.name === channelName);
    if (!contractChannel) return;

    const contractId = String(contract._id);
    const farms = await storage.getFarms();
    const farm = farms.find(f => String(f.farmId) === String(farmId));
    const farmName = farm?.name || `Farma ${farmId}`;

    // Re-fetch contract for latest deliveredAmount
    const fresh = (await storage.getActiveContracts()).find((c: any) => String(c._id) === contractId);
    if (!fresh) return;

    const delivered = fresh.deliveredAmount || 0;
    const required = fresh.requiredAmount || 1;
    const pct = Math.min(100, Math.round(delivered / required * 100));
    const expiresH = fresh.expiresAt ? Math.max(0, Math.ceil((new Date(fresh.expiresAt).getTime() - Date.now()) / 3600000)) : 0;

    // Get farm-specific stats
    const deliveries = await storage.getRecentDeliveries(500);
    const farmDeliveries = deliveries.filter((d: any) => d.contractId === contractId && String(d.farmId) === String(farmId));
    const farmDelivered = farmDeliveries.reduce((s: number, d: any) => s + (d.amount || 0), 0);
    const farmEarned = farmDeliveries.reduce((s: number, d: any) => s + (d.totalEarned || 0), 0);
    const completionRatio = Math.min(1, delivered / required);
    const effectiveBonusPct = +(fresh.bonusPercent * completionRatio).toFixed(1);
    const farmBonusEstimate = +(farmEarned * effectiveBonusPct / 100).toFixed(0);

    const progressBar = this.buildProgressBar(pct);
    const updatedEmbed = new EmbedBuilder()
      .setColor(pct >= 100 ? 0x2ecc71 : 0xe67e22)
      .setTitle(`📦 Ugovor: ${this.getFillTypeEmoji(fresh.fillType)} ${cName}`)
      .setDescription(
        `**${farmName}** — Coop ugovor\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 **Napredak ugovora:**\n` +
        `${progressBar} **${pct}%**\n` +
        `Ukupno: **${delivered.toLocaleString('hr-HR')}/${required.toLocaleString('hr-HR')}L**\n` +
        `Status: **⏳ Još ${expiresH}h**\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🏘️ **Tvoja farma (${farmName}):**\n` +
        `Isporučeno: **${farmDelivered.toLocaleString('hr-HR')}L**\n` +
        `Zarađeno: **$${farmEarned.toLocaleString('hr-HR')}**\n` +
        `Procjena bonusa: **~$${farmBonusEstimate.toLocaleString('hr-HR')}** (+${effectiveBonusPct}%)\n\n` +
        `💡 *Dovezite robu u Coop Silo. Bonus je proporcionalan isporuci!*`
      )
      .setFooter({ text: `Ugovor ID: ${contractId} • Farma ${farmId} • Ažurirano` })
      .setTimestamp();

    // Find the tracking message (first bot message with embed) and edit it
    try {
      const messages = await (contractChannel as any).messages.fetch({ limit: 10 });
      const botMsg = messages.find((m: any) => m.author.id === this.client.user?.id && m.embeds.length > 0 && m.components.length > 0);
      if (botMsg) {
        await botMsg.edit({ embeds: [updatedEmbed] });
      }
    } catch {}
  }

  /** Delete contract channel by finding it from contract data */
  private async deleteContractChannel(contract: any, farmId: string): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const cName = COOP_FILL_NAMES[contract.fillType] || contract.fillType;
    const channelName = `📦┃${cName.toLowerCase().replace(/[^a-zA-Zščćžđ0-9]/g, '-').replace(/-+/g, '-')}-f${farmId}`;
    const channel = guild.channels.cache.find((ch: any) => ch.type === 0 && ch.name === channelName);
    if (channel) {
      try {
        const doneEmbed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('✅ Ugovor ispunjen!')
          .setDescription('Kanal se zatvara za 5 sekundi...')
          .setTimestamp();
        await (channel as any).send({ embeds: [doneEmbed] }).catch(() => {});
        setTimeout(async () => {
          try { await channel.delete('Coop ugovor završen'); } catch {}
        }, 5000);
      } catch {}
    }
  }

  private getFeatureFlagsFilePath(): string {
    return path.join(process.cwd(), 'src', 'storage', 'backups', 'panel-feature-flags.json');
  }

  private isMissingPanelChannelError(error: any): boolean {
    const code = String((error as any)?.code || '');
    if (code === 'PANEL_CHANNEL_MISSING') return true;
    const message = String((error as any)?.message || '').toLowerCase();
    return message.includes('kanal nije pronaden') || message.includes('nije tekstualni kanal');
  }

  private async forceRefreshAllPanels(): Promise<{ refreshed: number; skipped: number; failed: number }> {
    const panels = await storage.getDeployedPanels();
    const targets = panels.filter((p: any) => {
      const t = String(p?.panelType || '').toLowerCase();
      return t !== 'admin' && t !== 'log_channel' && t !== 'log_sequence';
    });

    let refreshed = 0;
    let skipped = 0;
    let failed = 0;

    for (const panel of targets) {
      try {
        const result = await this.sendOrRefreshPanel(
          String(panel.channelId || ''),
          String(panel.panelType || ''),
          panel.farmId == null ? null : String(panel.farmId),
          panel
        );
        if (result?.refreshed) refreshed += 1;
        else skipped += 1;
      } catch (e) {
        if (this.isMissingPanelChannelError(e) && panel?.id != null) {
          try {
            await storage.deleteDeployedPanel(Number(panel.id));
            skipped += 1;
            console.warn(`Removed stale panel deployment ${panel.id} (${panel.panelType} in ${panel.channelId})`);
          } catch (cleanupError) {
            failed += 1;
            console.error(`Failed to cleanup stale deployment ${panel?.id}:`, cleanupError);
          }
        } else {
          failed += 1;
          console.error(`Force refresh failed for ${panel.panelType} in ${panel.channelId}:`, e);
        }
      }
    }

    return { refreshed, skipped, failed };
  }

  private normalizeFeatureFarmKey(farmId?: string | null): string {
    const key = String(farmId ?? 'all').trim();
    if (!key || key.toLowerCase() === 'null') return 'all';
    return key;
  }

  private getDefaultFeatureFlags(): PanelFeatureFlags {
    return {
      vehiclesAlerts: true,
      fieldsTaskHints: true
    };
  }

  private normalizeFeatureFlags(raw: any): Partial<PanelFeatureFlags> {
    const out: Partial<PanelFeatureFlags> = {};
    if (typeof raw?.vehiclesAlerts === 'boolean') out.vehiclesAlerts = raw.vehiclesAlerts;
    if (typeof raw?.fieldsTaskHints === 'boolean') out.fieldsTaskHints = raw.fieldsTaskHints;
    return out;
  }

  private async readFeatureFlagsStore(): Promise<{ updatedAt?: string; byFarm: Record<string, Partial<PanelFeatureFlags>> }> {
    const file = this.getFeatureFlagsFilePath();
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      const byFarmRaw = parsed?.byFarm && typeof parsed.byFarm === 'object' ? parsed.byFarm : {};
      const byFarm: Record<string, Partial<PanelFeatureFlags>> = {};

      for (const [k, v] of Object.entries(byFarmRaw)) {
        byFarm[this.normalizeFeatureFarmKey(k)] = this.normalizeFeatureFlags(v);
      }

      return {
        updatedAt: parsed?.updatedAt ? String(parsed.updatedAt) : undefined,
        byFarm
      };
    } catch {
      return { byFarm: {} };
    }
  }

  private async writeFeatureFlagsStore(store: { byFarm: Record<string, Partial<PanelFeatureFlags>> }): Promise<void> {
    const file = this.getFeatureFlagsFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      updatedAt: new Date().toISOString(),
      byFarm: store.byFarm || {}
    }, null, 2), 'utf8');
  }

  private async getFarmFeatureFlags(farmId?: string | null): Promise<PanelFeatureFlags> {
    const defaults = this.getDefaultFeatureFlags();
    const store = await this.readFeatureFlagsStore();
    const all = this.normalizeFeatureFlags(store.byFarm?.all || {});
    const farmKey = this.normalizeFeatureFarmKey(farmId);
    const perFarm = this.normalizeFeatureFlags(store.byFarm?.[farmKey] || {});
    return {
      vehiclesAlerts: perFarm.vehiclesAlerts ?? all.vehiclesAlerts ?? defaults.vehiclesAlerts,
      fieldsTaskHints: perFarm.fieldsTaskHints ?? all.fieldsTaskHints ?? defaults.fieldsTaskHints,
    };
  }

  private async setFarmFeatureFlags(farmId: string | null, next: Partial<PanelFeatureFlags>): Promise<PanelFeatureFlags> {
    const store = await this.readFeatureFlagsStore();
    const key = this.normalizeFeatureFarmKey(farmId);
    const merged = {
      ...this.normalizeFeatureFlags(store.byFarm?.[key] || {}),
      ...this.normalizeFeatureFlags(next)
    };

    store.byFarm[key] = merged;
    await this.writeFeatureFlagsStore(store);
    return this.getFarmFeatureFlags(farmId);
  }

  private async buildFeatureFlagsFarmSelectRow(): Promise<ActionRowBuilder<StringSelectMenuBuilder>> {
    const farms = (await storage.getFarms()).filter((f: any) => !String(f.farmId || '').startsWith('U:'));
    const options = [
      { label: 'Sve mape (global)', value: 'all', description: 'Default za sve farme' },
      ...farms.slice(0, 24).map((farm: any) => ({
        label: String(farm.name || `Farma ${farm.farmId}`).slice(0, 100),
        value: String(farm.farmId),
        description: `Map/Farma ID: ${String(farm.farmId)}`.slice(0, 100)
      }))
    ];

    return new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('admin_features_farm_select')
          .setPlaceholder('Odaberi mapu/farmu...')
          .addOptions(options)
      );
  }

  private buildFeatureFlagsToggleRow(farmKey: string, flags: PanelFeatureFlags): ActionRowBuilder<StringSelectMenuBuilder> {
    return new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`admin_features_toggle:${farmKey}`)
          .setPlaceholder('Označeno = uključeno')
          .setMinValues(0)
          .setMaxValues(2)
          .addOptions(
            {
              label: 'Vozila Smart Alerti',
              value: 'vehiclesAlerts',
              description: 'Gorivo/šteta/spremnici upozorenja',
              default: !!flags.vehiclesAlerts
            },
            {
              label: 'Polja Task Prioriteti',
              value: 'fieldsTaskHints',
              description: 'Prioritet + akcije po polju',
              default: !!flags.fieldsTaskHints
            }
          )
      );
  }

  private getPanelsBackupFilePath(): string {
    return path.join(process.cwd(), 'src', 'storage', 'backups', 'deployed-panels-backup.json');
  }

  private async backupDeployedPanels(): Promise<{ count: number; file: string }> {
    const panels = await storage.getDeployedPanels();
    const filtered = panels.filter((p: any) => String(p.panelType || '').toLowerCase() !== 'admin');

    const file = this.getPanelsBackupFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      createdAt: new Date().toISOString(),
      panels: filtered.map((p: any) => ({
        channelId: String(p.channelId || ''),
        panelType: String(p.panelType || ''),
        farmId: p.farmId == null ? null : String(p.farmId)
      }))
    }, null, 2), 'utf8');

    await storage.log({ type: 'info', message: `Deploy backup saved (${filtered.length}) -> ${file}` });
    return { count: filtered.length, file };
  }

  private async restoreDeployedPanelsFromBackup(): Promise<{ restored: number; skipped: number; failed: number }> {
    const file = this.getPanelsBackupFilePath();
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw || '{}');
    const panels = Array.isArray(data?.panels) ? data.panels : [];

    const unique = new Map<string, { channelId: string; panelType: string; farmId: string | null }>();
    for (const p of panels) {
      const channelId = String(p?.channelId || '').trim();
      const panelType = String(p?.panelType || '').trim();
      const farmId = p?.farmId == null || String(p.farmId).trim() === '' ? null : String(p.farmId);
      if (!channelId || !panelType) continue;
      if (panelType.toLowerCase() === 'admin') continue;
      const key = `${channelId}|${panelType}|${farmId || 'all'}`;
      if (!unique.has(key)) unique.set(key, { channelId, panelType, farmId });
    }

    let restored = 0;
    let skipped = 0;
    let failed = 0;

    for (const p of unique.values()) {
      try {
        const existing = await storage.getDeployedPanel(p.channelId, p.panelType, p.farmId);
        await this.sendOrRefreshPanel(p.channelId, p.panelType, p.farmId, existing);
        restored += 1;
      } catch (e: any) {
        failed += 1;
        console.error(`Restore panel failed [${p.panelType}] [${p.channelId}] [${p.farmId || 'all'}]:`, e);
      }
    }

    if (unique.size === 0) skipped = 1;
    await storage.log({ type: 'info', message: `Deploy restore: restored=${restored} failed=${failed} total=${unique.size}` });
    return { restored, skipped, failed };
  }

  private async hardRefreshAllVehiclePanels(): Promise<{ refreshed: number; missing: number; failed: number }> {
    const deployed = await storage.getDeployedPanels();
    const vehiclePanels = deployed.filter((p: any) => String(p.panelType || '').toLowerCase() === 'vehicles');

    let refreshed = 0;
    let missing = 0;
    let failed = 0;

    for (const panel of vehiclePanels) {
      try {
        const channelId = String(panel.channelId || '');
        const messageId = String(panel.messageId || '');
        const farm = panel.farmId ? String(panel.farmId) : null;
        if (!channelId || !messageId) {
          failed += 1;
          continue;
        }

        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !this.isSendableChannel(channel)) {
          missing += 1;
          continue;
        }

        const textChannel = channel as TextChannel;
        const message = await textChannel.messages.fetch(messageId).catch(() => null);
        if (!message) {
          missing += 1;
          continue;
        }

        const key = this.getListPageKey(messageId, 'vehicles', farm);
        this.listPageByMessageAndPanel.set(key, this.listPageByMessageAndPanel.get(key) || 0);

        const embed = await this.buildPanelEmbed('vehicles', farm, { messageId });
        const components = await this.buildListPanelComponents('vehicles', farm, messageId);
        await message.edit({ embeds: [embed], components });
        refreshed += 1;
      } catch (e) {
        console.error('hardRefreshAllVehiclePanels item error:', e);
        failed += 1;
      }
    }

    await storage.log({ type: 'info', message: `Vehicles hard refresh: refreshed=${refreshed}, missing=${missing}, failed=${failed}` });
    return { refreshed, missing, failed };
  }

  private async runSyncWithVehiclesRefresh(): Promise<void> {
    await syncService.sync();
    try {
      await this.hardRefreshAllVehiclePanels();
    } catch (e) {
      console.error('Auto vehicles hard refresh after sync failed:', e);
    }
  }

  private async maybeNotifyServerStatusChange() {
    try {
      const cfg = await this.getLogConfig();
      if (!cfg.channelId || !cfg.enabled) return;

      const ws = await getWebStatsSummaryFromEnv().catch(() => null);
      const online = ws?.summary?.isOnline;
      if (typeof online !== 'boolean') return;

      if (this.lastGameServerOnlineState === null) {
        this.lastGameServerOnlineState = online;
        return;
      }
      if (this.lastGameServerOnlineState === online) return;

      this.lastGameServerOnlineState = online;

      const ch = await this.client.channels.fetch(cfg.channelId).catch(() => null) as any;
      if (!ch || !('send' in ch)) return;

      const serverName = getActiveServer()?.name || process.env.SERVER_NAME || 'Slavonska Ravnica';
      const eventId = await this.nextPersistentLogEventId(cfg.channelId);
      const embed = new EmbedBuilder()
        .setDescription(online ? `✅ **${serverName} Online**` : `🛑 **${serverName} Offline**`)
        .setColor(online ? 0x22c55e : 0xef4444)
        .setFooter({ text: `Event #${String(eventId).padStart(4, '0')}` })
        .setTimestamp();

      await ch.send({ embeds: [embed] });
    } catch (e) {
      console.error('maybeNotifyServerStatusChange error:', e);
    }
  }

  private getTrackingImageUrl(kind: 'player' | 'equipment'): string | null {
    const direct = kind === 'player'
      ? (process.env.LOG_PLAYER_TRACKING_IMAGE_URL || process.env.PLAYER_TRACKING_IMAGE_URL)
      : (process.env.LOG_EQUIPMENT_TRACKING_IMAGE_URL || process.env.EQUIPMENT_TRACKING_IMAGE_URL);
    if (direct) return direct;
    // Use proxy endpoint to avoid mixed-content issues (HTTPS page → HTTP image)
    const mapUrl = process.env.WEBSTATS_MAP_IMAGE_URL || process.env.SERVER_MAP_IMAGE_URL
      || getActiveServer()?.mapImageUrl;
    return mapUrl ? '/api/game/map-image' : null;
  }

  private async maybeNotifyAfkWarnings() {
    try {
      const cfg = await this.getLogConfig();
      if (!cfg.channelId || !cfg.enabled) return;

      const warn1Min = Math.max(1, Number(process.env.AFK_WARN_1 || '15') || 15);
      const warn2Min = Math.max(warn1Min, Number(process.env.AFK_WARN_2 || String(Math.max(30, warn1Min * 2))) || Math.max(30, warn1Min * 2));
      const adminRoleId = process.env.ADMIN_ROLE_ID || '';
      const adminMention = adminRoleId ? `<@&${adminRoleId}>` : '@Admin';

      const tracks = this.playerTracks || [];
      if (!tracks.length) return;

      const runtimePlayers = [...this.runtimePlayerTimes.values()];
      const onlineById = new Map(runtimePlayers.filter((p: any) => !!p.currentlyOnline).map((p: any) => [String(p.uniqueUserId || p.id || ''), p]));
      const onlineByName = new Map(runtimePlayers.filter((p: any) => !!p.currentlyOnline).map((p: any) => [String(p.nickname || '').toLowerCase(), p]));

      const ch = await this.client.channels.fetch(cfg.channelId).catch(() => null) as any;
      if (!ch || !('send' in ch)) return;

      const links = await storage.getPlayerLinks().catch(() => [] as any[]);
      const discordByGameId = new Map((links || []).map((l: any) => [String(l.uniqueUserId || ''), String(l.discordUserId || '')]));

      const activeKeys = new Set<string>();
      const serverName = getActiveServer()?.name || process.env.SERVER_NAME || 'Slavonska Ravnica';

      for (const t of tracks) {
        const key = String(t.id || t.nickname || '').trim();
        if (!key) continue;

        const rt = onlineById.get(String(t.id || '')) || onlineByName.get(String(t.nickname || '').toLowerCase());
        if (!rt) {
          this.afkWarnLevelByPlayer.delete(key);
          continue;
        }

        activeKeys.add(key);
        const idleMin = Math.max(0, Math.round(Number(t.idleMs || 0) / 60000));
        const level = idleMin >= warn2Min ? 2 : idleMin >= warn1Min ? 1 : 0;
        const prev = this.afkWarnLevelByPlayer.get(key) || 0;

        if (level === 0) {
          this.afkWarnLevelByPlayer.set(key, 0);
          continue;
        }
        if (level <= prev) continue;

        const gameId = String(t.id || rt.uniqueUserId || rt.id || 'N/A');
        const discordId = discordByGameId.get(gameId);
        const discordTxt = discordId ? `<@${discordId}> (${discordId})` : 'nije linkan';
        const eventId = await this.nextPersistentLogEventId(cfg.channelId);

        const embed = new EmbedBuilder()
          .setTitle(level === 2 ? 'AFK Warning 2' : 'AFK Warning 1')
          .setDescription([
            `⏸️ **${t.nickname || t.id || 'Player'}** je AFK ${idleMin} min na ${serverName}`,
            `Prag: ${level === 2 ? warn2Min : warn1Min} min`,
            `Event #${String(eventId).padStart(4, '0')} • Game: ${gameId} • Discord: ${discordTxt}`,
            `Ping: ${adminMention}`
          ].join('\n'))
          .setColor(level === 2 ? 0xef4444 : 0xf59e0b)
          .setTimestamp();

        await ch.send({ embeds: [embed] });
        this.afkWarnLevelByPlayer.set(key, level);
      }

      for (const key of [...this.afkWarnLevelByPlayer.keys()]) {
        if (!activeKeys.has(key)) this.afkWarnLevelByPlayer.delete(key);
      }
    } catch (e) {
      console.error('maybeNotifyAfkWarnings error:', e);
    }
  }

  private getTrackWindowMs(win: '10m' | '30m' | '2h' | '12h' | 'all'): number | null {
    if (win === '10m') return 10 * 60 * 1000;
    if (win === '30m') return 30 * 60 * 1000;
    if (win === '2h') return 2 * 60 * 60 * 1000;
    if (win === '12h') return 12 * 60 * 60 * 1000;
    return null;
  }

  private defaultTrackWindowFromEnv(): '10m' | '30m' | '2h' | '12h' | 'all' {
    const mins = Number(process.env.TRACKING_DEFAULT_INTERVAL || '30') || 30;
    if (mins <= 10) return '10m';
    if (mins <= 30) return '30m';
    if (mins <= 120) return '2h';
    if (mins <= 720) return '12h';
    return 'all';
  }

  private buildLogTrackButtons(selected: '10m' | '30m' | '2h' | '12h' | 'all'): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('logtrack_10m').setLabel('10m').setStyle(ButtonStyle.Secondary).setDisabled(selected === '10m'),
      new ButtonBuilder().setCustomId('logtrack_30m').setLabel('30m').setStyle(ButtonStyle.Secondary).setDisabled(selected === '30m'),
      new ButtonBuilder().setCustomId('logtrack_2h').setLabel('2h').setStyle(ButtonStyle.Secondary).setDisabled(selected === '2h'),
      new ButtonBuilder().setCustomId('logtrack_12h').setLabel('12h').setStyle(ButtonStyle.Secondary).setDisabled(selected === '12h'),
      new ButtonBuilder().setCustomId('logtrack_all').setLabel('All').setStyle(ButtonStyle.Secondary).setDisabled(selected === 'all')
    );
  }

  private findTrackForPlayer(uniqueUserId: string, name: string) {
    const tracks = this.playerTracks || [];
    if (!tracks.length) return null;

    const normalize = (v: any) => String(v || '')
      .trim()
      .toLowerCase()
      .replace(/^@+/, '')
      .replace(/\s+/g, ' ');

    const uid = String(uniqueUserId || '').trim();
    const uidNorm = normalize(uid);
    const targetName = normalize(name);

    if (uid) {
      const byExactId = tracks.find(t => String(t.id || '').trim() === uid);
      if (byExactId) return byExactId;
    }

    if (uidNorm) {
      const byNormalizedId = tracks.find(t => normalize(t.id) === uidNorm);
      if (byNormalizedId) return byNormalizedId;
      const byNormalizedName = tracks.find(t => normalize(t.nickname) === uidNorm);
      if (byNormalizedName) return byNormalizedName;
    }

    if (targetName) {
      const byName = tracks.find(t => normalize(t.nickname) === targetName);
      if (byName) return byName;
      const byIdAsName = tracks.find(t => normalize(t.id) === targetName);
      if (byIdAsName) return byIdAsName;
      const fuzzy = tracks.find(t => normalize(t.nickname).includes(targetName) || targetName.includes(normalize(t.nickname)));
      if (fuzzy) return fuzzy;
    }

    return null;
  }

  private buildRouteSvg(points: Array<{ x: number; z: number; t: number }>, title: string): string {
    const width = 900;
    const height = 900;
    const pad = 36;

    const minWorldX = Number(process.env.MAP_WORLD_MIN_X || process.env.MAP_MIN_X || NaN);
    const maxWorldX = Number(process.env.MAP_WORLD_MAX_X || process.env.MAP_MAX_X || NaN);
    const minWorldZ = Number(process.env.MAP_WORLD_MIN_Z || process.env.MAP_MIN_Z || NaN);
    const maxWorldZ = Number(process.env.MAP_WORLD_MAX_Z || process.env.MAP_MAX_Z || NaN);

    const xs = points.map(p => Number(p.x));
    const zs = points.map(p => Number(p.z));
    const localMinX = Math.min(...xs);
    const localMaxX = Math.max(...xs);
    const localMinZ = Math.min(...zs);
    const localMaxZ = Math.max(...zs);

    const worldBoundsValid = Number.isFinite(minWorldX) && Number.isFinite(maxWorldX) && Number.isFinite(minWorldZ) && Number.isFinite(maxWorldZ)
      && maxWorldX > minWorldX && maxWorldZ > minWorldZ;

    const pointsInsideWorld = worldBoundsValid
      ? points.filter(p => {
          const x = Number(p.x);
          const z = Number(p.z);
          return x >= minWorldX && x <= maxWorldX && z >= minWorldZ && z <= maxWorldZ;
        }).length
      : 0;

    const useWorldBounds = worldBoundsValid
      && pointsInsideWorld >= Math.max(2, Math.ceil(points.length * 0.2));

    const minX = useWorldBounds ? minWorldX : (Number.isFinite(localMinX) ? localMinX : 0);
    const maxX = useWorldBounds ? maxWorldX : (Number.isFinite(localMaxX) ? localMaxX : 1);
    const minZ = useWorldBounds ? minWorldZ : (Number.isFinite(localMinZ) ? localMinZ : 0);
    const maxZ = useWorldBounds ? maxWorldZ : (Number.isFinite(localMaxZ) ? localMaxZ : 1);

    const mapUrl = this.getTrackingImageUrl('player');
    // MAP_IMAGE_ZOOM_PCT: percentage to zoom into map image (crops black borders). E.g., 15 = 15% zoom.
    const zoomPct = Math.max(0, Math.min(50, Number(process.env.MAP_IMAGE_ZOOM_PCT || '0') || 0));
    const zoomFrac = zoomPct / 100;
    const imgX = -zoomFrac / 2 * width;
    const imgY = -zoomFrac / 2 * height;
    const imgW = width * (1 + zoomFrac);
    const imgH = height * (1 + zoomFrac);
    const bgImage = mapUrl
      ? `<image href="${escapeXml(mapUrl)}" x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" preserveAspectRatio="none" opacity="0.95" clip-path="url(#mapClip)" />`
      : `<rect x="0" y="0" width="${width}" height="${height}" fill="#1f2937"/>`;

    const toPx = (x: number, z: number) => {
      const nxRaw = (x - minX) / Math.max(1e-6, (maxX - minX));
      const nzRaw = (z - minZ) / Math.max(1e-6, (maxZ - minZ));
      const nx = Math.max(0, Math.min(1, nxRaw));
      const nz = Math.max(0, Math.min(1, nzRaw));
      const px = pad + nx * (width - pad * 2);
      const py = pad + nz * (height - pad * 2);
      return { px, py };
    };

    const projected = points.map(p => ({ ...p, ...toPx(Number(p.x), Number(p.z)) }));
    const poly = projected.map(p => `${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(' ');

    // Yellow dots for each tracking point
    const dots = projected.map(p =>
      `<circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="4" fill="#facc15" opacity="0.9"/>`
    ).join('\n  ');

    const first = projected[0];
    const last = projected[projected.length - 1];

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <clipPath id="mapClip"><rect x="0" y="0" width="${width}" height="${height}"/></clipPath>
    <linearGradient id="routeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#22c55e"/>
      <stop offset="100%" stop-color="#ef4444"/>
    </linearGradient>
  </defs>
  ${bgImage}
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(0,0,0,0.08)"/>
  <polyline points="${poly}" fill="none" stroke="url(#routeGrad)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
  ${dots}
  <circle cx="${first?.px ?? 0}" cy="${first?.py ?? 0}" r="7" fill="#22c55e" stroke="#fff" stroke-width="2"/>
  <circle cx="${last?.px ?? 0}" cy="${last?.py ?? 0}" r="7" fill="#ef4444" stroke="#fff" stroke-width="2"/>
  <rect x="12" y="12" width="${width - 24}" height="48" rx="8" fill="rgba(0,0,0,0.50)"/>
  <text x="24" y="43" font-size="24" font-family="Segoe UI, Arial, sans-serif" fill="#ffffff">${escapeXml(title)}</text>
</svg>`;
  }

  private getServerInfoWindow(messageId?: string): '10m' | '30m' | '2h' | '12h' | 'all' {
    if (!messageId) return this.defaultTrackWindowFromEnv();
    return this.serverInfoWindowByMessage.get(messageId) || this.defaultTrackWindowFromEnv();
  }

  private getLatestPlayerTrack(): { id: string; name: string; points: Array<{ x: number; z: number; t: number }> } | null {
    let best: { id: string; name: string; points: Array<{ x: number; z: number; t: number }>; lastT: number } | null = null;

    for (const t of (this.playerTracks || [])) {
      const pts = (t.points || [])
        .map((p: any) => ({ x: Number(p?.x || 0), z: Number(p?.z || 0), t: Number(p?.t || 0) }))
        .filter((p: any) => Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.t) && p.t > 0)
        .sort((a: any, b: any) => a.t - b.t);

      if (!pts.length) continue;
      const lastT = pts[pts.length - 1].t;
      if (!best || lastT > best.lastT) {
        best = {
          id: String((t as any).id || ''),
          name: String((t as any).nickname || (t as any).id || 'Player'),
          points: pts,
          lastT
        };
      }
    }

    if (!best) return null;
    return { id: best.id, name: best.name, points: best.points };
  }

  private getServerInfoSelectedPlayer(messageId?: string): string {
    if (!messageId) return 'latest';
    return this.serverInfoPlayerByMessage.get(messageId) || 'latest';
  }

  private getTrackByPlayerId(playerId: string): { id: string; name: string; points: Array<{ x: number; z: number; t: number }> } | null {
    if (!playerId || playerId === 'latest') {
      return this.getLatestPlayerTrack();
    }

    for (const t of (this.playerTracks || [])) {
      const id = String((t as any).id || '');
      if (id !== playerId) continue;

      const pts = (t.points || [])
        .map((p: any) => ({ x: Number(p?.x || 0), z: Number(p?.z || 0), t: Number(p?.t || 0) }))
        .filter((p: any) => Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.t) && p.t > 0)
        .sort((a: any, b: any) => a.t - b.t);

      if (!pts.length) return null;
      return {
        id,
        name: String((t as any).nickname || id || 'Player'),
        points: pts
      };
    }

    return null;
  }

  private getServerInfoPlayerOptions(): Array<{ label: string; value: string; description?: string }> {
    const candidates = (this.playerTracks || [])
      .map((t: any) => {
        const pts = (t?.points || [])
          .map((p: any) => ({ t: Number(p?.t || 0) }))
          .filter((p: any) => Number.isFinite(p.t) && p.t > 0)
          .sort((a: any, b: any) => a.t - b.t);
        const lastT = pts.length ? pts[pts.length - 1].t : 0;
        return {
          id: String(t?.id || ''),
          name: String(t?.nickname || t?.id || 'Player'),
          pointsCount: pts.length,
          lastT
        };
      })
      .filter((t: any) => !!t.id && t.pointsCount > 0)
      .sort((a: any, b: any) => b.lastT - a.lastT)
      .slice(0, 24)
      .map((t: any) => ({
        label: t.name.slice(0, 100),
        value: t.id,
        description: (`Points: ${t.pointsCount}`).slice(0, 100)
      }));

    return [
      { label: 'Latest active player', value: 'latest', description: 'Automatski najnoviji movement' },
      ...candidates
    ];
  }

  private async buildServerInfoComponents(messageId: string): Promise<any[]> {
    const win = this.getServerInfoWindow(messageId);
    const selectedPlayer = this.getServerInfoSelectedPlayer(messageId);
    const options = this.getServerInfoPlayerOptions().map((opt) => ({
      ...opt,
      default: opt.value === selectedPlayer
    }));

    const rowButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('serverinfo_10m').setLabel('10m').setStyle(ButtonStyle.Secondary).setDisabled(win === '10m'),
      new ButtonBuilder().setCustomId('serverinfo_30m').setLabel('30m').setStyle(ButtonStyle.Secondary).setDisabled(win === '30m'),
      new ButtonBuilder().setCustomId('serverinfo_2h').setLabel('2h').setStyle(ButtonStyle.Secondary).setDisabled(win === '2h'),
      new ButtonBuilder().setCustomId('serverinfo_12h').setLabel('12h').setStyle(ButtonStyle.Secondary).setDisabled(win === '12h'),
      new ButtonBuilder().setCustomId('serverinfo_all').setLabel('All').setStyle(ButtonStyle.Secondary).setDisabled(win === 'all')
    );

    const rowActions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('serverinfo_refresh').setLabel('Refresh').setStyle(ButtonStyle.Primary)
    );

    const rowPlayers = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('serverinfo_player_select')
        .setPlaceholder('Odaberi igrača za mapu...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options)
    );

    return [rowButtons, rowActions, rowPlayers];
  }

  private async buildServerInfoPayload(messageId: string): Promise<{ embeds: EmbedBuilder[]; components: any[]; files?: AttachmentBuilder[] }> {
    const win = this.getServerInfoWindow(messageId);
    this.serverInfoWindowByMessage.set(messageId, win);
    const selectedPlayerId = this.getServerInfoSelectedPlayer(messageId);
    this.serverInfoPlayerByMessage.set(messageId, selectedPlayerId);

    const embed = await this.buildPanelEmbed('server_info', null, { messageId });
    const comps = await this.buildServerInfoComponents(messageId);

    let track = this.getTrackByPlayerId(selectedPlayerId);
    if (!track && selectedPlayerId !== 'latest') {
      track = this.getLatestPlayerTrack();
    }
    if (!track) {
      embed.addFields({ name: 'Latest Movement', value: `Nema track podataka (window: ${win}).`, inline: false });
      const mapUrl = this.getTrackingImageUrl('player');
      if (mapUrl) embed.setImage(mapUrl);
      this.debugEmbedBatch('buildServerInfoPayload', [embed], { panelType: 'server_info', messageId, window: win, routeSource: 'none' });
      return { embeds: [embed], components: comps, attachments: [] as any[] } as any;
    }

    const windowMs = this.getTrackWindowMs(win);
    // Track point timestamps are game-time (not epoch) — use relative cutoff from max timestamp
    const maxT = track.points.length ? Math.max(...track.points.map(p => p.t)) : 0;
    const cutoff = windowMs && maxT > 0 ? (maxT - windowMs) : 0;
    const filtered = windowMs ? track.points.filter(p => p.t >= cutoff) : track.points;
    const use = filtered.length >= 1 ? filtered : track.points.slice(-Math.min(250, track.points.length));

    if (use.length < 1) {
      embed.addFields({ name: 'Latest Movement', value: `${track.name} • window: ${win} • nedovoljno točaka.`, inline: false });
      const mapUrl = this.getTrackingImageUrl('player');
      if (mapUrl) embed.setImage(mapUrl);
      this.debugEmbedBatch('buildServerInfoPayload', [embed], { panelType: 'server_info', messageId, window: win, routeSource: 'insufficient-points' });
      return { embeds: [embed], components: comps, attachments: [] as any[] } as any;
    }

    const serverName = getActiveServer()?.name || process.env.SERVER_NAME || 'Slavonska Ravnica';
    const svg = this.buildRouteSvg(use, `${track.name} • ${serverName}`);
    const fileName = `server-info-route-${String(track.id || track.name || 'player').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'player'}.svg`;
    const attachment = new AttachmentBuilder(Buffer.from(svg, 'utf8'), { name: fileName });
    embed.setImage(`attachment://${fileName}`);
    embed.addFields({ name: 'Latest Movement', value: `${track.name} • window: ${win} • points: ${use.length}`, inline: false });

    this.debugEmbedBatch('buildServerInfoPayload', [embed], { panelType: 'server_info', messageId, window: win, routeSource: 'track-svg', points: use.length });

    return { embeds: [embed], components: comps, files: [attachment] };
  }

  private async buildPlayerExitTrackPayload(state: { uniqueUserId: string; name: string; farmId: string | null }, win: '10m' | '30m' | '2h' | '12h' | 'all') {
    const directTrack = this.findTrackForPlayer(state.uniqueUserId, state.name);
    const latestTrack = this.getLatestPlayerTrack();
    const track = directTrack || latestTrack;
    const usingFallbackTrack = !directTrack && !!latestTrack;
    const serverName = getActiveServer()?.name || process.env.SERVER_NAME || 'Slavonska Ravnica';
    const eventId = await this.nextPersistentLogEventId();
    const links = await storage.getPlayerLinks().catch(() => [] as any[]);
    const linkedDiscordId = (links || []).find((l: any) => String(l?.uniqueUserId || '').trim() === String(state.uniqueUserId || '').trim())?.discordUserId;
    const playerLabel = linkedDiscordId ? `<@${linkedDiscordId}>` : state.name;

    const rt = Array.from(this.runtimePlayerTimes.values()).find((p: any) =>
      String(p?.uniqueUserId || '').trim() === String(state.uniqueUserId || '').trim()
    ) || Array.from(this.runtimePlayerTimes.values()).find((p: any) =>
      String(p?.id || '').trim() === String(state.uniqueUserId || '').trim()
    );
    const sessionKey = String(state.uniqueUserId || '').trim();
    const sessionStart = sessionKey ? this.runtimeSessionStartedAtByPlayer.get(sessionKey) : undefined;
    const sessionMinutes = sessionStart ? Math.max(0, Math.round((Date.now() - sessionStart.getTime()) / 60000)) : null;
    // Never fall back to cumulative totalOnlineMs — it's total since server start, not per-session
    const activeMinFallback = sessionMinutes ?? 0;
    const idleMinFallback = 0;

    if (!track || !Array.isArray(track.points) || !track.points.length) {
      const fallback = new EmbedBuilder()
        .setTitle('Player Tracking')
        .setDescription([
          `**Player:** ${playerLabel}`,
          `**Server:** ${serverName}`,
          `**Uptime:** ${this.fmtMin(activeMinFallback + idleMinFallback)}`,
          `**Idle Time:** ${this.fmtMin(idleMinFallback)}`,
          `**PlayTime:** ${this.fmtMin(activeMinFallback)}`
        ].join('\n'))
        .setColor(0xf59e0b)
        .setFooter({ text: `Event #${String(eventId).padStart(4, '0')}` })
        .setTimestamp();

      const mapUrl = this.getTrackingImageUrl('player');
      if (mapUrl) fallback.setImage(mapUrl);
      this.debugEmbedBatch('buildPlayerExitTrackPayload', [fallback], {
        panelType: 'player_tracking_exit',
        playerId: state.uniqueUserId,
        playerName: state.name,
        routeSource: 'fallback-no-track',
        window: win,
      });
      return { embeds: [fallback], components: [this.buildLogTrackButtons(win)] };
    }

    const trackName = String((track as any)?.nickname || (track as any)?.name || state.name || 'Player');
    const trackActiveMs = Number((track as any)?.activeMs || 0);
    const trackIdleMs = Number((track as any)?.idleMs || 0);

    const sorted = [...track.points]
      .map(p => ({ x: Number((p as any).x || 0), z: Number((p as any).z || 0), t: Number((p as any).t || 0) }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.t) && p.t > 0)
      .sort((a, b) => a.t - b.t);

    const windowMs = this.getTrackWindowMs(win);
    // Track point timestamps are game-time (not epoch), so use relative cutoff from max timestamp
    const maxT = sorted.length ? sorted[sorted.length - 1].t : 0;
    const cutoff = windowMs && maxT > 0 ? (maxT - windowMs) : 0;
    const points = windowMs ? sorted.filter(p => p.t >= cutoff) : sorted;

    const use = points.length >= 2 ? points : sorted.slice(-Math.min(200, sorted.length));
    const rawActiveMin = Math.round(trackActiveMs / 60000);
    const rawIdleMin = Math.round(trackIdleMs / 60000);
    const rawUptimeMin = Math.max(0, rawActiveMin + rawIdleMin);

    const uptimeMin = sessionMinutes != null ? sessionMinutes : rawUptimeMin;
    const idleMin = sessionMinutes != null
      ? Math.min(rawIdleMin, uptimeMin)
      : rawIdleMin;
    const activeMin = Math.max(0, uptimeMin - idleMin);
    // Track point timestamps are game-time, not epoch — always use current real time for embeds
    const eventTimestamp = new Date();

    const routeTitleName = usingFallbackTrack ? `${state.name} (latest route)` : state.name;
    const mapUrl = this.getTrackingImageUrl('player');
    let attachment: AttachmentBuilder | null = null;
    let fileName: string | null = null;
    // Always generate SVG route overlay (uses map image as background if available)
    fileName = `route-${String(track.id || state.uniqueUserId || state.name || 'player').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'player'}.svg`;
    const svg = this.buildRouteSvg(use, `${routeTitleName} • ${serverName}`);
    attachment = new AttachmentBuilder(Buffer.from(svg, 'utf8'), { name: fileName });

    const routeSourceLine = usingFallbackTrack
      ? `**Route Source:** latest active track (${trackName})`
      : null;

    const embed = new EmbedBuilder()
      .setTitle('Player Tracking')
      .setDescription([
        `**Player:** ${playerLabel}`,
        `**Server:** ${serverName}`,
        `**Uptime:** ${this.fmtMin(uptimeMin)}`,
        `**Idle Time:** ${this.fmtMin(idleMin)}`,
        `**PlayTime:** ${this.fmtMin(activeMin)}`,
        routeSourceLine
      ].join('\n'))
      .setColor(0xf59e0b)
      .setFooter({ text: `Event #${String(eventId).padStart(4, '0')}` })
      .setTimestamp(eventTimestamp);

    embed.setImage(`attachment://${fileName}`);

    this.debugEmbedBatch('buildPlayerExitTrackPayload', [embed], {
      panelType: 'player_tracking_exit',
      playerId: state.uniqueUserId,
      playerName: state.name,
      routeSource: usingFallbackTrack ? 'fallback-latest-track' : 'direct-track',
      window: win,
      points: use.length,
    });
    return { embeds: [embed], components: [this.buildLogTrackButtons(win)], files: [attachment!] };
  }

  private async buildEquipmentTrackingForPlayer(state: { uniqueUserId: string; name: string; farmId: string | null }): Promise<EmbedBuilder | null> {
    const vehicles = Array.from(this.runtimeVehicleUsage.values());
    if (!vehicles.length) return null;

    const playerName = String(state.name || '').trim().toLowerCase();
    const mine = vehicles
      .map(v => {
        const players = Array.isArray(v.players) ? v.players : [];
        const mineStat = players.find((pl: any) => {
          const byId = String(pl?.id || '').trim() === String(state.uniqueUserId || '').trim();
          const byName = String(pl?.nickname || '').trim().toLowerCase() === playerName;
          return byId || byName;
        });
        if (!mineStat) return null;
        return {
          name: String(v.name || 'Unknown vehicle'),
          farmId: String(v.farmId || state.farmId || 'N/A'),
          totalMin: Math.round(Number(mineStat.totalMs || 0) / 60000),
          movingMin: Math.round(Number(mineStat.movingMs || 0) / 60000),
          idleMin: Math.round(Number(mineStat.idleMs || 0) / 60000),
        };
      })
      .filter(Boolean) as Array<{ name: string; farmId: string; totalMin: number; movingMin: number; idleMin: number }>;

    if (!mine.length) return null;

    const byFarm = new Map<string, Array<{ name: string; totalMin: number; movingMin: number; idleMin: number }>>();
    for (const item of mine) {
      if (!byFarm.has(item.farmId)) byFarm.set(item.farmId, []);
      byFarm.get(item.farmId)!.push({ name: item.name, totalMin: item.totalMin, movingMin: item.movingMin, idleMin: item.idleMin });
    }

    const farmIds = Array.from(byFarm.keys());

    const serverName = getActiveServer()?.name || process.env.SERVER_NAME || 'Slavonska Ravnica';
    const eventId = await this.nextPersistentLogEventId();
    const embed = new EmbedBuilder()
      .setTitle('Equipment Tracking')
      .setDescription([
        `**Server:** ${serverName}`,
        `**Farms:** ${farmIds.length}`,
        `**Vehicles:** ${mine.length}`
      ].join('\n'))
      .setColor(farmIds.length > 1 ? 0xa855f7 : 0xeab308)
      .setFooter({ text: `Event #${String(eventId).padStart(4, '0')}` })
      .setTimestamp();

    const equipmentMap = this.getTrackingImageUrl('equipment');
    if (equipmentMap) embed.setImage(equipmentMap);

    this.debugEmbed('buildEquipmentTrackingForPlayer', embed, {
      panelType: 'equipment_tracking',
      playerId: state.uniqueUserId,
      playerName: state.name,
      farms: farmIds.length,
      vehicles: mine.length,
    });

    return embed;
  }

  public async notifyPlayerPresence(payload: { joined: Array<{ uniqueUserId: string; name: string; farmId: string | null }>; left: Array<{ uniqueUserId: string; name: string; farmId: string | null }>; }) {
        // Dedup: prevent the same player join/leave from being announced twice within 10s
        const dedupCooldownMs = 30_000;
        const nowDedupMs = Date.now();
        payload.joined = payload.joined.filter(j => {
          const key = `join:${j.uniqueUserId}`;
          const lastAt = this.lastPresenceNotifyAt.get(key) || 0;
          if ((nowDedupMs - lastAt) < dedupCooldownMs) return false;
          this.lastPresenceNotifyAt.set(key, nowDedupMs);
          return true;
        });
        payload.left = payload.left.filter(l => {
          const key = `leave:${l.uniqueUserId}`;
          const lastAt = this.lastPresenceNotifyAt.get(key) || 0;
          if ((nowDedupMs - lastAt) < dedupCooldownMs) return false;
          this.lastPresenceNotifyAt.set(key, nowDedupMs);
          return true;
        });
        if (!payload.joined.length && !payload.left.length) return;

    try {
      const logCfg = await this.getLogConfig();
      if (!logCfg.channelId || !logCfg.enabled) return;

      const ch = await this.client.channels.fetch(logCfg.channelId).catch(() => null) as any;
      if (!ch || !('send' in ch)) return;

      const trackingCfg = await this.getTrackingLogConfig();
      const trackingChannelId = trackingCfg.channelId || logCfg.channelId;
      const trackingCh = trackingChannelId === logCfg.channelId
        ? ch
        : await this.client.channels.fetch(trackingChannelId).catch(() => null) as any;

      const serverName = getActiveServer()?.name || process.env.SERVER_NAME || 'Slavonska Ravnica';
      const links = await storage.getPlayerLinks().catch(() => [] as any[]);
      const linksByGameId = new Map((links || []).map((l: any) => [String(l.uniqueUserId || ''), l]));

      // Extra channel for join/leave notifications
      const extraPresenceChannelId = process.env.PRESENCE_EXTRA_CHANNEL_ID || '1239288670872272956';
      const extraCh = extraPresenceChannelId
        ? await this.client.channels.fetch(extraPresenceChannelId).catch(() => null) as any
        : null;

      const normalizeName = (v: any) => String(v || '')
        .trim()
        .toLowerCase()
        .replace(/^@+/, '')
        .replace(/\s+/g, ' ');

      const buildIdentity = async (gameId: string, playerName?: string) => {
        const link = linksByGameId.get(String(gameId || '')) as any;
        const discordId = link ? String(link.discordUserId || '') : '';
        const eventId = await this.nextPersistentLogEventId(logCfg.channelId || undefined);
        return {
          eventCode: `#${String(eventId).padStart(4, '0')}`,
          discordText: discordId ? `<@${discordId}> (${discordId})` : 'nije linkan'
        };
      };

      for (const l of payload.left) {
          if (l.name?.toLowerCase() === 'server') continue;
       try {
        const trackingEnabledRaw = String(process.env.TRACKING_ENABLED ?? 'true').trim().toLowerCase();
        const trackingEnabled = !['0', 'false', 'off', 'no'].includes(trackingEnabledRaw);
        const leaveTextEnabledRaw = String(process.env.TRACKING_LEAVE_TEXT_ENABLED ?? '').trim().toLowerCase();
        const leaveTextEnabled = ['1', 'true', 'on', 'yes'].includes(leaveTextEnabledRaw);
        const nowMs = Date.now();
        // Reduce cooldown to 2 seconds for faster offline detection
        const trackingCooldownSec = Math.max(0, Number(process.env.TRACKING_LEAVE_COOLDOWN_SEC || '2') || 2);
        const playerKey = String(l.uniqueUserId || l.name || '').trim();
        const lastAt = this.lastLeaveTrackingAtByPlayer.get(playerKey) || 0;
        const cooledDown = (nowMs - lastAt) >= (trackingCooldownSec * 1000);



        // Always send leave embed to main log channel
        {
          const idn = await buildIdentity(l.uniqueUserId, l.name);
          const embed = new EmbedBuilder()
            .setAuthor({ name: serverName })
            .setDescription(`👋 **${l.name}** je izašao **${serverName}**`)
            .setFields(
              { name: 'Game ID', value: l.uniqueUserId || 'N/A', inline: true },
              { name: 'Discord', value: idn.discordText, inline: true }
            )
            .setColor(0xef4444)
            .setFooter({ text: idn.eventCode })
            .setTimestamp();
          const webBase = process.env.WEB_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
          if (webBase) {
            const base = webBase.startsWith('http') ? webBase : `https://${webBase}`;
            embed.setImage(`${base}/api/game/tracks/map.svg?player=${encodeURIComponent(l.uniqueUserId || l.name || '')}&t=${Date.now()}`);
          }
          this.debugEmbed('notifyPlayerPresence', embed, {
            panelType: 'presence_leave',
            channelId: logCfg.channelId,
            trackingChannelId,
            playerId: l.uniqueUserId,
            playerName: l.name,
            flow: 'leave-main-log',
          });
          await ch.send({ embeds: [embed] });
          if (extraCh && ('send' in extraCh) && extraCh.id !== ch.id) {
            const extraEmbed = new EmbedBuilder()
              .setDescription(`👋 **${l.name}** je izašao **${serverName}**`)
              .setColor(0xef4444)
              .setTimestamp();
            await extraCh.send({ embeds: [extraEmbed] }).catch(() => {});
          }
        }

        // Send leave notification to farm-obavijesti channel
        {
          const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
          const farmObavGuild = guildId ? this.client.guilds.cache.get(guildId) : null;
          if (farmObavGuild) {
            const farmObavCh = await getGuildChannel(farmObavGuild, 'farm-obavijesti');
            if (farmObavCh && ('send' in farmObavCh) && farmObavCh.id !== ch.id && farmObavCh.id !== extraCh?.id) {
              const farmLeaveEmbed = new EmbedBuilder()
                .setDescription(`👋 **${l.name}** je izašao sa servera`)
                .setColor(0xef4444)
                .setTimestamp();
              await (farmObavCh as any).send({ embeds: [farmLeaveEmbed] }).catch(() => {});
            }
          }
        }

        if (trackingEnabled && cooledDown) {
          this.lastLeaveTrackingAtByPlayer.set(playerKey, nowMs);
          const state = { uniqueUserId: l.uniqueUserId, name: l.name, farmId: l.farmId };
          const win = this.defaultTrackWindowFromEnv();
          const trackPayload = await this.buildPlayerExitTrackPayload(state, win);
          if (trackingCh && ('send' in trackingCh)) {
            const trackMsg: any = await trackingCh.send(trackPayload as any);
            if (trackMsg?.id) {
              this.logTrackWindowByMessage.set(trackMsg.id, win);
              this.logTrackPlayerByMessage.set(trackMsg.id, state);
            }

            const equipmentEmbed = await this.buildEquipmentTrackingForPlayer(state);
            if (equipmentEmbed) {
              await trackingCh.send({ embeds: [equipmentEmbed] });
            }
          }
          // Also notify the extra presence channel about leaves
          if (extraCh && ('send' in extraCh) && extraCh.id !== (trackingCh?.id || ch.id)) {
            const extraLeaveEmbed = new EmbedBuilder()
              .setDescription(`👋 **${l.name}** je izašao **${serverName}**`)
              .setColor(0xef4444)
              .setTimestamp();
            await extraCh.send({ embeds: [extraLeaveEmbed] }).catch(() => {});
          }
        }
       } catch (perPlayerErr) {
          console.error(`[PRESENCE] Leave embed failed for ${l.name}:`, perPlayerErr);
       }
      }

      for (const j of payload.joined) {
          if (j.name?.toLowerCase() === 'server') continue;
       try {
        const idn = await buildIdentity(j.uniqueUserId, j.name);
        const embed = new EmbedBuilder()
          .setAuthor({ name: serverName })
          .setDescription(`👤 **${j.name}** je ušao **${serverName}**`)
          .setColor(0x22c55e)
          .setFooter({ text: idn.eventCode })
          .setTimestamp();
        this.debugEmbed('notifyPlayerPresence', embed, {
          panelType: 'presence_join',
          channelId: logCfg.channelId,
          trackingChannelId,
          playerId: j.uniqueUserId,
          playerName: j.name,
          flow: 'join-main-log',
        });
        await ch.send({ embeds: [embed] });
        if (extraCh && ('send' in extraCh) && extraCh.id !== ch.id) {
          const extraEmbed = new EmbedBuilder()
            .setDescription(`👤 **${j.name}** je ušao **${serverName}**`)
            .setColor(0x22c55e)
            .setTimestamp();
          await extraCh.send({ embeds: [extraEmbed] }).catch(() => {});
        }

        // Send join notification to farm-obavijesti channel
        {
          const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
          const farmObavGuild = guildId ? this.client.guilds.cache.get(guildId) : null;
          if (farmObavGuild) {
            const farmObavCh = await getGuildChannel(farmObavGuild, 'farm-obavijesti');
            if (farmObavCh && ('send' in farmObavCh) && farmObavCh.id !== ch.id && farmObavCh.id !== extraCh?.id) {
              const farmJoinEmbed = new EmbedBuilder()
                .setDescription(`👤 **${j.name}** je ušao na server`)
                .setColor(0x22c55e)
                .setTimestamp();
              await (farmObavCh as any).send({ embeds: [farmJoinEmbed] }).catch(() => {});
            }
          }
        }
       } catch (perPlayerErr) {
          console.error(`[PRESENCE] Join embed failed for ${j.name}:`, perPlayerErr);
       }
      }
    } catch (e) {
      console.error('notifyPlayerPresence error:', e);
    }
  }

public async getChannels() {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId || !this.isConnected) return [];

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];

    await guild.channels.fetch().catch(() => null);

    const channels = guild.channels.cache
      .filter(ch => this.isSendableChannel(ch))
      .map(ch => ({
        id: ch.id,
        name: ch.name
      }));

    return Array.from(channels);
  }

  public getGuildChannels(guildId: string): { id: string; name: string; type: number; category: string | null }[] {
    if (!this.isConnected) return [];
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    return guild.channels.cache
      .filter((c: any) => [0, 5, 15].includes(c.type))
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        category: c.parent?.name || null,
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  }

  public async sendModErrorLog(errors: Array<{ time: string; source: string; message: string }>) {
    if (!errors.length) return;
    const logChannelId = await this.getLogChannelId();
    if (!logChannelId || !this.isConnected) return;

    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const channel = await guild.channels.fetch(logChannelId).catch(() => null) as TextChannel | null;
    if (!channel) return;

    const lines = errors.map(e => `\`${e.time}\` **[${e.source}]** ${e.message}`);
    // Truncate if too long for embed
    let desc = lines.join('\n');
    if (desc.length > 4000) desc = desc.substring(0, 4000) + '\n... (skraćeno)';

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Mod Error Log')
      .setDescription(desc)
      .setColor(0xFF4444)
      .setTimestamp()
      .setFooter({ text: `${errors.length} error(s) from Companion mod` });

    await channel.send({ embeds: [embed] }).catch(() => null);
  }

  public async sendToChannel(channelId: string, dataType: string) {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId || !this.isConnected) {
      throw new Error('Bot nije povezan');
    }

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild nije pronaden');

    const channel = await guild.channels.fetch(channelId).catch(() => null) as any;
    if (!channel || !this.isSendableChannel(channel)) {
      throw new Error('Kanal nije pronađen ili nije podržan tekstualni kanal');
    }

    const textChannel = channel as TextChannel;

    // Use the same rich panel embed builders that the bot panels use
    const embed = await this.buildPanelEmbed(dataType, null);

    this.debugEmbed('sendToChannel', embed, { panelType: dataType, channelId, flow: 'manual-send' });

    await textChannel.send({ embeds: [embed] });
    await storage.log({ type: 'info', message: `Poslano ${dataType} u kanal #${textChannel.name}` });
    return { success: true, channel: textChannel.name };
  }

  private async sendOrRefreshPanel(channelId: string, panelType: string, farmId: string | null, existingPanel: any) {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId || !this.isConnected) {
      throw new Error('Bot nije povezan');
    }

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild nije pronaden');

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !this.isSendableChannel(channel)) {
      const err: any = new Error('Kanal nije pronaden ili nije tekstualni kanal');
      err.code = 'PANEL_CHANNEL_MISSING';
      err.channelId = channelId;
      err.panelType = panelType;
      throw err;
    }

    const textChannel = channel as TextChannel;
    
    let message;
    let refreshed = false;
    
    // For interactive panels, use components
    // Bank DISABLED
    const isListPanel = this.isListPanel(panelType);
    if (panelType === 'jobs' || false && panelType === 'bank' || panelType === 'custom_contracts' || panelType === 'linking' || panelType === 'player_hours' || panelType === 'map_tracks' || panelType === 'server_info' || isListPanel) {
      const embed = panelType === 'jobs'
        ? await this.buildJobsEmbed(farmId)
        : false && panelType === 'bank'
          ? await this.buildBankEmbed(farmId)
          : panelType === 'custom_contracts'
            ? await this.buildPanelEmbed('custom_contracts', null)
            : panelType === 'linking'
              ? await this.buildPanelEmbed('linking', null)
              : await this.buildPanelEmbed(panelType, farmId);

      const components = panelType === 'jobs'
        ? await this.buildJobsComponents(farmId)
        : false && panelType === 'bank'
          ? await this.buildBankComponents(farmId)
          : panelType === 'custom_contracts'
            ? await this.buildCustomContractsComponents()
            : panelType === 'linking'
              ? await this.buildLinkingComponents()
              : panelType === 'player_hours'
                ? await this.buildPlayerHoursComponents(existingPanel?.messageId || '')
                : panelType === 'map_tracks'
                  ? await this.buildMapTracksComponents(existingPanel?.messageId || '')
                  : panelType === 'server_info'
                    ? await this.buildServerInfoComponents(existingPanel?.messageId || '')
                  : await this.buildListPanelComponents(panelType, farmId, existingPanel?.messageId || '');
      
      if (existingPanel) {
        try {
          const existingMessage = await textChannel.messages.fetch(existingPanel.messageId);
          // ensure per-message state uses correct key
          if (panelType === 'player_hours') {
            this.playerHoursPageByMessage.set(existingPanel.messageId, this.playerHoursPageByMessage.get(existingPanel.messageId) || 0);
          }
          if (panelType === 'map_tracks') {
            this.mapTracksSelectedWindowByMessage.set(existingPanel.messageId, this.mapTracksSelectedWindowByMessage.get(existingPanel.messageId) || '30m');
          }
          if (panelType === 'server_info') {
            this.serverInfoWindowByMessage.set(existingPanel.messageId, this.serverInfoWindowByMessage.get(existingPanel.messageId) || this.defaultTrackWindowFromEnv());
          }
          if (isListPanel) {
            const k = this.getListPageKey(existingPanel.messageId, panelType, farmId);
            this.listPageByMessageAndPanel.set(k, this.listPageByMessageAndPanel.get(k) || 0);
          }
          // rebuild components with the real message id
          const comps = panelType === 'player_hours'
            ? await this.buildPlayerHoursComponents(existingPanel.messageId)
            : panelType === 'map_tracks'
              ? await this.buildMapTracksComponents(existingPanel.messageId)
              : panelType === 'server_info'
                ? await this.buildServerInfoComponents(existingPanel.messageId)
              : isListPanel
                ? await this.buildListPanelComponents(panelType, farmId, existingPanel.messageId)
                : components;
          if (panelType === 'server_info') {
            const payload = await this.buildServerInfoPayload(existingPanel.messageId);
            await existingMessage.edit(payload as any);
          } else {
            const emb = (panelType === 'player_hours' || panelType === 'map_tracks' || isListPanel)
            ? await this.buildPanelEmbed(panelType, farmId, { messageId: existingPanel.messageId })
            : embed;
            await existingMessage.edit({ embeds: [emb], components: comps });
          }
          message = existingMessage;
          refreshed = true;
        } catch {
          message = await textChannel.send({ embeds: [embed], components });
        }
      } else {
        message = await textChannel.send({ embeds: [embed], components });
      }
    } else {
      const embed = await this.buildPanelEmbed(panelType, farmId);
      
      if (existingPanel) {
        try {
          const existingMessage = await textChannel.messages.fetch(existingPanel.messageId);
          await existingMessage.edit({ embeds: [embed] });
          message = existingMessage;
          refreshed = true;
        } catch {
          message = await textChannel.send({ embeds: [embed] });
        }
      } else {
        message = await textChannel.send({ embeds: [embed] });
      }
    }

    // For interactive panels that depend on messageId state, do a final refresh using the real message id.
    if (panelType === 'player_hours') {
      this.playerHoursPageByMessage.set(message.id, this.playerHoursPageByMessage.get(message.id) || 0);
      const embed = await this.buildPanelEmbed('player_hours', null, { messageId: message.id });
      const components = await this.buildPlayerHoursComponents(message.id);
      try { await message.edit({ embeds: [embed], components }); } catch {}
    }
    if (panelType === 'map_tracks') {
      this.mapTracksSelectedWindowByMessage.set(message.id, this.mapTracksSelectedWindowByMessage.get(message.id) || '30m');
      const embed = await this.buildPanelEmbed('map_tracks', null, { messageId: message.id });
      const components = await this.buildMapTracksComponents(message.id);
      try { await message.edit({ embeds: [embed], components }); } catch {}
    }
    if (panelType === 'server_info') {
      this.serverInfoWindowByMessage.set(message.id, this.serverInfoWindowByMessage.get(message.id) || this.defaultTrackWindowFromEnv());
      const payload = await this.buildServerInfoPayload(message.id);
      try { await message.edit(payload as any); } catch {}
    }

    if (isListPanel) {
      const k = this.getListPageKey(message.id, panelType, farmId);
      this.listPageByMessageAndPanel.set(k, this.listPageByMessageAndPanel.get(k) || 0);
      const embed = await this.buildPanelEmbed(panelType, farmId, { messageId: message.id });
      const components = await this.buildListPanelComponents(panelType, farmId, message.id);
      try { await message.edit({ embeds: [embed], components }); } catch {}
    }
    
    // Save/update panel reference
    await storage.upsertDeployedPanel({
      channelId: channelId,
      messageId: message.id,
      panelType: panelType,
      farmId: farmId
    });
    
    await storage.log({ type: 'info', message: `Panel ${panelType} ${refreshed ? 'osvjezen' : 'postavljen'} u kanal #${textChannel.name}` });
    return { success: true, channel: textChannel.name, refreshed };
  }

  private async buildPanelEmbed(panelType: string, farmId: string | null, ctx?: { messageId?: string }): Promise<EmbedBuilder> {
    const farmLabel = farmId ? ` - Farma ${farmId}` : '';
    const normalized = (panelType || '').toLowerCase();
    if (['runtime', 'runtimestats', 'playerstats', 'runtimestatslatest', 'runtimestats_last', 'runtimestats:last', 'runtime_stats', 'runtime-stats'].includes(normalized)) {
      panelType = 'players';
    }
    let embed: EmbedBuilder;

    switch (panelType) {
      case 'server_info': {
        const status = this.getStatus();
        const logs = await storage.getLogs(250);
        const webstats = await getWebStatsSummaryFromEnv();
        const sync = getSyncStatus();

        const serverName = getActiveServer()?.name || process.env.SERVER_NAME || 'Slavonska Ravnica';
        const serverDesc = process.env.SERVER_DESCRIPTION || 'Dobrodošli na Slavonsku Ravnicu!';
        const specialties = (process.env.SERVER_TAGS || 'Farming, Roleplay, Realistic, Hard Mode, PC, Mods')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .join(', ');
        const trackingBy = process.env.SERVER_TRACKING_BY || 'Slavonska Ravnica Companion';

        const getAgo = (d: Date | null | undefined) => {
          if (!d) return '—';
          const ms = Date.now() - d.getTime();
          const m = Math.max(0, Math.round(ms / 60000));
          if (m < 60) return `${m} min ago`;
          const h = Math.floor(m / 60);
          if (h < 24) return `${h}h ${m % 60}m ago`;
          const days = Math.floor(h / 24);
          return `${days} days ago`;
        };

        const findLogTime = (...needles: string[]) => {
          const hit = logs.find((x: any) => {
            const msg = String(x?.message || '').toLowerCase();
            return needles.some(n => msg.includes(n.toLowerCase()));
          });
          return hit?.createdAt ? new Date(hit.createdAt) : null;
        };

        const lastSavegameAt = findLogTime('savegame', 'save game', 'gamesettings', 'career') || (sync.lastSuccessAt ? new Date(sync.lastSuccessAt) : null);
        const lastServerAt = sync.lastSuccessAt ? new Date(sync.lastSuccessAt) : findLogTime('sync completed', 'sync finished', 'webstats');

        const links = await storage.getPlayerLinks().catch(() => [] as any[]);
        const linksByGameId = new Map((links || []).map((l: any) => [String(l.uniqueUserId || '').trim(), l]));
        const linksByName = new Map((links || []).map((l: any) => [String(l.playerName || '').trim().toLowerCase(), l]));

        const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
        const guild = guildId ? this.client.guilds.cache.get(guildId) : null;
        const adminRoleId = String(process.env.ADMIN_ROLE_ID || '').trim();
        const nowMs = Date.now();

        const fmtSessionMin = (minsRaw: any) => {
          const mins = Math.max(0, Number(minsRaw || 0));
          const h = Math.floor(mins / 60);
          const mm = Math.round(mins % 60);
          return h > 0 ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
        };

        const playerLines: string[] = [];
        const wsPlayersRaw = Array.isArray(webstats.summary?.players) ? webstats.summary.players : [];
        const storedPlayers = await storage.getPlayers().catch(() => [] as any[]);
        const wsUpdatedAtMs = webstats?.summary?.rawUpdatedAt ? Date.parse(String(webstats.summary.rawUpdatedAt)) : NaN;
        const wsFreshWindowMs = Math.max(30000, Number(process.env.WEBSTATS_FRESH_WINDOW_MS || '180000') || 180000);
        const wsIsFresh = Number.isFinite(wsUpdatedAtMs) && (nowMs - wsUpdatedAtMs) <= wsFreshWindowMs;
        const wsPlayers = wsIsFresh ? wsPlayersRaw : [];
        const runtimePlayers = [...this.runtimePlayerTimes.values()] as any[];

        const runtimeWindowSec = Math.max(10, Number(process.env.RUNTIME_ONLINE_WINDOW_SEC || '45') || 45);
        const strictActiveWindowMs = Math.max(120000, runtimeWindowSec * 1000);

        const toMs = (value: any): number => {
          const raw = Number(value);
          if (!Number.isFinite(raw) || raw <= 0) return 0;
          return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
        };

        const runtimeById = new Map<string, any>();
        const runtimeByName = new Map<string, any>();
        for (const rp of runtimePlayers) {
          const idKey = String(rp?.uniqueUserId || rp?.id || '').trim();
          const nameKey = String(rp?.nickname || rp?.name || '').trim().toLowerCase();
          if (idKey) runtimeById.set(idKey, rp);
          if (nameKey) runtimeByName.set(nameKey, rp);
        }

        const wsById = new Map<string, any>();
        const wsByName = new Map<string, any>();
        for (const wp of wsPlayers) {
          const idKey = String((wp as any)?.uniqueUserId || (wp as any)?.id || '').trim();
          const nameKey = String((wp as any)?.name || '').trim().toLowerCase();
          if (idKey) wsById.set(idKey, wp);
          if (nameKey) wsByName.set(nameKey, wp);
        }

        const isRuntimeOnlineStrict = (rp: any): boolean => {
          if (!rp?.currentlyOnline) return false;
          const lastAct = rp?.lastActivityRealAt ? new Date(rp.lastActivityRealAt).getTime() : 0;
          if (lastAct > 0 && (nowMs - lastAct) <= strictActiveWindowMs) return true;
          const seenMs = toMs(rp?.lastSeenAtMs);
          if (seenMs > 0 && Math.abs(nowMs - seenMs) <= strictActiveWindowMs) return true;
          const lastOnlineMs = rp?.lastOnlineAt ? Date.parse(String(rp.lastOnlineAt)) : NaN;
          return Number.isFinite(lastOnlineMs) && (nowMs - lastOnlineMs) <= strictActiveWindowMs;
        };

        const pushedNames = new Set<string>();
        const adminCache = new Map<string, boolean>();
        const resolveIsAdmin = async (discordId: string): Promise<boolean> => {
          if (!discordId) return false;
          if (adminCache.has(discordId)) return adminCache.get(discordId) || false;
          let value = false;
          if (this.isOwner(discordId)) {
            value = true;
          } else if (guild && adminRoleId) {
            const member = await guild.members.fetch(discordId).catch(() => null) as any;
            value = !!member?.roles?.cache?.has(adminRoleId);
          }
          adminCache.set(discordId, value);
          return value;
        };

        const addPlayerLine = async (nameRaw: string, gameIdRaw: string, sessionMinRaw: any) => {
          const name = String(nameRaw || gameIdRaw || 'Igrac').trim();
          const gameId = String(gameIdRaw || '').trim();
          const nameKey = name.toLowerCase();
          if (!name || pushedNames.has(nameKey) || playerLines.length >= 10) return;
          const link = (gameId ? linksByGameId.get(gameId) : undefined) || linksByName.get(nameKey);
          const discordId = String(link?.discordUserId || '').trim();
          const isAdmin = await resolveIsAdmin(discordId);
          playerLines.push(`${name} (${fmtSessionMin(sessionMinRaw)}, admin: ${isAdmin ? 'DA' : 'NE'})`);
          pushedNames.add(nameKey);
        };

        for (const sp of storedPlayers) {
          if (playerLines.length >= 10) break;
          const gameId = String((sp as any)?.uniqueUserId || (sp as any)?.id || '').trim();
          const name = String((sp as any)?.name || gameId || '').trim();
          if (!name) continue;
          const nameKey = name.toLowerCase();

          const rp = (gameId && runtimeById.get(gameId)) || runtimeByName.get(nameKey);
          const wp = (gameId && wsById.get(gameId)) || wsByName.get(nameKey);
          const linked = !!((gameId && linksByGameId.get(gameId)) || linksByName.get(nameKey));

          const runtimeOnline = isRuntimeOnlineStrict(rp);
          const webOnline = wsIsFresh && !!wp && (runtimeOnline || linked);
          const effectiveOnline = runtimeOnline || webOnline;
          if (!effectiveOnline) continue;

          const sessionStart = gameId ? this.runtimeSessionStartedAtByPlayer.get(gameId) : undefined;
          const runtimeMinutes = sessionStart
            ? Math.max(0, Math.round((nowMs - sessionStart.getTime()) / 60000))
            : 0;
          const wsMinutes = Math.max(0, Math.round(Number((wp as any)?.onlineMinutes || 0)));
          const sessionMin = runtimeMinutes > 0 ? runtimeMinutes : wsMinutes;
          await addPlayerLine(name, gameId, sessionMin);
        }

        if (playerLines.length < 10) {
          const runtimeOnlineOnly = runtimePlayers
            .filter((rp: any) => isRuntimeOnlineStrict(rp))
            .sort((a, b) => String(a.nickname || a.id || '').localeCompare(String(b.nickname || b.id || '')))
            .slice(0, 20);

          for (const rp of runtimeOnlineOnly) {
            if (playerLines.length >= 10) break;
            const name = String(rp?.nickname || rp?.id || '').trim();
            const gameId = String(rp?.uniqueUserId || rp?.id || '').trim();
            const sessionStart = gameId ? this.runtimeSessionStartedAtByPlayer.get(gameId) : undefined;
            const sessionMin = sessionStart
              ? Math.max(0, Math.round((nowMs - sessionStart.getTime()) / 60000))
              : 0;
            await addPlayerLine(name, gameId, sessionMin);
          }
        }

        const onlineCount = playerLines.length;
        const onlineLabel = (webstats.summary?.isOnline == null)
          ? (status.status === 'online' ? '🟢 Online' : '🔴 Offline')
          : (webstats.summary.isOnline ? '🟢 Online' : '🔴 Offline');

        embed = new EmbedBuilder()
          .setTitle(`🌾 ${serverName}`)
          .setColor(onlineCount > 0 ? 0x57f287 : 0xed4245)
          .setDescription(
            `${onlineLabel}\n\n` +
            `${serverDesc.length > 300 ? `${serverDesc.slice(0, 300)}…` : serverDesc}\n\n` +
            `**🏷️ Tagovi:** ${specialties || '—'}`
          )
          .addFields(
            { name: '👥 Igrači Online', value: `**${onlineCount}**/7${playerLines.length ? `\n${playerLines.map(p => `> 🚜 ${p}`).join('\n')}` : '\n> *Nitko nije online*'}`, inline: false },
            { name: '💾 Zadnji Save', value: getAgo(lastSavegameAt), inline: true },
            { name: '🔄 Zadnji Sync', value: getAgo(lastServerAt), inline: true },
            { name: '📡 Tracking', value: trackingBy, inline: true }
          )
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica • FarmBuddy Dashboard' });

        const iconImg = process.env.SERVER_ICON_URL;
        if (iconImg) embed.setThumbnail(iconImg);
        break;
      }

      case 'status': {
        const status = this.getStatus();
        let fields = await storage.getFields();
        let vehicles = await storage.getVehicles();
        let silos = await storage.getSilos();
        let animals = await storage.getAnimals();
        const farmsAll = (await storage.getFarms()).filter(f => !String((f as any).farmId || '').startsWith('U:'));
        const logs = await storage.getLogs(200);
        const webstats = await getWebStatsSummaryFromEnv();
        
        if (farmId) {
          fields = fields.filter(f => f.ownerFarmId === farmId);
          vehicles = vehicles.filter(v => v.farmId === farmId);
          silos = silos.filter(s => String(s.farmId ?? '') === String(farmId));
          animals = animals.filter(a => a.farmId === farmId);
        }
        
        const norm = (v: any) => String(v || '').toLowerCase();
        const readyCount = fields.filter(f => norm(f.fruitStatus).includes('ready')).length;
        const growingCount = fields.filter(f => norm(f.fruitStatus).includes('growing')).length;
        const emptyCount = fields.filter(f => {
          const fruit = norm((f as any).fruitName);
          const st = norm((f as any).fruitStatus);
          return !fruit || fruit === 'none' || fruit === 'unknown' || st === 'unknown' || st === 'none';
        }).length;
        const totalArea = fields.reduce((s, f) => s + Number((f as any).fieldAreaFull || (f as any).fieldArea || 0), 0);
        const totalAnimals = animals.reduce((sum, a) => sum + (a.numAnimals || 0), 0);
        const totalBalance = farmsAll.reduce((sum, f) => sum + Number((f as any).balance || 0), 0);

        const lastBy = (needle: string) => {
          const l = logs.find(x => String((x as any).message || '').toLowerCase().includes(needle.toLowerCase()));
          const d = (l as any)?.createdAt ? new Date((l as any).createdAt) : null;
          return d;
        };

        const fmtAgo = (d: Date | null) => {
          if (!d) return '—';
          const ms = Date.now() - d.getTime();
          const m = Math.max(0, Math.round(ms / 60000));
          if (m < 60) return `${m}m`;
          const h = Math.floor(m / 60);
          const mm = m % 60;
          return `${h}h ${mm}m`;
        };

        const syncLines = [
          ['Farms', fmtAgo(lastBy('farms synced'))],
          ['Fields', fmtAgo(lastBy('fields synced'))],
          ['Vehicles', fmtAgo(lastBy('vehicles synced'))],
          ['Silos', fmtAgo(lastBy('silos synced'))],
          ['Animals', fmtAgo(lastBy('animals synced'))],
          ['Prod', fmtAgo(lastBy('productions synced'))],
          ['Weather', fmtAgo(lastBy('weather synced'))],
          ['Players', fmtAgo(lastBy('playerstats synced'))],
        ];

        // Runtime players (aktivni u zadnjem sync intervalu)
        const windowMin = 15;
        const now = new Date();
        const activePlayers = [...this.runtimePlayerTimes.values()].filter(p => p.lastActivityRealAt && (now.getTime() - p.lastActivityRealAt.getTime()) <= windowMin * 60 * 1000);

        const uptimeHours = Math.floor(status.uptime / 3600000);
        const uptimeMins = Math.floor((status.uptime % 3600000) / 60000);

        const fmtHr = (n: number) => n.toLocaleString('hr-HR');

        const serverName = getActiveServer()?.name || process.env.SERVER_NAME || 'Slavonska Ravnica';
        const serverDesc = process.env.SERVER_DESCRIPTION || 'Dobrodošli na Slavonsku Ranicu! Hard mod + roleplay.';
        const serverTagsRaw = process.env.SERVER_TAGS || 'Farming, Roleplay, Realistic, Hard Mode, PC, Mods';
        const serverTags = serverTagsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10).join(', ');

        const storedOnlinePlayers = (await storage.getPlayers()).filter(p => p.isOnline);
        const runtimePlayers = [...this.runtimePlayerTimes.values()] as any[];
        const rtById = new Map(runtimePlayers.map(p => [String(p.uniqueUserId || p.id || ''), p]));
        const rtByName = new Map(runtimePlayers.map(p => [String(p.name || '').toLowerCase(), p]));

        // Hrvatski komentar: WebStats XML je server-side istina (radi i bez moda/FTP-a). Ako postoji, koristimo ga za listu online igrača.
        const wsPlayers = (webstats.summary?.players && webstats.summary.players.length) ? webstats.summary.players : null;

        const playerLines = (wsPlayers
          ? wsPlayers.slice(0, 7).map(p => {
              const rt = rtByName.get(String(p.name || '').toLowerCase());
              const mins = p.onlineMinutes ?? (rt?.totalOnlineMs ? Math.round(Number(rt.totalOnlineMs) / 60000) : null);
              const h = mins != null ? Math.floor(mins / 60) : null;
              const mm = mins != null ? (mins % 60) : null;
              const sess = mins != null ? ` - ${h}h ${mm}m` : '';
              return `${p.name}${sess}`;
            })
          : storedOnlinePlayers.slice(0, 7).map(p => {
              const rt = rtById.get(String(p.uniqueUserId));
              const mins = rt?.totalOnlineMs ? Math.round(Number(rt.totalOnlineMs) / 60000) : null;
              const h = mins != null ? Math.floor(mins / 60) : null;
              const mm = mins != null ? (mins % 60) : null;
              const sess = mins != null ? ` - ${h}h ${mm}m` : '';
              const farm = (p as any).farmId ? ` (F${(p as any).farmId})` : '';
              return `${p.name}${farm}${sess}`;
            })
        );

        const onlineCount = (webstats.summary?.playersOnline ?? (wsPlayers ? wsPlayers.length : null) ?? storedOnlinePlayers.length);
        const playersBlock = playerLines.length
          ? `${onlineCount}/${Math.max(onlineCount, 1)}\n` + playerLines.join('\n')
          : '0/0\n(nema online igrača)';

        const companionLine = (webstats.mods.companionActive == null)
          ? 'N/A'
          : (webstats.mods.companionActive ? '✅ Active' : '❌ Not active');

        const modsCountLine = webstats.mods.modCount != null ? String(webstats.mods.modCount) : 'N/A';

        const serverOnlineLine = (webstats.summary?.isOnline == null)
          ? (status.status === 'online' ? '✅ Online' : '❌ Offline')
          : (webstats.summary.isOnline ? '✅ Online' : '❌ Offline');


        const syncBlock = syncLines
          .filter(x => x[0] && x[1])
          .map(([k, v]) => `${String(k).padEnd(8)} ${String(v).padStart(7)}`)
          .join('\n');

        const s = getSyncStatus();
        const fmtMs = (ms?: number) => (ms == null ? '—' : `${Math.round(ms)}ms`);
        const fmtAgoIso = (iso?: string) => {
          if (!iso) return '—';
          const d = new Date(iso);
          if (isNaN(d.getTime())) return '—';
          const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
          if (m < 60) return `${m}m`; 
          const h = Math.floor(m / 60);
          const mm = m % 60;
          return `${h}h ${mm}m`;
        };

        const syncHealth = [
          `Run: ${s.runId || '—'}`,
          `InProgress: ${s.inProgress ? 'yes' : 'no'}`,
          `Last OK: ${fmtAgoIso(s.lastSuccessAt)} (${fmtMs(s.durationMs)})`,
          s.lastError ? `Last ERR: ${fmtAgoIso(s.lastErrorAt)} | ${String(s.lastError).slice(0, 120)}` : null,
          s.basePath ? `Path: ${s.basePath}` : null,
        ].filter(Boolean).join('\n');

        embed = new EmbedBuilder()
          .setTitle(`${serverName}${farmLabel}`)
          .setDescription('```\nFS25 Monitor\n```')
          .setColor(status.status === 'online' ? 0x22c55e : 0xef4444)
          .addFields(
            { name: 'Name', value: `\`\`\`\n${serverName}\n\`\`\``, inline: false },
            { name: 'Description', value: serverDesc.length > 900 ? serverDesc.slice(0, 900) + '…' : serverDesc, inline: false },
            { name: 'Specialties', value: `\`\`\`\n${serverTags}\n\`\`\``, inline: false },
            { name: 'Players Online', value: `\`\`\`\n${playersBlock}\n\`\`\``, inline: false },
            { name: 'Status', value: `\`\`\`\n${serverOnlineLine}\n\`\`\``, inline: true },
            { name: 'Uptime', value: `\`\`\`\n${uptimeHours}h ${uptimeMins}m\n\`\`\``, inline: true },
            { name: 'Ping', value: `\`\`\`\n${status.lastPing || 'N/A'}\n\`\`\``, inline: true },
            { name: 'Companion Mod', value: `\`\`\`\n${companionLine}\n\`\`\``, inline: true },
            { name: 'Mods (web)', value: `\`\`\`\n${modsCountLine}\n\`\`\``, inline: true },
            { name: 'Igraci', value: `\`\`\`\nAktivni: ${activePlayers.length}\n\`\`\``, inline: true },
            { name: '\u200b', value: '\u200b', inline: false },
            { name: 'Farme', value: `\`\`\`\n${farmsAll.length}\n\`\`\``, inline: true },
            { name: 'Balans (Σ)', value: `\`\`\`\n${fmtHr(Math.round(totalBalance))} €\n\`\`\``, inline: true },
            { name: 'Polja', value: `\`\`\`\n${fields.length} | ${totalArea.toFixed(1)} ha\n\`\`\``, inline: true },
            { name: 'Rast / Prazno', value: `\`\`\`\n${growingCount} / ${emptyCount}\n\`\`\``, inline: true },
            { name: 'Vozila', value: `\`\`\`\n${vehicles.length}\n\`\`\``, inline: true },
            { name: 'Silosi', value: `\`\`\`\n${silos.length}\n\`\`\``, inline: true },
            { name: 'Zivotinje', value: `\`\`\`\n${totalAnimals}\n\`\`\``, inline: true },
            { name: 'Spremno', value: readyCount > 0 ? `\`\`\`fix\n${readyCount} polja\n\`\`\`` : `\`\`\`\n0\n\`\`\``, inline: true },
            { name: 'Zadnji sync', value: `\`\`\`\n${syncBlock || '—'}\n\`\`\``, inline: false },
            { name: 'Sync Health', value: `\`\`\`\n${syncHealth || '—'}\n\`\`\``, inline: false }
          )
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica | Zadnje azuriranje' });
        const mapImg = process.env.SERVER_MAP_IMAGE_URL || process.env.WEBSTATS_MAP_IMAGE_URL;
        if (mapImg) embed.setImage(mapImg);
        const iconImg = process.env.SERVER_ICON_URL;
        if (iconImg) embed.setThumbnail(iconImg);

        break;
      }

      case 'farms': {
        const farms = (await storage.getFarms()).filter(f => !String(f.farmId || '').startsWith('U:'));
        const fieldsAll = await storage.getFields();
        const vehiclesAll = await storage.getVehicles();
        const silosAll = await storage.getSilos();
        const prodAll = await storage.getProductions();
        embed = new EmbedBuilder()
          .setTitle('Farme - Slavonska Ravnica')
          .setColor(0x3b82f6)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        if (farms.length === 0) {
          embed.setDescription('```\nNema registriranih farmi.\nPokreni sync za ucitavanje podataka.\n```');
        } else {
          const fmt = (n: number) => Math.round(n).toLocaleString('hr-HR');

          // Precompute per-farm metrics
          const byFarm = new Map<string, any>();
          const ensure = (id: string) => {
            if (!byFarm.has(id)) byFarm.set(id, { fields: 0, ready: 0, vehicles: 0, siloPct: 0, prodOwned: 0, prodTotal: 0, area: 0 });
            return byFarm.get(id);
          };

          for (const f of fieldsAll) {
            const id = String((f as any).ownerFarmId || '');
            if (!id) continue;
            const b = ensure(id);
            b.fields += 1;
            const st = String((f as any).fruitStatus || '').toLowerCase();
            if (st.includes('ready')) b.ready += 1;
            b.area += Number((f as any).fieldAreaFull || (f as any).fieldArea || 0);
          }
          for (const v of vehiclesAll) {
            const id = String((v as any).farmId || '');
            if (!id) continue;
            ensure(id).vehicles += 1;
          }
          for (const s of silosAll) {
            const id = String((s as any).farmId || '');
            if (!id) continue;
            const b = ensure(id);
            const cap = Number((s as any).capacity || 0);
            const fill = Number((s as any).totalFill || 0);
            if (!b._cap) { b._cap = 0; b._fill = 0; }
            b._cap += cap; b._fill += fill;
          }
          for (const p of prodAll) {
            const id = String((p as any).farmId || '');
            if (!id) continue;
            const b = ensure(id);
            b.prodTotal += 1;
            if ((p as any).isOwned) b.prodOwned += 1;
          }

          for (const [id, b] of byFarm.entries()) {
            const cap = Number(b._cap || 0);
            const fill = Number(b._fill || 0);
            b.siloPct = cap > 0 ? Math.round((fill / cap) * 100) : 0;
          }

          // Sort by balance desc (signal)
          const sorted = farms.slice().sort((a, b) => Number((b as any).balance || 0) - Number((a as any).balance || 0));
          const messageId = ctx?.messageId || '';
          const pageSize = this.getPageSizeForPanel('farms', 6);
          const pageKey = this.getListPageKey(messageId, 'farms', farmId);
          let page = messageId ? (this.listPageByMessageAndPanel.get(pageKey) || 0) : 0;
          const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
          if (page >= totalPages) page = totalPages - 1;
          if (messageId) this.listPageByMessageAndPanel.set(pageKey, page);

          const start = page * pageSize;
          const slice = sorted.slice(start, start + pageSize);

          const lines = slice.map((farm: any, idx: number) => {
            const fid = String(farm.farmId);
            const m = byFarm.get(fid) || { fields: 0, ready: 0, vehicles: 0, siloPct: 0, prodOwned: 0, prodTotal: 0, area: 0 };
            const name = String(farm.name || `Farma ${fid}`).slice(0, 18);
            const rank = String(start + idx + 1).padStart(2, '0');
            return `${rank}. ${name} | 💶 ${fmt(Number(farm.balance || 0))}€ | 🌾 ${m.fields} (✅${m.ready}) ${Number(m.area || 0).toFixed(1)}ha | 🚜 ${m.vehicles} | 🏭 ${m.prodOwned}/${m.prodTotal} | 🧺 ${m.siloPct}%`;
          });

          embed.setDescription([
            `\`\`\`yaml\nUkupno farmi: ${farms.length}\nStranica: ${page + 1}/${totalPages}\n\`\`\``,
            `🧭 **Legenda:** 💶 balans | 🌾 polja (✅ spremno) | 🚜 vozila | 🏭 proizvodnje | 🧺 silosi`,
            `\`\`\`text\n${lines.join('\n')}\n\`\`\``
          ].join('\n').slice(0, 3900));

          embed.setFooter({ text: `Prikazano ${slice.length}/${farms.length} farmi | Slavonska Ravnica` });
        }
        break;
      }
      case 'fields': {
        let fields = await storage.getFields();
        if (farmId) {
          fields = fields.filter(f => f.ownerFarmId === farmId);
        }
        const featureFlags = await this.getFarmFeatureFlags(farmId);
        const showFieldTaskHints = !!featureFlags.fieldsTaskHints;

        const norm = (v: any) => String(v || '').trim().toLowerCase();
        const isReady = (f: any) => norm(f.fruitStatus).includes('ready');
        const isGrowing = (f: any) => norm(f.fruitStatus).includes('growing');
        const isEmpty = (f: any) => {
          const fruit = norm(f.fruitName);
          const st = norm(f.fruitStatus);
          return !fruit || fruit === 'none' || fruit === 'unknown' || st === 'unknown' || st === 'none' || st.includes('unknown');
        };

        const needsLime = (f: any) => norm(f.limeInfo).includes('needs');
        const needsPlow = (f: any) => {
          const plowInfo = norm((f as any).plowingInfo);
          if (!plowInfo) return false;

          const stateText = [
            norm((f as any).fruitStatus),
            norm((f as any).growthStage),
            norm((f as any).fieldState),
            norm((f as any).soilState),
            norm((f as any).groundState),
          ].join(' ');

          const hasPreparedState =
            stateText.includes('cultivat') ||
            stateText.includes('plowed') ||
            stateText.includes('plough') ||
            stateText.includes('seed') ||
            stateText.includes('sown') ||
            stateText.includes('growing') ||
            stateText.includes('ready');

          if (hasPreparedState) return false;

          const explicitNo =
            plowInfo.includes('not required') ||
            plowInfo.includes("doesn't need") ||
            plowInfo.includes('does not need') ||
            plowInfo.includes('no need') ||
            plowInfo.includes('plowed') ||
            plowInfo.includes('plough') ||
            plowInfo.includes('cultivat') ||
            plowInfo.includes('done') ||
            plowInfo.includes('ok');
          if (explicitNo) return false;

          return (
            plowInfo.includes('needs') ||
            plowInfo.includes('required') ||
            plowInfo.includes('mora')
          );
        };
        const needsRoll = (f: any) => norm(f.rollingInfo).includes('needs');
        const needsFert = (f: any) => {
          const fi = norm(f.fertilizationInfo);
          if (!fi) return false;
          if (fi.includes('fertilized')) return false;
          return fi.includes('needs') || fi.includes('not') || fi.includes('missing') || fi.includes('unfert');
        };
        const weedMeta = (f: any) => {
          const wi = String(f.weedInfo || '').trim();
          const w = wi.toLowerCase();
          const hasWeed = w.includes('weed') && !w.includes('nil') && !w.includes('none');
          const method = w.includes('herbicide') ? 'S' : w.includes('hoe') ? 'H' : '';
          const sev = w.includes('large') ? 'L' : w.includes('medium') ? 'M' : w.includes('small') ? 'S' : w.includes('partial') ? 'P' : '';
          return { hasWeed, method, sev, raw: wi };
        };

        const areaHa = (f: any) => Number(f.fieldAreaFull || f.fieldArea || 0);
        const sumArea = (arr: any[]) => arr.reduce((s, f) => s + areaHa(f), 0);

        const readyFields = fields.filter(isReady);
        const growingFields = fields.filter(isGrowing);
        const emptyFields = fields.filter(isEmpty);

        const countWeeds = fields.filter(f => weedMeta(f).hasWeed).length;
        const countLime = fields.filter(needsLime).length;
        const countPlow = fields.filter(needsPlow).length;
        const countRoll = fields.filter(needsRoll).length;
        const countFert = fields.filter(needsFert).length;
        const totalArea = sumArea(fields);
        const weedsArea = sumArea(fields.filter(f => weedMeta(f).hasWeed));
        const limeArea = sumArea(fields.filter(needsLime));
        const fertArea = sumArea(fields.filter(needsFert));
        const plowArea = sumArea(fields.filter(needsPlow));
        const rollArea = sumArea(fields.filter(needsRoll));

        const fieldIdsFor = (predicate: (f: any) => boolean) => {
          const ids = fields
            .filter(predicate)
            .map((f: any) => String(f.fieldId || '').trim())
            .filter(Boolean)
            .map((id: string) => `#${id}`);
          if (!ids.length) return '—';
          const shown = ids.slice(0, 8).join(', ');
          return ids.length > 8 ? `${shown} +${ids.length - 8}` : shown;
        };

        embed = new EmbedBuilder()
          .setTitle(`🌾 Polja${farmLabel}`)
          .setColor(0x22c55e)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        if (fields.length === 0) {
          embed.setDescription('```\nNema podataka o poljima.\n```');
          break;
        }

        const fmtHa = (n: number) => n.toFixed(2).replace('.', ',');

        const readyArea = sumArea(readyFields);
        const growingArea = sumArea(growingFields);
        const emptyArea = sumArea(emptyFields);

        const actionScore = (f: any) => {
          const w = weedMeta(f).hasWeed ? 1 : 0;
          const l = needsLime(f) ? 1 : 0;
          const fe = needsFert(f) ? 1 : 0;
          const p = needsPlow(f) ? 1 : 0;
          const r = needsRoll(f) ? 1 : 0;
          return w + l + fe + p + r;
        };

        const priorityLabel = (f: any) => {
          if (isReady(f)) return '🔴 HITNO';
          const s = actionScore(f);
          if (s >= 3) return '🟠 VISOKO';
          if (s >= 1) return '🟡 SREDNJE';
          return '🟢 STABILNO';
        };

        const describeFieldState = (f: any) => {
          const baseRaw = String(f.fruitStatus || f.growthStage || '').trim();
          const baseNorm = norm(baseRaw);

          let base = 'Unknown';
          if (baseNorm.includes('cultivat')) base = 'Cultivated';
          else if (isReady(f)) base = 'Ready to harvest';
          else if (isGrowing(f)) base = 'Growing';
          else if (isEmpty(f)) base = 'Empty';
          else if (baseRaw) base = baseRaw;

          const needs: string[] = [];
          if (needsPlow(f)) needs.push('needs plowing');
          if (needsLime(f)) needs.push('needs lime');
          if (needsFert(f)) needs.push('needs fertilizer');
          if (needsRoll(f)) needs.push('needs rolling');
          if (weedMeta(f).hasWeed) needs.push('needs weeding');

          return needs.length ? `${base}; ${needs.join(', ')}` : base;
        };

        const toLine = (f: any) => {
          const id = String(f.fieldId || '').padStart(3, '0');
          const fruit = String(f.fruitName || 'Unknown').slice(0, 14);
          const stageText = describeFieldState(f).slice(0, 64);
          const a = areaHa(f);

          const w = weedMeta(f);
          const acts = [] as string[];
          if (w.hasWeed) acts.push(`🌿${w.method || ''}${w.sev || ''}`.trim());
          if (needsLime(f)) acts.push('🧱');
          if (needsFert(f)) acts.push('🧪');
          if (needsPlow(f)) acts.push('🚜');
          if (needsRoll(f)) acts.push('🧻');
          const actsTxt = acts.join(' ') || '✅';

          const icon = isReady(f) ? '🌾' : isGrowing(f) ? '🌱' : '🟪';
          const crop = this.getCropIcon(f.fruitName);
          return `${priorityLabel(f)} ${icon} #${id} ${crop} ${fruit} • Stanje: ${stageText} • ${fmtHa(a)}ha • ${actsTxt}`;
        };

        const toSimpleLine = (f: any) => {
          const id = String(f.fieldId || '').padStart(3, '0');
          const fruit = String(f.fruitName || 'Unknown').slice(0, 16);
          const a = areaHa(f);
          const icon = isReady(f) ? '🌾' : isGrowing(f) ? '🌱' : '🟪';
          const crop = this.getCropIcon(f.fruitName);
          const state = describeFieldState(f).slice(0, 42);
          return `${icon} #${id} ${crop} ${fruit} • ${fmtHa(a)}ha • ${state}`;
        };

        // Priority: ready -> action-needed -> big fields
        const sorted = [...fields].sort((a: any, b: any) => {
          const ar = isReady(a) ? 1 : 0;
          const br = isReady(b) ? 1 : 0;
          if (ar != br) return br - ar;
          const aa = actionScore(a);
          const ba = actionScore(b);
          if (aa != ba) return ba - aa;
          return areaHa(b) - areaHa(a);
        });

        const messageId = ctx?.messageId || '';
        const pageSize = this.getPageSizeForPanel('fields', 12);
        const pageKey = this.getListPageKey(messageId, 'fields', farmId);
        let page = messageId ? (this.listPageByMessageAndPanel.get(pageKey) || 0) : 0;
        const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
        if (page >= totalPages) page = totalPages - 1;
        if (messageId) this.listPageByMessageAndPanel.set(pageKey, page);

        const start = page * pageSize;
        const slice = sorted.slice(start, start + pageSize);
        const lines = slice.map(showFieldTaskHints ? toLine : toSimpleLine);

        const descParts: string[] = [
          `📊 **Pregled**`,
          `• Ukupno polja: **${fields.length}**`,
          `• Ukupna površina: **${fmtHa(totalArea)} ha**`,
          `• Prosjek po polju: **${fmtHa(totalArea / Math.max(1, fields.length))} ha**`,
          '',
          `🌱 **Status usjeva**`,
          `• 🌾 Spremno za žetvu: **${readyFields.length}** (${fmtHa(readyArea)} ha)`,
          `• 🌿 U rastu: **${growingFields.length}** (${fmtHa(growingArea)} ha)`,
          `• ⬜ Prazno/Unknown: **${emptyFields.length}** (${fmtHa(emptyArea)} ha)`,
        ];

        if (showFieldTaskHints) {
          descParts.push(
            '',
            `🛠️ **Akcije (broj polja | površina)**`,
            `• 🌿 Korov: **${countWeeds}** | ${fmtHa(weedsArea)} ha | Polja: ${fieldIdsFor((f: any) => weedMeta(f).hasWeed)}`,
            `• 🧱 Vapno: **${countLime}** | ${fmtHa(limeArea)} ha | Polja: ${fieldIdsFor(needsLime)}`,
            `• 🧪 Gnojivo: **${countFert}** | ${fmtHa(fertArea)} ha | Polja: ${fieldIdsFor(needsFert)}`,
            `• 🚜 Oranje: **${countPlow}** | ${fmtHa(plowArea)} ha | Polja: ${fieldIdsFor(needsPlow)}`,
            `• 🧻 Valjanje: **${countRoll}** | ${fmtHa(rollArea)} ha | Polja: ${fieldIdsFor(needsRoll)}`,
            '',
            `📋 **Prioritetna polja**`
          );
        } else {
          descParts.push('', `📋 **Polja**`);
        }

        descParts.push(
          lines.length ? lines.join('\n\n') : 'Nema polja za prikaz.',
          '',
          `🧭 **Legenda kultura**`,
          `🌾 žitarice | 🌽 kukuruz/maize | 🟡 canola | 🍬 sugar beet | 🥔 krumpir | 🌻 suncokret | 🫘 soja | ⬜ unknown`
        );

        embed.setDescription(descParts.join('\n').slice(0, 3900));

        if (fields.length > pageSize) {
          embed.setFooter({ text: `Prikazano ${slice.length}/${fields.length} polja | Stranica ${page + 1}/${totalPages} | Slavonska Ravnica` });
        } else {
          embed.setFooter({ text: `Prikazano ${fields.length}/${fields.length} polja | Slavonska Ravnica` });
        }
        break;
      }

      case 'vehicles': {
        let vehicles = await storage.getVehicles();
        if (farmId) {
          vehicles = vehicles.filter(v => v.farmId === farmId);
        }
        vehicles = vehicles.filter(v => this.isDrivableVehicle(v.name, v.vehType));
        const featureFlags = await this.getFarmFeatureFlags(farmId);
        const showVehicleAlerts = !!featureFlags.vehiclesAlerts;
        const toVehicleConditionPct = (rawValue: any) => {
          const raw = Number(rawValue);
          if (!Number.isFinite(raw)) return 0;
          const pct = this.normalizePercent(raw);
          const mode = String(process.env.VEHICLE_CONDITION_MODE || 'auto').trim().toLowerCase();
          if (mode === 'repair' || mode === 'condition' || mode === 'health') return pct;
          if (mode === 'damage') return Math.max(0, Math.min(100, 100 - pct));
          if (raw <= 1.0001) return Math.max(0, Math.min(100, 100 - pct));
          return pct;
        };
        
        // Normalizacija percenta (neki exporti vracaju 0-1, neki 0-100)
        const lowFuel = vehicles.filter(v => this.normalizePercent(v.fuelLevel) < 25).length;
        const needsRepair = vehicles.filter(v => toVehicleConditionPct(v.damage) < 85).length;

        // Runtime usage lookup (farmId+name)
        const usageByFarmName = new Map<string, any>();
        for (const u of this.runtimeVehicleUsage.values()) {
          const k = `${u.farmId || ''}|${(u.name || '').toLowerCase()}`;
          if (!usageByFarmName.has(k)) usageByFarmName.set(k, u);
        }
        
        const categoryOrder = ['TRAKTOR', 'KAMION', 'TELEHANDLER', 'VILICAR', 'KOMBAJN', 'UTOVARIVAC', 'AUTO', 'OSTALO'];
        const messageId = ctx?.messageId || '';
        const selectedTypesRaw = messageId ? (this.vehiclesTypesByMessage.get(messageId) || ['ALL']) : ['ALL'];
        const availableTypes = new Set(vehicles.map((v: any) => this.getVehicleDisplayType(v.name, v.vehType)));
        let selectedTypes = selectedTypesRaw.includes('ALL')
          ? ['ALL']
          : selectedTypesRaw.filter((t: string) => availableTypes.has(String(t || '').toUpperCase()));
        if (!selectedTypes.length) selectedTypes = ['ALL'];
        if (messageId && selectedTypes.join('|') !== selectedTypesRaw.join('|')) {
          this.vehiclesTypesByMessage.set(messageId, selectedTypes);
        }
        const selectedVehicles = messageId ? (this.vehiclesSelectedByMessage.get(messageId) || ['ALL']) : ['ALL'];

        const filteredByType = this.applyVehicleTypeFilter(vehicles, selectedTypes);
        const sortedFiltered = filteredByType
          .slice()
          .sort((a, b) => {
            const ac = categoryOrder.indexOf(this.categorizeVehicle(a.name, a.vehType));
            const bc = categoryOrder.indexOf(this.categorizeVehicle(b.name, b.vehType));
            if (ac !== bc) return ac - bc;
            return String(a.name || '').localeCompare(String(b.name || ''));
          });

        const selectedSet = new Set(selectedVehicles);
        const selectedVehicleObjs = selectedSet.has('ALL')
          ? []
          : sortedFiltered.filter((v: any) => selectedSet.has(this.vehicleOptionValue(v)));

        const effective = selectedVehicleObjs.length ? selectedVehicleObjs : sortedFiltered;

        const pageSize = this.getPageSizeForPanel('vehicles', 4);
        const pageKey = this.getListPageKey(messageId, 'vehicles', farmId);
        let page = messageId ? (this.listPageByMessageAndPanel.get(pageKey) || 0) : 0;
        const totalPages = Math.max(1, Math.ceil(effective.length / pageSize));
        if (page >= totalPages) page = totalPages - 1;
        if (messageId) this.listPageByMessageAndPanel.set(pageKey, page);
        
        embed = new EmbedBuilder()
          .setTitle(`Vozila${farmLabel}`)
          .setColor(0xf59e0b)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        if (vehicles.length === 0) {
          embed.setDescription('```\nNema vozila koja se mogu voziti.\n```');
        } else {
          const start = page * pageSize;
          const slice = effective.slice(start, start + pageSize);
          const showPaintStats = selectedVehicleObjs.length === 1;
          const parseFillUnits = (veh: any) => {
            const raw = veh?.fillUnits;
            const src = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
            return src
              .map((f: any) => ({
                fillType: this.normalizeFillType(f?.fillType || f?.type || f?.name || ''),
                fillLevel: Number(f?.fillLevel ?? f?.level ?? f?.amount ?? 0),
                fillPercentage: Number(f?.fillPercentage ?? f?.percent ?? f?.percentage ?? 0)
              }))
              .filter((f: any) => !!f.fillType && ((Number.isFinite(f.fillLevel) && f.fillLevel > 0) || (Number.isFinite(f.fillPercentage) && f.fillPercentage > 0)));
          };

          let desc = '';
          const selectedTypesTxt = selectedTypes.includes('ALL')
            ? 'Sve'
            : selectedTypes.map((t: string) => this.getVehicleDisplayTypeLabel(t)).join(', ');
          const selectedVehicleTxt = selectedVehicleObjs.length
            ? `${selectedVehicleObjs.length} odabrano`
            : 'Sva vozila';
          desc = `📊 Ukupno: **${vehicles.length}** • ⛽ Malo goriva: **${lowFuel}** • 🛠 Za servis: **${needsRepair}**\n`;
          desc += `🎛 Filteri: **${selectedTypesTxt}** • 🚜 **${selectedVehicleTxt}** • 📄 Stranica **${page + 1}/${totalPages}**\n`;
          desc += showPaintStats
            ? `🧭 Legenda: 🛠 šteta | ⛽ gorivo (motori) | 📦 spremnik (prikolice/sijačice/prskalice) | 🎨 boja | ⏱ ukupno | 🚜 aktivno | 😴 AFK\n\n`
            : `🧭 Legenda: 🛠 šteta | ⛽ gorivo (motori) | 📦 spremnik (po tipu) | ⏱ ukupno | 🚜 aktivno | 😴 AFK\n\n`;

          if (showVehicleAlerts) {
            const lowFuelNames: string[] = [];
            const lowConditionNames: string[] = [];
            const lowTankNames: string[] = [];

            for (const vv of effective) {
              const tKey = String(this.getVehicleDisplayType(vv.name, vv.vehType) || '').toUpperCase();
              const isEngine = ['TRAKTOR', 'KAMION', 'KOMBAJN', 'TELEHANDLER', 'VILICAR', 'UTOVARIVAC', 'AUTO'].includes(tKey);
              const isTankWork = tKey === 'PRIKOLICE' || tKey === 'SIJACICE' || tKey === 'PRSKALICE'
                || String(vv.name || '').toLowerCase().includes('planter')
                || String(vv.name || '').toLowerCase().includes('seeder')
                || String(vv.name || '').toLowerCase().includes('sprayer')
                || String(vv.name || '').toLowerCase().includes('trailer');

              const fuel = Math.round(this.normalizePercent(vv.fuelLevel));
              const condition = Math.round(toVehicleConditionPct(vv.damage));
              if (isEngine && fuel > 0 && fuel <= 15) lowFuelNames.push(String(vv.name || 'Vozilo').slice(0, 18));
              if (condition <= 30) lowConditionNames.push(String(vv.name || 'Vozilo').slice(0, 18));

              if (isTankWork) {
                const fills = parseFillUnits(vv);
                if (fills.length > 0) {
                  const top = [...fills].sort((a: any, b: any) => (b.fillLevel - a.fillLevel) || (b.fillPercentage - a.fillPercentage))[0];
                  const pct = Math.round(Number(top?.fillPercentage || 0));
                  if (pct > 0 && pct <= 15) lowTankNames.push(String(vv.name || 'Prikljucak').slice(0, 18));
                }
              }
            }

            const short = (arr: string[]) => arr.length ? `${arr.slice(0, 4).join(', ')}${arr.length > 4 ? ` +${arr.length - 4}` : ''}` : '—';
            desc += `🚨 Alerti: ⛽ nisko **${lowFuelNames.length}** (${short(lowFuelNames)}) • 🛠 kritično **${lowConditionNames.length}** (${short(lowConditionNames)}) • 📦 niski spremnik **${lowTankNames.length}** (${short(lowTankNames)})\n\n`;
          }

          for (const v of slice) {
            const fuelPct = Math.round(this.normalizePercent(v.fuelLevel));
            const conditionPct = Math.round(toVehicleConditionPct(v.damage));
            const category = this.categorizeVehicle(v.name, v.vehType);
            const displayType = this.getVehicleDisplayType(v.name, v.vehType);
            const displayTypeKey = String(displayType || '').toUpperCase();
            const nameLower = String(v.name || '').toLowerCase();
            const vehTypeLower = String(v.vehType || '').toLowerCase();

            // Color/emoji for condition
            let conditionIcon = '🟩';
            if (conditionPct < 35) conditionIcon = '🟥';
            else if (conditionPct < 70) conditionIcon = '🟧';

            const paintPct = (() => {
              const raw = (v.paint ?? '').toString().trim();
              const direct = Number.parseFloat(raw);
              if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));
              const mm = raw.match(/(\d{1,3})\s*%/);
              if (mm) return Math.max(0, Math.min(100, Number(mm[1])));
              return null;
            })();

            const fuelBar = this.getModernLoadingBar(fuelPct, 12);
            const conditionBar = this.getModernLoadingBar(conditionPct, 10);
            const paintBar = paintPct == null ? null : this.getModernLoadingBar(paintPct, 10);

            const fillUnits = parseFillUnits(v).map((f: any) => ({
              fillType: f.fillType,
              fillLevel: Number.isFinite(Number(f.fillLevel)) ? Math.max(0, Number(f.fillLevel)) : 0,
              fillPercentage: Number.isFinite(Number(f.fillPercentage)) ? Math.max(0, Math.min(100, Number(f.fillPercentage))) : 0,
            }));

            const isEngineVehicle = ['TRAKTOR', 'KAMION', 'KOMBAJN', 'TELEHANDLER', 'VILICAR', 'UTOVARIVAC', 'AUTO'].includes(displayTypeKey);
            const isTrailer = displayTypeKey === 'PRIKOLICE' || nameLower.includes('trailer') || vehTypeLower.includes('trailer');
            const isSeeder = displayTypeKey === 'SIJACICE' || nameLower.includes('seeder') || nameLower.includes('planter');
            const isSprayer = displayTypeKey === 'PRSKALICE' || nameLower.includes('sprayer');
            const isImplementLike = !isEngineVehicle && !isTrailer && !isSeeder && !isSprayer;

            const uKey = `${v.farmId || ''}|${(v.name || '').toLowerCase()}`;
            const usage = usageByFarmName.get(uKey);
            const totalTxt = usage ? this.formatHours(this.msToHours(usage.totalMs || 0)) : '0h 00m';
            const movingTxt = usage ? this.formatHours(this.msToHours(usage.movingMs || 0)) : '0h 00m';
            const afkTxt = usage ? this.formatHours(this.msToHours(usage.idleMs || 0)) : '0h 00m';

            const header = `${String(v.name || 'Vozilo').slice(0, 32)} (${this.getVehicleDisplayTypeLabel(category)} • ${this.getVehicleDisplayTypeLabel(displayType)})`;
            let block = `${header}\n`;

            const infoLines: string[] = [];
            infoLines.push(`🛠 ${conditionIcon} ${String(conditionPct).padStart(3)}% ${conditionBar}`);

            if (isEngineVehicle) {
              infoLines.unshift(`⛽ ${String(fuelPct).padStart(3)}% ${fuelBar}`);
            }

            if (isTrailer) {
              if (fillUnits.length > 0) {
                const top = [...fillUnits].sort((a: any, b: any) => (b.fillLevel - a.fillLevel) || (b.fillPercentage - a.fillPercentage))[0];
                const lvl = Math.round(top.fillLevel || 0);
                const pct = Math.round(top.fillPercentage || 0);
                const cap = pct > 0 ? Math.round(lvl / (pct / 100)) : 0;
                const icon = this.getFillTypeIcon(top.fillType);
                const label = this.formatFillTypeLabel(top.fillType);
                const capTxt = cap > 0
                  ? `${lvl.toLocaleString('hr-HR')}/${cap.toLocaleString('hr-HR')}L (${pct}%)`
                  : `${lvl.toLocaleString('hr-HR')}L (${pct}%)`;
                const extra = fillUnits.length > 1 ? ` | +${fillUnits.length - 1} tip` : '';
                infoLines.push(`📦 ${icon} ${label}: ${capTxt}${extra}`);
              }
            } else if (isSeeder || isSprayer) {
              if (fillUnits.length > 0) {
                const top = [...fillUnits]
                  .sort((a: any, b: any) => (b.fillLevel - a.fillLevel) || (b.fillPercentage - a.fillPercentage))
                  .slice(0, 2)
                  .map((f: any) => `${this.getFillTypeIcon(f.fillType)} ${this.formatFillTypeLabel(f.fillType)} ${Math.round(f.fillPercentage || 0)}%`)
                  .join(' | ');
                infoLines.push(`📦 Spremnik: ${top}`);
              }
            } else if (!isImplementLike && fillUnits.length > 0) {
              const top = [...fillUnits]
                .sort((a: any, b: any) => (b.fillLevel - a.fillLevel) || (b.fillPercentage - a.fillPercentage))
                .slice(0, 1)
                .map((f: any) => `${this.getFillTypeIcon(f.fillType)} ${this.formatFillTypeLabel(f.fillType)} ${Math.round(f.fillPercentage || 0)}%`)
                .join('');
              infoLines.push(`📦 ${top}`);
            }

            block += infoLines.join('\n');
            if (showPaintStats && paintBar) block += `\n🎨 ${String(paintPct).padStart(3)}% ${paintBar}`;
            block += `\n⏱ ${totalTxt} | 🚜 ${movingTxt} | 😴 ${afkTxt}`;

            if (usage && Array.isArray(usage.players) && usage.players.length > 0) {
              const aiVehicle = /ai\s*worker/i.test(String(v.name || ''));
              const aggByPlayer = new Map<string, { nickname: string; totalMs: number; movingMs: number; idleMs: number; isAi?: boolean }>();
              for (const p of usage.players) {
                const nick = String(p?.nickname || '').trim();
                const aiLikeNick = /(^|\s)ai(\s|$)|ai\s*worker|worker\s*ai|bot/i.test(nick);
                const isAi = aiVehicle || aiLikeNick;
                const key = isAi
                  ? 'ai:worker'
                  : `n:${nick.toLowerCase().replace(/[^a-z0-9]/g, '') || 'unknown'}`;
                const prev = aggByPlayer.get(key) || { nickname: isAi ? 'AI Worker' : (nick || 'Unknown'), totalMs: 0, movingMs: 0, idleMs: 0, isAi };
                prev.totalMs += Number(p?.totalMs || 0);
                prev.movingMs += Number(p?.movingMs || 0);
                prev.idleMs += Number(p?.idleMs || 0);
                if (!prev.nickname || prev.nickname === 'Unknown') prev.nickname = isAi ? 'AI Worker' : (nick || 'Unknown');
                if (isAi) prev.isAi = true;
                aggByPlayer.set(key, prev);
              }

              const topLimit = selectedVehicleObjs.length ? 10 : 3;
              const topPlayers = [...aggByPlayer.values()]
                .sort((a: any, b: any) => (b.totalMs || 0) - (a.totalMs || 0))
                .slice(0, topLimit);

              const pLine = topPlayers.map((p: any) => {
                const nick = String(p.nickname || 'N/A').slice(0, 10);
                const pTotal = this.formatHours(this.msToHours(p.totalMs || 0));
                const pActive = this.formatHours(this.msToHours(p.movingMs || 0));
                const pAfk = this.formatHours(this.msToHours(p.idleMs || 0));
                const icon = p.isAi ? '🤖' : '👤';
                return `${icon} ${nick} ${pTotal} (🚜 ${pActive} | 😴 ${pAfk})`;
              }).join('\n');

              const extra = aggByPlayer.size > topLimit ? `\n+${aggByPlayer.size - topLimit} više` : '';
              block += `\n${pLine}${extra}`;
            }

            desc += `• ${block.replace(/\n/g, '\n  ')}\n\n`;
          }

          embed.setDescription(desc.slice(0, 3900));
          embed.setFooter({ text: `Prikazano ${slice.length}/${effective.length} vozila | Slavonska Ravnica` });
        }
        break;
      }


      case 'vehicleHistory': {
        const logs = await storage.getLogs(500);
        const items: Array<any> = [];
        for (const l of logs) {
          if (l.type !== 'vehicle_removed') continue;
          try {
            const data = JSON.parse(String(l.message || '{}'));
            items.push(data);
          } catch { /* ignore */ }
        }

        let filtered = items;
        if (farmId) filtered = filtered.filter(x => String(x.farmId || '') === String(farmId));

        filtered = filtered.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

        embed = new EmbedBuilder()
          .setTitle(`Povijest vozila${farmLabel}`)
          .setColor(0x60a5fa)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        if (filtered.length === 0) {
          embed.setDescription('```\nNema evidentiranih prodaja/uklanjanja vozila.\n```');
          break;
        }

        const maxShow = 15;
        const lines: string[] = [];
        for (const it of filtered.slice(0, maxShow)) {
          const at = String(it.at || '').replace('T', ' ').replace('Z', '').slice(0, 16);
          const f = it.farmId ? `F${it.farmId}` : 'F?';
          const name = String(it.name || 'Unknown').slice(0, 40);
          const h = it.usage?.totalMs ? (Number(it.usage.totalMs) / 3600000) : null;
          const hTxt = h !== null ? `${h.toFixed(1)}h` : '—';
          lines.push(`${at} | ${f} | ${name} | ${hTxt}`);
        }

        embed.setDescription(`\`\`\`yaml
${lines.join('\n')}
\`\`\``);
        if (filtered.length > maxShow) {
          embed.setFooter({ text: `Prikazano ${maxShow}/${filtered.length} zapisa | Slavonska Ravnica` });
        }
        break;
      }


      case 'silos': {
        let silos = await storage.getSilos();
        if (farmId) {
          silos = silos.filter(s => String(s.farmId ?? '') === String(farmId));
        }
        
        const totalCapacity = silos.reduce((sum, s) => sum + (s.capacity || 0), 0);
        const totalFilled = silos.reduce((sum, s) => sum + (s.totalFill || 0), 0);
        const overallPercent = totalCapacity > 0 ? Math.round((totalFilled / totalCapacity) * 100) : 0;
        
        embed = new EmbedBuilder()
          .setTitle(`Silosi${farmLabel}`)
          .setColor(0x8b5cf6)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        const messageId = ctx?.messageId || '';
        const pageSize = this.getPageSizeForPanel('silos', 8);
        const pageKey = this.getListPageKey(messageId, 'silos', farmId);
        let page = messageId ? (this.listPageByMessageAndPanel.get(pageKey) || 0) : 0;
        const totalPages = Math.max(1, Math.ceil(silos.length / pageSize));
        if (page >= totalPages) page = totalPages - 1;
        if (messageId) this.listPageByMessageAndPanel.set(pageKey, page);

        if (silos.length === 0) {
          embed.setDescription('```\nNema podataka o silosima.\n```');
        } else {
          const fillLevelsAsObj = (s: any) => {
            const raw = (s as any).fillLevels as any;
            if (Array.isArray(raw)) {
              const map: Record<string, number> = {};
              for (const x of raw) {
                const key = this.normalizeFillType(x.fillType || x.type || x.name || '');
                const val = Number(x.level ?? x.amount ?? x.fillLevel ?? 0);
                if (!key || !Number.isFinite(val) || val <= 0) continue;
                map[key] = (map[key] || 0) + val;
              }
              return map;
            }
            if (raw && typeof raw === 'object') {
              const map: Record<string, number> = {};
              for (const [k, v] of Object.entries(raw)) {
                const key = this.normalizeFillType(k);
                const val = Number(v);
                if (!key || !Number.isFinite(val) || val <= 0) continue;
                map[key] = (map[key] || 0) + val;
              }
              return map;
            }
            return {};
          };

              const scoreSilo = (s: any, obj: Record<string, number>, pct: number) => {
                const name = String((s as any).name || '').toLowerCase();
            const entries = obj && typeof obj === 'object' ? Object.entries(obj).filter(([_, v]) => Number(v) > 0) : [];
            const types = entries.map(([k]) => String(k).toLowerCase());

            // hr: voda i tankovi idu na dno
            const isWatery = name.includes('water') || types.every(t => t.includes('water'));

            // hr: silaza / chaff / digestate su high priority (server signal)
            const hasSilage = types.some(t => t.includes('silage') || t.includes('chaff'));
            const hasCrop = types.some(t => !t.includes('water') && !t.includes('diesel') && !t.includes('def') && !t.includes('milk'));

            let score = 0;
            if (hasSilage) score += 300;
            if (hasCrop) score += 200;
            if (pct >= 85) score += 40;
            if (pct >= 50) score += 20;
            if (isWatery) score -= 500;
            return score;
          };

          const prepared = silos.map((s: any) => {
            const fillLevels = fillLevelsAsObj(s);
            const pct = Number(s?.percent || 0);
            const totalFill = Number(s?.totalFill || 0);
            const hasContent = totalFill > 0 || pct > 0 || Object.keys(fillLevels).length > 0;
            const score = scoreSilo(s, fillLevels, pct);
            return { s, fillLevels, pct, totalFill, hasContent, score };
          });

          prepared.sort((a: any, b: any) => {
            const aHas = a.hasContent ? 1 : 0;
            const bHas = b.hasContent ? 1 : 0;
            return (bHas - aHas)
              || (b.score - a.score)
              || (b.pct - a.pct)
              || (b.totalFill - a.totalFill);
          });

          const start = page * pageSize;
          const slice = prepared.slice(start, start + pageSize);

          let desc = `\`\`\`yaml\nUkupno: ${silos.length} | Popunjenost: ${overallPercent}% | Stranica: ${page + 1}/${totalPages}\n\`\`\`\n`;
          desc += `🧭 **Legenda kultura:** 🌾 žitarice | 🌽 kukuruz/maize | 🟡 canola | 🍬 beet | 🥔 potato | 🍇 grapes | 🫒 olives | 🌿 grass/silage\n\n`;

          for (const item of slice) {
            const s = item.s;
            const rawPercent = Number(item.pct || 0);
            const percent = Math.round(rawPercent);
            // Dogovor: ako je barem 1%, odmah prikaži 1 kockicu
            const minChunkPct = 100 / 12;
            const barPercent = (rawPercent >= 1 && rawPercent < minChunkPct) ? minChunkPct : rawPercent;
            const bar = this.getColoredBar(barPercent, 12);
            const name = (s.name || 'Silos').slice(0, 32);
            const fill = Math.round(s.totalFill || 0).toLocaleString('hr-HR');
            const cap = Math.round(s.capacity || 0).toLocaleString('hr-HR');

            const fillLevels = item.fillLevels;
            const top = (fillLevels && typeof fillLevels === 'object')
              ? Object.entries(fillLevels)
                .filter(([_, v]) => Number(v) > 0)
                .sort((a, b) => Number(b[1]) - Number(a[1]))
                .slice(0, 5)
              : [];
            const allEntries = (fillLevels && typeof fillLevels === 'object')
              ? Object.entries(fillLevels)
                  .filter(([_, v]) => Number(v) > 0)
                  .sort((a, b) => Number(b[1]) - Number(a[1]))
              : [];
            const inferFillTypeFromName = (rawName: string): string | null => {
              const n = String(rawName || '').toUpperCase();
              if (!n) return null;
              if (n.includes('PETROL') || n.includes('DIESEL') || n.includes('FUEL')) return 'DIESEL';
              if (n.includes('DEF') || n.includes('ADBLUE')) return 'DEF';
              if (n.includes('WATER')) return 'WATER';
              if (n.includes('MILK')) return 'MILK';
              if (n.includes('FERTILIZER')) return 'FERTILIZER';
              if (n.includes('LIME')) return 'LIME';
              if (n.includes('SEED')) return 'SEEDS';
              if (n.includes('MANURE')) return 'MANURE';
              if (n.includes('SLURRY')) return 'SLURRY';
              if (n.includes('SILAGE')) return 'SILAGE';
              if (n.includes('GRAIN') || n.includes('WHEAT') || n.includes('BARLEY') || n.includes('OAT') || n.includes('MAIZE') || n.includes('CORN')) return 'GRAIN';
              return null;
            };
            const inferredFillType = inferFillTypeFromName(String(s?.name || ''));
            const fallbackTop = (!top.length && Number(s?.totalFill || 0) > 0 && inferredFillType)
              ? [[inferredFillType, Number(s?.totalFill || 0)]]
              : [];
            const displayTop = top.length ? top : fallbackTop;
            const topTxt = displayTop.length
              ? displayTop.map(([k, v]) => `${this.getFillTypeIcon(k)} ${this.formatFillTypeLabel(String(k))} ${Math.round(Number(v)).toLocaleString('hr-HR')}L`).join(' | ')
              : '—';
            const extraCount = Math.max(0, allEntries.length - top.length);
            const extraTxt = extraCount > 0 ? ` | +${extraCount} više` : '';

            desc += `\`\`\`text\n${name}\n[${bar}] ${String(percent).padStart(3)}%  ${fill}/${cap} L\nSadržaj: ${topTxt}${extraTxt}\n\`\`\`\n`;
          }

          embed.setDescription(desc.slice(0, 3900));
          embed.setFooter({ text: `Silos | Page ${page + 1}/${totalPages} | Slavonska Ravnica` });
        }
        break;
      }


      case 'animals': {
        let animals = await storage.getAnimals();
        if (farmId) {
          animals = animals.filter(a => a.farmId === farmId);
        }

        const totalAnimals = animals.reduce((sum, a) => sum + (a.numAnimals || 0), 0);
        const avgHealth = totalAnimals > 0
          ? Math.round(animals.reduce((sum, a) => sum + ((a.health || 0) * (a.numAnimals || 0)), 0) / totalAnimals)
          : 0;

        embed = new EmbedBuilder()
          .setTitle(`Zivotinje${farmLabel}`)
          .setColor(0xec4899)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        if (animals.length === 0) {
          embed.setDescription('```\nNema podataka o zivotinjama.\n```');
        } else {
          const normType = (t: any) => {
            const s = String(t || '').toUpperCase();
            if (s.includes('CHICKEN')) return 'CHICKEN';
            if (s.includes('COW')) return 'COW';
            if (s.includes('PIG')) return 'PIG';
            if (s.includes('SHEEP')) return 'SHEEP';
            if (s.includes('HORSE')) return 'HORSE';
            return 'OTHER';
          };

          const groupMeta: Array<{ key: string; title: string }> = [
            { key: 'CHICKEN', title: '🐔 PILICI' },
            { key: 'COW', title: '🐄 KRAVE' },
            { key: 'PIG', title: '🐖 SVINJE' },
            { key: 'SHEEP', title: '🐑 OVCE' },
            { key: 'HORSE', title: '🐎 KONJI' },
            { key: 'OTHER', title: '🐾 OSTALO' }
          ];

          const groups = new Map<string, any[]>();
          for (const a of animals) {
            const k = normType(a.animalType || a.name);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k)!.push(a);
          }

          const nameCounts = new Map<string, number>();
          const makeName = (raw: string) => {
            const base = (raw || 'Husbandry').trim();
            const n = (nameCounts.get(base) || 0) + 1;
            nameCounts.set(base, n);
            return n === 1 ? base : `${base} #${n}`;
          };

          const husbandryCounts = Array.from(groups.entries()).reduce((acc, [type, arr]) => {
            acc[type] = arr.length;
            return acc;
          }, {} as Record<string, number>);

          const avgProd = totalAnimals > 0
            ? Math.round(animals.reduce((sum, a) => sum + ((Number((a as any).productivity || 0)) * (a.numAnimals || 0)), 0) / totalAnimals)
            : 0;

          const lowHealth = animals.filter(a => Number(a.health || 0) < 70).length;
          const lowProd = animals.filter(a => Number((a as any).productivity || 0) < 60).length;
          const lowFood = animals.filter(a => {
            const foodArr = Array.isArray((a as any).food) ? (a as any).food : [];
            if (!foodArr.length) return false;
            const top = Math.max(...foodArr.map((f: any) => this.normalizePercent(f?.percent ?? f?.level ?? f ?? 0)));
            return Number(top) < 40;
          }).length;

          let desc = [
            `📊 **Pregled stoke**`,
            `• Ukupno životinja: **${totalAnimals.toLocaleString('hr-HR')}**`,
            `• Prosj. zdravlje: **${avgHealth}%**`,
            `• Prosj. produktivnost: **${avgProd}%**`,
            `• Objekata: **${animals.length}** (🐔 ${husbandryCounts['CHICKEN'] || 0} | 🐄 ${husbandryCounts['COW'] || 0} | 🐖 ${husbandryCounts['PIG'] || 0} | 🐑 ${husbandryCounts['SHEEP'] || 0} | 🐎 ${husbandryCounts['HORSE'] || 0})`,
            '',
            `🚨 **Upozorenja**`,
            `• Nisko zdravlje (<70%): **${lowHealth}**`,
            `• Niska produktivnost (<60%): **${lowProd}**`,
            `• Niska hrana (<40%): **${lowFood}**`,
            ''
          ].join('\n');

          let shownRows = 0;
          const maxRows = 12;

          const statusBadge = (health: number, prod: number, foodPct: number) => {
            if (health < 70 || prod < 60 || foodPct < 40) return '🔴';
            if (health < 85 || prod < 80 || foodPct < 60) return '🟡';
            return '🟢';
          };

          for (const g of groupMeta) {
            const list = (groups.get(g.key) || [])
              .slice()
              .sort((a, b) => (b.numAnimals || 0) - (a.numAnimals || 0));

            const groupTotal = list.reduce((s, a) => s + (a.numAnimals || 0), 0);
            if (!list.length) continue;

            const weightedHealth = groupTotal > 0
              ? Math.round(list.reduce((s, a) => s + (Number(a.health || 0) * Number(a.numAnimals || 0)), 0) / groupTotal)
              : 0;
            const weightedProd = groupTotal > 0
              ? Math.round(list.reduce((s, a) => s + (Number((a as any).productivity || 0) * Number(a.numAnimals || 0)), 0) / groupTotal)
              : 0;

            desc += `**${g.title} — ${groupTotal.toLocaleString('hr-HR')}**\n`;
            desc += `• ❤️ ${weightedHealth}% | ⚡ ${weightedProd}% | 🏠 ${list.length}\n`;

            const lines: string[] = [];
            for (const a of list) {
              if (shownRows >= maxRows) break;
              const count = Number(a.numAnimals || 0);
              if (count <= 0) continue;

              const health = Math.round(Number(a.health || 0));
              const prod = Math.round(Number((a as any).productivity || 0));
              const foodArr = Array.isArray(a.food) ? a.food : [];
              const foodPct = foodArr.length
                ? Math.round(Math.max(...foodArr.map((f: any) => this.normalizePercent(f?.percent ?? f?.level ?? f ?? 0))))
                : 0;

              const outArr = Array.isArray(a.outputs) ? a.outputs : [];
              const outByType = new Map<string, number>();
              for (const o of outArr) {
                const type = this.normalizeFillType(o?.fillType || o?.type || o?.title || '');
                const amount = Number(o?.amount ?? o?.fillLevel ?? o?.level ?? 0);
                if (!type || !Number.isFinite(amount) || amount <= 0) continue;
                outByType.set(type, (outByType.get(type) || 0) + amount);
              }

              const milk = outByType.get('MILK') || 0;
              const manure = outByType.get('MANURE') || 0;
              const slurry = outByType.get('SLURRY') || 0;
              const outputsTxt = [
                milk > 0 ? `🥛${Math.round(milk).toLocaleString('hr-HR')}L` : null,
                manure > 0 ? `💩${Math.round(manure).toLocaleString('hr-HR')}L` : null,
                slurry > 0 ? `🧪${Math.round(slurry).toLocaleString('hr-HR')}L` : null,
              ].filter(Boolean).join(' ');

              const label = makeName(String(a.name || a.animalType || 'Objekt')).slice(0, 22);
              const occupancy = a.maxAnimals ? `${count}/${a.maxAnimals}` : `${count}`;
              const badge = statusBadge(health, prod, foodPct);
              const core = `${badge} ${label} • 🐾 ${occupancy} • ❤️ ${health}% • ⚡ ${prod}% • 🍽 ${foodPct}%`;
              lines.push(outputsTxt ? `${core} • ${outputsTxt}` : core);
              shownRows += 1;
            }

            desc += lines.length ? `${lines.join('\n')}\n\n` : `• (nema aktivnih)\n\n`;
            if (shownRows >= maxRows) break;
          }

          if (shownRows >= maxRows) desc += `… prikaz skraćen (max ${maxRows} objekata)`;

          embed.setDescription(desc.slice(0, 3900));
        }
        break;
      }
      case 'weather': {
        const weather = await storage.getWeather();
        const current = (weather as any)?.current ?? {};
        const hourly = Array.isArray((weather as any)?.hourly) ? (weather as any).hourly : [];
        const daily = Array.isArray((weather as any)?.daily) ? (weather as any).daily : [];
        let desc = '';
        embed = new EmbedBuilder()
          .setTitle('Vremenska Prognoza')
          .setColor(0x0ea5e9)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        const fmtTemp = (v: any, digits: number = 1) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return '—';
          const s = n.toFixed(digits);
          return s.replace(/\.0$/, '');
        };

        const fmtInt = (v: any) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return '—';
          return String(Math.round(n));
        };

        const label = (t: any) => {
          const s = String(t || '').toLowerCase();
          if (s.includes('sun') || s.includes('clear')) return 'Vedro';
          if (s.includes('overcast')) return 'Naoblaka';
          if (s.includes('cloud')) return 'Oblačno';
          if (s.includes('rain')) return 'Kiša';
          if (s.includes('storm') || s.includes('thunder')) return 'Oluja';
          if (s.includes('snow')) return 'Snijeg';
          if (s.includes('fog') || s.includes('mist')) return 'Magla';
          return (String(t || 'N/A')).slice(0, 18);
        };

        const icon = (t: any) => {
          const s = String(t || '').toLowerCase();
          if (s.includes('sun') || s.includes('clear')) return '☀️';
          if (s.includes('storm') || s.includes('thunder')) return '⛈️';
          if (s.includes('rain')) return '🌧️';
          if (s.includes('snow')) return '❄️';
          if (s.includes('fog') || s.includes('mist')) return '🌫️';
          if (s.includes('overcast')) return '☁️';
          if (s.includes('cloud')) return '☁️';
          return '🌡️';
        };
        // We don't know the exact in-game "now" hour here, so we treat the first hourly item as "now/next".
        // To avoid misleading status (e.g. always rainy), we also show the next few hours for "today".
        const cType = (current as any).weatherType || (hourly[0]?.weatherType ?? 'N/A');
        const cBits: string[] = [];
        cBits.push(`${icon(cType)} ${label(cType)}`);
        const nowTemp = (current as any).temperature ?? hourly[0]?.temperature;
        cBits.push(`🌡 ${fmtTemp(nowTemp)}°C`);
        const nowWind = (current as any).windSpeed ?? hourly[0]?.windSpeed;
        if (nowWind !== undefined && nowWind !== null && nowWind !== '') {
          cBits.push(`💨 ${fmtTemp(nowWind, 0)} m/s`);
        }
        desc += `\`\`\`yaml
SADA/USKORO: ${cBits.join(' | ')}
\`\`\`
`;

        // Today: next 6 hours
        const baseDay = hourly.length ? Math.min(...hourly.map((h: any) => Number(h?.day)).filter((n: number) => Number.isFinite(n))) : 0;

        const fmtTime = (t: any) => {
          const n = Number(t);
          if (!Number.isFinite(n)) return '--:--';
          const toHHmm = (totalMinutes: number) => {
            const safe = ((Math.floor(totalMinutes) % 1440) + 1440) % 1440;
            const hh = Math.floor(safe / 60);
            const mm = safe % 60;
            return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
          };

          // 0..48 -> sati (float)
          if (n >= 0 && n <= 48) return toHHmm((n % 24) * 60);
          // 0..1440 -> minute u danu
          if (n >= 0 && n < 1440) return toHHmm(n);
          // 0..86400 -> sekunde u danu
          if (n >= 0 && n < 86400) return toHHmm(n / 60);

          // Veće vrijednosti su obično gameTime u milisekundama/tickovima (npr. 61199673.55)
          // Pretvorba: ms -> minute, pa modulo 24h.
          return toHHmm((n / 1000) / 60);
        };

        const todayHours = hourly
          .filter((h: any) => Number(h?.day) === baseDay)
          .sort((a: any, b: any) => Number(a?.time ?? 0) - Number(b?.time ?? 0))
          .slice(0, 6);

        desc += `\`\`\`fix
DANAS (sljedecih par sati)
\`\`\`
`;

        if (todayHours.length === 0) {
          desc += '```\nNema satne prognoze za danas.\n```\n';
        } else {
          const colTime = 6;
          const colWeather = 14;
          const colTemp = 6;
          const header = ['Vrijeme'.padEnd(colTime), 'Prognoza'.padEnd(colWeather), 'Temp'.padStart(colTemp)].join(' ');
          const rows = todayHours.map((h: any) => {
            // Prikaz vremena uvijek u 24h formatu
            const t = fmtTime(h.time).padEnd(colTime);
            const wType = h.weatherType || 'N/A';
            const w = (`${icon(wType)} ${label(wType)}`).slice(0, colWeather).padEnd(colWeather);
            const temp = `${fmtTemp(h.temperature)}°`.padStart(colTemp);
            return [t, w, temp].join(' ');
          });
          desc += `\`\`\`text
${header}
${rows.join('\n')}
\`\`\`\n`;
        }

        // Other days (daily)
        desc += `\`\`\`fix
OSTALI DANI (dnevna prognoza)
\`\`\`
`;

        if (daily.length === 0) {
          desc += '```\nNema dnevne prognoze.\n```';
        } else {
          const header = ['Dan'.padEnd(4), 'Vrijeme'.padEnd(14), 'Min'.padStart(4), 'Max'.padStart(4)].join(' ');
          const rows = daily.slice(0, 7).map((d: any, i: number) => {
            // We use D0/D1... instead of calendar dates because server day length can be 1–2 in-game days per "month".
            const day = (`D${i}`).padEnd(4);
            const wType = d.weatherType || 'N/A';
            const w = (`${icon(wType)} ${label(wType)}`).slice(0, 14).padEnd(14);
            const min = fmtInt(d.minTemp).padStart(4);
            const max = fmtInt(d.maxTemp).padStart(4);
            return [day, w, min, max].join(' ');
          });
          desc += `\`\`\`text
${header}
${rows.join('\n')}
\`\`\``;
        }

        embed.setDescription(desc);
        break;
      }

      case 'productions': {
        let productions = await storage.getProductions();
        if (farmId) {
          productions = productions.filter(p => String(p.farmId ?? '') === String(farmId));
        }

        embed = new EmbedBuilder()
          .setTitle(`Proizvodnje${farmLabel}`)
          .setColor(0x6366f1)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica' });

        const messageId = ctx?.messageId || '';
        const pageSize = this.getPageSizeForPanel('productions', 4);
        const pageKey = this.getListPageKey(messageId, 'productions', farmId);
        let page = messageId ? (this.listPageByMessageAndPanel.get(pageKey) || 0) : 0;
        // NOTE: we paginate over (owned || all) below

        if (productions.length === 0) {
          embed.setDescription('```\nNema podataka o proizvodnjama.\n```');
          break;
        }

        const owned = productions.filter(p => !!(p as any).isOwned);
        const notOwnedCount = productions.length - owned.length;

        const fmtNum = (n: number) => Math.round(n).toLocaleString('hr-HR');

        const statusIcon = (s: string) => {
          const t = (s || '').toLowerCase();
          if (t.includes('run') || t.includes('active') || t.includes('producing')) return '▶️';
          if (t.includes('pause') || t.includes('stopp') || t.includes('sleep')) return '⏸️';
          if (t.includes('error') || t.includes('block') || t.includes('stuck')) return '⚠️';
          return '⚪';
        };

        const pctOf = (amount: any, cap: any) => {
          const a = Number(amount);
          const c = Number(cap);
          if (!Number.isFinite(a) || !Number.isFinite(c) || c <= 0) return null;
          return Math.max(0, Math.min(100, Math.round((a / c) * 100)));
        };

        const itemLine = (it: any) => {
          const type = String(it?.fillType || it?.type || 'N/A');
          const amount = Number(it?.amount ?? it?.level ?? it?.fillLevel ?? 0);
          const cap = it?.capacity ?? it?.maxCapacity ?? it?.max ?? null;
          const pct = pctOf(amount, cap);
          const pctTxt = pct == null ? '' : ` (${pct}%)`;
          const capTxt = cap ? `/${fmtNum(Number(cap))}` : '';
          return `- ${type}: ${fmtNum(amount)}${capTxt}${pctTxt}`;
        };

        const list = (owned.length ? owned : productions)
          .slice()
          .sort((a: any, b: any) => (Number(b.isOwned) - Number(a.isOwned)) || String(a.name || '').localeCompare(String(b.name || '')));

        const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
        if (page >= totalPages) page = totalPages - 1;
        if (messageId) this.listPageByMessageAndPanel.set(pageKey, page);
        const start = page * pageSize;
        const slice = list.slice(start, start + pageSize);

        let desc = `\`\`\`yaml\nOwned: ${owned.length}/${productions.length} | Stranica: ${page + 1}/${totalPages}\n\`\`\`\n`;

        for (const pr of slice) {
          const name = String((pr as any).name || 'Production').slice(0, 40);
          const st = String((pr as any).status || 'N/A');
          const icon = statusIcon(st);
          const ins = Array.isArray((pr as any).inputs) ? (pr as any).inputs : [];
          const outs = Array.isArray((pr as any).outputs) ? (pr as any).outputs : [];

          const inTop = ins.slice().sort((a: any, b: any) => Number(b.amount || 0) - Number(a.amount || 0)).slice(0, 3);
          const outTop = outs.slice().sort((a: any, b: any) => Number(b.amount || 0) - Number(a.amount || 0)).slice(0, 3);

          desc += `\`\`\`text\n${icon} ${name}\nSTATUS: ${st}\nIN: ${inTop.length ? inTop.map((x: any) => `${this.getFillTypeIcon(x.fillType)} ${this.formatFillTypeLabel(x.fillType)}:${fmtNum(Number(x.amount||0))}`).join(' | ') : '—'}\nOUT: ${outTop.length ? outTop.map((x: any) => `${this.getFillTypeIcon(x.fillType)} ${this.formatFillTypeLabel(x.fillType)}:${fmtNum(Number(x.amount||0))}`).join(' | ') : '—'}\n\`\`\`\n`;
        }

        embed.setDescription(desc.slice(0, 3900));
        if (notOwnedCount > 0) {
          embed.setFooter({ text: `Ne-kupljeno: ${notOwnedCount} | Page ${page + 1}/${totalPages} | Slavonska Ravnica` });
        } else {
          embed.setFooter({ text: `Productions | Page ${page + 1}/${totalPages} | Slavonska Ravnica` });
        }
        break;
      }
      case 'players': {
        const now = new Date();
        const windowMin = 15;
        const onlineWindowSec = Math.max(10, Number(process.env.RUNTIME_ONLINE_WINDOW_SEC || '45') || 45);
        const onlineWindowMs = onlineWindowSec * 1000;
        const normPlayerKey = (v: any) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        const isLikelyEpochMs = (value: number) => Number.isFinite(value) && value > 946684800000;
        const webstats = await getWebStatsSummaryFromEnv().catch(() => null as any);
        const wsFreshWindowMs = Math.max(30000, Number(process.env.WEBSTATS_FRESH_WINDOW_MS || '180000') || 180000);
        const wsUpdatedAtMs = webstats?.summary?.rawUpdatedAt ? Date.parse(String(webstats.summary.rawUpdatedAt)) : NaN;
        const wsIsFresh = Number.isFinite(wsUpdatedAtMs) && (now.getTime() - wsUpdatedAtMs) <= wsFreshWindowMs;
        const wsOnlineByName = new Set(
          wsIsFresh
            ? (webstats?.summary?.players || [])
                .map((p: any) => normPlayerKey(p?.name || ''))
                .filter((x: string) => !!x)
            : []
        );

        const isActiveWindow = (d?: Date) => !!d && (now.getTime() - d.getTime()) <= windowMin * 60 * 1000;

        const runtimePlayers = [...this.runtimePlayerTimes.values()];
        const allStoredPlayers = await storage.getPlayers();
        const storedPlayers = allStoredPlayers;

        const toKnownPlayerKey = (uniqueUserId: any, playerName: any): string => {
          const idPart = String(uniqueUserId || '').trim();
          if (idPart) return `id:${idPart}`;
          const namePart = normPlayerKey(playerName || '');
          return namePart ? `name:${namePart}` : '';
        };
        const globalKnownPlayerKeys = new Set<string>();
        for (const stored of allStoredPlayers) {
          const knownKey = toKnownPlayerKey((stored as any).uniqueUserId, (stored as any).name);
          if (knownKey) globalKnownPlayerKeys.add(knownKey);
        }
        for (const runtime of runtimePlayers) {
          const knownKey = toKnownPlayerKey((runtime as any).uniqueUserId || (runtime as any).id, (runtime as any).nickname);
          if (knownKey) globalKnownPlayerKeys.add(knownKey);
        }
        const globalKnownPlayersCount = globalKnownPlayerKeys.size;

        // index runtime by uniqueUserId (fallback to id/nickname)
        const rtByKey = new Map<string, any>();
        const rtByNameLower = new Map<string, any>();
        const rtByNameNorm = new Map<string, any>();
        for (const rp of runtimePlayers) {
          const k = rp.uniqueUserId || rp.id || rp.nickname;
          if (!k) continue;
          rtByKey.set(String(k), rp);
          const nk = String(rp.nickname || '').trim().toLowerCase();
          if (nk) rtByNameLower.set(nk, rp);
          const nn = normPlayerKey(rp.nickname || rp.id || '');
          if (nn) rtByNameNorm.set(nn, rp);
        }

        const spByKey = new Map<string, any>();
        const spByNameLower = new Map<string, any>();
        const spByNameNorm = new Map<string, any>();
        for (const sp of allStoredPlayers) {
          const k = String((sp as any).uniqueUserId || '').trim();
          if (k) spByKey.set(k, sp);
          const nk = String((sp as any).name || '').trim().toLowerCase();
          if (nk) spByNameLower.set(nk, sp);
          const nn = normPlayerKey((sp as any).name || '');
          if (nn) spByNameNorm.set(nn, sp);
        }

        type Row = {
          key: string;
          name: string;
          farmId?: string | null;
          totalHours: number;
          isOnline: boolean;
          onlineNow: boolean;
          active15m: boolean;
          afkMs?: number;
          currentSessionMs?: number;
          idleMin?: number;
          lastPlayed?: Date | null;
        };

        const rows: Row[] = [];
        const trackById = new Map((this.playerTracks || []).map(t => [String(t.id || ''), t]));
        const trackByName = new Map((this.playerTracks || []).map(t => [String(t.nickname || '').toLowerCase(), t]));

        const farmByPlayerId = new Map<string, string>();
        const farmByPlayerName = new Map<string, string>();
        for (const usage of Array.from(this.runtimeVehicleUsage.values())) {
          const farm = String((usage as any)?.farmId || '').trim();
          if (!farm) continue;
          const players = Array.isArray((usage as any)?.players) ? (usage as any).players : [];
          for (const pl of players) {
            const pid = String((pl as any)?.id || '').trim();
            const pname = String((pl as any)?.nickname || '').trim().toLowerCase();
            if (pid && !farmByPlayerId.has(pid)) farmByPlayerId.set(pid, farm);
            if (pname && !farmByPlayerName.has(pname)) farmByPlayerName.set(pname, farm);
          }
        }

        const maxSeenMs = runtimePlayers
          .map((p: any) => Number(p?.lastSeenAtMs))
          .filter((n: number) => Number.isFinite(n))
          .reduce((m: number, n: number) => Math.max(m, n), 0);
        const isOnlineNow = (rt: any) => {
          if (!rt) return false;
          if (typeof rt?.currentlyOnline === 'boolean') return rt.currentlyOnline;
          const seen = Number(rt?.lastSeenAtMs);
          if (Number.isFinite(seen)) {
            if (isLikelyEpochMs(seen)) {
              const delta = now.getTime() - seen;
              return delta >= -5000 && delta <= onlineWindowMs;
            }
            if (maxSeenMs > 0) return (maxSeenMs - seen) <= onlineWindowMs;
          }
          const lastOnline = rt?.lastOnlineAt ? Date.parse(String(rt.lastOnlineAt)) : NaN;
          if (Number.isFinite(lastOnline)) return (now.getTime() - lastOnline) <= onlineWindowMs;
          return false;
        };
        const isOnlineStrictNow = (rt: any) => {
          if (!rt) return false;
          const strictWindowMs = Math.min(120000, Math.max(15000, Number(process.env.RUNTIME_ONLINE_STRICT_WINDOW_MS || '45000') || 45000));
          const seen = Number(rt?.lastSeenAtMs);
          if (Number.isFinite(seen)) {
            if (isLikelyEpochMs(seen)) {
              const delta = now.getTime() - seen;
              return delta >= -5000 && delta <= strictWindowMs;
            }
            if (maxSeenMs > 0) return (maxSeenMs - seen) <= strictWindowMs;
          }
          const lastOnline = rt?.lastOnlineAt ? Date.parse(String(rt.lastOnlineAt)) : NaN;
          if (Number.isFinite(lastOnline)) return (now.getTime() - lastOnline) <= strictWindowMs;
          return rt?.currentlyOnline === true;
        };
        const isTrackOnlineStrict = (track: any) => {
          if (!track) return false;
          const strictWindowMs = Math.min(300000, Math.max(45000, Number(process.env.TRACK_ONLINE_STRICT_WINDOW_MS || '120000') || 120000));
          const lastMoveMs = Number(track?.lastMoveMs);
          const sessionStartMs = Number(track?.sessionStartMs);
          const latestMs = Math.max(
            Number.isFinite(lastMoveMs) ? lastMoveMs : 0,
            Number.isFinite(sessionStartMs) ? sessionStartMs : 0
          );
          if (!Number.isFinite(latestMs) || latestMs <= 0) return false;
          const delta = now.getTime() - latestMs;
          return delta >= 0 && delta <= strictWindowMs;
        };

        for (const sp of storedPlayers) {
          const key = String(sp.uniqueUserId);
          const rt = rtByKey.get(key);
          const track = trackById.get(key) || trackByName.get(String(sp.name || '').toLowerCase());
          const sessionKey = String((rt?.uniqueUserId || key || rt?.id || sp.name || '').trim());
          const runtimeSessionStart = this.runtimeSessionStartedAtByPlayer.get(sessionKey);

          const totalHoursStored = Number(sp.playTime || 0);
          const afkMs = rt && Number.isFinite(Number(rt.totalAfkMs)) ? Number(rt.totalAfkMs) : undefined;
          const sessionStartMs = track && Number.isFinite(Number(track.sessionStartMs)) ? Number(track.sessionStartMs) : undefined;
          const currentSessionMs = runtimeSessionStart
            ? Math.max(0, now.getTime() - runtimeSessionStart.getTime())
            : (sessionStartMs ? Math.max(0, now.getTime() - sessionStartMs) : undefined);
          // Use stored total + current ongoing session if online
          const totalHours = totalHoursStored + (currentSessionMs ? currentSessionMs / 3600000 : 0);
          const idleMin = rt && rt.lastActivityRealAt ? Math.max(0, Math.round((now.getTime() - rt.lastActivityRealAt.getTime()) / 60000)) : undefined;

          const snapshotExplicitOffline = sp.isOnline === false;
          const runtimeOnline = isOnlineNow(rt);
          const runtimeOnlineStrict = isOnlineStrictNow(rt);
          const trackOnlineStrict = isTrackOnlineStrict(track);
          const webstatsOnline = wsOnlineByName.has(normPlayerKey(sp.name || ''));
          const effectiveOnline = snapshotExplicitOffline
            ? (runtimeOnlineStrict || trackOnlineStrict || webstatsOnline)
            : (runtimeOnlineStrict || trackOnlineStrict || webstatsOnline || runtimeOnline);

          const farmResolved = String(
            sp.farmId
            ?? rt?.farmId
            ?? farmByPlayerId.get(String(sp.uniqueUserId || '').trim())
            ?? farmByPlayerName.get(String(sp.name || '').trim().toLowerCase())
            ?? ''
          ).trim();

          rows.push({
            key,
            name: sp.name,
            farmId: farmResolved || null,
            totalHours,
            isOnline: effectiveOnline,
            onlineNow: effectiveOnline,
            active15m: isActiveWindow(rt?.lastActivityRealAt) || (effectiveOnline && (idleMin == null || idleMin <= windowMin)),
            afkMs,
            currentSessionMs,
            idleMin,
            lastPlayed: sp.lastPlayed || null,
          });
        }

        // include runtime-only players not in stored list (edge case)
        for (const rt of runtimePlayers) {
          const k = String(rt.uniqueUserId || rt.id || rt.nickname || '');
          if (!k) continue;
          if (rows.some(r => r.key === k || normPlayerKey(r.name) === normPlayerKey(rt.nickname))) continue;
          const inferred = spByKey.get(String(rt.uniqueUserId || ''))
            || spByNameLower.get(String(rt.nickname || '').toLowerCase())
            || spByNameNorm.get(normPlayerKey(rt.nickname || ''));
          const inferredFarmId = String(
            (inferred as any)?.farmId
            ?? rt?.farmId
            ?? farmByPlayerId.get(String(rt.uniqueUserId || rt.id || '').trim())
            ?? farmByPlayerName.get(String(rt.nickname || '').trim().toLowerCase())
            ?? ''
          ).trim();
          const runtimeOnline = isOnlineNow(rt);
          const track = trackById.get(k) || trackByName.get(String(rt.nickname || '').toLowerCase());
          const trackOnlineStrict = isTrackOnlineStrict(track);
          const webstatsOnline = wsOnlineByName.has(normPlayerKey(rt.nickname || k));
          const sessionKey = String((rt.uniqueUserId || k || rt.id || rt.nickname || '').trim());
          const runtimeSessionStart = this.runtimeSessionStartedAtByPlayer.get(sessionKey);
          const afkMs = Number.isFinite(Number(rt.totalAfkMs)) ? Number(rt.totalAfkMs) : undefined;
          const sessionStartMs = track && Number.isFinite(Number(track.sessionStartMs)) ? Number(track.sessionStartMs) : undefined;
          const currentSessionMs = runtimeSessionStart
            ? Math.max(0, now.getTime() - runtimeSessionStart.getTime())
            : (sessionStartMs ? Math.max(0, now.getTime() - sessionStartMs) : undefined);
          const idleMin = rt.lastActivityRealAt ? Math.max(0, Math.round((now.getTime() - rt.lastActivityRealAt.getTime()) / 60000)) : undefined;

          rows.push({
            key: k,
            name: rt.nickname || k,
            farmId: inferredFarmId || null,
            totalHours: currentSessionMs ? currentSessionMs / 3600000 : 0,
            isOnline: false,
            onlineNow: runtimeOnline || trackOnlineStrict || webstatsOnline,
            active15m: isActiveWindow(rt.lastActivityRealAt) || ((runtimeOnline || trackOnlineStrict || webstatsOnline) && (idleMin == null || idleMin <= windowMin)),
            afkMs,
            currentSessionMs,
            idleMin,
            lastPlayed: null,
          });
        }

        const onlineRows = rows.filter(r => r.onlineNow);
        const activeRows = rows.filter(r => r.active15m && r.onlineNow);

        const totalHoursSum = rows.reduce((s, r) => s + (r.totalHours || 0), 0);

        const fmtHours = (h: number) => this.formatHours(h);

        const fmtHHmm = (ms?: number) => {
          if (ms == null || !Number.isFinite(ms) || ms < 0) return '--:--';
          const totalMin = Math.floor(ms / 60000);
          const hh = Math.floor(totalMin / 60);
          const mm = totalMin % 60;
          return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        };

        embed = new EmbedBuilder()
          .setTitle('👥 Igraci')
          .setColor(0x10b981)
          .setTimestamp()
          .setFooter({ text: 'RuntimeStats | Zadnje: sad' });

        if (rows.length === 0) {
          embed.setDescription('```\nNema podataka o igracima.\n```');
          break;
        }

        let desc = '';
        desc += `🟢 Aktivni (${windowMin}m): **${activeRows.length}** • 👥 Online: **${onlineRows.length}** • 📚 Poznatih: **${globalKnownPlayersCount}** • ⏱ Ukupno: **${Math.round(totalHoursSum)}h**\n\n`;

        if (onlineRows.length > 0) {
          // Group online players by farm, sorted by farmId
          const byFarm = new Map<string, typeof onlineRows>();
          for (const r of [...onlineRows].sort((a, b) => (Number(b.active15m) - Number(a.active15m)) || (b.totalHours - a.totalHours))) {
            const key = r.farmId || '?';
            if (!byFarm.has(key)) byFarm.set(key, []);
            byFarm.get(key)!.push(r);
          }
          const sortedFarms = [...byFarm.entries()].sort((a, b) => {
            if (a[0] === '?') return 1;
            if (b[0] === '?') return -1;
            return Number(a[0]) - Number(b[0]);
          });

          desc += `**Online / Aktivni**\n`;
          for (const [farmId, players] of sortedFarms) {
            const farmLabel = farmId !== '?' ? `🏡 Farma ${farmId}` : '🏡 Farma ?';
            desc += `\n${farmLabel}\n`;
            for (const r of players.slice(0, 10)) {
              const activityIcon = r.active15m ? '🧍' : '😴';
              const activityLabel = r.active15m ? 'Aktivan' : 'AFK';
              const sessionTxt = fmtHHmm(r.currentSessionMs);
              const afkTxt = fmtHHmm(r.afkMs);
              desc += `  🟢 ${r.name} — ⏱ ${sessionTxt} • 😴 ${afkTxt} • ${activityIcon} ${activityLabel}\n`;
            }
          }
          desc += '\n';
        }

        const leaderboard = [...rows]
          .sort((a, b) => b.totalHours - a.totalHours)
          .slice(0, 10)
          .map((r, idx) => {
            const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '•';
            const farmTag = r.farmId ? `F${r.farmId}` : 'F?';
            return `${medal} ${String(idx + 1).padStart(2, '0')}. ${r.name} (${farmTag}) — ${fmtHours(r.totalHours)}`;
          });

        desc += `**Leaderboard (All-time)**\n${leaderboard.join('\n')}`;

        if (desc.length > 3900) {
          desc = desc.slice(0, 3897) + '...';
        }

        embed.setDescription(desc);
        break;
      }

      case 'player_hours': {
        embed = await this.buildPlayerHoursEmbed(ctx?.messageId);
        break;
      }

      case 'map_tracks': {
        embed = await this.buildMapTracksEmbed(ctx?.messageId);
        break;
      }

            case 'linking': {
          const online = await this.getOnlinePlayersForLinking();
        const links = await storage.getPlayerLinks();

        const lines = online.slice(0, 12).map(p => {
          const idShort = (p.uniqueUserId || '').slice(0, 8);
          const farmTag = p.farmId ? ` | Farma ${p.farmId}` : '';
          return `🟢 ${p.name}${farmTag} | ID: ${idShort}…`;
        });

        embed = new EmbedBuilder()
          .setTitle('🔗 Linkanje igrača (Admin)')
          .setDescription([
            '```',
            `Online: ${online.length} | Linkani: ${links.length}`,
            '```',
            online.length ? lines.join('\n') : '🟡 Trenutno nema online igrača.'
          ].join('\n'))
          .setColor(0x3b82f6)
          .setFooter({ text: 'Samo OWNER može linkati (OWNER_DISCORD_ID)' })
          .setTimestamp();
        break;
      }

case 'jobs': {
        let jobs = await storage.getJobs();
        if (farmId) {
          jobs = jobs.filter(j => j.createdByFarmId === farmId);
        }
        
        const openJobs = jobs.filter(j => j.status === 'open').length;
        const inProgressJobs = jobs.filter(j => j.status === 'in_progress').length;
        const completedJobs = jobs.filter(j => j.status === 'completed').length;
        
        embed = new EmbedBuilder()
          .setTitle(`Oglasna Ploca - Poslovi${farmLabel}`)
          .setColor(0x6366f1)
          .setTimestamp()
          .setFooter({ text: 'Slavonska Ravnica - Poslovi' });

        if (jobs.length === 0) {
          embed.setDescription('```\nNema dostupnih poslova.\n\nKoristi /posao za kreiranje novog posla!\n```');
        } else {
          let desc = `\`\`\`yaml\nOtvoreno: ${openJobs} | U tijeku: ${inProgressJobs} | Zavrseno: ${completedJobs}\n\`\`\`\n`;
          
          // Group by status
          const openJobsList = jobs.filter(j => j.status === 'open').slice(0, 5);
          const inProgressList = jobs.filter(j => j.status === 'in_progress').slice(0, 3);
          
          if (openJobsList.length > 0) {
            desc += `\`\`\`diff\n+ OTVORENI POSLOVI\n\`\`\``;
            for (const job of openJobsList) {
              const jobType = this.getJobTypeLabel(job.jobType);
              const payment = job.payment ? `${job.payment.toLocaleString('hr-HR')} €` : 'Dogovor';
              const field = job.fieldId ? `Polje ${job.fieldId}` : 'Bilo koje';
              desc += `\`\`\`fix\n${jobType}\n\`\`\``;
              desc += `\`\`\`yaml\nPolje: ${field} | Plata: ${payment}\nOpis: ${(job.description || 'Nema opisa').slice(0, 50)}\n\`\`\`\n`;
            }
          }
          
          if (inProgressList.length > 0) {
            desc += `\`\`\`yaml\n= U TIJEKU\n\`\`\``;
            for (const job of inProgressList) {
              const jobType = this.getJobTypeLabel(job.jobType);
              desc += `\`\`\`\n${jobType} - Farma ${job.assignedToFarmId || 'N/A'}\n\`\`\`\n`;
            }
          }
          
          embed.setDescription(desc);
        }
        break;
      }

      case 'custom_contracts': {
        const contracts = await storage.getCustomContracts();
        const farms = await storage.getFarms();
        const farmName = (fid: string | null) => {
          if (!fid) return 'N/A';
          const f = farms.find((fm: any) => String(fm.farmId) === String(fid));
          return f?.name || `Farma ${fid}`;
        };

        const open = contracts.filter((c: any) => c.status === 'OTVORENO');
        const accepted = contracts.filter((c: any) => c.status === 'PRIHVAĆENO');
        const completed = contracts.filter((c: any) => c.status === 'DOVRŠENO');
        const cancelled = contracts.filter((c: any) => c.status === 'OTKAZANO');
        const expired = contracts.filter((c: any) => c.status === 'ISTEKAO');

        let desc = '';
        const formatContract = (c: any) => {
          const wt = this.POSLOVI_WORK_TYPES[c.workType] || c.workType;
          const field = c.fieldId ? `Polje ${c.fieldId}` : '';
          const reward = c.reward ? `${c.reward.toLocaleString()}€` : '';
          const creator = farmName(c.creatorFarmId);
          const contractor = c.contractorFarmId ? ` → ${farmName(c.contractorFarmId)}` : '';
          return `#${c.gameId} ${wt} | ${field} | ${reward} | ${creator}${contractor}`;
        };

        if (open.length === 0 && accepted.length === 0 && completed.length === 0 && cancelled.length === 0 && expired.length === 0) {
          desc = 'Nema poslova na ugovor. Kreiraj ih u igri putem Custom Contracts moda.';
        } else {
          if (open.length > 0) {
            desc += '**🟢 OTVORENO:**\n```\n';
            for (const c of open.slice(0, 8)) desc += `${formatContract(c)}\n`;
            if (open.length > 8) desc += `... i još ${open.length - 8}\n`;
            desc += '```\n';
          }
          if (accepted.length > 0) {
            desc += '**🟡 PRIHVAĆENO:**\n```\n';
            for (const c of accepted.slice(0, 8)) desc += `${formatContract(c)}\n`;
            if (accepted.length > 8) desc += `... i još ${accepted.length - 8}\n`;
            desc += '```\n';
          }
          if (completed.length > 0) {
            desc += '**✅ DOVRŠENO:**\n```\n';
            for (const c of completed.slice(0, 5)) desc += `${formatContract(c)}\n`;
            if (completed.length > 5) desc += `... i još ${completed.length - 5}\n`;
            desc += '```\n';
          }
          if (cancelled.length > 0) {
            desc += '**❌ OTKAZANO:**\n```\n';
            for (const c of cancelled.slice(0, 3)) desc += `${formatContract(c)}\n`;
            if (cancelled.length > 3) desc += `... i još ${cancelled.length - 3}\n`;
            desc += '```\n';
          }
          if (expired.length > 0) {
            desc += '**⏰ ISTEKAO:**\n```\n';
            for (const c of expired.slice(0, 3)) desc += `${formatContract(c)}\n`;
            if (expired.length > 3) desc += `... i još ${expired.length - 3}\n`;
            desc += '```\n';
          }
        }

        embed = new EmbedBuilder()
          .setTitle('📋 Poslovi na Ugovor')
          .setDescription(desc)
          .setColor(0xFF8C00)
          .setTimestamp()
          .setFooter({ text: `Ukupno: ${contracts.length} | Otvoreno: ${open.length} | Prihvaćeno: ${accepted.length}` });
        break;
      }

      default:
        throw new Error(`Nepoznat tip podataka: ${panelType}`);
    }

    this.cleanupEmbedMissing(embed);
    this.attachLegendToEmbed(embed, panelType);
    this.debugEmbed('buildPanelEmbed', embed, { panelType, farmId, messageId: ctx?.messageId || null, flow: 'panel-build' });
    return embed;
  }

  private async buildCustomContractsComponents(): Promise<ActionRowBuilder<ButtonBuilder>[]> {
    const contracts = await storage.getCustomContracts();
    const hasOpen = contracts.some((c: any) => c.status === 'OTVORENO');
    const hasAccepted = contracts.some((c: any) => c.status === 'PRIHVAĆENO');

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('poslovi_accept')
          .setLabel('Prihvati')
          .setEmoji('🟢')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!hasOpen),
        new ButtonBuilder()
          .setCustomId('poslovi_complete')
          .setLabel('Dovrši')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!hasAccepted),
        new ButtonBuilder()
          .setCustomId('poslovi_cancel')
          .setLabel('Otkaži')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!hasOpen && !hasAccepted),
        new ButtonBuilder()
          .setCustomId('poslovi_refresh')
          .setLabel('Osvježi')
          .setStyle(ButtonStyle.Secondary)
      );
    return [row];
  }

  private getLegendForPanel(panelType: string): string | null {
    const t = String(panelType || '').toLowerCase();
    if (t === 'status') return '🟢 Online | 🔴 Offline | ⏱ Vrijeme rada | 📡 Ping | 🌾 Polja | 🚜 Vozila | 🐄 Životinje';
    if (t === 'server_info') return '🟢 Online | 🔴 Offline | 👥 Igrači online | 💾 Zadnji savegame update | 🌍 Podaci servera';
    if (t === 'farms') return '🏡 Farma | 💶 Balans | 🌾 Polja | ✅ Spremno | 🚜 Vozila | 🏭 Proizvodnje';
    if (t === 'fields') return '🔴 Hitno | 🟠 Visoko | 🟡 Srednje | 🟢 Stabilno | 🌿 Korov | 🧱 Vapno | 🧪 Gnojivo | 🚜 Oranje | 🧻 Valjanje';
    if (t === 'vehicles') return '⛽ Gorivo | 🛠 Stanje | 🧼 Prljavština | 🎨 Boja | ⏱ Sati rada | 👤 Top vozači';
    if (t === 'vehiclehistory') return '🕒 Vrijeme | 🚜 Vozilo | 🏡 Farma | ⏱ Ukupni sati prije uklanjanja';
    if (t === 'silos') return '🟩🟨🟥 Popunjenost | 📦 Sadržaj | 🧭 Prioritet: silaža/chaff na vrhu';
    if (t === 'productions') return '🏭 Objekt | 🟢 Aktivno | 📥 Input | 📤 Output | ⚙️ Ciklusi/proizvodnja';
    if (t === 'animals') return '🟢 OK | 🟡 Pažnja | 🔴 Hitno | ❤️ Zdravlje | ⚡ Produktivnost | 🍽 Hrana | 🥛/💩/🧪 Output';
    if (t === 'weather') return '☀️ Vedro | ☁️ Oblačno | 🌧️ Kiša | ⛈️ Oluja | ❄️ Snijeg | 🌡️ Temperatura | 💨 Vjetar';
    if (t === 'players' || t === 'runtime' || t === 'runtime_stats') return '🟢 Online | 😴 AFK | ⏱ Sesija | 🧍 Aktivnost | 🏡 Farma';
    if (t === 'jobs') return '🟩 Otvoreno | 🟨 U tijeku | ✅ Završeno | 💶 Isplata | 🌾 Tip posla';
    if (t === 'player_hours') return '🥇 Top ukupno | 📅 Zadnjih 30 dana | 👥 Praćeni igrači | 🟢 Trenutno online';
    if (t === 'map_tracks') return '📍 Točke kretanja | ⏱ Vremenski prozor (10m/30m/2h) | 🚶 Aktivne/idle minute';
    if (t === 'linking') return '🔗 Link status | 🟢 Online u igri | 👤 Discord korisnik | 🆔 Game ID';
    if (t === 'custom_contracts') return '🟢 Otvoreno | 🟡 Prihvaćeno | ✅ Dovršeno | ❌ Otkazano | ⏰ Istekao | 💰 Nagrada';
    return 'ℹ️ Podaci su iz Slavonska Ravnica synca i prikazuju zadnje dostupno stanje.';
  }

  private attachLegendToEmbed(embed: EmbedBuilder, panelType: string) {
    const legend = this.getLegendForPanel(panelType);
    if (!legend) return;

    const data: any = (embed as any).data || {};
    const desc = String(data.description || '');
    const fields = Array.isArray(data.fields) ? data.fields : [];

    if (desc && desc.length < 3000) {
      embed.setDescription(`${desc}\n\n🧭 **Legenda**\n${legend}`.slice(0, 3900));
      return;
    }

    if (fields.length < 25) {
      try {
        embed.addFields({ name: '🧭 Legenda', value: legend.slice(0, 1024), inline: false });
        return;
      } catch {
        // fallback below
      }
    }

    const footerText = String(data.footer?.text || 'Slavonska Ravnica');
    const suffix = ` | Legenda: ${legend}`;
    embed.setFooter({ text: `${footerText}${suffix}`.slice(0, 2048) });
  }

  private isMissingDisplayValue(value: any): boolean {
    const raw = String(value ?? '').trim();
    if (!raw) return true;

    const normalized = raw
      .replace(/[\*`_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (!normalized) return true;
    return normalized === 'n/a'
      || normalized === 'na'
      || normalized === 'unknown'
      || normalized === '—'
      || normalized === '-'
      || normalized === '--'
      || normalized === 'farma ?'
      || normalized === 'spremnik: —';
  }

  private cleanupEmbedMissing(embed: EmbedBuilder): void {
    const data: any = (embed as any).data || {};

    const fields = Array.isArray(data.fields) ? data.fields : [];
    if (fields.length) {
      const cleaned = fields.filter((f: any) => {
        const name = String(f?.name || '').trim();
        const value = String(f?.value || '').trim();
        if (!name || !value) return false;
        return !this.isMissingDisplayValue(value);
      });
      if (cleaned.length !== fields.length) {
        embed.setFields(cleaned as any);
      }
    }

    const description = String(data.description || '');
    if (description && !description.includes('```')) {
      const lines = description
        .split('\n')
        .map((line) => String(line || '').trimEnd())
        .filter((line) => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          if (this.isMissingDisplayValue(trimmed)) return false;
          if (/(:\s*(N\/A|Unknown|—|--|-)\s*$)/i.test(trimmed)) return false;
          return true;
        });

      if (lines.length) {
        embed.setDescription(lines.join('\n').slice(0, 3900));
      }
    }
  }

  private async buildPlayerHoursEmbed(messageId?: string): Promise<EmbedBuilder> {
    const page = messageId ? (this.playerHoursPageByMessage.get(messageId) || 0) : 0;
    const pageSize = Number(process.env.PLAYER_HOURS_TOP_N || '25') || 25;
    const lb = getPlayerHoursLeaderboard(page + 1, pageSize);
    const totalPages = Math.max(1, Math.ceil((lb.total || 0) / Math.max(1, lb.pageSize || pageSize)));

    const linesAll = (lb.rows || []).map((r: any, i: number) => `${String((page * pageSize) + i + 1).padStart(2, ' ')}. ${(r.name || r.userId).slice(0, 22).padEnd(22, ' ')}  ${formatHours(Number(r.secondsAllTime || 0))}`);
    const lines30 = (lb.rows || []).map((r: any, i: number) => `${String((page * pageSize) + i + 1).padStart(2, ' ')}. ${(r.name || r.userId).slice(0, 22).padEnd(22, ' ')}  ${formatHours(Number(r.seconds30d || 0))}`);

    const updated = this.runtimeUpdatedAt ? new Date(this.runtimeUpdatedAt) : null;
    const updatedTxt = updated ? `<t:${Math.floor(updated.getTime() / 1000)}:R>` : '—';

    const desc = [
      `\`\`\`yaml\nLast updated: ${updatedTxt}\nTracked: ${lb.total}\nPage: ${lb.page}/${totalPages}\n\`\`\``,
      `\`\`\`fix\nALL-TIME (Top ${pageSize})\n\`\`\``,
      `\`\`\`text\n${(linesAll.length ? linesAll.join('\n') : '—')}\n\`\`\``,
      `\`\`\`fix\nLAST 30 DAYS (Top ${pageSize})\n\`\`\``,
      `\`\`\`text\n${(lines30.length ? lines30.join('\n') : '—')}\n\`\`\``
    ].join('\n');

    return new EmbedBuilder()
      .setTitle(`${getActiveServer()?.name || process.env.SERVER_NAME || 'FS25'} — Player Hours`)
      .setDescription(desc.slice(0, 3900))
      .setColor(0x22c55e)
      .setTimestamp()
      .setFooter({ text: 'All-time + last 30 days | Slavonska Ravnica' });
  }

  private async buildMapTracksEmbed(messageId?: string): Promise<EmbedBuilder> {
    const win = messageId ? (this.mapTracksSelectedWindowByMessage.get(messageId) || '30m') : '30m';
    const updated = this.playerTrackingUpdatedAt;
    const updatedTxt = updated ? `<t:${Math.floor(updated.getTime() / 1000)}:R>` : '—';

    const bounds = {
      minX: process.env.MAP_MIN_X,
      maxX: process.env.MAP_MAX_X,
      minZ: process.env.MAP_MIN_Z,
      maxZ: process.env.MAP_MAX_Z,
    };
    const hasBounds = Object.values(bounds).every(v => v != null && String(v).trim() !== '');

    const windowMs = win === '10m' ? 10 * 60 * 1000 : win === '2h' ? 2 * 60 * 60 * 1000 : 30 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    const trackSumm = (this.playerTracks || []).map(t => {
      const pts = (t.points || []).filter(p => (p.t || 0) >= cutoff);
      return {
        id: t.id,
        nickname: t.nickname,
        points: pts.length,
        distanceM: Number(t.distanceM || 0),
        activeMs: Number(t.activeMs || 0),
        idleMs: Number(t.idleMs || 0),
      };
    }).sort((a, b) => b.points - a.points);

    const top = trackSumm.slice(0, 8);
    const lines = top.map(t => {
      const name = (t.nickname || t.id || '').toString().slice(0, 20);
      const mins = Math.round((t.activeMs || 0) / 60000);
      const idle = Math.round((t.idleMs || 0) / 60000);
      return `${name.padEnd(20, ' ')} pts:${String(t.points).padStart(4, ' ')}  active:${String(mins).padStart(4, ' ')}m  idle:${String(idle).padStart(4, ' ')}m`;
    });

    const desc = [
      `\`\`\`yaml\nLast tracking update: ${updatedTxt}\nWindow: ${win}\nPlayers tracked: ${(this.playerTracks || []).length}\n\`\`\``,
      `\`\`\`text\n${lines.length ? lines.join('\n') : 'Nema track podataka (playerTracks.xml nije exportan ili je prazan).'}\n\`\`\``,
      `\`\`\`diff\n- Rendering (map lines)\n\`\`\``,
      hasBounds
        ? `\`\`\`yaml\nOK: MAP bounds set. Sljedeći korak: dodati PNG renderer (attachment) + overlay na SERVER_MAP_IMAGE_URL\n\`\`\``
        : `\`\`\`yaml\nFALI: MAP_MIN_X, MAP_MAX_X, MAP_MIN_Z, MAP_MAX_Z (bez toga ne mozemo nacrtati linije na mapi)\n\`\`\``
    ].join('\n');

    return new EmbedBuilder()
      .setTitle(`${getActiveServer()?.name || process.env.SERVER_NAME || 'FS25'} — Map Tracks`)
      .setDescription(desc.slice(0, 3900))
      .setColor(0x0ea5e9)
      .setTimestamp()
      .setFooter({ text: 'Groundwork: tracking + window controls | Rendering pending' });
  }

  private getWeatherIcon(weatherType: string | null): string {
    const type = String(weatherType || '').toLowerCase();
    if (!type) return '—';
    if (type.includes('sun') || type.includes('clear')) return '☀️';
    if (type.includes('cloud')) return '☁️';
    if (type.includes('rain') || type.includes('shower')) return '🌧️';
    if (type.includes('storm') || type.includes('thunder')) return '⛈️';
    if (type.includes('snow')) return '❄️';
    if (type.includes('fog') || type.includes('mist')) return '🌫️';
    return '⛅';
  }


  // Loading bar with 3 colors based on percentage
  // Red (< 30%), Yellow (30-70%), Green (> 70%)
  private getColoredBar(percent: number, width: number = 10): string {
    const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
    const filled = Math.floor(safe / (100 / width));
    const empty = Math.max(0, width - filled);

    // Emoji bar (Discord prikazuje boje i u code blockovima)
    const fillEmoji = safe < 30 ? '🟥' : safe < 70 ? '🟨' : '🟩';
    const emptyEmoji = '⬛';
    return fillEmoji.repeat(filled) + emptyEmoji.repeat(empty);
  }

  private getModernLoadingBar(percent: number, width: number = 12): string {
    const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
    const filled = Math.round((safe / 100) * width);
    const empty = Math.max(0, width - filled);
    const color = safe < 30 ? '🔴' : safe < 70 ? '🟠' : '🟢';
    return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}`;
  }

  private normalizeFillType(raw: any): string {
    return String(raw || '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_]/g, '')
      .toUpperCase();
  }

  private canonicalFillType(raw: any): string {
    const t = this.normalizeFillType(raw);
    if (!t) return t;

    const alias: Record<string, string> = {
      OIILSEED_RADISH: 'OILSEED_RADISH',
      OLIIVES: 'OLIVES',
      TRIITICALE: 'TRITICALE',
      FIIELD_GRASS: 'FIELD_GRASS',
      SIILAGE_MAZE: 'SILAGE_MAIZE',
      HUMMUSACTIIVE: 'HUMUSACTIVE'
    };

    if (alias[t]) return alias[t];
    return t;
  }

  private getCropIcon(cropRaw: any): string {
    const c = this.canonicalFillType(cropRaw);
    if (!c || c === 'NONE' || c === 'UNKNOWN') return '⬜';

    if (c.includes('CARROT') || c.includes('PARSNIP')) return '🥕';
    if (c.includes('POTATO')) return '🥔';
    if (c.includes('SUGAR_BEET') || c.includes('SUGARBEET')) return '🍬';
    if (c.includes('RED_BEET') || c === 'REDBEET') return '🟥';
    if (c.includes('SPINACH')) return '🥬';
    if (c.includes('CORN') || c.includes('MAIZE')) return '🌽';
    if (c.includes('PEA')) return '🫛';
    if (c.includes('SOY')) return '🫘';

    if (c.includes('CANOLA') || c.includes('RAPE')) return '🟡';
    if (c.includes('SUNFLOWER')) return '🌻';
    if (c.includes('MUSTARD')) return '🌼';
    if (c.includes('OILSEED_RADISH')) return '🌱';

    if (c.includes('GRAPE')) return '🍇';
    if (c.includes('OLIVE')) return '🫒';
    if (c.includes('POPLAR')) return '🪵';
    if (c.includes('GRASS') || c.includes('FIELD_GRASS')) return '🌿';

    if (c.includes('WHEAT') || c.includes('BARLEY') || c.includes('SUMMER_BARLEY') || c.includes('OAT') || c.includes('RYE') || c.includes('GREEN_RYE') || c.includes('TRITICALE') || c.includes('SPELT') || c.includes('VECT_RYE') || c.includes('VETCH_RYE') || c.includes('SORGHUM')) return '🌾';
    if (c.includes('CANOLA') || c.includes('RAPE')) return '🟡';

    if (c.includes('COTTON')) return '🧵';
    if (c.includes('HUMUSACTIVE')) return '🧪';
    return '🌱';
  }

  private getFillTypeIcon(fillTypeRaw: any): string {
    const t = this.canonicalFillType(fillTypeRaw);
    if (!t) return '📦';
    if (t.includes('PETROL') || t.includes('DIESEL') || t.includes('FUEL') || t === 'DEF' || t.includes('ADBLUE')) return '⛽';
    if (t.includes('CARROT') || t.includes('PARSNIP')) return '🥕';
    if (t.includes('POTATO')) return '🥔';
    if (t.includes('SUGAR_BEET') || t.includes('SUGARBEET')) return '🍬';
    if (t.includes('RED_BEET') || t === 'REDBEET') return '🟥';
    if (t.includes('SPINACH')) return '🥬';
    if (t.includes('CORN') || t.includes('MAIZE')) return '🌽';
    if (t.includes('PEA')) return '🫛';
    if (t.includes('SOY')) return '🫘';

    if (t.includes('CANOLA') || t.includes('RAPE')) return '🟡';
    if (t.includes('SUNFLOWER')) return '🌻';
    if (t.includes('MUSTARD')) return '🌼';
    if (t.includes('OILSEED_RADISH')) return '🌱';

    if (t.includes('GRAPE')) return '🍇';
    if (t.includes('OLIVE')) return '🫒';
    if (t.includes('POPLAR')) return '🪵';
    if (t.includes('WHEAT') || t.includes('BARLEY') || t.includes('SUMMER_BARLEY') || t.includes('OAT') || t.includes('RYE') || t.includes('GREEN_RYE') || t.includes('TRITICALE') || t.includes('SPELT') || t.includes('VECT_RYE') || t.includes('VETCH_RYE')) return '🌾';
    if (t.includes('GRASS') || t.includes('HAY') || t.includes('SILAGE') || t.includes('CHAFF')) return '🌿';
    if (t.includes('HUMUSACTIVE')) return '🧪';
    if (t.includes('DIGESTATE')) return '♻️';
    if (t.includes('MANURE')) return '💩';
    if (t.includes('SLURRY')) return '🧪';
    if (t.includes('WATER')) return '💧';
    if (t.includes('MILK')) return '🥛';
    return '📦';
  }

  private formatFillTypeLabel(raw: any): string {
    const t = this.canonicalFillType(raw);
    if (!t) return 'Unknown';

    const named: Record<string, string> = {
      DEF: 'DEF',
      DIESEL: 'Diesel',
      FUEL: 'Fuel',
      PETROL: 'Petrol',
      ADBLUE: 'AdBlue',
      FIELD_GRASS: 'Field Grass',
      GREEN_RYE: 'Green Rye',
      OILSEED_RADISH: 'Oilseed Radish',
      RED_BEET: 'Red Beet',
      SUGAR_BEET: 'Sugar Beet',
      SUMMER_BARLEY: 'Summer Barley',
      SILAGE_MAIZE: 'Silage Maize',
      VECT_RYE: 'Vect Rye',
      HUMUSACTIVE: 'Humus Active'
    };
    if (named[t]) return named[t];

    return t
      .toLowerCase()
      .split('_')
      .map((p: string) => p ? (p[0].toUpperCase() + p.slice(1)) : p)
      .join(' ');
  }

  private normalizePercent(value: any): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const pct = n <= 1.0001 ? n * 100 : n;
    return Math.max(0, Math.min(100, pct));
  }

  private msToHours(ms: any): number {
    const n = Number(ms);
    if (!Number.isFinite(n)) return 0;
    return n / 3600000;
  }

  private formatHours(hours: number): string {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }

  // Categorize vehicle by type
  private categorizeVehicle(name: string, vehType: string | null): string {
    const type = this.getVehicleDisplayType(name, vehType);
    if (type === 'TRAKTOR') return 'TRAKTOR';
    if (type === 'KAMION') return 'KAMION';
    if (type === 'TELEHANDLER') return 'TELEHANDLER';
    if (type === 'VILICAR') return 'VILICAR';
    if (type === 'KOMBAJN') return 'KOMBAJN';
    if (type === 'UTOVARIVAC') return 'UTOVARIVAC';
    if (type === 'AUTO') return 'AUTO';
    return 'OSTALO';
  }

  private getVehicleDisplayType(name: string, vehType: string | null): string {
    const n = String(name || '').toLowerCase();
    const t = String(vehType || '').toLowerCase();

    if (t.includes('telehandler') || n.includes('telehandler') || n.includes('handler')) return 'TELEHANDLER';
    if (t.includes('forklift') || n.includes('forklift')) return 'VILICAR';
    if (t.includes('tractor') || n.includes('tractor')) return 'TRAKTOR';
    if (t.includes('truck') || t.includes('lorry') || n.includes('truck') || n.includes('scania') || n.includes('iveco') || n.includes('daf ') || n.includes('volvo')) return 'KAMION';
    if (t.includes('harvester') || t.includes('combine') || n.includes('harvester') || n.includes('combine') || n.includes('lexion')) return 'KOMBAJN';
    if (t.includes('loader') || n.includes('wheel loader') || n.includes('front loader') || n.includes('skid steer') || n.includes('skidsteer')) return 'UTOVARIVAC';
    if (t.includes('car') || t.includes('pickup') || t.includes('suv') || n.includes('pickup') || n.includes('gator') || n.includes('car ')) return 'AUTO';
    return 'OSTALO';
  }

  private getVehicleDisplayTypeLabel(type: string | null): string {
    const t = String(type || '').toUpperCase();
    if (t === 'TRAKTOR') return 'Traktor';
    if (t === 'KAMION') return 'Kamion';
    if (t === 'TELEHANDLER') return 'Telehandler';
    if (t === 'VILICAR') return 'Viličar';
    if (t === 'KOMBAJN') return 'Kombajn';
    if (t === 'UTOVARIVAC') return 'Utovarivač';
    if (t === 'AUTO') return 'Auto';
    return 'Ostalo';
  }

  private isDrivableVehicle(name: string, vehType: string | null): boolean {
    const n = String(name || '').toLowerCase();
    const t = String(vehType || '').toLowerCase();

    const nonDrivableHints = [
      'trailer', 'implement', 'tool', 'header', 'cutter', 'seeder', 'planter', 'sprayer', 'baler',
      'plow', 'cultivator', 'subsoiler', 'roller', 'mower', 'tedder', 'rake'
    ];
    if (nonDrivableHints.some((hint) => t.includes(hint) || n.includes(hint))) {
      return false;
    }

    const display = this.getVehicleDisplayType(name, vehType);
    return ['TRAKTOR', 'KAMION', 'TELEHANDLER', 'VILICAR', 'KOMBAJN', 'UTOVARIVAC', 'AUTO'].includes(display);
  }

  private applyVehicleTypeFilter(items: any[], selected: string[]): any[] {
    if (!selected?.length || selected.includes('ALL')) return items;
    const set = new Set(selected.map(s => String(s || '').toUpperCase()));
    return items.filter((v: any) => set.has(this.getVehicleDisplayType(v.name, v.vehType)));
  }

  private vehicleOptionValue(v: any): string {
    const idRaw = v?.id;
    const id = Number(idRaw);
    if (Number.isFinite(id) && id > 0) {
      return `veh:${Math.floor(id)}`;
    }

    const farm = String(v?.farmId || '').replace(/\|/g, '/');
    const type = String(v?.vehType || '').replace(/\|/g, '/');
    const name = String(v?.name || '').replace(/\|/g, '/');
    const pos = String(v?.position || '').replace(/\|/g, '/');
    const img = String(v?.imageFilename || '').replace(/\|/g, '/');
    const fallback = `${farm}|${type}|${name}|${pos}|${img}`;

    let hash = 2166136261;
    for (let i = 0; i < fallback.length; i++) {
      hash ^= fallback.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    const digest = (hash >>> 0).toString(36);
    return `vehh:${digest}`;
  }

// Get job type label in Croatian
  private getJobTypeLabel(jobType: string | null): string {
    const types: { [key: string]: string } = {
      'plowing': 'Oranje',
      'cultivating': 'Kultivacija',
      'seeding': 'Sijanje',
      'harvesting': 'Zetva',
      'fertilizing': 'Gnojenje',
      'spraying': 'Prskanje',
      'mowing': 'Kosidba',
      'baling': 'Baliranje',
      'transport': 'Prijevoz',
      'animal_care': 'Briga o zivotinjama',
      'forestry': 'Sumarstvo',
      'other': 'Ostalo'
    };
    return types[jobType || 'other'] || 'Posao';
  }

  // Show modal for creating a new job
  private async showJobCreateModal(interaction: any) {
    const modal = new ModalBuilder()
      .setCustomId('job_create_modal')
      .setTitle('Kreiraj Novi Posao');

    const jobTypeInput = new TextInputBuilder()
      .setCustomId('job_type')
      .setLabel('Tip posla')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('oranje/sijanje/zetva/prijevoz/ostalo')
      .setRequired(true);

    const titleInput = new TextInputBuilder()
      .setCustomId('job_title')
      .setLabel('Naslov posla')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('npr. Oranje polja 15')
      .setRequired(true);

    const descriptionInput = new TextInputBuilder()
      .setCustomId('job_description')
      .setLabel('Opis posla')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Detaljan opis sto treba napraviti...')
      .setRequired(false);

    const paymentInput = new TextInputBuilder()
      .setCustomId('job_payment')
      .setLabel('Plata (u igri)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('npr. 5000')
      .setRequired(true);

    const fieldInput = new TextInputBuilder()
      .setCustomId('job_field')
      .setLabel('Broj polja (opcionalno)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('npr. 15')
      .setRequired(false);

    const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(jobTypeInput);
    const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput);
    const row3 = new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput);
    const row4 = new ActionRowBuilder<TextInputBuilder>().addComponents(paymentInput);
    const row5 = new ActionRowBuilder<TextInputBuilder>().addComponents(fieldInput);

    modal.addComponents(row1, row2, row3, row4, row5);

    await interaction.showModal(modal);
  }

  // Handle modal submission
  
  private async handleModalSubmit(interaction: any) {
    // ── Channel Manager: Add Category modal ──
    if (interaction.customId === 'chm_modal_add_category') {
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.fields.getTextInputValue('cat_name').trim();
      if (!name) { await interaction.editReply({ content: '❌ Ime ne smije biti prazno.' }); return; }
      const config = await readChannelConfig();
      config.categories.push({ name, channels: [] });
      await writeChannelConfig(config);
      await interaction.editReply({ content: `✅ Kategorija **${name}** dodana! Koristi \`/channels\` za osvježavanje panela.` });
      return;
    }

    // ── Channel Manager: Add Channel modal ──
    if (interaction.customId === 'chm_modal_add_channel') {
      await interaction.deferReply({ ephemeral: true });
      const chName = interaction.fields.getTextInputValue('ch_name').trim();
      const catNum = parseInt(interaction.fields.getTextInputValue('ch_category').trim());
      const chTypeRaw = interaction.fields.getTextInputValue('ch_type').trim().toLowerCase();
      const permsRaw = (interaction.fields.getTextInputValue('ch_perms') || '').trim().toLowerCase();

      if (!chName) { await interaction.editReply({ content: '❌ Ime kanala ne smije biti prazno.' }); return; }
      const chType = chTypeRaw === 'voice' ? 'voice' : chTypeRaw === 'forum' ? 'forum' : 'text';

      const config = await readChannelConfig();
      const catIdx = catNum - 1;
      if (catIdx < 0 || catIdx >= config.categories.length) {
        await interaction.editReply({ content: `❌ Kategorija #${catNum} ne postoji. Imaš ${config.categories.length} kategorija.` });
        return;
      }

      const newCh: ChannelDef_Saved = { name: chName, type: chType };
      if (permsRaw.includes('readonly') || permsRaw.includes('read_only') || permsRaw.includes('readOnly')) newCh.readOnly = true;
      if (permsRaw.includes('staffonly') || permsRaw.includes('staff_only') || permsRaw.includes('staffOnly')) newCh.staffOnly = true;
      if (permsRaw.includes('playeronly') || permsRaw.includes('player_only') || permsRaw.includes('playerOnly')) newCh.playerOnly = true;
      if (permsRaw.includes('freewrite') || permsRaw.includes('free_write') || permsRaw.includes('freeWrite')) newCh.freeWrite = true;
      if (permsRaw.includes('farmonly') || permsRaw.includes('farm_only') || permsRaw.includes('farmOnly')) newCh.farmOnly = true;

      config.categories[catIdx].channels.push(newCh);
      await writeChannelConfig(config);

      const flags = Object.entries(PERM_LABELS).filter(([k]) => (newCh as any)[k]).map(([, v]) => v).join(' ') || 'Default';
      await interaction.editReply({
        content: `✅ Kanal **${chName}** dodan u kategoriju **${config.categories[catIdx].name}**\nTip: ${chType} • Permisije: ${flags}\n\nKoristi \`/channels\` → Deploy za kreiranje na serveru.`
      });
      return;
    }

    // ── Ticket form modal submit (after category selection) ──
    if (interaction.customId.startsWith('ticket_form_')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const typeId = interaction.customId.replace('ticket_form_', '');
        const ticketType = TICKET_TYPES.find(t => t.id === typeId);
        const guild = interaction.guild;
        if (!guild || !ticketType) { await interaction.editReply({ content: 'Greška — neispravan tip ticketa.' }); return; }

        const priority = PRIORITY_CONFIG[ticketType.priority];
        const ticketiChannel = await getGuildChannel(guild, 'tickets');
        if (!ticketiChannel) { await interaction.editReply({ content: 'Greška — kanal za tickete nije pronađen. Pokreni /setup.' }); return; }

        // Re-check ticket limit
        const existingThread = guild.channels.cache.find((c: any) =>
          c.isThread?.() && c.name.startsWith('🎫') && c.name.includes(interaction.user.username) && !c.archived
        );
        if (existingThread) {
          await interaction.editReply({ content: `Već imaš otvoren ticket: ${existingThread}` });
          return;
        }

        // Collect modal answers
        const modalFields = TICKET_MODAL_FIELDS[ticketType.id] || TICKET_MODAL_FIELDS.ostalo;
        const answers: Array<{ label: string; value: string }> = [];
        for (const field of modalFields) {
          try {
            const val = (interaction as any).fields.getTextInputValue(field.id);
            if (val?.trim()) answers.push({ label: field.label, value: val.trim() });
          } catch { /* optional field not filled */ }
        }

        // Generate ticket number
        const allTicketThreads = guild.channels.cache.filter((c: any) => c.isThread?.() && c.name.startsWith('🎫'));
        const ticketNum = allTicketThreads.size + 1;
        const ticketId = String(ticketNum).padStart(4, '0');

        // Create private thread
        const thread = await (ticketiChannel as any).threads.create({
          name: `🎫 #${ticketId} — ${interaction.user.username}`,
          autoArchiveDuration: 10080,
          type: 12,
          reason: `Ticket #${ticketId} od ${interaction.user.tag} [${ticketType.label}]`,
        });

        await thread.members.add(interaction.user.id).catch(() => {});

        // Add staff to thread
        const staffMembers = guild.members.cache.filter((m: any) =>
          m.roles.cache.some((r: any) =>
            ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
          )
        );
        for (const [, staffMember] of staffMembers) {
          await thread.members.add(staffMember.id).catch(() => {});
        }

        // Build ticket header embed
        const ticketEmbed = new EmbedBuilder()
          .setColor(priority.color)
          .setTitle(`${ticketType.emoji} Ticket #${ticketId}`)
          .setDescription(
            `┌─────────────────────────────────\n` +
            `│ **Korisnik:** ${interaction.user}\n` +
            `│ **Vrsta:** ${ticketType.emoji} ${ticketType.label}\n` +
            `│ **Prioritet:** ${priority.label}\n` +
            `│ **Status:** ⏳ Čeka preuzimanje\n` +
            `└─────────────────────────────────`
          )
          .setFooter({ text: `Ticket #${ticketId} • ${ticketType.label}` })
          .setTimestamp();

        // Build answers embed
        const answersEmbed = new EmbedBuilder()
          .setColor(0x2b2d31)
          .setTitle('📋 Detalji prijave');
        for (const a of answers) {
          answersEmbed.addFields({ name: a.label, value: a.value.length > 1024 ? a.value.slice(0, 1021) + '...' : a.value });
        }

        // Staff action buttons
        const staffRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('ticket_claim').setLabel('Preuzmi Ticket').setEmoji('✋').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Zatvori').setEmoji('🔒').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('ticket_note').setLabel('Bilješka').setEmoji('📝').setStyle(ButtonStyle.Secondary),
        );

        const snippetSelect = new StringSelectMenuBuilder()
          .setCustomId('ticket_snippet')
          .setPlaceholder('📋 Brzi odgovor (snippet)...')
          .addOptions(TICKET_SNIPPETS.map(s => ({
            label: s.label,
            value: s.value,
          })));
        const staffRow2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(snippetSelect);

        await thread.send({ embeds: [ticketEmbed, answersEmbed], components: [staffRow1, staffRow2] });

        // High priority: ping staff
        if (priority.pingStaff) {
          const staffRoles = guild.roles.cache.filter((r: any) =>
            ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
          );
          const mentions = staffRoles.map((r: any) => `<@&${r.id}>`).join(' ');
          if (mentions) {
            await thread.send({ content: `🚨 **PRIORITET VISOKI** — ${ticketType.label}\n${mentions}` });
          }
        }

        // Log to mod-log
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          const logEmbed = new EmbedBuilder()
            .setColor(priority.color)
            .setTitle('🎫 Novi Ticket Otvoren')
            .addFields(
              { name: 'Korisnik', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
              { name: 'Vrsta', value: `${ticketType.emoji} ${ticketType.label}`, inline: true },
              { name: 'Prioritet', value: priority.label, inline: true },
              { name: 'Ticket', value: `${thread} (#${ticketId})`, inline: true },
            )
            .setTimestamp();
          await (modLog as any).send({ embeds: [logEmbed] }).catch(() => {});
        }

        await interaction.editReply({ content: `✅ Ticket kreiran: ${thread}` });
      } catch (e: any) {
        console.error('[TICKET FORM] Create error:', e);
        await interaction.editReply({ content: `Greška: ${e.message}` }).catch(() => {});
      }
      return;
    }

    // ── Ticket note modal submit ──
    if (interaction.customId === 'ticket_note_modal') {
      try {
        const noteText = (interaction as any).fields.getTextInputValue('note_content');
        const thread = interaction.channel;
        if (!thread?.isThread?.()) { await interaction.reply({ content: 'Greška.', ephemeral: true }); return; }

        const noteEmbed = new EmbedBuilder()
          .setColor(0x6b7280)
          .setTitle('📝 Staff Bilješka')
          .setDescription(noteText)
          .setFooter({ text: `${interaction.user.tag} • Vidljivo samo u threadu` })
          .setTimestamp();

        await interaction.reply({ embeds: [noteEmbed], ephemeral: true });
      } catch (e: any) {
        console.error('[TICKET NOTE MODAL] Error:', e);
        await interaction.reply({ content: `Greška: ${e.message}`, ephemeral: true }).catch(() => {});
      }
      return;
    }

    // ── Farm Application modal submit ──
    if (interaction.customId === 'farm_apply_modal') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const guild = interaction.guild;
        if (!guild) { await interaction.editReply({ content: 'Greška.' }); return; }

        const ime = interaction.fields.getTextInputValue('app_ime');
        const godine = interaction.fields.getTextInputValue('app_godine');
        const iskustvo = interaction.fields.getTextInputValue('app_iskustvo');
        const aktivnost = interaction.fields.getTextInputValue('app_aktivnost');
        const razlog = interaction.fields.getTextInputValue('app_razlog');

        // Create review thread in staff-chat
        const staffChat = await getGuildChannel(guild, 'staff-chat');
        if (!staffChat) { await interaction.editReply({ content: 'Greška — staff kanal nije pronađen.' }); return; }

        const thread = await (staffChat as any).threads.create({
          name: `📝 Prijava — ${interaction.user.username}`,
          autoArchiveDuration: 10080,
          type: 12,
          reason: `Prijava za farmu od ${interaction.user.tag}`,
        });

        const appEmbed = new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle('📝 Nova Prijava za Farmu')
          .setThumbnail(interaction.user.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: '👤 Discord', value: `${interaction.user} (${interaction.user.tag})`, inline: false },
            { name: '📛 Ime / Nadimak', value: ime, inline: true },
            { name: '🎂 Godine', value: godine, inline: true },
            { name: '⏰ Planirana aktivnost', value: aktivnost, inline: true },
            { name: '🎮 Iskustvo s FS igrama', value: iskustvo, inline: false },
            { name: '💬 Zašto Slavonska Ravnica?', value: razlog, inline: false },
          )
          .setFooter({ text: `Korisnik ID: ${interaction.user.id}` })
          .setTimestamp();

        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`farm_approve:${interaction.user.id}`)
            .setLabel('Odobri')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`farm_deny:${interaction.user.id}`)
            .setLabel('Odbij')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger),
        );

        await thread.send({ embeds: [appEmbed], components: [actionRow] });

        // Ping staff
        const staffRoles = guild.roles.cache.filter((r: any) =>
          ['Upravitelj', 'Nadzornik', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
        );
        const mentions = staffRoles.map((r: any) => `<@&${r.id}>`).join(' ');
        if (mentions) {
          await thread.send({ content: `📝 **Nova prijava čeka pregled!**\n${mentions}` });
        }

        // Log to mod-log
        const modLog = await getGuildChannel(guild, 'mod-log');
        if (modLog) {
          await (modLog as any).send({ embeds: [new EmbedBuilder()
            .setColor(0xf59e0b)
            .setTitle('📝 Nova Prijava za Farmu')
            .addFields(
              { name: 'Korisnik', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
              { name: 'Status', value: '⏳ Čeka pregled', inline: true },
            )
            .setTimestamp()
          ] }).catch(() => {});
        }

        await interaction.editReply({
          content: '✅ Prijava uspješno poslana! Staff će pregledati tvoju prijavu i javiti ti rezultat. ⏳'
        });
      } catch (e: any) {
        console.error('[FARM APPLY MODAL] Error:', e);
        await interaction.editReply({ content: `Greška: ${e.message}` }).catch(() => {});
      }
      return;
    }

    if (String(interaction.customId || '').startsWith('select_channel_for_farm_manual_submit:')) {
      const farmId = String(interaction.customId.split(':')[1] || '').trim();

      try {
        await interaction.deferReply({ ephemeral: true });

        if (!farmId) {
          await interaction.editReply({ content: 'Greška: nedostaje farm ID.' });
          return;
        }

        const raw = String(interaction.fields.getTextInputValue('farm_channel_id_or_mention') || '').trim();
        const channelId = (raw.match(/\d{16,22}/)?.[0] || '').trim();

        if (!channelId) {
          await interaction.editReply({ content: 'Neispravan unos. Unesi valjan channel ID ili #mention.' });
          return;
        }

        const guild = interaction.guild;
        const channel = await guild?.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          await interaction.editReply({ content: `Kanal nije pronađen: ${channelId}` });
          return;
        }

        if (!this.isSendableChannel(channel)) {
          await interaction.editReply({ content: `Kanal <#${channelId}> nije sendable za panel poruke.` });
          return;
        }

        await interaction.editReply({ content: `Postavljam panele za farmu ${farmId} u kanal <#${channelId}>...` });
        const resultMessage = await this.deployFarmPanelsToChannel(farmId, channelId);
        await interaction.editReply({ content: resultMessage });
      } catch (error: any) {
        console.error('Farm manual channel modal error:', error);
        try {
          await interaction.editReply({ content: `Greška: ${error.message || error}` });
        } catch {}
      }
      return;
    }

    if (String(interaction.customId || '').startsWith('admin_deploy_manual_submit:')) {
      const panelType = String(interaction.customId.split(':')[1] || '').trim();

      try {
        await interaction.deferReply({ ephemeral: true });

        if (!panelType) {
          await interaction.editReply({ content: 'Greška: nedostaje panel tip.' });
          return;
        }

        const raw = String(interaction.fields.getTextInputValue('channel_id_or_mention') || '').trim();
        const channelId = (raw.match(/\d{16,22}/)?.[0] || '').trim();

        if (!channelId) {
          await interaction.editReply({ content: 'Neispravan unos. Unesi valjan channel ID ili #mention.' });
          return;
        }

        const guild = interaction.guild;
        const channel = await guild?.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          await interaction.editReply({ content: `Kanal nije pronađen: ${channelId}` });
          return;
        }

        if (!this.isSendableChannel(channel)) {
          await interaction.editReply({ content: `Kanal <#${channelId}> nije sendable za panel poruke.` });
          return;
        }

        const existingPanel = await storage.getDeployedPanel(channelId, panelType, null);
        const result = await this.sendOrRefreshPanel(channelId, panelType, null, existingPanel);
        const msg = result.refreshed
          ? `✅ Panel **${panelType}** osvježen u <#${channelId}>.`
          : `✅ Panel **${panelType}** postavljen u <#${channelId}>.`;

        await interaction.editReply({ content: msg });
      } catch (error: any) {
        console.error('Admin deploy manual modal error:', error);
        try {
          await interaction.editReply({ content: `Greška: ${error.message || error}` });
        } catch {}
      }
      return;
    }

    // Job create modal
    if (interaction.customId === 'job_create_modal') {
      try {
        await interaction.deferReply({ ephemeral: true });

        const jobTypeRaw = interaction.fields.getTextInputValue('job_type').toLowerCase();
        const title = interaction.fields.getTextInputValue('job_title');
        const description = interaction.fields.getTextInputValue('job_description') || null;
        const paymentStr = interaction.fields.getTextInputValue('job_payment');
        const fieldStr = interaction.fields.getTextInputValue('job_field');

        // Map Croatian job types to English
        const typeMap: { [key: string]: string } = {
          'oranje': 'plowing',
          'kultivacija': 'cultivating',
          'sijanje': 'seeding',
          'zetva': 'harvesting',
          'gnojenje': 'fertilizing',
          'prskanje': 'spraying',
          'kosidba': 'mowing',
          'baliranje': 'baling',
          'prijevoz': 'transport',
          'zivotinje': 'animal_care',
          'sumarstvo': 'forestry',
          'ostalo': 'other'
        };
        const jobType = typeMap[jobTypeRaw] || 'other';

        const payment = parseInt(paymentStr) || 0;
        const fieldId = fieldStr ? parseInt(fieldStr) : null;

        // Create the job
        const jobId = `JOB-${Date.now()}`;
        const job = await storage.createJob({
          jobId,
          jobType,
          title,
          description,
          payment,
          fieldId: fieldId?.toString() || null,
          status: 'open',
          createdByFarmId: '1',
          createdByUserId: interaction.user.id,
          assignedToFarmId: null,
          assignedToUserId: null,
          completedAt: null,
          paidAt: null
        });

        await interaction.editReply({ 
          content: `Posao kreiran! ID: ${job.id}\n**${title}** - ${this.getJobTypeLabel(jobType)} - Plata: ${payment.toLocaleString()}` 
        });

        await this.refreshJobsPanelInChannel(interaction.channelId);
        return;
      } catch (error: any) {
        console.error('Job modal submit error:', error);
        try {
          if (interaction.deferred) {
            await interaction.editReply({ content: 'Greška pri kreiranju posla.' });
          }
        } catch {}
        return;
      }
    }

    // Bank transfer modal DISABLED
    if (false && String(interaction.customId || '').startsWith('bank_pay_submit:')) {
      try {
        await interaction.deferReply({ ephemeral: true });

        const parts = String(interaction.customId).split(':'); // bank_pay_submit:<farmId>:<type>:<targetId>
        const farmId = parts[1];
        const targetType = parts[2];
        const targetId = parts[3];

        const amountStr = interaction.fields.getTextInputValue('bank_amount') || '0';
        const reason = interaction.fields.getTextInputValue('bank_reason') || '';

        const amount = Math.round(Number(String(amountStr).replace(/[^0-9\-]/g, '')));
        if (!isFinite(amount) || amount <= 0) {
          await interaction.editReply({ content: 'Iznos mora biti broj veći od 0.' });
          return;
        }

        const fromFarmId = farmId;
        let toFarmId = '';

        if (targetType === 'user') {
          const member = await interaction.guild.members.fetch(targetId).catch(() => null);
          const displayName = member?.displayName || member?.user?.username || targetId;
          const wallet = await this.getOrCreateWallet(targetId, displayName);
          toFarmId = wallet.farmId;
        } else if (targetType === 'farm') {
          toFarmId = targetId;
        } else {
          await interaction.editReply({ content: 'Nepoznat tip primatelja.' });
          return;
        }

        if (targetType === 'farm') {
  // HR: Farm -> Farm transfer ide u igru preko INBOX komande (XML format za companion mod)
  const nonce = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const cmdId = Date.now().toString();

  // First: add money to target farm
  const xmlAdd = `<?xml version="1.0" encoding="utf-8"?>\n<commands>\n  <command id="${escapeXml(cmdId)}" command="moneyTransfer" farmId="${escapeXml(String(toFarmId))}" amount="${escapeXml(String(amount))}" />\n</commands>`;
  await this.enqueueInboxCommand({
    kind: 'bank_transfer',
    payloadType: 'xml',
    filename: `cmd-moneyTransfer-${cmdId}.xml`,
    commandRef: cmdId,
    xml: xmlAdd
  });

  // Second: remove money from source farm (negative amount)
  const cmdId2 = String(Date.now() + 1);
  const xmlSub = `<?xml version="1.0" encoding="utf-8"?>\n<commands>\n  <command id="${escapeXml(cmdId2)}" command="moneyTransfer" farmId="${escapeXml(String(fromFarmId))}" amount="${escapeXml(String(-amount))}" />\n</commands>`;
  await this.enqueueInboxCommand({
    kind: 'bank_transfer',
    payloadType: 'xml',
    filename: `cmd-moneyTransfer-${cmdId2}.xml`,
    commandRef: cmdId2,
    xml: xmlSub
  });

  await this.processInboxQueue(4).catch(() => {});

  await this.recordBankLog({
    ts: new Date().toISOString(),
    from: fromFarmId,
    to: toFarmId,
    amount,
    reason: reason || '',
    by: interaction.user.id,
    nonce,
    status: 'queued'
  });

  await interaction.editReply({
    content: `🟡 Transfer poslan u igru (queued): **${this.fmtMoney(amount)} €**\nOd: **${fromFarmId}**\nZa: **${toFarmId}**\nRazlog: ${reason || '-'}\nNonce: \`${nonce}\``
  });
} else {
  // HR: User isplata je virtualni wallet (Discord-side)
  await this.transferVirtual(fromFarmId, toFarmId, amount, reason, interaction.user.id);

  await interaction.editReply({
    content: `✅ Transfer uspješan: **${this.fmtMoney(amount)} €**\nOd: **${fromFarmId}**\nZa: **${toFarmId}**\nRazlog: ${reason || '-'}`
  });
}

        // Refresh bank panel in this channel (if present)
        try {
          const panel = await storage.getDeployedPanelByChannel(interaction.channelId, 'bank');
          const panelMessageId = String(panel?.messageId || '');
          if (panelMessageId) {
            const channel = await this.client.channels.fetch(interaction.channelId) as TextChannel;
            const msg = await channel.messages.fetch(panelMessageId);
            await msg.edit({ embeds: [await this.buildBankEmbed(panel?.farmId || null)], components: await this.buildBankComponents(panel?.farmId || null) });
          }
        } catch {}

        return;
      } catch (error: any) {
        console.error('Bank modal submit error:', error);
        try {
          await interaction.editReply({ content: `Greška: ${error.message || error}` });
        } catch {}
        return;
      }
    }

    // Modal submit: log channel ID
    if (interaction.customId === 'modal_log_channel') {
      const selectedChannelId = interaction.fields.getTextInputValue('log_channel_id').trim();
      if (!/^\d{17,20}$/.test(selectedChannelId)) {
        await interaction.reply({ content: '❌ Neispravan ID kanala. Mora biti 17-20 znamenki.', ephemeral: true });
        return;
      }

      await interaction.reply({
        content: `✅ Event log kanal postavljen u <#${selectedChannelId}> (join/leave + online/offline)`,
        ephemeral: true
      });

      try {
        await storage.upsertDeployedPanel({
          channelId: selectedChannelId,
          messageId: '1',
          panelType: 'log_channel',
          farmId: null
        } as any);

        await storage.upsertDeployedPanel({
          channelId: selectedChannelId,
          messageId: '1',
          panelType: 'log_presence_channel',
          farmId: null
        } as any);

        await storage.upsertDeployedPanel({
          channelId: selectedChannelId,
          messageId: '1',
          panelType: 'log_server_status_channel',
          farmId: null
        } as any);

        await storage.log({ type: 'info', message: `Event log kanal postavljen: ${selectedChannelId}` });
      } catch (e: any) {
        console.error('Save event log channel error:', e);
      }
      return;
    }

    // Modal submit: tracking channel ID
    if (interaction.customId === 'modal_tracking_channel') {
      const selectedChannelId = interaction.fields.getTextInputValue('tracking_channel_id').trim();
      if (!/^\d{17,20}$/.test(selectedChannelId)) {
        await interaction.reply({ content: '❌ Neispravan ID kanala. Mora biti 17-20 znamenki.', ephemeral: true });
        return;
      }

      await interaction.reply({
        content: `✅ Tracking log kanal postavljen u <#${selectedChannelId}>`,
        ephemeral: true
      });

      try {
        await storage.upsertDeployedPanel({
          channelId: selectedChannelId,
          messageId: '1',
          panelType: 'log_tracking_channel',
          farmId: null
        } as any);

        await storage.log({ type: 'info', message: `Tracking log kanal postavljen: ${selectedChannelId}` });
      } catch (e: any) {
        console.error('Save tracking log channel error:', e);
      }
      return;
    }
  }


  // Refresh jobs panel (button click)
  private async refreshJobsPanel(interaction: any) {
    try {
      await interaction.deferUpdate();
      
      // Get farmId from panel - use getDeployedPanelByChannel to find panel regardless of farmId
      const panel = await storage.getDeployedPanelByChannel(interaction.channelId, 'jobs');
      const farmId = panel?.farmId || null;
      
      const embed = await this.buildJobsEmbed(farmId);
      const components = await this.buildJobsComponents(farmId);
      
      await interaction.message.edit({ embeds: [embed], components });
    } catch (error: any) {
      console.error('Refresh jobs panel error:', error);
    }
  }

  // Refresh jobs panel in a specific channel
  private async refreshJobsPanelInChannel(channelId: string) {
    try {
      // Use getDeployedPanelByChannel to find panel regardless of farmId
      const panel = await storage.getDeployedPanelByChannel(channelId, 'jobs');
      if (!panel) return;

      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (!channel) return;

      const message = await channel.messages.fetch(panel.messageId);
      if (!message) return;

      // Use farmId from panel
      const farmId = panel.farmId || null;
      const embed = await this.buildJobsEmbed(farmId);
      const components = await this.buildJobsComponents(farmId);
      
      await message.edit({ embeds: [embed], components });
    } catch (error: any) {
      console.error('Refresh jobs panel in channel error:', error);
    }
  }

  // Handle job take button
  private async handleJobTake(interaction: any, jobId: number) {
    try {
      await interaction.deferReply({ ephemeral: true });

      const job = await storage.getJob(jobId);
      if (!job) {
        await interaction.editReply({ content: 'Posao nije pronaden.' });
        return;
      }

      if (job.status !== 'open') {
        await interaction.editReply({ content: 'Ovaj posao je vec preuzet ili zavrsen.' });
        return;
      }

      await storage.updateJob(jobId, {
        status: 'in_progress',
        assignedToFarmId: '1',
        assignedToUserId: interaction.user.id
      });

      await interaction.editReply({ content: `Preuzeo si posao: **${job.title}**` });

      // Refresh the panel
      await this.refreshJobsPanelInChannel(interaction.channelId);

    } catch (error: any) {
      console.error('Job take error:', error);
      try {
        if (interaction.deferred) {
          await interaction.editReply({ content: 'Greška pri preuzimanju posla.' });
        }
      } catch {}
    }
  }

  // Handle job complete button
  private async handleJobComplete(interaction: any, jobId: number) {
    try {
      await interaction.deferReply({ ephemeral: true });

      const job = await storage.getJob(jobId);
      if (!job) {
        await interaction.editReply({ content: 'Posao nije pronaden.' });
        return;
      }

      // Only the person who took or created the job can complete it
      if (job.assignedToUserId !== interaction.user.id && job.createdByUserId !== interaction.user.id) {
        await interaction.editReply({ content: 'Samo osoba koja je preuzela ili kreirala posao moze ga zavrsiti.' });
        return;
      }

      if (job.status === 'completed') {
        await interaction.editReply({ content: 'Ovaj posao je vec zavrsen.' });
        return;
      }

      await storage.updateJob(jobId, {
        status: 'completed',
        completedAt: new Date()
      });

      await interaction.editReply({ content: `Posao zavrsen: **${job.title}** - Plata: ${job.payment?.toLocaleString() || 0}` });

      // Refresh the panel
      await this.refreshJobsPanelInChannel(interaction.channelId);

    } catch (error: any) {
      console.error('Job complete error:', error);
      try {
        if (interaction.deferred) {
          await interaction.editReply({ content: 'Greška pri zavrsavanju posla.' });
        }
      } catch {}
    }
  }

  // Build jobs embed with current jobs list
  private async buildJobsEmbed(farmId: string | null = null): Promise<EmbedBuilder> {
    let jobs = await storage.getJobs();
    if (farmId) {
      jobs = jobs.filter(j => j.createdByFarmId === farmId);
    }
    const openJobs = jobs.filter(j => j.status === 'open');
    const inProgressJobs = jobs.filter(j => j.status === 'in_progress');

    let description = '';
    const farmLabel = farmId ? ` - Farma ${farmId}` : '';

    if (openJobs.length === 0 && inProgressJobs.length === 0) {
      description = 'Nema dostupnih poslova. Klikni **Novi Posao** za kreiranje.';
    } else {
      if (openJobs.length > 0) {
        description += '**DOSTUPNI POSLOVI:**\n```\n';
        for (const job of openJobs.slice(0, 10)) {
          const typeLabel = this.getJobTypeLabel(job.jobType);
          const field = job.fieldId ? ` | Polje ${job.fieldId}` : '';
          description += `#${job.id} ${typeLabel} | ${job.title}${field} | ${job.payment?.toLocaleString() || 0}\n`;
        }
        description += '```\n';
      }

      if (inProgressJobs.length > 0) {
        description += '**U TIJEKU:**\n```\n';
        for (const job of inProgressJobs.slice(0, 5)) {
          const typeLabel = this.getJobTypeLabel(job.jobType);
          description += `#${job.id} ${typeLabel} | ${job.title} | <@${job.assignedToUserId}>\n`;
        }
        description += '```\n';
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`Oglasna Ploca - Poslovi${farmLabel}`)
      .setDescription(description)
      .setColor(0x22c55e)
      .setTimestamp()
      .setFooter({ text: `Osvjezeno | Ukupno: ${jobs.length} poslova` });

    return embed;
  }

  // Build jobs panel components (buttons)
  private async buildJobsComponents(farmId: string | null = null): Promise<ActionRowBuilder<ButtonBuilder>[]> {
    let jobs = await storage.getJobs();
    if (farmId) {
      jobs = jobs.filter(j => j.createdByFarmId === farmId);
    }
    const openJobs = jobs.filter(j => j.status === 'open').slice(0, 4);
    const inProgressJobs = jobs.filter(j => j.status === 'in_progress').slice(0, 4);

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    // Row 1: Create and Refresh buttons
    const mainRow = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('job_create')
          .setLabel('Novi Posao')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('job_refresh')
          .setLabel('Osvjezi')
          .setStyle(ButtonStyle.Secondary)
      );
    rows.push(mainRow);

    // Row 2: Take job buttons (up to 4)
    if (openJobs.length > 0) {
      const takeRow = new ActionRowBuilder<ButtonBuilder>();
      for (const job of openJobs) {
        takeRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`job_take_${job.id}`)
            .setLabel(`Preuzmi #${job.id}`)
            .setStyle(ButtonStyle.Primary)
        );
      }
      rows.push(takeRow);
    }

    // Row 3: Complete job buttons (up to 4)
    if (inProgressJobs.length > 0) {
      const completeRow = new ActionRowBuilder<ButtonBuilder>();
      for (const job of inProgressJobs) {
        completeRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`job_complete_${job.id}`)
            .setLabel(`Zavrsi #${job.id}`)
            .setStyle(ButtonStyle.Danger)
        );
      }
      rows.push(completeRow);
    }

    return rows;
  }

  // --- List panel pagination helpers ---
  private isListPanel(panelType: string): boolean {
    const t = String(panelType || '').toLowerCase();
    return ['silos', 'productions', 'vehicles', 'animals', 'fields', 'farms', 'players', 'vehiclehistory'].includes(t);
  }

  private getListPageKey(messageId: string, panelType: string, farmId: string | null): string {
    return `${messageId}:${String(panelType || '').toLowerCase()}:${farmId || 'all'}`;
  }

  private getPageSizeForPanel(panelType: string, fallback: number): number {
    const t = String(panelType || '').toUpperCase();
    const envKey = `PANEL_PAGE_SIZE_${t}`;
    const raw = process.env[envKey];
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(25, Math.floor(n)));
    return fallback;
  }

  private async buildListPanelComponents(panelType: string, farmId: string | null, messageId: string): Promise<any[]> {
    const t = String(panelType || '').toLowerCase();
    const key = this.getListPageKey(messageId, t, farmId);
    const current = this.listPageByMessageAndPanel.get(key) || 0;

    const getTotal = async () => {
      if (t === 'silos') {
        let items = await storage.getSilos();
        if (farmId) items = items.filter((s: any) => String(s.farmId ?? '') === String(farmId));
        return items.length;
      }
      if (t === 'productions') {
        let items = await storage.getProductions();
        if (farmId) items = items.filter((p: any) => String(p.farmId ?? '') === String(farmId));
        const owned = items.filter((p: any) => !!p.isOwned);
        return (owned.length ? owned : items).length;
      }
      if (t === 'vehicles') {
        let items = await storage.getVehicles();
        if (farmId) items = items.filter((v: any) => String(v.farmId ?? '') === String(farmId));
        items = items.filter((v: any) => this.isDrivableVehicle(v.name, v.vehType));
        const selectedTypesRaw = this.vehiclesTypesByMessage.get(messageId) || ['ALL'];
        const availableTypes = new Set(items.map((v: any) => this.getVehicleDisplayType(v.name, v.vehType)));
        let selectedTypes = selectedTypesRaw.includes('ALL')
          ? ['ALL']
          : selectedTypesRaw.filter((x: string) => availableTypes.has(String(x || '').toUpperCase()));
        if (!selectedTypes.length) selectedTypes = ['ALL'];
        if (selectedTypes.join('|') !== selectedTypesRaw.join('|')) {
          this.vehiclesTypesByMessage.set(messageId, selectedTypes);
        }
        items = this.applyVehicleTypeFilter(items, selectedTypes);
        const selectedVehicles = this.vehiclesSelectedByMessage.get(messageId) || ['ALL'];
        if (!selectedVehicles.includes('ALL')) {
          const set = new Set(selectedVehicles);
          items = items.filter((v: any) => set.has(this.vehicleOptionValue(v)));
        }
        return items.length;
      }
      if (t === 'animals') {
        let items = await storage.getAnimals();
        if (farmId) items = items.filter((a: any) => String(a.farmId ?? '') === String(farmId));
        return items.length;
      }
      if (t === 'fields') {
        let items = await storage.getFields();
        if (farmId) items = items.filter((f: any) => String(f.ownerFarmId ?? '') === String(farmId));
        return items.length;
      }
      if (t === 'farms') {
        const items = (await storage.getFarms()).filter(f => !String(f.farmId || '').startsWith('U:'));
        return items.length;
      }
      if (t === 'players') {
        let items = await storage.getPlayers();
        if (farmId) items = items.filter((p: any) => String(p.farmId ?? '') === String(farmId));
        return items.length;
      }
      if (t === 'vehiclehistory') {
        const logs = await storage.getLogs(1000);
        let items = logs.filter((l: any) => l.type === 'vehicle_removed');
        if (farmId) {
          items = items.filter((l: any) => {
            try { return String(JSON.parse(String(l.message || '{}')).farmId || '') === String(farmId); } catch { return false; }
          });
        }
        return items.length;
      }
      return 0;
    };

    const total = await getTotal();
    const defaultFallback = t === 'productions' ? 4 : t === 'silos' ? 8 : 10;
    const pageSize = this.getPageSizeForPanel(t, defaultFallback);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const safePage = Math.min(current, totalPages - 1);
    if (safePage !== current) this.listPageByMessageAndPanel.set(key, safePage);

    const farmToken = farmId || 'all';
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`list:${t}:prev:${farmToken}`)
          .setLabel('◀ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage <= 0),
        new ButtonBuilder()
          .setCustomId(`list:${t}:refresh:${farmToken}`)
          .setLabel('↻ Refresh')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`list:${t}:next:${farmToken}`)
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= totalPages - 1)
      );

    if (t === 'vehicles') {
      let items = await storage.getVehicles();
      if (farmId) items = items.filter((v: any) => String(v.farmId ?? '') === String(farmId));
      items = items.filter((v: any) => this.isDrivableVehicle(v.name, v.vehType));

      const typeOrder = ['TRAKTOR', 'KAMION', 'TELEHANDLER', 'VILICAR', 'KOMBAJN', 'UTOVARIVAC', 'AUTO'];
      const presentTypes = new Set<string>(items.map((v: any) => this.getVehicleDisplayType(v.name, v.vehType)));
      const selectedTypesRaw = this.vehiclesTypesByMessage.get(messageId) || ['ALL'];
      let selectedTypes = selectedTypesRaw.includes('ALL')
        ? ['ALL']
        : selectedTypesRaw.filter((x: string) => presentTypes.has(String(x || '').toUpperCase()));
      if (!selectedTypes.length) selectedTypes = ['ALL'];
      if (selectedTypes.join('|') !== selectedTypesRaw.join('|')) {
        this.vehiclesTypesByMessage.set(messageId, selectedTypes);
      }
      const selectedVehicles = this.vehiclesSelectedByMessage.get(messageId) || ['ALL'];

      const typeOptions: Array<{ label: string; value: string; default?: boolean }> = [
        { label: 'Sve kategorije', value: 'ALL', default: selectedTypes.includes('ALL') }
      ];
      for (const ttype of typeOrder) {
        if (!presentTypes.has(ttype)) continue;
        typeOptions.push({ label: this.getVehicleDisplayTypeLabel(ttype).slice(0, 100), value: ttype, default: selectedTypes.includes(ttype) });
      }

      const filtered = this.applyVehicleTypeFilter(items, selectedTypes);
      const vehicleOptions: Array<{ label: string; value: string; default?: boolean; description?: string }> = [
        { label: 'Sva vozila', value: 'ALL', default: selectedVehicles.includes('ALL') }
      ];
      for (const v of filtered.slice().sort((a: any, b: any) => String(a.name || '').localeCompare(String(b.name || ''))).slice(0, 24)) {
        const val = this.vehicleOptionValue(v);
        vehicleOptions.push({
          label: String(v.name || 'Vozilo').slice(0, 100),
          value: val,
          default: selectedVehicles.includes(val),
          description: this.getVehicleDisplayTypeLabel(this.getVehicleDisplayType(v.name, v.vehType)).slice(0, 100)
        });
      }

      const maxVals = Math.min(5, typeOptions.length);
      const maxVehicleVals = Math.min(10, vehicleOptions.length);

      const rowTypes = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('vehicles_types_select')
            .setPlaceholder('Odaberi grupe vozila (traktor, kamion, telehandler...)')
            .setMinValues(1)
            .setMaxValues(maxVals)
            .addOptions(typeOptions)
        );

      const rowVehicle = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('vehicles_item_select')
            .setPlaceholder('Odaberi jedno ili više vozila/traktora...')
            .setMinValues(1)
            .setMaxValues(maxVehicleVals)
            .addOptions(vehicleOptions)
        );

      return [row, rowTypes, rowVehicle];
    }

    return [row];
  }

  // =========================
  // PLAYER HOURS (public leaderboard)
  // =========================

  private async buildPlayerHoursComponents(messageId: string): Promise<ActionRowBuilder<ButtonBuilder>[]> {
    const page = this.playerHoursPageByMessage.get(messageId) || 0;
    const pageSize = Number(process.env.PLAYER_HOURS_TOP_N || '25') || 25;
    const lb = getPlayerHoursLeaderboard(page + 1, pageSize);
    const totalPages = Math.max(1, Math.ceil((lb.total || 0) / Math.max(1, lb.pageSize || pageSize)));

    const prev = new ButtonBuilder()
      .setCustomId('playerhours_prev')
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(lb.page <= 1);

    const next = new ButtonBuilder()
      .setCustomId('playerhours_next')
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(lb.page >= totalPages);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next);
    return [row];
  }

  // =========================
  // MAP TRACKS (groundwork)
  // =========================

  private async buildMapTracksComponents(messageId: string): Promise<ActionRowBuilder<ButtonBuilder>[]> {
    const win = this.mapTracksSelectedWindowByMessage.get(messageId) || '30m';

    const b10 = new ButtonBuilder().setCustomId('maptracks_10m').setLabel('10m').setStyle(ButtonStyle.Secondary).setDisabled(win === '10m');
    const b30 = new ButtonBuilder().setCustomId('maptracks_30m').setLabel('30m').setStyle(ButtonStyle.Secondary).setDisabled(win === '30m');
    const b2h = new ButtonBuilder().setCustomId('maptracks_2h').setLabel('2h').setStyle(ButtonStyle.Secondary).setDisabled(win === '2h');
    const ref = new ButtonBuilder().setCustomId('maptracks_refresh').setLabel('Refresh').setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(b10, b30, b2h, ref);
    return [row];
  }


  // =========================
  // BANKA (virtualni novac)
  // =========================

  private walletFarmId(discordUserId: string) {
    return `U:${discordUserId}`;
  }

  private async getOrCreateWallet(discordUserId: string, displayName?: string) {
    const id = this.walletFarmId(discordUserId);
    const farms = await storage.getFarms();
    let wallet = farms.find(f => f.farmId === id) || null;
    if (!wallet) {
      wallet = await storage.upsertFarm({
        farmId: id,
        name: `Wallet - ${displayName || discordUserId}`.slice(0, 64),
        owner: discordUserId,
        balance: 0
      });
    }
    return wallet;
  }

  private async getFarmOrNull(farmId: string | null) {
    if (!farmId) return null;
    const farms = await storage.getFarms();
    return farms.find(f => f.farmId === farmId) || null;
  }

  private fmtMoney(n: number) {
    const v = Math.round(Number(n || 0));
    return v.toLocaleString('hr-HR');
  }

  private async recordBankLog(msg: any) {
    try {
      await storage.log({ type: 'bank', message: JSON.stringify(msg) });
    } catch {}
  }

  private async transferVirtual(fromFarmId: string, toFarmId: string, amount: number, reason: string, actorDiscordId: string) {
    const farms = await storage.getFarms();
    const from = farms.find(f => f.farmId === fromFarmId);
    if (!from) throw new Error(`Farma/Wallet ne postoji: ${fromFarmId}`);

    let to = farms.find(f => f.farmId === toFarmId);
    if (!to) {
      to = await storage.upsertFarm({
        farmId: toFarmId,
        name: toFarmId.startsWith('U:') ? `Wallet - ${toFarmId.slice(2)}` : `Farma ${toFarmId}`,
        owner: toFarmId.startsWith('U:') ? toFarmId.slice(2) : null,
        balance: 0
      });
    }

    const amt = Math.round(Number(amount || 0));
    if (!isFinite(amt) || amt <= 0) throw new Error('Iznos mora biti veći od 0.');
    const fromBal = Number(from.balance || 0);
    if (fromBal < amt) throw new Error('Nedovoljno sredstava.');

    await storage.upsertFarm({ farmId: from.farmId, name: from.name, owner: from.owner, balance: fromBal - amt });
    const toBal = Number(to.balance || 0);
    await storage.upsertFarm({ farmId: to.farmId, name: to.name, owner: to.owner, balance: toBal + amt });

    await this.recordBankLog({
      ts: new Date().toISOString(),
      from: from.farmId,
      to: to.farmId,
      amount: amt,
      reason: reason || '',
      by: actorDiscordId
    });
  }

  private async buildBankEmbed(farmId: string | null = null): Promise<EmbedBuilder> {
    const farmLabel = farmId ? ` - Farma ${farmId}` : '';
    const farm = await this.getFarmOrNull(farmId);

    const embed = new EmbedBuilder()
      .setTitle(`🏦 Banka${farmLabel}`)
      .setColor(0xf59e0b)
      .setTimestamp()
      .setFooter({ text: 'Virtualna banka | Sve transakcije se bilježe' });

    if (!farmId || !farm) {
      embed.setDescription('```\nBanka panel mora biti postavljen po farmi.\nKoristi /panel tip:Banka farma:<ID>\n```');
      return embed;
    }

    const allFarms = await storage.getFarms();
    const wallets = allFarms.filter(f => (f.farmId || '').startsWith('U:'));
    const farmCount = allFarms.filter(f => !(f.farmId || '').startsWith('U:')).length;

    const bal = this.fmtMoney(Number(farm.balance || 0));

    const logs = (await storage.getLogs(40)).filter(l => l.type === 'bank').slice(0, 8);
    const lines = logs.map(l => {
      try {
        const j = JSON.parse(l.message || '{}');
        const a = this.fmtMoney(Number(j.amount || 0));
        const from = String(j.from || '').slice(0, 14);
        const to = String(j.to || '').slice(0, 14);
        const r = String(j.reason || '').slice(0, 22);
        const st = String(j.status || '').toLowerCase();
        const icon = st === 'queued' ? '🟡' : st === 'failed' ? '❌' : st === 'completed' ? '✅' : '•';
        const nonce = j.nonce ? String(j.nonce).slice(0, 8) : '';
        return `${icon} ${from} -> ${to} | ${a}€ | ${r || '-'} ${nonce ? `| ${nonce}` : ''}`;
      } catch {
        return (l.message || '').slice(0, 80);
      }
    });

    let desc = '';
    desc += `\`\`\`yaml\nSaldo farme (zadnji sync): ${bal} €\nFarmi: ${farmCount} | Walleta: ${wallets.length}\n\`\`\`\n`;
    desc += `\`\`\`fix\nAKCIJE\n\`\`\`\n`;
    desc += `Odaberi akciju u dropdownu ispod, zatim cilj (igrač/farma) i unesi iznos.\n\n`;
    desc += `\`\`\`fix\nZADNJE TRANSAKCIJE\n\`\`\`\n`;
    desc += lines.length ? `\`\`\`\n${lines.join('\n')}\n\`\`\`` : '```\nNema transakcija.\n```';

    embed.setDescription(desc);
    return embed;
  }

  private async getOnlinePlayersForLinking(): Promise<Array<{ uniqueUserId: string; name: string; farmId: string | null }>> {
    const byId = new Map<string, { uniqueUserId: string; name: string; farmId: string | null }>();
    const nowMs = Date.now();
    const strictWindowMs = Math.min(120000, Math.max(15000, Number(process.env.RUNTIME_ONLINE_STRICT_WINDOW_MS || '45000') || 45000));
    const onlineByRuntimeStrict = (p: any) => {
      if (!p) return false;
      if (p.currentlyOnline === true) return true;
      const seen = Number(p.lastSeenAtMs);
      if (Number.isFinite(seen) && seen > 946684800000) {
        const delta = nowMs - seen;
        if (delta >= -5000 && delta <= strictWindowMs) return true;
      }
      const lastOnline = p.lastOnlineAt ? Date.parse(String(p.lastOnlineAt)) : NaN;
      return Number.isFinite(lastOnline) && (nowMs - lastOnline) <= strictWindowMs;
    };

    for (const p of this.runtimePlayerTimes.values()) {
      if (!onlineByRuntimeStrict(p)) continue;
      const uid = String((p as any).uniqueUserId || (p as any).id || '').trim();
      if (!uid) continue;
      byId.set(uid, {
        uniqueUserId: uid,
        name: String((p as any).nickname || (p as any).id || uid),
        farmId: (p as any).farmId != null ? String((p as any).farmId) : null,
      });
    }

    const stored = await storage.getPlayers();
    const normalize = (v: any) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const storedByName = new Map<string, any>();
    for (const p of stored) {
      const nk = normalize((p as any).name);
      if (nk && !storedByName.has(nk)) storedByName.set(nk, p);
    }

    const webstats = await getWebStatsSummaryFromEnv().catch(() => null as any);
    const wsFreshWindowMs = Math.max(30000, Number(process.env.WEBSTATS_FRESH_WINDOW_MS || '180000') || 180000);
    const wsUpdatedAtMs = webstats?.summary?.rawUpdatedAt ? Date.parse(String(webstats.summary.rawUpdatedAt)) : NaN;
    const wsIsFresh = Number.isFinite(wsUpdatedAtMs) && (nowMs - wsUpdatedAtMs) <= wsFreshWindowMs;
    if (wsIsFresh) {
      const wsPlayers = Array.isArray(webstats?.summary?.players) ? webstats.summary.players : [];
      for (const wp of wsPlayers) {
        const wsName = String((wp as any)?.name || '').trim();
        const nk = normalize(wsName);
        if (!nk) continue;
        const sp = storedByName.get(nk);
        const uid = String((sp as any)?.uniqueUserId || '').trim();
        if (!uid || byId.has(uid)) continue;
        byId.set(uid, {
          uniqueUserId: uid,
          name: String((sp as any)?.name || wsName || uid),
          farmId: (sp as any)?.farmId != null ? String((sp as any).farmId) : null,
        });
      }
    }

    return Array.from(byId.values()).slice(0, 25);
  }

    private async buildLinkingComponents(): Promise<ActionRowBuilder<any>[]> {
    const onlinePlayers = await this.getOnlinePlayersForLinking();

    const discordPick = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('link_discord_user')
        .setPlaceholder('Odaberi Discord korisnika')
        .setMinValues(1)
        .setMaxValues(1)
    );

    const gamePick = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('link_game_user')
        .setPlaceholder('Odaberi online FS25 igrača')
        .addOptions(
          onlinePlayers.length
            ? onlinePlayers.map(p => ({
                label: `${p.name}${p.farmId ? ` (Farma ${p.farmId})` : ''}`,
                value: p.uniqueUserId
              }))
            : [{ label: 'Nema online igrača', value: 'none' }]
        )
        .setMinValues(1)
        .setMaxValues(1)
    );

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('link_confirm').setLabel('Poveži').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('link_unlink').setLabel('Odspoji').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('link_refresh').setLabel('Osvježi').setStyle(ButtonStyle.Secondary)
    );

    return [discordPick, gamePick, buttons];
  }

  // ── Whitelist Management (/whitelist) ──

  private async handleWhitelistCommand(interaction: any) {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Nemaš admin ovlasti.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    try {
      switch (sub) {
        case 'add': {
          const user = interaction.options.getUser('user', true);
          const member = interaction.guild?.members.cache.get(user.id);
          const displayName = member?.displayName || user.displayName || user.username;
          const added = await addToWhitelist(user.id, displayName);
          await interaction.editReply({
            content: added
              ? `✅ **${displayName}** (${user.id}) dodan na whitelist.`
              : `ℹ️ **${displayName}** je već na whitelisti.`,
          });
          break;
        }
        case 'remove': {
          const user = interaction.options.getUser('user', true);
          const removed = await removeFromWhitelist(user.id);
          await interaction.editReply({
            content: removed
              ? `✅ **${user.displayName}** (${user.id}) uklonjen s whiteliste.`
              : `ℹ️ **${user.displayName}** nije bio na whitelisti.`,
          });
          break;
        }
        case 'list': {
          const entries = await getWhitelist();
          if (entries.length === 0) {
            await interaction.editReply({ content: 'Whitelist je prazna.' });
            return;
          }
          const lines = entries.map((e, i) => `${i + 1}. **${e.discordName}** — \`${e.discordId}\``);
          // Split into chunks of 20 for long lists
          const chunks: string[] = [];
          for (let i = 0; i < lines.length; i += 20) {
            chunks.push(lines.slice(i, i + 20).join('\n'));
          }
          const embed = new EmbedBuilder()
            .setTitle(`📋 Whitelist (${entries.length} igrača)`)
            .setColor(0x22c55e)
            .setDescription(chunks[0])
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          // Send additional chunks as follow-ups
          for (let c = 1; c < chunks.length; c++) {
            const extraEmbed = new EmbedBuilder().setDescription(chunks[c]).setColor(0x22c55e);
            await interaction.followUp({ embeds: [extraEmbed], ephemeral: true });
          }
          break;
        }
      }
    } catch (e: any) {
      console.error('[WHITELIST] Command error:', e);
      await interaction.editReply({ content: `❌ Greška: ${e.message}` });
    }
  }

  // ── Activity Check DM (/provjera) ──

  private async handleProvjeraCommand(interaction: any) {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Nemas admin ovlasti.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user', true);
    const targetId = targetUser.id;
    const adminId = interaction.user.id;
    const guildId = interaction.guildId;

    if (this.activeChecks.has(targetId)) {
      await interaction.editReply({ content: `Provjera za <@${targetId}> je vec u tijeku.` });
      return;
    }

    const sent = await this.sendActivityCheckDM(targetId, adminId, guildId, 1);
    if (!sent) {
      await interaction.editReply({ content: `Ne mogu poslati DM korisniku <@${targetId}>. Mozda ima zatvorene DM-ove.` });
      return;
    }

    await interaction.editReply({ content: `Provjera aktivnosti poslana korisniku <@${targetId}>. Dobit ces odgovor kad reagira (ili nakon 3 pokusaja).` });
  }

  private async sendActivityCheckDM(targetId: string, adminId: string, guildId: string, attempt: number): Promise<boolean> {
    try {
      const user = await this.client.users.fetch(targetId).catch(() => null);
      if (!user) return false;

      const guild = await this.client.guilds.fetch(guildId).catch(() => null);
      const serverName = (guild as any)?.name ?? 'Slavonska ravnica';

      const embed = new EmbedBuilder()
        .setTitle('Provjera aktivnosti')
        .setDescription(
          `Pozdrav! Ovo je automatska provjera aktivnosti sa servera **${serverName}**.\n\n` +
          `Molimo te da odaberes jedan od gumbova ispod kako bismo potvrdili da si jos aktivan/na.\n\n` +
          `Pokusaj: **${attempt}/3**`
        )
        .setColor(0x5865F2)
        .setTimestamp(new Date());

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('actcheck:da').setLabel('DA').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('actcheck:ne').setLabel('NE').setStyle(ButtonStyle.Danger),
      );

      await (user as any).send({ embeds: [embed], components: [row] });

      const timerId = setTimeout(async () => {
        const check = this.activeChecks.get(targetId);
        if (!check) return;

        if (attempt >= 3) {
          this.activeChecks.delete(targetId);
          try {
            const admin = await this.client.users.fetch(adminId).catch(() => null);
            if (admin) {
              const member = guild ? await (guild as any).members.fetch(targetId).catch(() => null) : null;
              const displayName = member?.displayName ?? (user as any).username;
              await (admin as any).send({
                content: `⚠️ **Provjera aktivnosti** — bez odgovora!\n**Korisnik:** ${displayName} (<@${targetId}>)\n**Pokusaji:** 3/3 — korisnik nije odgovorio.`,
              }).catch(() => null);
            }
          } catch {}
          return;
        }

        await this.sendActivityCheckDM(targetId, adminId, guildId, attempt + 1);
      }, 60 * 60 * 1000);

      this.activeChecks.set(targetId, { adminId, attempt, timerId, guildId });
      return true;
    } catch (err: any) {
      console.warn('[actcheck] Failed to send DM:', err?.message ?? err);
      return false;
    }
  }

  private fmtMin(minutes: number): string {
    const m = Math.max(0, Math.round(minutes));
    return String(m);
  }

  // ── /channels — Interactive channel manager ──
  private async handleChannelsCommand(interaction: any) {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '❌ Samo vlasnik bota može upravljati kanalima.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await this.sendChannelManagerPanel(interaction);
  }

  private async sendChannelManagerPanel(interaction: any, edit = false) {
    const config = await readChannelConfig();
    const totalChannels = config.categories.reduce((sum, c) => sum + c.channels.length, 0);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📂 Upravljanje Kanalima')
      .setDescription(
        `**${config.categories.length}** kategorija • **${totalChannels}** kanala • **${config.farmChannels.length}** farm kanala\n\n` +
        config.categories.map((cat, i) => {
          const chList = cat.channels.map(ch => {
            const flags = [
              ch.readOnly ? '🔒' : '',
              ch.staffOnly ? '🛡️' : '',
              ch.playerOnly ? '🌾' : '',
              ch.freeWrite ? '✏️' : '',
            ].filter(Boolean).join('');
            return `\`${ch.name}\` ${flags}`;
          }).join(', ');
          return `**${i + 1}. ${cat.name}**\n${chList}`;
        }).join('\n\n') +
        (config.farmChannels.length > 0 ? '\n\n**🚜 Farm kanali (per-farma):**\n' +
          config.farmChannels.map(ch => `\`${ch.name}\``).join(', ') : '')
      )
      .setFooter({ text: '🔒=readOnly 🛡️=staffOnly 🌾=playerOnly ✏️=freeWrite' })
      .setTimestamp();

    // Category select menu (for adding channel to category or removing)
    const catOptions = config.categories.map((cat, i) => ({
      label: cat.name.replace(/[─── ]/g, '').slice(0, 50),
      value: `cat_${i}`,
      description: `${cat.channels.length} kanala`,
    }));

    const rows: any[] = [];

    // Row 1: Action buttons
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('chm_add_category').setLabel('Nova Kategorija').setEmoji('📁').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('chm_add_channel').setLabel('Novi Kanal').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('chm_remove').setLabel('Ukloni').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('chm_deploy').setLabel('Deploy').setEmoji('🚀').setStyle(ButtonStyle.Secondary),
    );
    rows.push(actionRow);

    const opts: any = { embeds: [embed], components: rows };
    if (edit) {
      await interaction.editReply(opts);
    } else {
      await interaction.editReply(opts);
    }
  }

  // ── /settings — Configurable channel assignments ──
  private async handleSettingsCommand(interaction: any) {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '❌ Samo vlasnik bota može mijenjati postavke.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await this.sendSettingsPanel(interaction);
  }

  private async sendSettingsPanel(interaction: any, edit = false) {
    const guild = interaction.guild;
    if (!guild) return;

    const settings = await readGuildSettings();
    const gs = settings[guild.id] || {};

    const lines: string[] = [];
    for (const [key, meta] of Object.entries(GUILD_CHANNEL_KEYS)) {
      const chId = gs[key as GuildChannelKey];
      const chDisplay = chId ? `<#${chId}>` : '`nije postavljeno`';
      lines.push(`${meta.label}: ${chDisplay}`);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('⚙️ Postavke Kanala')
      .setDescription(
        'Odaberi koji Discord kanal se koristi za svaku funkciju bota.\n' +
        'Klikni **Postavi Kanal** pa odaberi funkciju, zatim kanal.\n\n' +
        lines.join('\n')
      )
      .setFooter({ text: `Server: ${guild.name} (${guild.id})` })
      .setTimestamp();

    // String select menu to pick which setting to change
    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('settings_pick_key')
        .setPlaceholder('Odaberi funkciju za postavljanje...')
        .addOptions(
          Object.entries(GUILD_CHANNEL_KEYS).map(([key, meta]) => ({
            label: meta.label.replace(/^[^\w]+/, '').trim(),
            value: key,
            description: meta.desc.slice(0, 100),
            emoji: meta.label.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)/u)?.[0] || undefined,
          }))
        )
    );

    // Reset button
    const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('settings_reset').setLabel('Resetiraj Sve').setEmoji('🔄').setStyle(ButtonStyle.Danger),
    );

    const opts: any = { embeds: [embed], components: [selectRow, btnRow] };
    await interaction.editReply(opts);
  }

  // ── Dashboard Backup/Restore API ──

  /**
   * Create backup from dashboard (no interaction needed).
   */
  public async createBackupFromDashboard(guildId: string, name: string): Promise<{ id: string; channelCount: number; messageCount: number; sizeMB: string }> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const result = await this.runBackup(guild, name, null, false);
    if (!result) throw new Error('Backup failed');
    return result;
  }

  /**
   * Restore backup from dashboard. mode: 'full' | 'messages'
   * channelNames: optional array of channel names to restore (null = all)
   * targetGuildId: optional guild to restore into (null = same guild)
   * targetChannelId: optional single channel to dump all messages into
   */
  public async restoreBackupFromDashboard(
    guildId: string,
    backupId: string,
    mode: string,
    channelNames?: string[] | null,
    targetGuildId?: string | null,
    targetChannelId?: string | null,
  ): Promise<{ rolesCreated: number; categoriesCreated: number; channelsCreated: number; messagesPosted: number }> {
    const destGuildId = targetGuildId || guildId;
    const guild = this.client.guilds.cache.get(destGuildId);
    if (!guild) throw new Error('Guild not found');

    const backupData = await storage.getBackup(backupId);
    if (!backupData) throw new Error('Backup not found');
    if (!backupData.channels || !Array.isArray(backupData.channels)) throw new Error('Invalid backup format');

    let rolesCreated = 0, categoriesCreated = 0, channelsCreated = 0, messagesPosted = 0, webhooksCreated = 0;

    // FULL mode: create roles
    if (mode === 'full' && backupData.roles?.length) {
      for (const r of backupData.roles) {
        try {
          const existing = guild.roles.cache.find((role: any) => role.name === r.name);
          if (!existing) {
            await guild.roles.create({
              name: r.name,
              color: parseInt(String(r.color).replace('#', ''), 16) || 0,
              hoist: r.hoist || false,
              mentionable: r.mentionable || false,
              reason: 'Dashboard restore',
            });
            rolesCreated++;
          }
        } catch {}
      }
    }

    // FULL mode: create categories
    const categoryMap = new Map<string, any>();
    if (mode === 'full' && backupData.categories?.length) {
      for (const cat of backupData.categories) {
        try {
          let existing = guild.channels.cache.find((c: any) => c.type === 4 && c.name === cat.name);
          if (!existing) {
            existing = await guild.channels.create({ name: cat.name, type: 4, reason: 'Dashboard restore' });
            categoriesCreated++;
          }
          categoryMap.set(cat.name, existing);
        } catch {}
      }
    } else {
      guild.channels.cache.filter((c: any) => c.type === 4).forEach((c: any) => categoryMap.set(c.name, c));
    }

    // Webhook cache
    const webhookCache = new Map<string, any>();
    async function getOrCreateWebhook(channel: any): Promise<any> {
      if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);
      try {
        const hooks = await channel.fetchWebhooks();
        let hook = hooks.find((h: any) => h.name === 'FarmBuddy Restore');
        if (!hook) { hook = await channel.createWebhook({ name: 'FarmBuddy Restore', reason: 'Dashboard restore' }); webhooksCreated++; }
        webhookCache.set(channel.id, hook);
        return hook;
      } catch { return null; }
    }

    // Resolve target channel if specified
    let singleTargetChannel: any = null;
    if (targetChannelId) {
      singleTargetChannel = await this.client.channels.fetch(targetChannelId).catch(() => null);
      if (!singleTargetChannel || !('send' in singleTargetChannel)) throw new Error('Target channel not found or not sendable');
    }

    // Filter channels if channelNames is provided
    const channelsToRestore = channelNames && channelNames.length > 0
      ? backupData.channels.filter((ch: any) => channelNames.includes(ch.name))
      : backupData.channels;

    // Check for previous incomplete restore state
    const prevState = await storage.getRestoreState(destGuildId);
    const channelsDone = new Set<string>(prevState?.backupId === backupId ? (prevState.channelsDone || []) : []);
    messagesPosted = prevState?.backupId === backupId ? (prevState.messagesPosted || 0) : 0;

    // Save initial state
    const allChannelNames = channelsToRestore.map((ch: any) => ch.name);
    await storage.saveRestoreState({
      guildId: destGuildId, backupId, mode, channelNames: allChannelNames,
      targetChannelId: targetChannelId || null, targetGuildId: destGuildId,
      channelsDone: [...channelsDone], messagesPosted, source: 'dashboard',
    });

    // Process channels
    for (const chData of channelsToRestore) {
      // Skip channels already restored in a previous run
      if (channelsDone.has(chData.name)) {
        console.log(`[RESTORE-DASH] Skipping already restored channel: #${chData.name}`);
        continue;
      }

      let destChannel: any = null;
      if (singleTargetChannel) {
        destChannel = singleTargetChannel;
      } else if (mode === 'full') {
        destChannel = guild.channels.cache.find((c: any) => [0, 5, 15].includes(c.type) && c.name === chData.name);
        if (!destChannel) {
          try {
            const parent = chData.category ? categoryMap.get(chData.category) : null;
            destChannel = await guild.channels.create({
              name: chData.name,
              type: chData.type === 15 ? 15 : chData.type === 5 ? 5 : 0,
              parent: parent?.id || null,
              topic: chData.topic || undefined,
              reason: 'Dashboard restore',
            });
            channelsCreated++;
          } catch {}
        }
      } else {
        destChannel = guild.channels.cache.find((c: any) => [0, 5, 15].includes(c.type) && c.name === chData.name);
      }

      if (!destChannel || !chData.messages?.length) continue;
      const webhook = await getOrCreateWebhook(destChannel);

      for (const msgData of chData.messages) {
        try {
          if (!msgData.content && (!msgData.embeds?.length) && (!msgData.attachments?.length)) continue;
          const username = (msgData.username || msgData.displayName || 'Nepoznat').slice(0, 80);
          const avatarUrl = msgData.avatarUrl || null;
          const originalTime = msgData.timestamp ? new Date(msgData.timestamp) : null;

          const rebuiltEmbeds: any[] = [];
          if (msgData.embeds?.length) {
            for (const e of msgData.embeds) {
              const eb = new EmbedBuilder();
              if (e.title) eb.setTitle(e.title);
              if (e.description) eb.setDescription(e.description);
              if (e.color != null) eb.setColor(e.color);
              if (e.url) eb.setURL(e.url);
              if (e.fields?.length) eb.addFields(e.fields.map((f: any) => ({ name: f.name || '\u200b', value: f.value || '\u200b', inline: f.inline || false })));
              if (e.footer) eb.setFooter({ text: e.footer.text || '\u200b', iconURL: e.footer.iconURL || undefined });
              if (e.thumbnail) eb.setThumbnail(e.thumbnail);
              if (e.image) eb.setImage(e.image);
              if (e.author) eb.setAuthor({ name: e.author.name || '\u200b', iconURL: e.author.iconURL || undefined, url: e.author.url || undefined });
              rebuiltEmbeds.push(eb);
            }
          }

          let content = msgData.content || '';
          if (originalTime) content += (content ? '\n' : '') + `-# <t:${Math.floor(originalTime.getTime() / 1000)}:f>`;

          // Download attachments as files (parallel)
          const files: any[] = [];
          if (msgData.attachments?.length) {
            const downloaded = await Promise.all(msgData.attachments.map(async (att: any) => {
              try {
                const url = att.proxyUrl || att.url;
                if (!url) return null;
                const resp = await fetch(url);
                if (!resp.ok) return null;
                const buffer = Buffer.from(await resp.arrayBuffer());
                return new AttachmentBuilder(buffer, { name: att.name || 'attachment' });
              } catch { return null; }
            }));
            for (const f of downloaded) { if (f) files.push(f); }
          }

          if (webhook) {
            await webhook.send({ content: content || undefined, username, avatarURL: avatarUrl || undefined, embeds: rebuiltEmbeds.length ? rebuiltEmbeds : undefined, files: files.length ? files : undefined });
          } else {
            await (destChannel as any).send({ content: content || undefined, embeds: rebuiltEmbeds.length ? rebuiltEmbeds : undefined, files: files.length ? files : undefined });
          }
          messagesPosted++;

          if (messagesPosted % 10 === 0) await new Promise(r => setTimeout(r, 300));
        } catch {}
      }

      // Mark channel done and persist
      channelsDone.add(chData.name);
      await storage.saveRestoreState({
        guildId: destGuildId, backupId, mode, channelNames: allChannelNames,
        targetChannelId: targetChannelId || null, targetGuildId: destGuildId,
        channelsDone: [...channelsDone], messagesPosted, source: 'dashboard',
      });
    }

    // Restore complete — delete state
    await storage.deleteRestoreState(destGuildId);

    // Cleanup webhooks
    for (const [, hook] of webhookCache) {
      try { await hook.delete('Restore complete'); } catch {}
    }

    return { rolesCreated, categoriesCreated, channelsCreated, messagesPosted };
  }

  // ── /backup — Save server backup to MongoDB ──
  private async handleBackupCommand(interaction: any) {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '❌ Samo vlasnik bota može napraviti backup.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;
      if (!guild) { await interaction.editReply({ content: 'Greška — ne mogu pristupiti serveru.' }); return; }

      const backupName = interaction.options.getString('name') || `backup_${new Date().toISOString().slice(0, 10)}`;
      const selectedChannel = interaction.options.getChannel('channel');
      const singleChannelMode = !!selectedChannel;

      if (singleChannelMode && ![0, 5, 15].includes(selectedChannel.type)) {
        await interaction.editReply({ content: '❌ Možeš backupirati samo tekstualne, announcement ili forum kanale.' });
        return;
      }

      await this.runBackup(guild, backupName, singleChannelMode ? selectedChannel : null, false, interaction);
    } catch (e: any) {
      console.error('[BACKUP] Error:', e);
      await interaction.editReply({ content: `❌ Greška: ${e.message}` }).catch(() => {});
    }
  }

  // Core backup function used by both /backup and daily auto-backup
  private async runBackup(guild: any, backupName: string, selectedChannel: any | null, isAuto: boolean, interaction?: any): Promise<{ id: string; channelCount: number; messageCount: number; sizeMB: string } | null> {
    const singleChannelMode = !!selectedChannel;
    const backup: any = {
      version: 3,
      serverName: guild.name,
      serverId: guild.id,
      serverIcon: guild.iconURL({ size: 128 }) || null,
      createdAt: new Date().toISOString(),
      roles: [],
      categories: [],
      channels: [],
    };

    // Backup roles (skip in single-channel mode)
    if (!singleChannelMode) {
      const roles = guild.roles.cache.sort((a: any, b: any) => b.position - a.position);
      for (const [, role] of roles) {
        if (role.name === '@everyone') continue;
        backup.roles.push({
          name: role.name,
          color: role.hexColor,
          position: role.position,
          permissions: role.permissions.toArray(),
          hoist: role.hoist,
          mentionable: role.mentionable,
        });
      }
    }

    if (interaction) {
      await interaction.editReply({ content: singleChannelMode
        ? `⏳ Backup kanala #${selectedChannel.name}...`
        : `⏳ Backup "${backupName}" u tijeku...` }).catch(() => {});
    }

    // Gather text channels
    let textChannels: any;
    if (singleChannelMode) {
      textChannels = new Map([[selectedChannel.id, selectedChannel]]);
    } else {
      textChannels = guild.channels.cache
        .filter((c: any) => [0, 5, 15].includes(c.type))
        .sort((a: any, b: any) => {
          const catA = (a as any).parent?.position ?? 999;
          const catB = (b as any).parent?.position ?? 999;
          if (catA !== catB) return catA - catB;
          return (a.position || 0) - (b.position || 0);
        });
    }

    if (!singleChannelMode) {
      const categories = guild.channels.cache
        .filter((c: any) => c.type === 4)
        .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));

      for (const [, cat] of categories) {
        backup.categories.push({ name: cat.name, position: cat.position });
      }
    }

    let totalMessages = 0;
    let channelsDone = 0;
    const totalChannels = textChannels.size;

    for (const [, channel] of textChannels) {
      const chData: any = {
        name: (channel as any).name,
        type: (channel as any).type,
        category: (channel as any).parent?.name || null,
        topic: (channel as any).topic || null,
        position: (channel as any).position || 0,
        messages: [],
        threads: [],
      };

      // Fetch ALL messages
      try {
        let lastId: string | undefined;
        for (;;) {
          const options: any = { limit: 100 };
          if (lastId) options.before = lastId;
          const msgs = await (channel as any).messages.fetch(options);
          if (!msgs || msgs.size === 0) break;

          for (const [, msg] of msgs) {
            chData.messages.push({
              username: msg.author?.username || 'unknown',
              displayName: msg.author?.globalName || msg.author?.displayName || msg.author?.username || 'Unknown',
              authorId: msg.author?.id || '',
              avatarUrl: msg.author?.displayAvatarURL?.({ size: 128 }) || null,
              isBot: msg.author?.bot || false,
              content: msg.content || '',
              embeds: msg.embeds?.map((e: any) => ({
                title: e.title || null,
                description: e.description || null,
                color: e.color ?? null,
                url: e.url || null,
                fields: e.fields || [],
                footer: e.footer ? { text: e.footer.text, iconURL: e.footer.iconURL } : null,
                thumbnail: e.thumbnail?.url || null,
                image: e.image?.url || null,
                author: e.author ? { name: e.author.name, iconURL: e.author.iconURL, url: e.author.url } : null,
              })) || [],
              attachments: msg.attachments?.map((a: any) => ({
                name: a.name,
                url: a.url,
                proxyUrl: a.proxyURL || null,
                size: a.size,
                contentType: a.contentType || null,
                width: a.width || null,
                height: a.height || null,
              })) || [],
              timestamp: msg.createdAt?.toISOString(),
              pinned: msg.pinned || false,
              reactions: msg.reactions?.cache?.map((r: any) => ({
                emoji: r.emoji?.name || '?',
                count: r.count || 0,
              })) || [],
            });
          }
          lastId = msgs.last()?.id;
          if (msgs.size < 100) break;
        }
        totalMessages += chData.messages.length;
        chData.messages.reverse(); // chronological order
      } catch {}

      // Fetch threads (active + archived)
      try {
        const activeThreads = await (channel as any).threads?.fetchActive?.().catch(() => null);
        const archivedThreads = await (channel as any).threads?.fetchArchived?.({ limit: 100 }).catch(() => null);

        const allThreads = new Map();
        if (activeThreads?.threads) for (const [id, t] of activeThreads.threads) allThreads.set(id, t);
        if (archivedThreads?.threads) for (const [id, t] of archivedThreads.threads) allThreads.set(id, t);

        for (const [, thread] of allThreads) {
          const threadData: any = { name: thread.name, archived: thread.archived || false, messages: [] };
          try {
            let lastId: string | undefined;
            for (;;) {
              const options: any = { limit: 100 };
              if (lastId) options.before = lastId;
              const msgs = await thread.messages.fetch(options);
              if (!msgs || msgs.size === 0) break;
              for (const [, msg] of msgs) {
                threadData.messages.push({
                  username: msg.author?.username || 'unknown',
                  displayName: msg.author?.globalName || msg.author?.displayName || msg.author?.username || 'Unknown',
                  authorId: msg.author?.id || '',
                  avatarUrl: msg.author?.displayAvatarURL?.({ size: 128 }) || null,
                  isBot: msg.author?.bot || false,
                  content: msg.content || '',
                  embeds: msg.embeds?.map((e: any) => ({
                    title: e.title || null,
                    description: e.description || null,
                    color: e.color ?? null,
                    fields: e.fields || [],
                    footer: e.footer ? { text: e.footer.text } : null,
                    thumbnail: e.thumbnail?.url || null,
                    image: e.image?.url || null,
                  })) || [],
                  attachments: msg.attachments?.map((a: any) => ({
                    name: a.name,
                    url: a.url,
                    proxyUrl: a.proxyURL || null,
                    size: a.size,
                    contentType: a.contentType || null,
                    width: a.width || null,
                    height: a.height || null,
                  })) || [],
                  timestamp: msg.createdAt?.toISOString(),
                });
              }
              lastId = msgs.last()?.id;
              if (msgs.size < 100) break;
            }
            threadData.messages.reverse();
            totalMessages += threadData.messages.length;
          } catch {}
          chData.threads.push(threadData);
        }
      } catch {}

      backup.channels.push(chData);
      channelsDone++;

      // Progress update every 3 channels
      if (interaction && (channelsDone % 3 === 0 || channelsDone === totalChannels)) {
        await interaction.editReply({
          content: `⏳ Backup "${backupName}"... ${channelsDone}/${totalChannels} kanala | ${totalMessages} poruka`
        }).catch(() => {});
      }
    }

    // Save to MongoDB
    const result = await storage.saveBackup({
      name: backupName,
      guildId: guild.id,
      data: backup,
      channelCount: backup.channels.length,
      messageCount: totalMessages,
      auto: isAuto,
    });

    const jsonStr = JSON.stringify(backup);
    const sizeMB = (Buffer.byteLength(jsonStr, 'utf-8') / 1024 / 1024).toFixed(1);

    if (interaction) {
      const summaryEmbed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('✅ Backup Spremljen u Bazu')
        .addFields(
          { name: '📛 Naziv', value: backupName, inline: true },
          { name: '📁 Kanali', value: `${backup.channels.length}`, inline: true },
          { name: '💬 Poruke', value: `${totalMessages.toLocaleString()}`, inline: true },
          ...(singleChannelMode ? [] : [
            { name: '🏷️ Role', value: `${backup.roles.length}`, inline: true },
            { name: '📂 Kategorije', value: `${backup.categories.length}`, inline: true },
          ]),
          { name: '📦 Veličina', value: `${sizeMB} MB`, inline: true },
          { name: '🆔 ID', value: `\`${result.id}\``, inline: true },
        )
        .setFooter({ text: `${guild.name}${singleChannelMode ? ` • #${selectedChannel.name}` : ''} • Koristi /backups za listu` })
        .setTimestamp();

      await interaction.editReply({ content: null, embeds: [summaryEmbed] });
    }

    return { id: result.id, channelCount: backup.channels.length, messageCount: totalMessages, sizeMB };
  }

  // ── Daily auto-backup ──
  private async runDailyAutoBackup() {
    const guilds = this.client.guilds.cache;
    if (!guilds || guilds.size === 0) return;

    for (const [, guild] of guilds) {
      try {
        // Check if we already did an auto-backup today
        const backups = await storage.listBackups(guild.id);
        const today = new Date().toISOString().slice(0, 10);
        const alreadyDone = backups.some(b => b.auto && b.createdAt.toISOString().slice(0, 10) === today);
        if (alreadyDone) continue;

        console.log(`[AUTO-BACKUP] Starting daily backup for ${guild.name}...`);
        const backupName = `Auto-Backup ${today}`;

        const result = await this.runBackup(guild, backupName, null, true);

        // Notify in log channel
        const logChannel = await getGuildChannel(guild, 'log');
        if (logChannel && result) {
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('🔄 Dnevni Auto-Backup Završen')
            .addFields(
              { name: '📛 Naziv', value: backupName, inline: true },
              { name: '📁 Kanali', value: `${result.channelCount}`, inline: true },
              { name: '💬 Poruke', value: `${result.messageCount.toLocaleString()}`, inline: true },
              { name: '📦 Veličina', value: `${result.sizeMB} MB`, inline: true },
              { name: '🆔 ID', value: `\`${result.id}\``, inline: true },
            )
            .setFooter({ text: 'Koristi /backups za listu svih backupa' })
            .setTimestamp();

          await logChannel.send({ embeds: [embed] }).catch(() => {});
        }

        console.log(`[AUTO-BACKUP] Done for ${guild.name}: ${result?.messageCount} messages, ${result?.sizeMB} MB`);

        // Prune auto-backups older than 7 days
        const backupsAfter = await storage.listBackups(guild.id);
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const staleAutoBackups = backupsAfter.filter(b => b.auto && b.createdAt < cutoff);
        for (const stale of staleAutoBackups) {
          await storage.deleteBackup(stale.id);
          console.log(`[AUTO-BACKUP] Pruned old auto-backup: ${stale.name} (${stale.id})`);
        }
        if (staleAutoBackups.length > 0 && logChannel) {
          await logChannel.send({ content: `🗑️ Obrisano ${staleAutoBackups.length} auto-backup(a) starijih od 7 dana.` }).catch(() => {});
        }
      } catch (e: any) {
        console.error(`[AUTO-BACKUP] Error for guild ${guild.name}:`, e);
      }
    }
  }

  // ── /backups — List saved backups ──
  private async handleBackupsListCommand(interaction: any) {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '❌ Samo vlasnik bota može pregledati backupe.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;
      if (!guild) { await interaction.editReply({ content: 'Greška.' }); return; }

      const backups = await storage.listBackups(guild.id);

      if (backups.length === 0) {
        await interaction.editReply({ content: '📂 Nema spremljenih backupa. Koristi `/backup` za kreiranje.' });
        return;
      }

      const lines = backups.slice(0, 25).map((b, i) => {
        const date = b.createdAt.toLocaleDateString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const auto = b.auto ? ' 🔄' : '';
        return `**${i + 1}.** ${b.name}${auto} — ${b.channelCount} kanala, ${b.messageCount} poruka, ${b.sizeMB} MB\n\`${b.id}\` • ${date}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📂 Spremljeni Backupi')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `${backups.length} ukupno • 🔄 = auto-backup • Koristi /restore za vraćanje` })
        .setTimestamp();

      // Add delete button
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('backup_delete').setLabel('Obriši Backup').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (e: any) {
      console.error('[BACKUPS] Error:', e);
      await interaction.editReply({ content: `❌ Greška: ${e.message}` }).catch(() => {});
    }
  }

  // ── /restore — Restore backup from MongoDB (multi-step flow) ──
  private async handleRestoreCommand(interaction: any) {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '❌ Samo vlasnik bota može pokrenuti restore.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;
      if (!guild) { await interaction.editReply({ content: 'Greška — ne mogu pristupiti serveru.' }); return; }

      const mode = interaction.options.getString('mode') || 'messages';
      const targetChannelOption = interaction.options.getChannel('channel');

      if (targetChannelOption && ![0, 5, 15].includes(targetChannelOption.type)) {
        await interaction.editReply({ content: '❌ Ciljni kanal mora biti tekstualni, announcement ili forum kanal.' });
        return;
      }

      // ── STEP 1: Select backup ──
      const backups = await storage.listBackups(guild.id);
      if (backups.length === 0) {
        await interaction.editReply({ content: '📂 Nema spremljenih backupa. Koristi `/backup` za kreiranje.' });
        return;
      }

      const backupOptions = backups.slice(0, 25).map((b) => {
        const date = b.createdAt.toLocaleDateString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const auto = b.auto ? ' 🔄' : '';
        return {
          label: `${b.name}${auto}`.slice(0, 100),
          description: `${b.channelCount} kanala, ${b.messageCount} poruka, ${b.sizeMB} MB — ${date}`.slice(0, 100),
          value: b.id,
        };
      });

      const backupSelect = new StringSelectMenuBuilder()
        .setCustomId('restore_step1_backup')
        .setPlaceholder('1️⃣ Odaberi backup...')
        .addOptions(backupOptions);

      await interaction.editReply({
        content: '📂 **Korak 1/3** — Odaberi backup koji želiš restorirati:',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(backupSelect)],
      });

      const step1 = await interaction.channel?.awaitMessageComponent({
        filter: (i: any) => i.customId === 'restore_step1_backup' && i.user.id === interaction.user.id,
        time: 120000,
      }).catch(() => null);

      if (!step1) {
        await interaction.editReply({ content: '⏰ Vrijeme isteklo.', components: [] });
        return;
      }
      await step1.deferUpdate();

      const selectedBackupId = step1.values[0];
      const selectedBackup = backups.find(b => b.id === selectedBackupId);

      // Load backup data
      await interaction.editReply({ content: `⏳ Učitavam backup "${selectedBackup?.name}"...`, components: [] });
      const backupData = await storage.getBackup(selectedBackupId);
      if (!backupData?.channels?.length) {
        await interaction.editReply({ content: '❌ Backup ne sadrži kanale.' });
        return;
      }

      // ── STEP 2: Select channels from backup ──
      const channelsWithMsgs = backupData.channels.filter((ch: any) => ch.messages?.length > 0);
      if (channelsWithMsgs.length === 0) {
        await interaction.editReply({ content: '❌ Backup ne sadrži poruke u kanalima.' });
        return;
      }

      const channelOptions = channelsWithMsgs.slice(0, 25).map((ch: any) => ({
        label: `#${ch.name}`.slice(0, 100),
        description: `${ch.messages?.length || 0} poruka${ch.category ? ` • ${ch.category}` : ''}`.slice(0, 100),
        value: ch.name,
      }));

      const channelSelect = new StringSelectMenuBuilder()
        .setCustomId('restore_step2_channels')
        .setPlaceholder('2️⃣ Odaberi kanale za restore...')
        .setMinValues(1)
        .setMaxValues(channelOptions.length)
        .addOptions(channelOptions);

      await interaction.editReply({
        content: `📂 **Korak 2/3** — Backup: **${selectedBackup?.name}**\nOdaberi kanale koje želiš restorirati (možeš odabrati više):`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(channelSelect)],
      });

      const step2 = await interaction.channel?.awaitMessageComponent({
        filter: (i: any) => i.customId === 'restore_step2_channels' && i.user.id === interaction.user.id,
        time: 120000,
      }).catch(() => null);

      if (!step2) {
        await interaction.editReply({ content: '⏰ Vrijeme isteklo.', components: [] });
        return;
      }
      await step2.deferUpdate();

      const selectedChannelNames: string[] = step2.values;

      // ── STEP 3: Select target server + channel ──
      const botGuilds = this.client.guilds.cache.map((g: any) => g);
      let destGuild = guild;
      let destChannel: any = targetChannelOption || null;

      // If bot is in more than 1 guild, let user pick
      if (botGuilds.length > 1 && !targetChannelOption) {
        const guildOptions = botGuilds.slice(0, 25).map((g: any) => ({
          label: g.name.slice(0, 100),
          description: `${g.memberCount} članova • ${g.channels.cache.size} kanala`.slice(0, 100),
          value: g.id,
        }));

        const guildSelect = new StringSelectMenuBuilder()
          .setCustomId('restore_step3_guild')
          .setPlaceholder('3️⃣ Odaberi server...')
          .addOptions(guildOptions);

        await interaction.editReply({
          content: `📂 **Korak 3/3** — Odaberi server na koji želiš restorirati:\n> Backup: **${selectedBackup?.name}** • Kanali: ${selectedChannelNames.map(n => `#${n}`).join(', ')}`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(guildSelect)],
        });

        const step3guild = await interaction.channel?.awaitMessageComponent({
          filter: (i: any) => i.customId === 'restore_step3_guild' && i.user.id === interaction.user.id,
          time: 120000,
        }).catch(() => null);

        if (!step3guild) {
          await interaction.editReply({ content: '⏰ Vrijeme isteklo.', components: [] });
          return;
        }
        await step3guild.deferUpdate();

        destGuild = this.client.guilds.cache.get(step3guild.values[0]);
        if (!destGuild) {
          await interaction.editReply({ content: '❌ Server nije pronađen.', components: [] });
          return;
        }
      }

      // If more than 1 channel selected in step 2, skip target channel pick (restore by name)
      // If exactly 1 channel selected, let user pick a target channel
      if (selectedChannelNames.length === 1 && !targetChannelOption) {
        const textChannels = destGuild.channels.cache
          .filter((c: any) => [0, 5, 15].includes(c.type))
          .sort((a: any, b: any) => a.name.localeCompare(b.name));

        const chOptions = Array.from(textChannels.values()).slice(0, 25).map((c: any) => ({
          label: `#${c.name}`.slice(0, 100),
          description: c.parent?.name ? `${c.parent.name}`.slice(0, 100) : 'Bez kategorije',
          value: c.id,
        }));

        // Add "by name" option
        chOptions.unshift({
          label: '🔄 Po imenu iz backupa',
          description: `Traži #${selectedChannelNames[0]} na serveru`,
          value: '__by_name__',
        });

        const targetSelect = new StringSelectMenuBuilder()
          .setCustomId('restore_step3_channel')
          .setPlaceholder('Odaberi ciljni kanal...')
          .addOptions(chOptions);

        await interaction.editReply({
          content: `📂 **Ciljni kanal** — Gdje želiš restorirati #${selectedChannelNames[0]}?\n> Server: **${destGuild.name}**`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(targetSelect)],
        });

        const step3ch = await interaction.channel?.awaitMessageComponent({
          filter: (i: any) => i.customId === 'restore_step3_channel' && i.user.id === interaction.user.id,
          time: 120000,
        }).catch(() => null);

        if (!step3ch) {
          await interaction.editReply({ content: '⏰ Vrijeme isteklo.', components: [] });
          return;
        }
        await step3ch.deferUpdate();

        if (step3ch.values[0] !== '__by_name__') {
          destChannel = destGuild.channels.cache.get(step3ch.values[0]);
        }
      }

      // ── Execute restore ──
      await interaction.editReply({
        content: `⏳ Restore "${selectedBackup?.name}" u tijeku...\n> Kanali: ${selectedChannelNames.map(n => `#${n}`).join(', ')}\n> Server: **${destGuild.name}**${destChannel ? ` • Kanal: <#${destChannel.id}>` : ''}`,
        components: [],
      });

      // Filter backup channels to only selected ones
      const channelsToRestore = backupData.channels.filter((ch: any) => selectedChannelNames.includes(ch.name));

      // Check for previous incomplete restore state
      const prevState = await storage.getRestoreState(destGuild.id);
      const channelsDone = new Set<string>(prevState?.backupId === selectedBackupId ? (prevState.channelsDone || []) : []);
      let resuming = channelsDone.size > 0;
      if (resuming) {
        await interaction.editReply({
          content: `🔄 Nastavljam restore gdje je stalo (${channelsDone.size} kanala već gotovo)...`,
        }).catch(() => {});
      }

      // Save initial restore state
      await storage.saveRestoreState({
        guildId: destGuild.id,
        backupId: selectedBackupId,
        mode,
        channelNames: selectedChannelNames,
        targetChannelId: destChannel?.id || null,
        targetGuildId: destGuild.id,
        channelsDone: [...channelsDone],
        messagesPosted: prevState?.backupId === selectedBackupId ? (prevState.messagesPosted || 0) : 0,
        source: 'slash',
      });

      let rolesCreated = 0;
      let categoriesCreated = 0;
      let channelsCreated = 0;
      let messagesPosted = prevState?.backupId === selectedBackupId ? (prevState.messagesPosted || 0) : 0;
      let webhooksCreated = 0;

      // FULL mode: create roles
      if (mode === 'full' && backupData.roles?.length) {
        await interaction.editReply({ content: '⏳ Kreiram role...' });
        for (const r of backupData.roles) {
          try {
            const existing = destGuild.roles.cache.find((role: any) => role.name === r.name);
            if (!existing) {
              await destGuild.roles.create({
                name: r.name,
                color: parseInt(String(r.color).replace('#', ''), 16) || 0,
                hoist: r.hoist || false,
                mentionable: r.mentionable || false,
                reason: 'Restore iz backupa',
              });
              rolesCreated++;
            }
          } catch {}
        }
      }

      // FULL mode: create categories
      const categoryMap = new Map<string, any>();
      if (mode === 'full' && backupData.categories?.length) {
        for (const cat of backupData.categories) {
          try {
            let existing = destGuild.channels.cache.find((c: any) => c.type === 4 && c.name === cat.name);
            if (!existing) {
              existing = await destGuild.channels.create({ name: cat.name, type: 4, reason: 'Restore iz backupa' });
              categoriesCreated++;
            }
            categoryMap.set(cat.name, existing);
          } catch {}
        }
      } else {
        destGuild.channels.cache.filter((c: any) => c.type === 4).forEach((c: any) => categoryMap.set(c.name, c));
      }

      const webhookCache = new Map<string, any>();
      async function getOrCreateWebhook(channel: any): Promise<any> {
        if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);
        try {
          const hooks = await channel.fetchWebhooks();
          let hook = hooks.find((h: any) => h.name === 'FarmBuddy Restore');
          if (!hook) { hook = await channel.createWebhook({ name: 'FarmBuddy Restore', reason: 'Restore iz backupa' }); webhooksCreated++; }
          webhookCache.set(channel.id, hook);
          return hook;
        } catch { return null; }
      }

      const totalCh = channelsToRestore.length;
      for (let ci = 0; ci < totalCh; ci++) {
        const chData = channelsToRestore[ci];

        // Skip channels already restored in a previous run
        if (channelsDone.has(chData.name)) {
          console.log(`[RESTORE] Skipping already restored channel: #${chData.name}`);
          continue;
        }

        let target: any = null;

        if (destChannel) {
          target = destChannel;
        } else if (mode === 'full') {
          target = destGuild.channels.cache.find((c: any) => [0, 5, 15].includes(c.type) && c.name === chData.name);
          if (!target) {
            try {
              const parent = chData.category ? categoryMap.get(chData.category) : null;
              target = await destGuild.channels.create({
                name: chData.name,
                type: chData.type === 15 ? 15 : chData.type === 5 ? 5 : 0,
                parent: parent?.id || null,
                topic: chData.topic || undefined,
                reason: 'Restore iz backupa',
              });
              channelsCreated++;
            } catch {}
          }
        } else {
          target = destGuild.channels.cache.find((c: any) => [0, 5, 15].includes(c.type) && c.name === chData.name);
        }

        if (!target || !chData.messages?.length) continue;
        const webhook = await getOrCreateWebhook(target);

        for (const msgData of chData.messages) {
          try {
            if (!msgData.content && (!msgData.embeds?.length) && (!msgData.attachments?.length)) continue;
            const username = (msgData.username || msgData.displayName || msgData.author || 'Nepoznat').slice(0, 80);
            const avatarUrl = msgData.avatarUrl || null;
            const originalTime = msgData.timestamp ? new Date(msgData.timestamp) : null;

            const rebuiltEmbeds: any[] = [];
            if (msgData.embeds?.length > 0) {
              for (const e of msgData.embeds) {
                const eb = new EmbedBuilder();
                if (e.title) eb.setTitle(e.title);
                if (e.description) eb.setDescription(e.description);
                if (e.color != null) eb.setColor(e.color);
                if (e.url) eb.setURL(e.url);
                if (e.fields?.length) eb.addFields(e.fields.filter((f: any) => f.name && f.value));
                if (e.footer?.text) eb.setFooter({ text: e.footer.text, iconURL: e.footer.iconURL || undefined });
                if (e.thumbnail) eb.setThumbnail(e.thumbnail);
                if (e.image) eb.setImage(e.image);
                if (e.author?.name) eb.setAuthor({ name: e.author.name, iconURL: e.author.iconURL || undefined, url: e.author.url || undefined });
                if (originalTime) eb.setTimestamp(originalTime);
                rebuiltEmbeds.push(eb);
              }
            }

            if (webhook) {
              const payload: any = { username, avatarURL: avatarUrl };
              if (msgData.content && !msgData.isBot) {
                payload.content = msgData.content.slice(0, 2000);
                if (rebuiltEmbeds.length > 0) payload.embeds = rebuiltEmbeds;
              } else if (rebuiltEmbeds.length > 0) {
                payload.embeds = rebuiltEmbeds;
                if (msgData.content) payload.content = msgData.content.slice(0, 2000);
              } else if (msgData.attachments?.length > 0) {
                payload.content = msgData.attachments.map((a: any) => a.url).join('\n').slice(0, 2000);
              } else { continue; }

              if (originalTime && !rebuiltEmbeds.length && payload.content) {
                const timeStr = originalTime.toLocaleString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                const timestampSuffix = `\n-# ${timeStr}`;
                if ((payload.content.length + timestampSuffix.length) <= 2000) payload.content += timestampSuffix;
              }
              await webhook.send(payload).catch(() => {});
            } else {
              const timeStr = originalTime ? originalTime.toLocaleString('hr-HR') : '';
              const content = `**${username}** — ${timeStr}\n${msgData.content || ''}`.slice(0, 2000);
              await target.send({ content, embeds: rebuiltEmbeds.length > 0 ? rebuiltEmbeds : undefined }).catch(() => {});
            }

            messagesPosted++;
            if (messagesPosted % 5 === 0) await new Promise(r => setTimeout(r, 1200));
          } catch {}
        }

        // Mark this channel as done and persist state
        channelsDone.add(chData.name);
        await storage.saveRestoreState({
          guildId: destGuild.id, backupId: selectedBackupId, mode,
          channelNames: selectedChannelNames, targetChannelId: destChannel?.id || null,
          targetGuildId: destGuild.id, channelsDone: [...channelsDone], messagesPosted, source: 'slash',
        });

        if ((ci + 1) % 2 === 0 || ci === totalCh - 1) {
          await interaction.editReply({
            content: `⏳ Restore "${selectedBackup?.name || 'backup'}"... ${ci + 1}/${totalCh} kanala | ${messagesPosted} poruka`
          }).catch(() => {});
        }
      }

      // Restore complete — delete state
      await storage.deleteRestoreState(destGuild.id);

      for (const [, hook] of webhookCache) {
        await hook.delete('Restore završen').catch(() => {});
      }

      const doneEmbed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('✅ Restore Završen')
        .addFields(
          { name: '📛 Backup', value: selectedBackup?.name || selectedBackupId, inline: true },
          { name: '🏠 Server', value: destGuild.name, inline: true },
          ...(destChannel ? [{ name: '📌 Ciljni kanal', value: `<#${destChannel.id}>`, inline: true }] : []),
          { name: '📂 Kanali', value: selectedChannelNames.map(n => `#${n}`).join(', ').slice(0, 1024), inline: false },
          { name: '🏷️ Role', value: `${rolesCreated} kreirano`, inline: true },
          { name: '📂 Kategorije', value: `${categoriesCreated} kreirano`, inline: true },
          { name: '💬 Kanali kreirani', value: `${channelsCreated}`, inline: true },
          { name: '📝 Poruke', value: `${messagesPosted} postano`, inline: true },
        )
        .setFooter({ text: `Mode: ${mode} • ${new Date().toLocaleDateString('hr-HR')}` })
        .setTimestamp();

      await interaction.editReply({ content: null, embeds: [doneEmbed] });
    } catch (e: any) {
      console.error('[RESTORE] Error:', e);
      await interaction.editReply({ content: `❌ Greška: ${e.message}` }).catch(() => {});
    }
  }

  // ── /forcerestore — Full destructive server restore from backup ──
  private async handleForceRestoreCommand(interaction: any) {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '❌ Samo vlasnik bota može pokrenuti force restore.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;
      if (!guild) { await interaction.editReply({ content: 'Greška — ne mogu pristupiti serveru.' }); return; }

      // Step 1: Pick backup — list from ALL guilds bot is in
      const allGuildIds = [...this.client.guilds.cache.keys()];
      let allBackups: any[] = [];
      for (const gid of allGuildIds) {
        const guildBackups = await storage.listBackups(gid);
        const guildName = this.client.guilds.cache.get(gid)?.name || gid;
        allBackups.push(...guildBackups.map(b => ({ ...b, guildName })));
      }
      allBackups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      if (allBackups.length === 0) {
        await interaction.editReply({ content: '📂 Nema spremljenih backupa ni na jednom serveru. Koristi `/backup` za kreiranje.' });
        return;
      }

      const backupOptions = allBackups.slice(0, 25).map((b) => {
        const date = b.createdAt.toLocaleDateString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const auto = b.auto ? ' 🔄' : '';
        const serverTag = b.guildId !== guild.id ? ` [${b.guildName}]` : '';
        return {
          label: `${b.name}${auto}${serverTag}`.slice(0, 100),
          description: `${b.channelCount} kanala, ${b.messageCount} poruka, ${b.sizeMB} MB — ${date}`.slice(0, 100),
          value: b.id,
        };
      });

      const backupSelect = new StringSelectMenuBuilder()
        .setCustomId('forcerestore_step1')
        .setPlaceholder('Odaberi backup za potpuni restore...')
        .addOptions(backupOptions);

      await interaction.editReply({
        content: '⚠️ **FORCE RESTORE** — Odaberi backup:\n> Ovo će **OBRISATI SVE** kanale i role na serveru i vratiti ih iz backupa!',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(backupSelect)],
      });

      const step1 = await interaction.channel?.awaitMessageComponent({
        filter: (i: any) => i.customId === 'forcerestore_step1' && i.user.id === interaction.user.id,
        time: 120000,
      }).catch(() => null);

      if (!step1) {
        await interaction.editReply({ content: '⏰ Vrijeme isteklo.', components: [] });
        return;
      }
      await step1.deferUpdate();

      const selectedBackupId = step1.values[0];
      const selectedBackup = allBackups.find(b => b.id === selectedBackupId);

      // Step 2: Confirm
      const sourceServer = selectedBackup?.guildId !== guild.id ? `\nIzvor: **${selectedBackup?.guildName}** → Cilj: **${guild.name}**\n` : '';
      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('forcerestore_confirm').setLabel('⚠️ DA — Obriši sve i restoriraj').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('forcerestore_cancel').setLabel('Odustani').setStyle(ButtonStyle.Secondary),
      );

      await interaction.editReply({
        content: `⚠️ **POTVRDI FORCE RESTORE**\n\n` +
          `Backup: **${selectedBackup?.name}** (${selectedBackup?.channelCount} kanala, ${selectedBackup?.messageCount} poruka)\n` +
          `${sourceServer}\n` +
          `Ovo će:\n` +
          `> 🗑️ Obrisati **SVE** kanale na serveru **${guild.name}**\n` +
          `> 🗑️ Obrisati **SVE** custom role\n` +
          `> 📂 Kreirati kategorije, kanale i role iz backupa\n` +
          `> 💬 Restorirati sve poruke, embede i slike\n\n` +
          `**Ova akcija je nepovratna!**`,
        components: [confirmRow],
      });

      const step2 = await interaction.channel?.awaitMessageComponent({
        filter: (i: any) => (i.customId === 'forcerestore_confirm' || i.customId === 'forcerestore_cancel') && i.user.id === interaction.user.id,
        time: 60000,
      }).catch(() => null);

      if (!step2 || step2.customId === 'forcerestore_cancel') {
        await interaction.editReply({ content: '❌ Force restore otkazan.', components: [] });
        return;
      }
      await step2.deferUpdate();

      // Execute force restore
      await interaction.editReply({ content: '⏳ Učitavam backup...', components: [] });
      const result = await this.executeForceRestore(guild, selectedBackupId, async (status: string) => {
        await interaction.editReply({ content: status }).catch(() => {});
      });

      const doneEmbed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('✅ Force Restore Završen')
        .addFields(
          { name: '📛 Backup', value: selectedBackup?.name || selectedBackupId, inline: true },
          { name: '🏠 Server', value: guild.name, inline: true },
          { name: '🗑️ Obrisano', value: `${result.rolesDeleted} rola, ${result.channelsDeleted} kanala`, inline: false },
          { name: '🏷️ Role kreirane', value: `${result.rolesCreated}`, inline: true },
          { name: '📂 Kategorije', value: `${result.categoriesCreated}`, inline: true },
          { name: '💬 Kanali', value: `${result.channelsCreated}`, inline: true },
          { name: '📝 Poruke', value: `${result.messagesPosted}`, inline: true },
        )
        .setFooter({ text: `Force Restore • ${new Date().toLocaleDateString('hr-HR')}` })
        .setTimestamp();

      await interaction.editReply({ content: null, embeds: [doneEmbed] });
    } catch (e: any) {
      console.error('[FORCE-RESTORE] Error:', e);
      await interaction.editReply({ content: `❌ Greška: ${e.message}` }).catch(() => {});
    }
  }

  // Core force restore logic — used by both /forcerestore and dashboard
  public async executeForceRestore(
    guild: any,
    backupId: string,
    onProgress?: (status: string) => Promise<void>,
    guildIdForAbort?: string,
  ): Promise<{
    rolesDeleted: number; channelsDeleted: number;
    rolesCreated: number; categoriesCreated: number; channelsCreated: number; messagesPosted: number;
  }> {
    const backupData = await storage.getBackup(backupId);
    if (!backupData) throw new Error('Backup not found');
    if (!backupData.channels || !Array.isArray(backupData.channels)) throw new Error('Invalid backup format');

    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
    let rolesDeleted = 0, channelsDeleted = 0;
    let rolesCreated = 0, categoriesCreated = 0, channelsCreated = 0, messagesPosted = 0;

    // Count total messages for progress
    const totalMessages = backupData.channels.reduce((sum: number, ch: any) => sum + (ch.messages?.length || 0), 0);

    const botMember = guild.members.cache.get(this.client.user?.id);
    const botHighestRole = botMember?.roles?.highest?.position ?? 0;

    // Helper to check if cancelled
    const checkAbort = () => {
      if (guildIdForAbort && this.forceRestoreAbort.get(guildIdForAbort)) {
        throw new Error('FORCE_RESTORE_CANCELLED');
      }
    };

    // Helper to update dashboard progress
    const updateDashboardProgress = (phase: string, current: number, total: number) => {
      if (guildIdForAbort) {
        this.forceRestoreProgress.set(guildIdForAbort, {
          phase, current, total, messagesPosted, totalMessages,
        });
      }
    };

    // Helper to download attachment and return AttachmentBuilder
    async function downloadAttachment(att: any): Promise<any | null> {
      try {
        const url = att.proxyUrl || att.url;
        if (!url) return null;
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const buffer = Buffer.from(await resp.arrayBuffer());
        const name = att.name || 'attachment';
        return new AttachmentBuilder(buffer, { name });
      } catch {
        return null;
      }
    }

    // ── PHASE 1: Delete all channels ──
    if (onProgress) await onProgress('🗑️ Brišem sve kanale...');
    updateDashboardProgress('Brišem kanale...', 0, 1);
    const allChannels = [...guild.channels.cache.values()];
    for (const ch of allChannels) {
      checkAbort();
      try {
        await (ch as any).delete('Force Restore');
        channelsDeleted++;
        await delay(300);
      } catch {}
    }
    if (onProgress) await onProgress(`🗑️ Obrisano ${channelsDeleted} kanala. Brišem role...`);

    // ── PHASE 2: Delete all custom roles (not @everyone, not managed/bot roles, not above bot) ──
    updateDashboardProgress('Brišem role...', 0, 1);
    const allRoles = [...guild.roles.cache.values()];
    for (const role of allRoles) {
      checkAbort();
      if ((role as any).managed || (role as any).id === guild.id) continue; // skip bot roles + @everyone
      if ((role as any).position >= botHighestRole) continue; // can't delete roles above bot
      try {
        await (role as any).delete('Force Restore');
        rolesDeleted++;
        await delay(300);
      } catch {}
    }
    if (onProgress) await onProgress(`🗑️ Obrisano ${rolesDeleted} rola, ${channelsDeleted} kanala. Kreiram role iz backupa...`);

    // ── PHASE 3: Create roles from backup ──
    const roleMap = new Map<string, any>(); // backup role name → new Role
    if (backupData.roles?.length) {
      const sortedRoles = [...backupData.roles].sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
      const totalRoles = sortedRoles.filter((r: any) => r.name !== '@everyone').length;
      let ri = 0;
      for (const r of sortedRoles) {
        if (r.name === '@everyone') continue;
        checkAbort();
        try {
          const newRole = await guild.roles.create({
            name: r.name,
            color: parseInt(String(r.color).replace('#', ''), 16) || 0,
            hoist: r.hoist || false,
            mentionable: r.mentionable || false,
            permissions: r.permissions ? BigInt(r.permissions) : undefined,
            reason: 'Force Restore',
          });
          roleMap.set(r.name, newRole);
          rolesCreated++;
          await delay(300);
        } catch (e: any) {
          console.error(`[FORCE-RESTORE] Role create error (${r.name}):`, e.message);
        }
        ri++;
        updateDashboardProgress('Kreiram role...', ri, totalRoles);
      }
    }
    if (onProgress) await onProgress(`✅ ${rolesCreated} rola kreirano. Kreiram kategorije...`);

    // ── PHASE 4: Create categories from backup ──
    const categoryMap = new Map<string, any>(); // backup cat name → new Category
    if (backupData.categories?.length) {
      const sortedCats = [...backupData.categories].sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
      let cati = 0;
      for (const cat of sortedCats) {
        checkAbort();
        try {
          const newCat = await guild.channels.create({
            name: cat.name,
            type: 4,
            reason: 'Force Restore',
          });
          categoryMap.set(cat.name, newCat);
          categoriesCreated++;
          await delay(200);
        } catch (e: any) {
          console.error(`[FORCE-RESTORE] Category create error (${cat.name}):`, e.message);
        }
        cati++;
        updateDashboardProgress('Kreiram kategorije...', cati, sortedCats.length);
      }
    }
    if (onProgress) await onProgress(`✅ ${categoriesCreated} kategorija. Kreiram kanale i restoriram poruke...`);

    // ── PHASE 5: Create channels and restore messages ──
    const sortedChannels = [...backupData.channels].sort((a: any, b: any) => (a.position || 0) - (b.position || 0));

    const webhookCache = new Map<string, any>();
    async function getOrCreateWebhook(channel: any): Promise<any> {
      if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);
      try {
        const hooks = await channel.fetchWebhooks();
        let hook = hooks.find((h: any) => h.name === 'FarmBuddy Restore');
        if (!hook) { hook = await channel.createWebhook({ name: 'FarmBuddy Restore', reason: 'Force Restore' }); }
        webhookCache.set(channel.id, hook);
        return hook;
      } catch { return null; }
    }

    const totalCh = sortedChannels.length;
    for (let ci = 0; ci < totalCh; ci++) {
      checkAbort();
      const chData = sortedChannels[ci];
      const chType = chData.type === 15 ? 15 : chData.type === 5 ? 5 : chData.type === 2 ? 2 : 0;
      const parent = chData.category ? categoryMap.get(chData.category) : null;

      let channel: any;
      try {
        channel = await guild.channels.create({
          name: chData.name,
          type: chType,
          parent: parent?.id || null,
          topic: chData.topic || undefined,
          reason: 'Force Restore',
        });
        channelsCreated++;
        await delay(200);
      } catch (e: any) {
        console.error(`[FORCE-RESTORE] Channel create error (${chData.name}):`, e.message);
        continue;
      }

      // Post messages (only for text-like channels)
      if ([0, 5, 15].includes(chType) && chData.messages?.length > 0) {
        const webhook = await getOrCreateWebhook(channel);

        for (const msgData of chData.messages) {
          checkAbort();
          try {
            if (!msgData.content && (!msgData.embeds?.length) && (!msgData.attachments?.length)) continue;
            const username = (msgData.username || msgData.displayName || msgData.author || 'Nepoznat').slice(0, 80);
            const avatarUrl = msgData.avatarUrl || null;
            const originalTime = msgData.timestamp ? new Date(msgData.timestamp) : null;

            // Rebuild embeds
            const rebuiltEmbeds: any[] = [];
            if (msgData.embeds?.length > 0) {
              for (const e of msgData.embeds) {
                const eb = new EmbedBuilder();
                if (e.title) eb.setTitle(e.title);
                if (e.description) eb.setDescription(e.description);
                if (e.color != null) eb.setColor(e.color);
                if (e.url) eb.setURL(e.url);
                if (e.fields?.length) eb.addFields(e.fields.filter((f: any) => f.name && f.value));
                if (e.footer?.text) eb.setFooter({ text: e.footer.text, iconURL: e.footer.iconURL || undefined });
                if (e.thumbnail) eb.setThumbnail(e.thumbnail);
                if (e.image) eb.setImage(e.image);
                if (e.author?.name) eb.setAuthor({ name: e.author.name, iconURL: e.author.iconURL || undefined, url: e.author.url || undefined });
                if (originalTime) eb.setTimestamp(originalTime);
                rebuiltEmbeds.push(eb);
              }
            }

            // Download attachments as files (parallel)
            const files: any[] = [];
            if (msgData.attachments?.length > 0) {
              const downloaded = await Promise.all(msgData.attachments.map((att: any) => downloadAttachment(att)));
              for (const file of downloaded) { if (file) files.push(file); }
            }

            if (webhook) {
              const payload: any = { username, avatarURL: avatarUrl };
              if (msgData.content) {
                payload.content = msgData.content.slice(0, 2000);
              }
              if (rebuiltEmbeds.length > 0) payload.embeds = rebuiltEmbeds;
              if (files.length > 0) payload.files = files;
              if (!payload.content && !payload.embeds?.length && !files.length) continue;

              // Add timestamp footer
              if (originalTime && !rebuiltEmbeds.length && payload.content) {
                const timeStr = originalTime.toLocaleString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                const timestampSuffix = `\n-# ${timeStr}`;
                if ((payload.content.length + timestampSuffix.length) <= 2000) payload.content += timestampSuffix;
              }
              await webhook.send(payload).catch(() => {});
            } else {
              const timeStr = originalTime ? originalTime.toLocaleString('hr-HR') : '';
              const content = `**${username}** — ${timeStr}\n${msgData.content || ''}`.slice(0, 2000);
              await channel.send({ content, embeds: rebuiltEmbeds.length > 0 ? rebuiltEmbeds : undefined, files: files.length > 0 ? files : undefined }).catch(() => {});
            }

            messagesPosted++;
            // Update dashboard progress for each message
            updateDashboardProgress(`Restoriram #${chData.name}...`, ci + 1, totalCh);
            if (messagesPosted % 10 === 0) await delay(300);
          } catch {}
        }
      }

      // Progress update every 2 channels
      if (onProgress && ((ci + 1) % 2 === 0 || ci === totalCh - 1)) {
        await onProgress(`⏳ ${ci + 1}/${totalCh} kanala | ${messagesPosted} poruka | ${channelsCreated} kreirano`).catch(() => {});
      }
    }

    // Cleanup webhooks
    for (const [, hook] of webhookCache) {
      try { await hook.delete('Force Restore završen'); } catch {}
    }

    return { rolesDeleted, channelsDeleted, rolesCreated, categoriesCreated, channelsCreated, messagesPosted };
  }

  // Public method for dashboard force restore (async, with progress + cancel)
  public async forceRestoreFromDashboard(guildId: string, backupId: string): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');

    // Initialize progress + abort flag
    this.forceRestoreAbort.set(guildId, false);
    this.forceRestoreProgress.set(guildId, {
      phase: 'Pokrećem...', current: 0, total: 0, messagesPosted: 0, totalMessages: 0,
    });

    // Run in background — don't await, let polling handle progress
    this.executeForceRestore(guild, backupId, undefined, guildId)
      .then((result) => {
        const p = this.forceRestoreProgress.get(guildId);
        if (p) {
          p.done = true;
          p.phase = 'Završeno!';
          p.result = result;
        }
      })
      .catch((err) => {
        const p = this.forceRestoreProgress.get(guildId);
        if (p) {
          if (err.message === 'FORCE_RESTORE_CANCELLED') {
            p.cancelled = true;
            p.phase = 'Otkazano';
          } else {
            p.error = err.message;
            p.phase = 'Greška';
          }
        }
      });
  }

  public cancelForceRestore(guildId: string): void {
    this.forceRestoreAbort.set(guildId, true);
  }

  public getForceRestoreProgress(guildId: string) {
    return this.forceRestoreProgress.get(guildId) || null;
  }

  public clearForceRestoreProgress(guildId: string) {
    this.forceRestoreProgress.delete(guildId);
    this.forceRestoreAbort.delete(guildId);
  }

  private isOwner(userId: string): boolean {
    const ownerIds = String(process.env.OWNER_DISCORD_ID || process.env.DISCORD_OWNER_ID || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (ownerIds.length === 0) return true;
    return ownerIds.includes(String(userId || '').trim());
  }

  private isStaffMember(member: any): boolean {
    const userId = String(member?.id || member?.user?.id || '').trim();
    if (userId && this.isOwner(userId)) return true;
    if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    return !!member?.roles?.cache?.some((r: any) =>
      ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(name => r.name.includes(name))
    );
  }

  private normalizeModerationSearch(value: any): string {
    return plainName(String(value || '').trim());
  }

  private async sendGameAdminCommand(command: string, params: Record<string, any>): Promise<string> {
    const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    let attrs = `id="${escapeXml(id)}" command="${escapeXml(command)}"`;
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      attrs += ` ${escapeXml(String(key))}="${escapeXml(String(value))}"`;
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<commands>\n  <command ${attrs} />\n</commands>`;
    await this.enqueueInboxCommand({
      kind: 'console',
      payloadType: 'xml',
      filename: `cmd-${command}-${id}.xml`,
      commandRef: id,
      xml,
    });
    await this.processInboxQueue(2).catch(() => {});
    return id;
  }

  private async logModerationAction(guild: any, title: string, color: number, fields: any[]) {
    const modLog = await getGuildChannel(guild, 'mod-log');
    if (!modLog || !('send' in modLog)) return;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .addFields(fields)
      .setTimestamp();
    await (modLog as any).send({ embeds: [embed] }).catch(() => {});
  }

  private async findModerationCandidates(guild: any, query: string): Promise<any[]> {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) return [];

    const idQuery = rawQuery.replace(/[<@!>]/g, '').trim();
    const normQuery = this.normalizeModerationSearch(rawQuery);
    const [links, removed] = await Promise.all([
      storage.getPlayerLinks().catch(() => [] as any[]),
      storage.getRemovedPlayers().catch(() => [] as any[]),
    ]);

    const scoreEntry = (entry: any) => {
      const discordId = String(entry?.discordUserId || '').trim();
      const uniqueUserId = String(entry?.uniqueUserId || '').trim();
      const playerName = String(entry?.playerName || '').trim();
      const discordName = String(entry?.discordName || '').trim();
      const normPlayer = this.normalizeModerationSearch(playerName);
      const normDiscord = this.normalizeModerationSearch(discordName);

      if (idQuery && discordId && discordId === idQuery) return 100;
      if (idQuery && uniqueUserId && uniqueUserId === idQuery) return 95;
      if (normQuery && normPlayer && normPlayer === normQuery) return 92;
      if (normQuery && normDiscord && normDiscord === normQuery) return 90;
      if (normQuery && normPlayer && normPlayer.includes(normQuery)) return 72;
      if (normQuery && normDiscord && normDiscord.includes(normQuery)) return 68;
      return 0;
    };

    const candidates = new Map<string, any>();
    const upsert = (entry: any, source: string) => {
      const score = scoreEntry(entry);
      if (score <= 0) return;
      const key = String(entry?.discordUserId || '').trim()
        ? `d:${String(entry.discordUserId).trim()}`
        : String(entry?.uniqueUserId || '').trim()
          ? `g:${String(entry.uniqueUserId).trim()}`
          : `n:${this.normalizeModerationSearch(entry?.playerName || entry?.discordName || source)}`;
      const existing = candidates.get(key);
      if (!existing) {
        candidates.set(key, {
          discordUserId: String(entry?.discordUserId || '').trim() || undefined,
          discordName: String(entry?.discordName || '').trim() || undefined,
          uniqueUserId: String(entry?.uniqueUserId || '').trim() || undefined,
          playerName: String(entry?.playerName || '').trim() || undefined,
          defaultFarmId: String(entry?.defaultFarmId || '').trim() || undefined,
          removedAt: entry?.removedAt,
          score,
          sources: [source],
        });
        return;
      }
      existing.score = Math.max(existing.score, score);
      existing.discordUserId ||= String(entry?.discordUserId || '').trim() || undefined;
      existing.discordName ||= String(entry?.discordName || '').trim() || undefined;
      existing.uniqueUserId ||= String(entry?.uniqueUserId || '').trim() || undefined;
      existing.playerName ||= String(entry?.playerName || '').trim() || undefined;
      existing.defaultFarmId ||= String(entry?.defaultFarmId || '').trim() || undefined;
      existing.removedAt ||= entry?.removedAt;
      if (!existing.sources.includes(source)) existing.sources.push(source);
    };

    for (const link of links) {
      const member = guild?.members?.cache?.get?.(String(link?.discordUserId || '').trim());
      upsert({
        discordUserId: link?.discordUserId,
        discordName: member?.user?.tag || member?.user?.username || member?.displayName || undefined,
        uniqueUserId: link?.uniqueUserId,
        playerName: link?.playerName,
        defaultFarmId: link?.defaultFarmId,
      }, 'link');
    }
    for (const row of removed) {
      upsert(row, 'arhiva');
    }

    // Also search guild members directly — covers players not in DB (searched by Discord ID or username)
    if (guild) {
      // If query looks like a Discord ID, try direct fetch
      if (/^\d{15,20}$/.test(idQuery)) {
        try {
          const fetchedMember = await guild.members.fetch(idQuery).catch(() => null);
          if (fetchedMember) {
            upsert({
              discordUserId: fetchedMember.id,
              discordName: fetchedMember.user?.tag || fetchedMember.user?.username,
              playerName: fetchedMember.displayName || undefined,
            }, 'discord-live');
          }
        } catch {}
      }

      // Also search cached members by display name / username
      if (normQuery.length >= 3) {
        for (const [, member] of guild.members.cache) {
          const nameNorm = this.normalizeModerationSearch(member.displayName || '');
          const tagNorm = this.normalizeModerationSearch(member.user?.tag || member.user?.username || '');
          if (nameNorm.includes(normQuery) || tagNorm.includes(normQuery)) {
            upsert({
              discordUserId: member.id,
              discordName: member.user?.tag || member.user?.username,
              playerName: member.displayName || undefined,
            }, 'discord-live');
          }
        }
      }
    }

    return [...candidates.values()].sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(String(b.removedAt || 0)).getTime() - new Date(String(a.removedAt || 0)).getTime();
    });
  }

  /** Purge all messages from a specific user across all accessible text channels */
  private async purgeUserMessages(guild: any, targetUserId: string): Promise<number> {
    if (!targetUserId || !guild) return 0;
    let total = 0;
    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
    const textChannels = [...guild.channels.cache.values()].filter((c: any) => c.type === 0);

    for (const ch of textChannels) {
      try {
        const msgs = await (ch as any).messages.fetch({ limit: 100 });
        const userMsgs = msgs.filter((m: any) => m.author?.id === targetUserId);
        if (userMsgs.size === 0) continue;

        const recent = userMsgs.filter((m: any) => Date.now() - m.createdTimestamp < TWO_WEEKS);
        const old = userMsgs.filter((m: any) => Date.now() - m.createdTimestamp >= TWO_WEEKS);

        if (recent.size > 0) {
          if (recent.size === 1) {
            await [...recent.values()][0].delete().catch(() => {});
          } else {
            await (ch as any).bulkDelete(recent).catch(() => {});
          }
          total += recent.size;
        }
        for (const [, msg] of old) {
          await msg.delete().catch(() => {});
          total += 1;
        }
      } catch {}
    }
    return total;
  }

private async buildBankComponents(farmId: string | null = null): Promise<any[]> {
    const fid = farmId || 'null';

    const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`bank_action:${fid}`)
          .setPlaceholder('Odaberi bankovnu akciju...')
          .addOptions(
            { label: 'Isplata igraču', value: 'pay_user', description: 'Prebaci s farme na wallet igrača' },
            { label: 'Transfer farmi', value: 'pay_farm', description: 'Prebaci s farme na drugu farmu' },
            { label: 'Pregled transakcija', value: 'statement', description: 'Zadnje transakcije' }
          )
      );

    const btnRow = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_refresh:${fid}`)
          .setLabel('Osvježi')
          .setStyle(ButtonStyle.Secondary)
      );

    return [actionRow, btnRow];
  }


  async handleSayCommand(interaction: any) {
    const msg = interaction.options.getString('message', true);
    const fromUser = interaction.user?.username || interaction.user?.tag || 'DiscordUser';
    await this.sendChatToGame(msg, fromUser);

    await interaction.reply({
      content: `${String(fromUser).slice(0, 48)}: ${String(msg).slice(0, 300)}`,
      allowedMentions: { parse: [] }
    });
  }

  private async sendChatToGame(msg: string, fromUser: string): Promise<void> {
    const id = Date.now();
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<commands>\n` +
      `  <command id="${id}" command="sendChat" fromUser="${escapeXml(fromUser)}" content="${escapeXml(msg)}" />\n` +
      `</commands>\n`;

    const filename = `cmd-sendChat-${id}.xml`;
    await this.enqueueInboxCommand({
      kind: 'chat',
      payloadType: 'xml',
      filename,
      commandRef: String(id),
      xml
    });
    await this.processInboxQueue(2).catch(() => {});
  }

  private async handleModeracijaCommand(interaction: any) {
    if (!this.isStaffMember(interaction.member)) {
      await interaction.reply({ content: '❌ Samo staff može koristiti ovu komandu.', ephemeral: true });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '❌ Ova komanda radi samo na serveru.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    const archiveIdentity = async (data: any, reason: string) => {
      const discordUserId = String(data?.discordUserId || '').trim();
      if (!discordUserId) return;
      await storage.addRemovedPlayer({
        discordUserId,
        discordName: String(data?.discordName || '').trim() || undefined,
        uniqueUserId: String(data?.uniqueUserId || '').trim() || undefined,
        playerName: String(data?.playerName || '').trim() || undefined,
        defaultFarmId: String(data?.defaultFarmId || '').trim() || undefined,
        reason,
      }).catch(() => null);
    };

    const summarizeCandidate = (candidate: any, index: number) => {
      const sourceTxt = Array.isArray(candidate.sources) ? candidate.sources.join(', ') : 'n/a';
      const removedTxt = candidate.removedAt ? ` | arhiva: ${new Date(candidate.removedAt).toLocaleString('hr-HR')}` : '';
      return `${index + 1}. **${candidate.playerName || candidate.discordName || 'Nepoznat'}** | Discord: ${candidate.discordUserId || 'nema'} | Game ID: ${candidate.uniqueUserId || 'nema'} | Izvor: ${sourceTxt}${removedTxt}`;
    };

    try {
      if (sub === 'find') {
        const target = interaction.options.getString('target', true);
        const candidates = await this.findModerationCandidates(guild, target);
        if (candidates.length === 0) {
          await interaction.editReply('❌ Nema podudaranja u live linkovima ni arhivi removed players.');
          return;
        }
        const embed = new EmbedBuilder()
          .setColor(0x3b82f6)
          .setTitle('🕵️ Moderacija — rezultati pretrage')
          .setDescription(candidates.slice(0, 10).map(summarizeCandidate).join('\n'))
          .addFields({ name: '🔎 Upit', value: String(target), inline: false })
          .setFooter({ text: `Prikazano ${Math.min(10, candidates.length)} od ${candidates.length}` })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === 'timeout') {
        const user = interaction.options.getUser('user', true);
        const minutes = interaction.options.getInteger('minute', true);
        const reason = String(interaction.options.getString('razlog') || 'Nije naveden').trim();
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          await interaction.editReply('❌ Korisnik nije na serveru pa timeout nije moguć.');
          return;
        }
        await member.timeout(minutes * 60 * 1000, `${reason} | ${interaction.user.tag}`);
        await this.logModerationAction(guild, '🔇 Moderacija — timeout', 0xf59e0b, [
          { name: '👮 Moderator', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: '👤 Korisnik', value: `${user.tag} (<@${user.id}>)`, inline: true },
          { name: '⏱️ Trajanje', value: `${minutes} min`, inline: true },
          { name: '📝 Razlog', value: reason, inline: false },
        ]);
        await interaction.editReply(`✅ Timeout postavljen za **${user.tag}** na **${minutes} min**.`);
        return;
      }

      if (sub === 'unban-discord') {
        const userId = String(interaction.options.getString('user_id', true) || '').replace(/[<@!>]/g, '').trim();
        await guild.bans.remove(userId, `Unban by ${interaction.user.tag}`).catch((e: any) => { throw new Error(`Discord unban nije uspio: ${e.message}`); });
        await this.logModerationAction(guild, '🔓 Moderacija — Discord unban', 0x22c55e, [
          { name: '👮 Moderator', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: '🆔 Korisnik ID', value: userId, inline: true },
        ]);
        await interaction.editReply(`✅ Discord ban uklonjen za ID **${userId}**.`);
        return;
      }

      if (sub === 'unban-igra') {
        const nickname = String(interaction.options.getString('nick', true) || '').trim();
        await this.sendGameAdminCommand('unBanUser', { userNickname: nickname });
        await this.logModerationAction(guild, '🔓 Moderacija — in-game unban', 0x22c55e, [
          { name: '👮 Moderator', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: '🎮 Nick', value: nickname, inline: true },
        ]);
        await interaction.editReply(`✅ In-game unban poslan za **${nickname}**.`);
        return;
      }

      if (sub === 'ban' || sub === 'kick') {
        const user = interaction.options.getUser('user', true);
        const reason = String(interaction.options.getString('razlog') || (sub === 'ban' ? 'Ban bez razloga' : 'Kick bez razloga')).trim();
        const doDiscord = interaction.options.getBoolean('discord') ?? true;
        const doGame = interaction.options.getBoolean('igra') ?? true;
        const doPurge = interaction.options.getBoolean('brisi_poruke') ?? false;
        const nickOverride = String(interaction.options.getString('nick') || '').trim();
        if (!doDiscord && !doGame) {
          await interaction.editReply('❌ Odaberi barem jednu akciju: Discord i/ili igra.');
          return;
        }

        const member = await guild.members.fetch(user.id).catch(() => null);
        const link = await storage.getPlayerLinkByDiscord(user.id).catch(() => null);
        const removed = (await storage.getRemovedPlayers().catch(() => [] as any[]))
          .filter((row: any) => String(row?.discordUserId || '').trim() === user.id)
          .sort((a: any, b: any) => new Date(String(b?.removedAt || 0)).getTime() - new Date(String(a?.removedAt || 0)).getTime());
        const latestRemoved = removed[0] || null;
        const gameNickname = nickOverride || String(link?.playerName || latestRemoved?.playerName || member?.displayName || '').trim();
        const identity = {
          discordUserId: user.id,
          discordName: user.tag || member?.displayName,
          uniqueUserId: String(link?.uniqueUserId || latestRemoved?.uniqueUserId || '').trim() || undefined,
          playerName: gameNickname || undefined,
          defaultFarmId: String(link?.defaultFarmId || latestRemoved?.defaultFarmId || '').trim() || undefined,
        };
        const results: string[] = [];

        if (doDiscord) {
          if (sub === 'ban') {
            await guild.bans.create(user.id, { reason: `${reason} | ${interaction.user.tag}` });
            results.push('Discord ban postavljen');
          } else {
            if (!member) throw new Error('Discord kick nije moguć jer korisnik više nije na serveru.');
            await member.kick(`${reason} | ${interaction.user.tag}`);
            results.push('Discord kick izvršen');
          }
          const removedFromWhitelist = await removeFromWhitelist(user.id).catch(() => false);
          if (removedFromWhitelist) results.push('Maknut s whiteliste');
        }

        if (doGame) {
          if (!gameNickname) {
            results.push(`${sub === 'ban' ? 'In-game ban' : 'In-game kick'} preskočen — nema nicka`);
          } else {
            await this.sendGameAdminCommand(sub === 'ban' ? 'banUser' : 'kickUser', { userNickname: gameNickname });
            results.push(`${sub === 'ban' ? 'In-game ban' : 'In-game kick'} poslan za ${gameNickname}`);
          }
        }

        if (doDiscord && link) {
          await storage.deletePlayerLinkByDiscord(user.id).catch(() => {});
        }
        if (doDiscord || sub === 'ban') {
          await archiveIdentity(identity, `${sub === 'ban' ? 'Ban' : 'Kick'} — ${reason}`);
        }

        if (doPurge) {
          // Run purge async so the reply isn't blocked
          this.purgeUserMessages(guild, user.id)
            .then(n => {
              if (n > 0) results.push(`🗑️ Obrisano poruka: ${n}`);
            })
            .catch(() => {});
        }

        await this.logModerationAction(guild, sub === 'ban' ? '🔨 Moderacija — ban' : '👢 Moderacija — kick', sub === 'ban' ? 0xef4444 : 0xf59e0b, [
          { name: '👮 Moderator', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: '👤 Korisnik', value: `${user.tag} (${user.id})`, inline: true },
          { name: '🎮 Nick', value: gameNickname || 'nije poznat', inline: true },
          { name: '📝 Razlog', value: reason, inline: false },
          { name: '⚙️ Akcije', value: results.join('\n'), inline: false },
        ]);

        await interaction.editReply(`✅ ${sub === 'ban' ? 'Ban' : 'Kick'} završen za **${user.tag}**.\n${results.map(r => `• ${r}`).join('\n')}${doPurge ? '\n⏳ Brisanje poruka u tijeku...' : ''}`);
        return;
      }

      if (sub === 'banoffline') {
        const target = interaction.options.getString('target', true);
        const reason = String(interaction.options.getString('razlog', true) || '').trim();
        const doDiscord = interaction.options.getBoolean('discord') ?? true;
        const doGame = interaction.options.getBoolean('igra') ?? true;
        const doPurgeOffline = interaction.options.getBoolean('brisi_poruke') ?? false;
        const nickOverride = String(interaction.options.getString('nick') || '').trim();
        if (!doDiscord && !doGame) {
          await interaction.editReply('❌ Odaberi barem jednu akciju: Discord i/ili igra.');
          return;
        }

        const candidates = await this.findModerationCandidates(guild, target);
        if (candidates.length === 0) {
          await interaction.editReply('❌ Nema podudaranja u arhivi ili live linkovima.');
          return;
        }
        if (candidates.length > 1 && Number(candidates[0].score || 0) < 90 && Number(candidates[0].score || 0) === Number(candidates[1].score || 0)) {
          await interaction.editReply(`⚠️ Upit je nejasan. Suzi pretragu i pokušaj opet.\n\n${candidates.slice(0, 5).map(summarizeCandidate).join('\n')}`);
          return;
        }

        const selected = candidates[0];
        const gameNickname = nickOverride || String(selected?.playerName || '').trim();
        const discordUserId = String(selected?.discordUserId || '').trim();
        const results: string[] = [];

        if (doDiscord) {
          if (!discordUserId) {
            results.push('Discord ban preskočen — nema spremljenog Discord ID-a');
          } else {
            await guild.bans.create(discordUserId, { reason: `${reason} | offline ban | ${interaction.user.tag}` });
            const removedFromWhitelist = await removeFromWhitelist(discordUserId).catch(() => false);
            if (removedFromWhitelist) results.push('Maknut s whiteliste');
            await storage.deletePlayerLinkByDiscord(discordUserId).catch(() => {});
            results.push(`Discord ban postavljen za ${discordUserId}`);
          }
        }

        if (doGame) {
          if (!gameNickname) {
            results.push('In-game ban preskočen — nema spremljenog nicka');
          } else {
            await this.sendGameAdminCommand('banUser', { userNickname: gameNickname });
            results.push(`In-game ban poslan za ${gameNickname}`);
          }
        }

        await archiveIdentity({
          discordUserId: discordUserId || undefined,
          discordName: selected?.discordName,
          uniqueUserId: selected?.uniqueUserId,
          playerName: gameNickname || selected?.playerName,
          defaultFarmId: selected?.defaultFarmId,
        }, `Offline ban — ${reason}`);

        await this.logModerationAction(guild, '🔨 Moderacija — offline ban', 0xef4444, [
          { name: '👮 Moderator', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: '🔎 Upit', value: target, inline: true },
          { name: '👤 Meta', value: selected?.discordName || selected?.playerName || 'Nepoznat', inline: true },
          { name: '📝 Razlog', value: reason, inline: false },
          { name: '⚙️ Akcije', value: results.join('\n'), inline: false },
        ]);

        if (doPurgeOffline && discordUserId) {
          this.purgeUserMessages(guild, discordUserId).catch(() => {});
        }

        await interaction.editReply(`✅ Offline ban obrađen za **${selected?.discordName || selected?.playerName || target}**.\n${results.map(r => `• ${r}`).join('\n')}${doPurgeOffline && discordUserId ? '\n⏳ Brisanje poruka u tijeku...' : ''}`);
        return;
      }

      await interaction.editReply('❌ Nepoznata moderacijska akcija.');
    } catch (e: any) {
      console.error('[MODERATION] Command error:', e);
      await interaction.editReply({ content: `❌ Greška: ${String(e?.message || e)}` });
    }
  }

  // ====== Server Setup Command ======
  private async handleServerSetupCommand(interaction: any) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'setup') {
      // Only guild owner or administrator can run this
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Samo administratori mogu koristiti ovu komandu.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const guild = interaction.guild;
      if (!guild) return interaction.editReply('❌ Ova komanda radi samo na serveru.');

      // ── Warning countdown before setup ──
      // Find a public channel to post warning (općenito, or first text channel)
      const warningCh = guild.channels.cache.find((c: any) =>
        c.type === 0 && (plainName(c.name) === 'opcenito' || plainName(c.name) === 'general' || plainName(c.name) === 'obavijesti')
      ) || guild.channels.cache.find((c: any) => c.type === 0 && !c.permissionOverwrites?.cache?.some((o: any) => o.id === guild.id && o.deny?.has?.(PermissionFlagsBits.ViewChannel)));

      let warningMsg: any = null;

      if (warningCh && 'send' in warningCh) {
        const warningEmbed = new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle('⚠️ SERVER SETUP — UPOZORENJE')
          .setDescription(
            '**Administrator je pokrenuo server setup!**\n\n' +
            '🔧 Kanali, role i permisije će biti ažurirani.\n' +
            '⏳ Setup počinje za **30 sekundi**...\n\n' +
            '> *Ništa se ne briše — samo se ažurira.*'
          )
          .setFooter({ text: `Pokrenuo: ${interaction.user.tag}` })
          .setTimestamp();

        warningMsg = await (warningCh as any).send({ content: '@everyone', embeds: [warningEmbed] }).catch(() => null);

        // Wait 25 seconds, then start 5-second countdown
        await new Promise(r => setTimeout(r, 25000));

        if (warningMsg) {
          for (let i = 5; i >= 1; i--) {
            const countdownEmbed = new EmbedBuilder()
              .setColor(i <= 2 ? 0xff0000 : i <= 3 ? 0xff8c00 : 0xffd700)
              .setTitle(`⏰ Setup počinje za ${i}...`)
              .setDescription(
                i === 1
                  ? '🚨 **SETUP POČINJE SADA!** Kanali se ažuriraju...'
                  : `⚠️ Server setup počinje za **${i}** sekund${i > 1 ? (i < 5 ? 'e' : 'i') : 'u'}...`
              )
              .setFooter({ text: `Pokrenuo: ${interaction.user.tag}` })
              .setTimestamp();
            await warningMsg.edit({ embeds: [countdownEmbed] }).catch(() => {});
            if (i > 1) await new Promise(r => setTimeout(r, 1000));
          }

          // Final — setup starting
          await new Promise(r => setTimeout(r, 1000));
          const startEmbed = new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle('🔧 Setup u tijeku...')
            .setDescription('Server setup je pokrenut. Kanali i role se ažuriraju.\n\n> ⏳ *Ovo može potrajati nekoliko minuta.*')
            .setFooter({ text: `Pokrenuo: ${interaction.user.tag}` })
            .setTimestamp();
          await warningMsg.edit({ content: '', embeds: [startEmbed] }).catch(() => {});
        }
      }

      await interaction.editReply('⏳ Setup je pokrenut... Pratite napredak na serveru.');

      const log: string[] = [];
      const botMember = guild.members.me;

      try { // Master try/catch — ensures editReply ALWAYS gets called
      console.log('[SETUP] ▶ v7 Starting server setup for guild', guild.id, guild.name);

      // Rate limit helper — small delay between API calls
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      // --- Detect server boost level ---
      const boostTier = guild.premiumTier || 0; // 0=None, 1=Tier1(2 boosts), 2=Tier2(7), 3=Tier3(14)
      const boostCount = guild.premiumSubscriptionCount || 0;
      const isPremium = boostTier >= 2; // Tier 2+ = role icons, better quality
      const isMaxBoost = boostTier >= 3; // Tier 3 = maximum perks

      if (isPremium) {
        log.push(`**💎 Server Boost Tier ${boostTier}** (${boostCount} boostova) — Premium boje aktivirane!`);
        log.push('');
      }

      // Premium color variants: more vibrant / gradient-like when max boosted
      const PREMIUM_PLAYTIME_COLORS: Record<string, number> = {
        '🌱 Sjeme':          isMaxBoost ? 0x00ff87 : 0x7aba57,
        '🌿 Sadnica':        isMaxBoost ? 0x00e676 : 0x2ecc71,
        '🌾 Žetelac':        isMaxBoost ? 0xffea00 : 0xf1c40f,
        '🚜 Farmer':         isMaxBoost ? 0xff6d00 : 0xe67e22,
        '⭐ Agronom':        isMaxBoost ? 0xff1744 : 0xe91e63,
        '🏆 Zemljoposjednik': isMaxBoost ? 0xffd600 : 0xffd700,
      };
      const PREMIUM_STAFF_COLORS: Record<string, number> = {
        '👑 Gazda':          isMaxBoost ? 0xffd700 : 0xe8c41a,
        '🏡 Suvlasnik':     isMaxBoost ? 0xff9100 : 0xe67e22,
        '🚜 Upravitelj':     isMaxBoost ? 0xff1744 : 0xe74c3c,
        '⚙️ Nadzornik':     isMaxBoost ? 0x448aff : 0x3498db,
        '🌿 Čuvar':          isMaxBoost ? 0x00e676 : 0x2ecc71,
      };
      const PREMIUM_SPECIAL_COLORS: Record<string, number> = {
        '🌾 Ratar':          isMaxBoost ? 0xd500f9 : 0x9b59b6,
        '🔔 NotifyMe':       isMaxBoost ? 0xffea00 : 0xf1c40f,
        '‼️ BLACKLIST':     0x1a1a1a,
        '🏘️ Mještanin':    isMaxBoost ? 0xb0bec5 : 0x95a5a6,
      };

      // --- STEP 0: Quick server scan (cache only — no Gateway calls) ---
      log.push('**🔍 Pregled servera:**');
      console.log('[SETUP] STEP 0 — Quick server scan (cache only)');

      const botHighestPos = botMember?.roles?.highest?.position || 0;
      log.push(`  📋 Cache: ${guild.members.cache.size} članova, ${guild.roles.cache.size} rola, ${guild.channels.cache.size} kanala`);

      // --- STEP 1: Create/update roles ---
      log.push('**🛡️ Role:**');
      console.log('[SETUP] STEP 1 — Creating/updating roles');

      // --- Role migration: rename old role names → new names ---
      const ROLE_MIGRATION: Record<string, string> = {
        'Vlasnik':    '👑 Gazda',
        'Sugazda':    '🏡 Suvlasnik',
        'Player':     '🌾 Ratar',
        'Member':     '🏘️ Mještanin',
      };
      for (const [oldName, newName] of Object.entries(ROLE_MIGRATION)) {
        const oldRole = guild.roles.cache.find((r: any) =>
          r.name === oldName || r.name.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}⚔️🛡️🔱‼️💎💠🎮🔔🌟🔮🥇🥈🥉👑🏰🏡🚜⚙️🌿🌱🌾⭐🏆]/gu, '').trim().toLowerCase() === oldName.toLowerCase()
        );
        if (!oldRole) continue;
        if (PROTECTED_ROLE_IDS.has(oldRole.id)) continue; // Never touch Gazda/Suvlasnik
        const newRole = guild.roles.cache.find((r: any) => r.name === newName);
        if (!newRole) {
          // No new role exists yet — just rename the old one
          try {
            await oldRole.edit({ name: newName }, 'Role migration — Server Setup');
            log.push(`  🔄 Rola preimenovana: ${oldName} → ${newName}`);
            console.log(`[SETUP] Migrated role: ${oldName} → ${newName}`);
            await delay(1000);
          } catch (e: any) {
            log.push(`  ⚠️ Migracija role ${oldName}: ${e.message}`);
          }
        } else {
          // New role already exists — migrate members from old → new, then delete old
          let migrated = 0;
          for (const [, m] of guild.members.cache) {
            if (m.roles.cache.has(oldRole.id)) {
              try {
                if (!m.roles.cache.has(newRole.id)) {
                  await m.roles.add(newRole, `Migracija: ${oldName} → ${newName}`);
                }
                await m.roles.remove(oldRole, `Migracija: ${oldName} → ${newName}`);
                migrated++;
                await delay(300);
              } catch {}
            }
          }
          // Delete the old role
          try {
            await oldRole.delete(`Migracija završena — stara rola ${oldName}`);
            log.push(`  🗑️ Stara rola obrisana: ${oldName} (${migrated} članova prebačeno na ${newName})`);
            console.log(`[SETUP] Deleted old role ${oldName}, migrated ${migrated} members`);
          } catch (e: any) {
            log.push(`  ⚠️ Brisanje stare role ${oldName}: ${e.message}`);
          }
        }
      }
      // Refresh role cache after migration
      await guild.roles.fetch();

      // Helper: find or create role
      const findOrCreateRole = async (name: string, color: number, perms: bigint | null, hoist = false, mentionable = false, reason = 'Server Setup') => {
        // Try to match by name (strip emoji for matching)
        const stripped = name.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}⚔️🛡️🔱‼️💎💠🎮🔔🌟🔮🥇🥈🥉👑🏰🏡🚜⚙️🌿🌱🌾⭐🏆]/gu, '').trim();
        let existing = guild.roles.cache.find((r: any) => r.name === name) ||
                        guild.roles.cache.find((r: any) => r.name.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}⚔️🛡️🔱‼️💎💠🎮🔔🌟🔮🥇🥈🥉👑🏰🏡🚜⚙️🌿🌱🌾⭐🏆]/gu, '').trim().toLowerCase() === stripped.toLowerCase());
        if (existing) {
          // Never touch protected roles (Gazda, Suvlasnik)
          if (PROTECTED_ROLE_IDS.has(existing.id)) {
            log.push(`  🔒 Zaštićeno: ${existing.name}`);
            return existing;
          }
          // Update if needed
          const updates: any = {};
          if (existing.color !== color) updates.color = color;
          if (hoist && !existing.hoist) updates.hoist = true;
          if (mentionable && !existing.mentionable) updates.mentionable = true;
          if (existing.name !== name) updates.name = name;
          if (Object.keys(updates).length > 0) {
            try {
              await existing.edit(updates, reason);
              log.push(`  ✏️ Ažurirano: ${name}`);
            } catch (editErr: any) {
              log.push(`  ⚠️ Ne mogu ažurirati: ${name} (${editErr.message})`);
              console.warn(`[SETUP] Cannot edit role ${name}: ${editErr.message}`);
            }
          } else {
            log.push(`  ✅ Postoji: ${name}`);
          }
          return existing;
        }
        const opts: any = { name, color, hoist, mentionable, reason };
        if (perms !== null) opts.permissions = perms;
        const created = await guild.roles.create(opts);
        log.push(`  ✨ Kreirano: ${name}`);
        await delay(1500); // Rate limit protection
        return created;
      };

      // Staff roles (highest position)
      const staffRoleObjs: any[] = [];
      for (const r of STAFF_ROLES) {
        const color = isPremium ? (PREMIUM_STAFF_COLORS[r.name] || r.color) : r.color;
        const role = await findOrCreateRole(r.name, color, r.permissions, r.hoist);
        staffRoleObjs.push(role);
      }

      // Special roles
      const specialRoleObjs: Map<string, any> = new Map();
      for (const r of SPECIAL_ROLES) {
        const color = isPremium ? (PREMIUM_SPECIAL_COLORS[r.name] || r.color) : r.color;
        const role = await findOrCreateRole(r.name, color, null, r.hoist || false, r.mentionable || false);
        specialRoleObjs.set(r.name, role);
      }

      // Playtime roles (lowest section)
      const playtimeRoleObjs: any[] = [];
      for (const r of PLAYTIME_ROLES) {
        const color = isPremium ? (PREMIUM_PLAYTIME_COLORS[r.name] || r.color) : r.color;
        const role = await findOrCreateRole(r.name, color, null, false);
        playtimeRoleObjs.push(role);
      }

      // Farm roles (dynamic, based on ALL DB farms — skip farmId 0 only)
      const allDbFarms = await storage.getFarms();
      const dbFarms = allDbFarms.filter(f => f.farmId !== '0');
      const farmRoleObjs: Map<string, any> = new Map(); // farmId → Role
      for (let i = 0; i < dbFarms.length; i++) {
        const farm = dbFarms[i];
        const farmName = farm.name || `Farma ${farm.farmId}`;
        const roleName = `${FARM_ROLE_PREFIX}${farmName}`;
        const color = FARM_ROLE_COLORS[i % FARM_ROLE_COLORS.length];
        const role = await findOrCreateRole(roleName, color, null, false);
        farmRoleObjs.set(farm.farmId, role);
      }

      // --- Reorder roles: FarmBot > Gazda > Suvlasnik > Upravitelj > Nadzornik > Čuvar > Ratar > Mještanin > rest ---
      try {
        await guild.roles.fetch(); // Refresh cache
        const botRole = botMember?.roles?.highest;
        const botPos = botRole?.position || 0;
        // Position ALL roles below bot's highest role in strict order
        const positions: { id: string; position: number }[] = [];
        const usedIds = new Set<string>();
        let pos = botPos - 1;
        // Staff roles first (Gazda, Suvlasnik, Upravitelj, Nadzornik, Čuvar)
        for (const r of staffRoleObjs) {
          if (pos > 0 && !usedIds.has(r.id)) { positions.push({ id: r.id, position: pos-- }); usedIds.add(r.id); }
        }
        // Special roles (Ratar, Mještanin, NotifyMe, BLACKLIST, Unverified)
        for (const [, r] of specialRoleObjs) {
          if (r && pos > 0 && !usedIds.has(r.id)) { positions.push({ id: r.id, position: pos-- }); usedIds.add(r.id); }
        }
        // Playtime roles
        for (const r of playtimeRoleObjs) {
          if (pos > 0 && !usedIds.has(r.id)) { positions.push({ id: r.id, position: pos-- }); usedIds.add(r.id); }
        }
        // Farm roles
        for (const [, r] of farmRoleObjs) {
          if (pos > 0 && !usedIds.has(r.id)) { positions.push({ id: r.id, position: pos-- }); usedIds.add(r.id); }
        }
        if (positions.length > 0) {
          await guild.roles.setPositions(positions);
          log.push('  📊 Redoslijed rola posložen: Gazda > Suvlasnik > Upravitelj > Nadzornik > Čuvar > Ratar > Mještanin > ...');
        }
      } catch (e: any) {
        log.push(`  ⚠️ Redoslijed rola: ${e.message}`);
      }

      // --- STEP 1b: Migrate old role members to new roles ---
      log.push('');
      log.push('**🔄 Migracija rola:**');

      // --- STEP 1b: Assign bot owner role (cache only) ---
      const OWNER_USER_ID = '955519719308427294';
      const upraviteljRole = staffRoleObjs[2]; // 🚜 Upravitelj
      try {
        const ownerMember = guild.members.cache.get(OWNER_USER_ID);
        if (ownerMember && upraviteljRole && !ownerMember.roles.cache.has(upraviteljRole.id)) {
          await ownerMember.roles.add(upraviteljRole, 'Vlasnik bota — Server Setup');
          log.push(`  👤 <@${OWNER_USER_ID}> → Upravitelj`);
        }
      } catch (e: any) {
        log.push(`  ⚠️ Upravitelj dodjela: ${e.message}`);
      }

      // --- STEP 1c: Ensure Mještanin & Ratar members also have NotifyMe ---
      const notifyMeRole = specialRoleObjs.get('🔔 NotifyMe');
      const ratarRoleObj = specialRoleObjs.get('🌾 Ratar');
      const mjestaninRoleObj = specialRoleObjs.get('🏘️ Mještanin');
      if (notifyMeRole) {
        let notifyAdded = 0;
        await guild.members.fetch();
        for (const [, m] of guild.members.cache) {
          if (m.user.bot) continue;
          const hasTarget = (ratarRoleObj && m.roles.cache.has(ratarRoleObj.id)) || (mjestaninRoleObj && m.roles.cache.has(mjestaninRoleObj.id));
          if (hasTarget && !m.roles.cache.has(notifyMeRole.id)) {
            try {
              await m.roles.add(notifyMeRole, 'Server Setup — NotifyMe za Mještanin/Ratar');
              notifyAdded++;
              await delay(300);
            } catch {}
          }
        }
        if (notifyAdded > 0) log.push(`  🔔 NotifyMe dodana ${notifyAdded} članovima`);
      }

      // --- STEP 1d: Assign Unverified to members who have no Mještanin/Ratar/staff roles ---
      const unverifiedRoleObj = specialRoleObjs.get('🚫 Unverified');
      if (unverifiedRoleObj && mjestaninRoleObj) {
        let unverifiedAdded = 0;
        const allKnownRoleIds = new Set([
          ...staffRoleObjs.map((r: any) => r.id),
          ...[...specialRoleObjs.values()].filter(Boolean).map((r: any) => r.id),
        ]);
        // Remove unverified role id from the check set
        allKnownRoleIds.delete(unverifiedRoleObj.id);
        for (const [, m] of guild.members.cache) {
          if (m.user.bot) continue;
          const hasAnyKnown = m.roles.cache.some((r: any) => r.name !== '@everyone' && allKnownRoleIds.has(r.id));
          if (!hasAnyKnown && !m.roles.cache.has(unverifiedRoleObj.id)) {
            try {
              await m.roles.add(unverifiedRoleObj, 'Nema verifikaciju');
              unverifiedAdded++;
              await delay(300);
            } catch {}
          }
          // Remove Unverified from verified members
          if (hasAnyKnown && m.roles.cache.has(unverifiedRoleObj.id)) {
            try {
              await m.roles.remove(unverifiedRoleObj, 'Već verificiran');
              await delay(300);
            } catch {}
          }
        }
        if (unverifiedAdded > 0) log.push(`  🚫 Unverified dodana ${unverifiedAdded} članovima`);
      }

      // --- STEP 1e: Delete unknown/stale roles ---
      {
        const knownRoleNames = new Set<string>([
          ...STAFF_ROLES.map(r => r.name),
          ...SPECIAL_ROLES.map(r => r.name),
          ...PLAYTIME_ROLES.map(r => r.name),
          ...Array.from(farmRoleObjs.values()).map((r: any) => r.name),
          '@everyone',
        ]);
        // Also keep bot integration roles and "Slavonska Ravnica" etc.
        let deleted = 0;
        await guild.roles.fetch();
        for (const [, r] of guild.roles.cache) {
          const role = r as any;
          if (role.managed) continue; // bot/integration roles — never touch
          if (role.name === '@everyone') continue;
          if (PROTECTED_ROLE_IDS.has(role.id)) continue; // Never delete Gazda/Suvlasnik
          if (knownRoleNames.has(role.name)) continue;
          // Keep roles with "Slavonska" or the bot name in them
          if (role.name.toLowerCase().includes('slavonsk')) continue;
          // Don't delete roles above bot (can't anyway)
          if (role.position >= (botMember?.roles?.highest?.position || 0)) continue;
          // Don't delete roles that still have members assigned — preserve user-created roles
          if (role.members && role.members.size > 0) {
            log.push(`  ⏭️ Preskačem: ${role.name} (${role.members.size} članova)`);
            continue;
          }
          try {
            await role.delete('Server Setup — čišćenje nepoznatih rola');
            log.push(`  🗑️ Rola obrisana: ${role.name}`);
            deleted++;
            await delay(500);
          } catch (e: any) {
            log.push(`  ⚠️ Ne mogu obrisati: ${role.name} (${e.message})`);
          }
        }
        if (deleted > 0) log.push(`  🧹 Ukupno obrisano ${deleted} nepotrebnih rola`);
      }

      // --- STEP 2: Update channels & categories (no longer nukes — just update/create) ---
      log.push('');
      log.push('**📁 Kanali:**');
      console.log('[SETUP] STEP 2 — Updating channels & categories');
      await guild.channels.fetch(); // Refresh channel cache

      const adminRole = staffRoleObjs[3]; // ⚙️ Nadzornik
      const modRole = staffRoleObjs[4]; // 🌿 Čuvar  
      const playerRole = specialRoleObjs.get('🌾 Ratar');
      const memberRole = specialRoleObjs.get('🏘️ Mještanin');
      const blacklistRole = specialRoleObjs.get('‼️ BLACKLIST');

      let naFarmiCatPosition = -1;

      // Read channel config from file (dynamic), fall back to hardcoded CATEGORIES
      const channelConfig = await readChannelConfig();
      let setupCategories: (CategoryDef | CategoryDef_Saved)[] = channelConfig.categories.length > 0 ? channelConfig.categories : CATEGORIES;

      // Merge autoEmbed definitions and channel names from hardcoded CATEGORIES into saved config
      // (saved config may have lost autoEmbed data or have old channel names without emojis)
      if (channelConfig.categories.length > 0) {
        const defaultAutoEmbeds = new Map<string, ChannelDef['autoEmbed']>();
        const defaultNames = new Map<string, string>();
        for (const cat of CATEGORIES) {
          for (const ch of cat.channels) {
            const pn = plainName(ch.name);
            if (ch.autoEmbed) defaultAutoEmbeds.set(pn, ch.autoEmbed);
            defaultNames.set(pn, ch.name);
          }
        }
        for (const cat of setupCategories) {
          for (const ch of cat.channels) {
            const pn = plainName(ch.name);
            if (!(ch as ChannelDef).autoEmbed) {
              const embed = defaultAutoEmbeds.get(pn);
              if (embed) (ch as any).autoEmbed = embed;
            }
            // Always use the latest channel name from CATEGORIES (keeps emojis up-to-date)
            const defaultName = defaultNames.get(pn);
            if (defaultName && ch.name !== defaultName) {
              ch.name = defaultName;
            }
          }
        }
      }

      for (const cat of setupCategories) {
        // Find or create category (fuzzy match using plainName normalization)
        const catPlain = plainName(cat.name);
        let category = guild.channels.cache.find((c: any) => c.type === 4 && c.name === cat.name);
        if (!category) {
          // Fuzzy: compare normalized names
          category = guild.channels.cache.find((c: any) => {
            if (c.type !== 4) return false;
            const cPlain = plainName(c.name);
            return cPlain === catPlain;
          });
        }
        if (!category) {
          try {
            category = await guild.channels.create({
              name: cat.name,
              type: 4, // GuildCategory
              reason: 'Server Setup',
            });
            log.push(`  📂 Kategorija kreirana: ${cat.name}`);
            console.log('[SETUP] Created category:', cat.name);
            await delay(1500); // Rate limit protection
          } catch (e: any) {
            log.push(`  ❌ Kategorija greška: ${cat.name} — ${e.message}`);
            console.error('[SETUP] Category creation error:', cat.name, e.message);
            continue; // Skip channels for this category
          }
        } else {
          // Category exists — do NOT rename (non-destructive setup)
          log.push(`  📂 Kategorija postoji: ${(category as any).name}`);
        }

        // Track GLASOVNI KANALI position for farm categories placement (they go after voice channels)
        if (cat.name.includes('𝗚𝗟𝗔𝗦𝗢𝗩𝗡𝗜')) {
          naFarmiCatPosition = (category as any).position ?? -1;
        }

        for (const ch of cat.channels) {
          const chType = ch.type === 'voice' ? 2 : ch.type === 'forum' ? 15 : 0; // GuildVoice : GuildForum : GuildText
          let channel = guild.channels.cache.find((c: any) => 
            c.type === chType && c.name === ch.name && c.parentId === category.id
          );
          // Fallback: match by name without requiring same parent category
          if (!channel) {
            channel = guild.channels.cache.find((c: any) => c.type === chType && c.name === ch.name);
          }
          // Fallback fuzzy match: normalize Unicode small caps/bold → plain ASCII
          if (!channel && chType !== 2) {
            const chPlain = plainName(ch.name);
            if (chPlain) {
              channel = guild.channels.cache.find((c: any) => {
                if (c.type !== chType) return false;
                const cPlain = plainName(c.name);
                return cPlain === chPlain;
              });
            }
          }

          // Build permission overwrites
          const permOverwrites: any[] = [];

          const isVoice = ch.type === 'voice';

          if (ch.staffOnly) {
            // Staff-only: deny @everyone, allow admin+
            permOverwrites.push(
              { id: guild.id, deny: [PermissionFlagsBits.ViewChannel, ...(isVoice ? [PermissionFlagsBits.Connect] : [])] },
              { id: adminRole?.id, allow: [PermissionFlagsBits.ViewChannel, ...(isVoice ? [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] : [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages])] },
              { id: modRole?.id, allow: [PermissionFlagsBits.ViewChannel, ...(isVoice ? [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] : [PermissionFlagsBits.SendMessages])] },
            );
            // Also allow all staff roles above
            for (const sr of staffRoleObjs.slice(0, 3)) { // Vlasnik, Suvlasnik, Head Admin
              permOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, ...(isVoice ? [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] : [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages])] });
            }
          } else if (ch.playerOnly) {
            // Player-only: deny @everyone, allow Player role + all staff
            permOverwrites.push(
              { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            );
            if (playerRole) {
              if (ch.readOnly) {
                permOverwrites.push({ id: playerRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] });
              } else {
                permOverwrites.push({ id: playerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
              }
            }
            // All staff can see and write in player channels
            for (const sr of staffRoleObjs) {
              permOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
            }
            if (memberRole) {
              permOverwrites.push({ id: memberRole.id, deny: [PermissionFlagsBits.ViewChannel] });
            }
          } else if (ch.freeWrite) {
            // Free-write: everyone can see and write (ZAJEDNICA etc.)
            // For forum channels, explicitly allow thread creation
            if (ch.type === 'forum') {
              permOverwrites.push(
                { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.ReadMessageHistory] },
              );
            }
            // No extra overwrites needed for text — inherits default @everyone view
          } else if (ch.readOnly) {
            // Read-only: everyone can see but not write
            permOverwrites.push(
              { id: guild.id, deny: [PermissionFlagsBits.SendMessages] },
            );
          } else if (isVoice) {
            // Voice: everyone can view and connect
            permOverwrites.push(
              { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
            );
          } else {
            // Default: everyone can see but only Nadzornik+ can write
            permOverwrites.push(
              { id: guild.id, deny: [PermissionFlagsBits.SendMessages] },
            );
            // Staff can write
            for (const sr of staffRoleObjs) {
              permOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
            }
          }

          // Blacklist denies everywhere
          if (blacklistRole) {
            permOverwrites.push({ id: blacklistRole.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect] });
          }

          // Bot always allowed
          if (botMember) {
            permOverwrites.push({ id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] });
          }

          if (!channel) {
            try {
            const createOpts: any = {
              name: ch.name,
              type: chType,
              parent: category.id,
              permissionOverwrites: permOverwrites.filter((p: any) => p.id),
              reason: 'Server Setup',
            };
            // Forum channel extra config
            if (ch.type === 'forum') {
              createOpts.topic = 'Postavi pitanje — otvori novu temu!';
              createOpts.defaultAutoArchiveDuration = 4320; // 3 days
            }
            channel = await guild.channels.create(createOpts);
            log.push(`  ✨ ${ch.type === 'voice' ? '🔊' : ch.type === 'forum' ? '💬' : '#'} ${ch.name}`);
            console.log('[SETUP] Created channel:', ch.name);
            await delay(1500); // Rate limit protection

            // Auto-post embed with button for new channels
            if (ch.autoEmbed && chType === 0) {
              try {
                const url = ch.autoEmbed.buttonUrl || resolveAutoEmbedUrl(ch.autoEmbed.buttonUrlEnv || '');
                const embed = new EmbedBuilder()
                  .setTitle(ch.autoEmbed.title)
                  .setDescription(ch.autoEmbed.description)
                  .setColor(ch.autoEmbed.color)
                  .setTimestamp();
                if (ch.autoEmbed.thumbnail) {
                  const thumbUrl = process.env[ch.autoEmbed.thumbnail];
                  if (thumbUrl) embed.setThumbnail(thumbUrl);
                }
                const sendOpts: any = { embeds: [embed] };
                if (url) {
                  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setLabel(ch.autoEmbed.buttonLabel)
                      .setStyle(ButtonStyle.Link)
                      .setURL(url)
                      .setEmoji(ch.autoEmbed.buttonEmoji || '🔗')
                  );
                  sendOpts.components = [row];
                }
                await (channel as any).send(sendOpts);
                log.push(`    📨 Embed poslan u ${ch.name}${url ? '' : ' (bez linka)'}`);
                await delay(500);
              } catch (e: any) {
                log.push(`    ⚠️ Embed greška: ${e.message}`);
              }
            }

            // ── Special setup embeds for specific channels ──
            const chLower = ch.name.toLowerCase();
            const chPlainLower = plainName(ch.name);

            // PRAVILA — rules embed
            if (chLower.includes('ᴘʀᴀᴠɪʟᴀ') || chPlainLower === 'pravila') {
              try {
                const logoUrl = getLogoUrl();
                const rulesEmbed = new EmbedBuilder()
                  .setColor(0xff6b6b)
                  .setTitle('📜 Pravila Servera')
                  .setDescription(
                    '**Dobrodošao/la na Slavonsku Ravnicu!**\n' +
                    'Molimo te da se pridržavaš sljedećih pravila:\n\n' +
                    '1️⃣ **Poštuj druge igrače** — bez vrijeđanja, provociranja ili toksičnosti.\n' +
                    '2️⃣ **Bez varanja** — ne koristi cheatove, exploite ili bugove.\n' +
                    '3️⃣ **Bez spama** — ne spamaj chat, kanale ili DM-ove.\n' +
                    '4️⃣ **Koristi ispravne kanale** — pitanja u pitanja, slike u fotografije itd.\n' +
                    '5️⃣ **Bez reklamiranja** — ne reklamiraj druge servere bez dozvole.\n' +
                    '6️⃣ **Slušaj staff** — odluke Upravitelja i staffa su konačne.\n' +
                    '7️⃣ **Bez krađe** — ne kradi vozila, opremu ili resurse drugih igrača.\n' +
                    '8️⃣ **Igraj fer** — dogovaraj se s drugim farmama, ne sabotiraj.\n\n' +
                    '⚠️ *Kršenje pravila rezultira opomenom, kickom ili banom.*\n' +
                    '📩 Za prijave koristi ticket sustav u kanalu **ticketi**.'
                  )
                  .setThumbnail(logoUrl || null)
                  .setFooter({ text: 'Slavonska Ravnica — FS25' })
                  .setTimestamp();
                await (channel as any).send({ embeds: [rulesEmbed] });
                log.push(`    📨 Pravila embed poslan`);
              } catch (e: any) { log.push(`    ⚠️ Pravila embed: ${e.message}`); }
            }

            // VERIFIKACIJA — verification button
            if (chLower.includes('ᴠᴇʀɪꜰɪᴋᴀᴄɪᴊᴀ') || chPlainLower === 'verifikacija') {
              try {
                const logoUrl = getLogoUrl();
                const verifyEmbed = new EmbedBuilder()
                  .setColor(0x3b82f6)
                  .setTitle('🛡️ Verifikacija')
                  .setDescription(
                    'Dobrodošao/la na **Slavonsku Ravnicu**! 🌾\n\n' +
                    'Klikni gumb ispod da potvrdiš da si pročitao/la pravila i dobiješ pristup svim kanalima.\n\n' +
                    '> Nakon verifikacije dobit ćeš **Mještanin** rolu.'
                  )
                  .setThumbnail(logoUrl || null)
                  .setFooter({ text: 'Klikni gumb za verifikaciju' })
                  .setTimestamp();
                const verifyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId('verify_member')
                    .setLabel('Verificiraj se')
                    .setEmoji('✅')
                    .setStyle(ButtonStyle.Success),
                );
                await (channel as any).send({ embeds: [verifyEmbed], components: [verifyRow] });
                log.push(`    📨 Verifikacija embed poslan`);
              } catch (e: any) { log.push(`    ⚠️ Verifikacija embed: ${e.message}`); }
            }

            // PRIJAVA — farm application button
            if (chLower.includes('ᴘʀɪᴊᴀᴠᴀ') || chPlainLower === 'prijava') {
              try {
                const logoUrl = getLogoUrl();
                const applyEmbed = new EmbedBuilder()
                  .setColor(0x22c55e)
                  .setTitle('🌾 Prijava za Farmu')
                  .setDescription(
                    'Želiš igrati na **Slavonskoj Ravnici**? 🚜\n\n' +
                    'Popuni kratku prijavu i staff će je pregledati.\n' +
                    'Nakon odobrenja dobiješ **Ratar** ulogu i pristup svim kanalima farme.\n\n' +
                    '**Što te čeka:**\n' +
                    '> 🗺️ Pristup karti, vremenu i statistikama\n' +
                    '> 💬 Farm chat s ostalim igračima\n' +
                    '> 📦 Modovi i launcher za automatsku instalaciju\n' +
                    '> 🏆 Leaderboard i praćenje sati'
                  )
                  .setThumbnail(logoUrl || null)
                  .setFooter({ text: 'Klikni gumb za prijavu' })
                  .setTimestamp();
                const applyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId('farm_apply')
                    .setLabel('Prijavi se za Farmu')
                    .setEmoji('📝')
                    .setStyle(ButtonStyle.Primary),
                );
                await (channel as any).send({ embeds: [applyEmbed], components: [applyRow] });
                log.push(`    📨 Prijava za farmu embed poslan`);
              } catch (e: any) { log.push(`    ⚠️ Prijava embed: ${e.message}`); }
            }

            // INFO — roles & server info embed
            if ((chLower.includes('ɪɴꜰᴏ') && ch.name.includes('ℹ️')) || chPlainLower === 'info') {
              try {
                const logoUrl = getLogoUrl();

                // Embed 1: Staff roles
                const staffEmbed = new EmbedBuilder()
                  .setColor(0xe74c3c)
                  .setTitle('🛡️ Staff Tim')
                  .setDescription(
                    'Staff tim brine o redu, pomaže igračima i upravlja serverom.\n\n' +
                    '👑 **Gazda** — Vlasnik servera, donosi konačne odluke.\n' +
                    '🏡 **Suvlasnik** — Zamjenik vlasnika, puna admin prava.\n' +
                    '🚜 **Upravitelj** — Administrator, upravlja serverom i modovima.\n' +
                    '⚙️ **Nadzornik** — Moderira kanale, upravlja rolama i banovima.\n' +
                    '🌿 **Čuvar** — Održava red, može kickati i mutati igrače.\n\n' +
                    '> 💡 *Za pomoć otvori ticket u kanalu ticketi.*'
                  )
                  .setThumbnail(logoUrl || null);
                await (channel as any).send({ embeds: [staffEmbed] });

                // Embed 2: Special roles
                const specialEmbed = new EmbedBuilder()
                  .setColor(0x9b59b6)
                  .setTitle('⭐ Posebne Role')
                  .setDescription(
                    'Role koje dobiješ na serveru:\n\n' +
                    '🏘️ **Mještanin** — Dobiješ nakon verifikacije. Otvara pristup zajedničkim kanalima.\n' +
                    '🌾 **Ratar** — Dobiješ nakon odobrene prijave za farmu. Pristup svim farm kanalima.\n' +
                    '🌾 **Farma [ime]** — Automatska rola za tvoju specifičnu farmu.\n' +
                    '🔔 **NotifyMe** — Označi se za obavijesti o serveru i eventima.\n' +
                    '💎 **Server Booster** — Za one koji boostaju Discord server.\n' +
                    '‼️ **BLACKLIST** — Banirani igrači — nema pristupa kanalima.'
                  );
                await (channel as any).send({ embeds: [specialEmbed] });

                // Embed 3: Playtime roles
                const playtimeEmbed = new EmbedBuilder()
                  .setColor(0xf1c40f)
                  .setTitle('⏱️ Role po Satima Igranja')
                  .setDescription(
                    'Automatski dobiješ rolu prema broju sati odigranih na serveru:\n\n' +
                    '🌱 **Sjeme** — 10 sati\n' +
                    '🌿 **Sadnica** — 25 sati\n' +
                    '🌾 **Žetelac** — 50 sati\n' +
                    '🚜 **Farmer** — 100 sati\n' +
                    '⭐ **Agronom** — 250 sati\n' +
                    '🏆 **Zemljoposjednik** — 500 sati\n\n' +
                    '> 📊 *Tvoje sate možeš pratiti u kanalu leaderboard.*'
                  );
                await (channel as any).send({ embeds: [playtimeEmbed] });

                // Embed 4: Server info / how things work
                const infoEmbed = new EmbedBuilder()
                  .setColor(0x3498db)
                  .setTitle('📖 Kako Funkcionira Server')
                  .setDescription(
                    '**🚀 Početak:**\n' +
                    '> 1. Verificiraj se u kanalu **verifikacija**\n' +
                    '> 2. Prijavi se za farmu u kanalu **prijava**\n' +
                    '> 3. Preuzmi launcher u kanalu **launcher**\n' +
                    '> 4. Pokreni igru i uživaj! 🎮\n\n' +
                    '**📦 Modovi:**\n' +
                    '> Sve modove automatski instalira launcher — ne trebaš ručno ništa skidati.\n\n' +
                    '**💬 Kanali:**\n' +
                    '> • **općenito** — slobodan chat za sve teme\n' +
                    '> • **fotografije** — screenshots iz igre\n' +
                    '> • **pitanja** — forum za pitanja i diskusije\n' +
                    '> • **farm-chat** — chat samo za igrače (Ratare)\n' +
                    '> • **ticketi** — privatni tiketi za pomoć i prijave\n\n' +
                    '**🎙️ Glasovni Kanali:**\n' +
                    '> Slobodno se pridruži bilo kojem glasovnom kanalu!\n' +
                    '> Kanal **ured** je rezerviran samo za staff.\n\n' +
                    '**📊 Statistike:**\n' +
                    '> Bot automatski prati tvoje sate, resurse, životinje i ekonomiju.\n' +
                    '> Sve možeš vidjeti na web stranici ili u farm kanalima.'
                  )
                  .setFooter({ text: 'Slavonska Ravnica — FS25' })
                  .setTimestamp();
                await (channel as any).send({ embeds: [infoEmbed] });

                log.push(`    📨 Info embedi poslani (4 embeda)`);
              } catch (e: any) { log.push(`    ⚠️ Info embed: ${e.message}`); }
            }

            // TICKETI — ticket creation button
            if (chLower.includes('ᴛɪᴄᴋᴇᴛɪ') || chPlainLower === 'ticketi') {
              try {
                const ticketEmbed = new EmbedBuilder()
                  .setColor(0x5865f2)
                  .setTitle('📩 Ticket Sustav')
                  .setDescription(
                    '```\n' +
                    '  Trebaš pomoć ili prijaviti nekoga?\n' +
                    '  Otvori ticket — privatno i sigurno.\n' +
                    '```\n\n' +
                    '**Kako funkcionira?**\n' +
                    '> 1️⃣ Klikni **Otvori Ticket** ispod\n' +
                    '> 2️⃣ Odaberi kategoriju problema\n' +
                    '> 3️⃣ Ispuni kratki formular s detaljima\n' +
                    '> 4️⃣ Ticket se otvara — staff ga preuzima\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '**📂 Kategorije:**\n' +
                    TICKET_TYPES.map(t => `> ${t.emoji} **${t.label}**\n> ╰ *${t.description}*`).join('\n') +
                    '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '**⚡ Prioriteti:**\n' +
                    '> 🔴 **Visoki** — staff odmah obavješten\n' +
                    '> 🟡 **Srednji** — standardna obrada\n' +
                    '> 🟢 **Niski** — odgovor kad staff bude dostupan\n\n' +
                    '*Jedan aktivan ticket po korisniku.*'
                  )
                  .setFooter({ text: '📩 Slavonska Ravnica • Ticket Sustav' })
                  .setTimestamp();
                const ticketRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId('ticket_create')
                    .setLabel('📩 Otvori Ticket')
                    .setStyle(ButtonStyle.Success),
                );
                await (channel as any).send({ embeds: [ticketEmbed], components: [ticketRow] });
                log.push(`    📨 Ticket embed poslan`);
              } catch (e: any) { log.push(`    ⚠️ Ticket embed: ${e.message}`); }
            }

            // BOT-DASHBOARD — link to web dashboard
            if (chLower.includes('ʙᴏᴛ-ᴅᴀꜱʜʙᴏᴀʀᴅ') || chPlainLower === 'bot-dashboard') {
              try {
                const dashUrl = process.env.WEB_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '';
                const dashEmbed = new EmbedBuilder()
                  .setColor(0x5865f2)
                  .setTitle('📊 FarmBuddy Dashboard')
                  .setDescription(
                    '```\n' +
                    '  Upravljaj serverom iz web preglednika\n' +
                    '```\n\n' +
                    '**Što možeš na dashboardu?**\n\n' +
                    '> 🗺️ **Karta** — pregled mape i polja\n' +
                    '> 📋 **Logovi** — bot logovi u realnom vremenu\n' +
                    '> ⚙️ **Admin** — upravljanje igračima, farmama, sync\n' +
                    '> 🖥️ **Konzola** — slanje FS25 server komandi\n' +
                    '> 🌐 **Server** — Discord postavke, kanali, guild info\n' +
                    '> 🗄️ **Baza** — MongoDB pregled, export, statistike\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*Dashboard zamjenjuje bot-commands i konzola kanale.*\n' +
                    '*Sve komande i upravljanje sada su na jednom mjestu.*'
                  )
                  .setFooter({ text: 'FarmBuddy Dashboard • Slavonska Ravnica' })
                  .setTimestamp();

                const sendOpts: any = { embeds: [dashEmbed] };
                if (dashUrl) {
                  const dashRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setLabel('Otvori Dashboard')
                      .setStyle(ButtonStyle.Link)
                      .setURL(dashUrl.startsWith('http') ? dashUrl : `https://${dashUrl}`)
                      .setEmoji('📊')
                  );
                  sendOpts.components = [dashRow];
                }
                await (channel as any).send(sendOpts);
                log.push(`    📨 Bot Dashboard embed poslan`);
              } catch (e: any) { log.push(`    ⚠️ Bot Dashboard embed: ${e.message}`); }
            }

            // DOBRODOŠLICA — welcome embed
            if (chLower.includes('ᴅᴏʙʀᴏᴅᴏšʟɩᴄᴀ') || chLower.includes('dobrodošlica') || chLower.includes('dobrodoslica') || chPlainLower === 'dobrodoslica') {
              try {
                const logoUrl = getLogoUrl();
                const welcomeEmbed = new EmbedBuilder()
                  .setColor(0x22c55e)
                  .setTitle('👋 Dobrodošao/la na Slavonsku Ravnicu!')
                  .setDescription(
                    'Drago nam je što si tu! 🌾\n\n' +
                    '**Kako početi?**\n' +
                    '> 1️⃣ Pročitaj pravila u kanalu **pravila** 📜\n' +
                    '> 2️⃣ Verificiraj se u kanalu **verifikacija** ✅\n' +
                    '> 3️⃣ Prijavi se za farmu u kanalu **prijava** 📝\n' +
                    '> 4️⃣ Preuzmi launcher i igraj! 🚀\n\n' +
                    '**Korisni kanali:**\n' +
                    '> 💬 **općenito** — slobodan chat\n' +
                    '> ❓ **pitanja** — forum za pomoć\n' +
                    '> 🎫 **ticketi** — privatna pomoć od staffa\n' +
                    '> ℹ️ **info** — sve o serveru i rolama\n\n' +
                    '*Sretno na poljima Slavonske Ravnice!* 🌻'
                  )
                  .setThumbnail(logoUrl || null)
                  .setFooter({ text: 'Slavonska Ravnica — FS25' })
                  .setTimestamp();
                await (channel as any).send({ embeds: [welcomeEmbed] });
                log.push(`    📨 Dobrodošlica embed poslan`);
              } catch (e: any) { log.push(`    ⚠️ Dobrodošlica embed: ${e.message}`); }
            }
            } catch (chErr: any) {
              log.push(`  ❌ Greška pri kreiranju ${ch.name}: ${chErr.message}`);
              console.error('[SETUP] Channel creation error:', ch.name, chErr.message);
            }
          } else {
            // Channel already exists — DO NOT modify name, permissions, or parent.
            // Setup is non-destructive: only log that the channel exists.
            log.push(`  ✅ ${ch.type === 'voice' ? '🔊' : '#'} ${ch.name} (postoji)`);

            // Post missing embeds in existing channels
            if (chType === 0 && 'messages' in channel) {
              try {
                const msgs = await (channel as any).messages.fetch({ limit: 10 });
                const hasBotEmbed = msgs.some((m: any) => m.author?.id === this.client.user?.id && m.embeds?.length > 0);
                if (!hasBotEmbed) {
                  const chLower = ch.name.toLowerCase();
                  const chPlainLower = plainName(ch.name);

                  // autoEmbed (launcher, web, etc.)
                  if ((ch as any).autoEmbed) {
                    try {
                      const url = ch.autoEmbed.buttonUrl || resolveAutoEmbedUrl(ch.autoEmbed.buttonUrlEnv || '');
                      const embed = new EmbedBuilder()
                        .setTitle(ch.autoEmbed.title)
                        .setDescription(ch.autoEmbed.description)
                        .setColor(ch.autoEmbed.color)
                        .setTimestamp();
                      if (ch.autoEmbed.thumbnail) {
                        const thumbUrl = process.env[ch.autoEmbed.thumbnail];
                        if (thumbUrl) embed.setThumbnail(thumbUrl);
                      }
                      const sendOpts: any = { embeds: [embed] };
                      if (url) {
                        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                          new ButtonBuilder()
                            .setLabel(ch.autoEmbed.buttonLabel)
                            .setStyle(ButtonStyle.Link)
                            .setURL(url)
                            .setEmoji(ch.autoEmbed.buttonEmoji || '🔗')
                        );
                        sendOpts.components = [row];
                      }
                      await (channel as any).send(sendOpts);
                      log.push(`    📨 Embed poslan u ${ch.name} (postojeći kanal)`);
                    } catch (e: any) {
                      log.push(`    ⚠️ Embed greška: ${e.message}`);
                    }
                  }

                  // PRAVILA
                  if (chLower.includes('ᴘʀᴀᴠɪʟᴀ') || chPlainLower === 'pravila') {
                    try {
                      const logoUrl = getLogoUrl();
                      const rulesEmbed = new EmbedBuilder()
                        .setColor(0xff6b6b)
                        .setTitle('📜 Pravila Servera')
                        .setDescription(
                          '**Dobrodošao/la na Slavonsku Ravnicu!**\n' +
                          'Molimo te da se pridržavaš sljedećih pravila:\n\n' +
                          '1️⃣ **Poštuj druge igrače** — bez vrijeđanja, provociranja ili toksičnosti.\n' +
                          '2️⃣ **Bez varanja** — ne koristi cheatove, exploite ili bugove.\n' +
                          '3️⃣ **Bez spama** — ne spamaj chat, kanale ili DM-ove.\n' +
                          '4️⃣ **Koristi ispravne kanale** — pitanja u pitanja, slike u fotografije itd.\n' +
                          '5️⃣ **Bez reklamiranja** — ne reklamiraj druge servere bez dozvole.\n' +
                          '6️⃣ **Slušaj staff** — odluke Upravitelja i staffa su konačne.\n' +
                          '7️⃣ **Bez krađe** — ne kradi vozila, opremu ili resurse drugih igrača.\n' +
                          '8️⃣ **Igraj fer** — dogovaraj se s drugim farmama, ne sabotiraj.\n\n' +
                          '⚠️ *Kršenje pravila rezultira opomenom, kickom ili banom.*\n' +
                          '📩 Za prijave koristi ticket sustav u kanalu **ticketi**.'
                        )
                        .setThumbnail(logoUrl || null)
                        .setFooter({ text: 'Slavonska Ravnica — FS25' })
                        .setTimestamp();
                      await (channel as any).send({ embeds: [rulesEmbed] });
                      log.push(`    📨 Pravila embed poslan (postojeći kanal)`);
                    } catch (e: any) { log.push(`    ⚠️ Pravila embed: ${e.message}`); }
                  }

                  // VERIFIKACIJA
                  if (chLower.includes('ᴠᴇʀɪꜰɪᴋᴀᴄɪᴊᴀ') || chPlainLower === 'verifikacija') {
                    try {
                      const logoUrl = getLogoUrl();
                      const verifyEmbed = new EmbedBuilder()
                        .setColor(0x3b82f6)
                        .setTitle('🛡️ Verifikacija')
                        .setDescription(
                          'Dobrodošao/la na **Slavonsku Ravnicu**! 🌾\n\n' +
                          'Klikni gumb ispod da potvrdiš da si pročitao/la pravila i dobiješ pristup svim kanalima.\n\n' +
                          '> Nakon verifikacije dobit ćeš **Mještanin** rolu.'
                        )
                        .setThumbnail(logoUrl || null)
                        .setFooter({ text: 'Klikni gumb za verifikaciju' })
                        .setTimestamp();
                      const verifyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                          .setCustomId('verify_member')
                          .setLabel('Verificiraj se')
                          .setEmoji('✅')
                          .setStyle(ButtonStyle.Success),
                      );
                      await (channel as any).send({ embeds: [verifyEmbed], components: [verifyRow] });
                      log.push(`    📨 Verifikacija embed poslan (postojeći kanal)`);
                    } catch (e: any) { log.push(`    ⚠️ Verifikacija embed: ${e.message}`); }
                  }

                  // PRIJAVA
                  if (chLower.includes('ᴘʀɪᴊᴀᴠᴀ') || chPlainLower === 'prijava') {
                    try {
                      const logoUrl = getLogoUrl();
                      const applyEmbed = new EmbedBuilder()
                        .setColor(0x22c55e)
                        .setTitle('🌾 Prijava za Farmu')
                        .setDescription(
                          'Želiš igrati na **Slavonskoj Ravnici**? 🚜\n\n' +
                          'Popuni kratku prijavu i staff će je pregledati.\n' +
                          'Nakon odobrenja dobiješ **Ratar** ulogu i pristup svim kanalima farme.\n\n' +
                          '**Što te čeka:**\n' +
                          '> 🗺️ Pristup karti, vremenu i statistikama\n' +
                          '> 💬 Farm chat s ostalim igračima\n' +
                          '> 📦 Modovi i launcher za automatsku instalaciju\n' +
                          '> 🏆 Leaderboard i praćenje sati'
                        )
                        .setThumbnail(logoUrl || null)
                        .setFooter({ text: 'Klikni gumb za prijavu' })
                        .setTimestamp();
                      const applyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                          .setCustomId('farm_apply')
                          .setLabel('Prijavi se za Farmu')
                          .setEmoji('📝')
                          .setStyle(ButtonStyle.Primary),
                      );
                      await (channel as any).send({ embeds: [applyEmbed], components: [applyRow] });
                      log.push(`    📨 Prijava embed poslan (postojeći kanal)`);
                    } catch (e: any) { log.push(`    ⚠️ Prijava embed: ${e.message}`); }
                  }

                  // INFO
                  if ((chLower.includes('ɪɴꜰᴏ') && ch.name.includes('ℹ️')) || chPlainLower === 'info') {
                    try {
                      const logoUrl = getLogoUrl();
                      const staffEmbed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setTitle('🛡️ Staff Tim')
                        .setDescription(
                          'Staff tim brine o redu, pomaže igračima i upravlja serverom.\n\n' +
                          '👑 **Gazda** — Vlasnik servera, donosi konačne odluke.\n' +
                          '🏡 **Suvlasnik** — Zamjenik vlasnika, puna admin prava.\n' +
                          '🚜 **Upravitelj** — Administrator, upravlja serverom i modovima.\n' +
                          '⚙️ **Nadzornik** — Moderira kanale, upravlja rolama i banovima.\n' +
                          '🌿 **Čuvar** — Održava red, može kickati i mutati igrače.\n\n' +
                          '> 💡 *Za pomoć otvori ticket u kanalu ticketi.*'
                        )
                        .setThumbnail(logoUrl || null);
                      await (channel as any).send({ embeds: [staffEmbed] });
                      const specialEmbed = new EmbedBuilder()
                        .setColor(0x9b59b6)
                        .setTitle('⭐ Posebne Role')
                        .setDescription(
                          'Role koje dobiješ na serveru:\n\n' +
                          '🏘️ **Mještanin** — Dobiješ nakon verifikacije. Otvara pristup zajedničkim kanalima.\n' +
                          '🌾 **Ratar** — Dobiješ nakon odobrene prijave za farmu. Pristup svim farm kanalima.\n' +
                          '🌾 **Farma [ime]** — Automatska rola za tvoju specifičnu farmu.\n' +
                          '🔔 **NotifyMe** — Označi se za obavijesti o serveru i eventima.\n' +
                          '💎 **Server Booster** — Za one koji boostaju Discord server.\n' +
                          '‼️ **BLACKLIST** — Banirani igrači — nema pristupa kanalima.'
                        );
                      await (channel as any).send({ embeds: [specialEmbed] });
                      const playtimeEmbed = new EmbedBuilder()
                        .setColor(0xf1c40f)
                        .setTitle('⏱️ Role po Satima Igranja')
                        .setDescription(
                          'Automatski dobiješ rolu prema broju sati odigranih na serveru:\n\n' +
                          '🌱 **Sjeme** — 10 sati\n' +
                          '🌿 **Sadnica** — 25 sati\n' +
                          '🌾 **Žetelac** — 50 sati\n' +
                          '🚜 **Farmer** — 100 sati\n' +
                          '⭐ **Agronom** — 250 sati\n' +
                          '🏆 **Zemljoposjednik** — 500 sati\n\n' +
                          '> 📊 *Tvoje sate možeš pratiti u kanalu leaderboard.*'
                        );
                      await (channel as any).send({ embeds: [playtimeEmbed] });
                      const infoEmbed = new EmbedBuilder()
                        .setColor(0x3498db)
                        .setTitle('📖 Kako Funkcionira Server')
                        .setDescription(
                          '**🚀 Početak:**\n' +
                          '> 1. Verificiraj se u kanalu **verifikacija**\n' +
                          '> 2. Prijavi se za farmu u kanalu **prijava**\n' +
                          '> 3. Preuzmi launcher u kanalu **launcher**\n' +
                          '> 4. Pokreni igru i uživaj! 🎮\n\n' +
                          '**📦 Modovi:**\n' +
                          '> Sve modove automatski instalira launcher — ne trebaš ručno ništa skidati.\n\n' +
                          '**💬 Kanali:**\n' +
                          '> • **općenito** — slobodan chat za sve teme\n' +
                          '> • **fotografije** — screenshots iz igre\n' +
                          '> • **pitanja** — forum za pitanja i diskusije\n' +
                          '> • **farm-chat** — chat samo za igrače (Ratare)\n' +
                          '> • **ticketi** — privatni tiketi za pomoć i prijave\n\n' +
                          '**🎙️ Glasovni Kanali:**\n' +
                          '> Slobodno se pridruži bilo kojem glasovnom kanalu!\n' +
                          '> Kanal **ured** je rezerviran samo za staff.\n\n' +
                          '**📊 Statistike:**\n' +
                          '> Bot automatski prati tvoje sate, resurse, životinje i ekonomiju.\n' +
                          '> Sve možeš vidjeti na web stranici ili u farm kanalima.'
                        )
                        .setFooter({ text: 'Slavonska Ravnica — FS25' })
                        .setTimestamp();
                      await (channel as any).send({ embeds: [infoEmbed] });
                      log.push(`    📨 Info embedi poslani (postojeći kanal)`);
                    } catch (e: any) { log.push(`    ⚠️ Info embed: ${e.message}`); }
                  }

                  // TICKETI
                  if (chLower.includes('ᴛɪᴄᴋᴇᴛɪ') || chPlainLower === 'ticketi') {
                    try {
                      const ticketEmbed = new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle('📩 Ticket Sustav')
                        .setDescription(
                          '```\n' +
                          '  Trebaš pomoć ili prijaviti nekoga?\n' +
                          '  Otvori ticket — privatno i sigurno.\n' +
                          '```\n\n' +
                          '**Kako funkcionira?**\n' +
                          '> 1️⃣ Klikni **Otvori Ticket** ispod\n' +
                          '> 2️⃣ Odaberi kategoriju problema\n' +
                          '> 3️⃣ Ispuni kratki formular s detaljima\n' +
                          '> 4️⃣ Ticket se otvara — staff ga preuzima\n\n' +
                          '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                          '**📂 Kategorije:**\n' +
                          TICKET_TYPES.map(t => `> ${t.emoji} **${t.label}**\n> ╰ *${t.description}*`).join('\n') +
                          '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                          '**⚡ Prioriteti:**\n' +
                          '> 🔴 **Visoki** — staff odmah obavješten\n' +
                          '> 🟡 **Srednji** — standardna obrada\n' +
                          '> 🟢 **Niski** — odgovor kad staff bude dostupan\n\n' +
                          '*Jedan aktivan ticket po korisniku.*'
                        )
                        .setFooter({ text: '📩 Slavonska Ravnica • Ticket Sustav' })
                        .setTimestamp();
                      const ticketRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                          .setCustomId('ticket_create')
                          .setLabel('📩 Otvori Ticket')
                          .setStyle(ButtonStyle.Success),
                      );
                      await (channel as any).send({ embeds: [ticketEmbed], components: [ticketRow] });
                      log.push(`    📨 Ticket embed poslan (postojeći kanal)`);
                    } catch (e: any) { log.push(`    ⚠️ Ticket embed: ${e.message}`); }
                  }

                  // BOT-DASHBOARD
                  if (chLower.includes('ʙᴏᴛ-ᴅᴀꜱʜʙᴏᴀʀᴅ') || chPlainLower === 'bot-dashboard') {
                    try {
                      const dashUrl = process.env.WEB_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '';
                      const dashEmbed = new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle('📊 FarmBuddy Dashboard')
                        .setDescription(
                          '```\n' +
                          '  Upravljaj serverom iz web preglednika\n' +
                          '```\n\n' +
                          '**Što možeš na dashboardu?**\n\n' +
                          '> 🗺️ **Karta** — pregled mape i polja\n' +
                          '> 📋 **Logovi** — bot logovi u realnom vremenu\n' +
                          '> ⚙️ **Admin** — upravljanje igračima, farmama, sync\n' +
                          '> 🖥️ **Konzola** — slanje FS25 server komandi\n' +
                          '> 🌐 **Server** — Discord postavke, kanali, guild info\n' +
                          '> 🗄️ **Baza** — MongoDB pregled, export, statistike\n\n' +
                          '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                          '*Dashboard zamjenjuje bot-commands i konzola kanale.*\n' +
                          '*Sve komande i upravljanje sada su na jednom mjestu.*'
                        )
                        .setFooter({ text: 'FarmBuddy Dashboard • Slavonska Ravnica' })
                        .setTimestamp();
                      const sendOpts: any = { embeds: [dashEmbed] };
                      if (dashUrl) {
                        const dashRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                          new ButtonBuilder()
                            .setLabel('Otvori Dashboard')
                            .setStyle(ButtonStyle.Link)
                            .setURL(dashUrl.startsWith('http') ? dashUrl : `https://${dashUrl}`)
                            .setEmoji('📊')
                        );
                        sendOpts.components = [dashRow];
                      }
                      await (channel as any).send(sendOpts);
                      log.push(`    📨 Bot Dashboard embed poslan (postojeći kanal)`);
                    } catch (e: any) { log.push(`    ⚠️ Bot Dashboard embed: ${e.message}`); }
                  }

                  // DOBRODOŠLICA
                  if (chLower.includes('ᴅᴏʙʀᴏᴅᴏšʟɩᴄᴀ') || chLower.includes('dobrodošlica') || chLower.includes('dobrodoslica') || chPlainLower === 'dobrodoslica') {
                    try {
                      const logoUrl = getLogoUrl();
                      const welcomeEmbed = new EmbedBuilder()
                        .setColor(0x22c55e)
                        .setTitle('👋 Dobrodošao/la na Slavonsku Ravnicu!')
                        .setDescription(
                          'Drago nam je što si tu! 🌾\n\n' +
                          '**Kako početi?**\n' +
                          '> 1️⃣ Pročitaj pravila u kanalu **pravila** 📜\n' +
                          '> 2️⃣ Verificiraj se u kanalu **verifikacija** ✅\n' +
                          '> 3️⃣ Prijavi se za farmu u kanalu **prijava** 📝\n' +
                          '> 4️⃣ Preuzmi launcher i igraj! 🚀\n\n' +
                          '**Korisni kanali:**\n' +
                          '> 💬 **općenito** — slobodan chat\n' +
                          '> ❓ **pitanja** — forum za pomoć\n' +
                          '> 🎫 **ticketi** — privatna pomoć od staffa\n' +
                          '> ℹ️ **info** — sve o serveru i rolama\n\n' +
                          '*Sretno na poljima Slavonske Ravnice!* 🌻'
                        )
                        .setThumbnail(logoUrl || null)
                        .setFooter({ text: 'Slavonska Ravnica — FS25' })
                        .setTimestamp();
                      await (channel as any).send({ embeds: [welcomeEmbed] });
                      log.push(`    📨 Dobrodošlica embed poslan (postojeći kanal)`);
                    } catch (e: any) { log.push(`    ⚠️ Dobrodošlica embed: ${e.message}`); }
                  }
                }
              } catch (e: any) {
                log.push(`    ⚠️ Provjera embeda: ${e.message}`);
              }
            }
          }
        }
      }

      // --- STEP 2b: Create per-farm categories & channels ---
      console.log('[SETUP] STEP 2b \u2014 Farm categories');

      // Force-sync to get latest farm names from game server
      try {
        console.log('[SETUP] Force-syncing farm data from game server...');
        await syncService.sync();
        // Refresh farm data after sync
        const freshFarms = (await storage.getFarms()).filter((f: any) => f.farmId !== '0');
        if (freshFarms.length > 0) {
          dbFarms.length = 0;
          dbFarms.push(...freshFarms);
          // Update farm role names if farm names changed
          for (const farm of dbFarms) {
            const farmName = farm.name || `Farma ${farm.farmId}`;
            const roleName = `${FARM_ROLE_PREFIX}${farmName}`;
            const existingRole = farmRoleObjs.get(farm.farmId);
            if (existingRole && existingRole.name !== roleName) {
              try {
                if (!PROTECTED_ROLE_IDS.has(existingRole.id)) {
                  await existingRole.edit({ name: roleName }, 'Setup — ažuriranje naziva farme');
                  log.push(`  🔄 Farm rola preimenovana: ${existingRole.name} → ${roleName}`);
                  await delay(500);
                }
              } catch (e: any) { log.push(`  ⚠️ Farm rola rename: ${e.message}`); }
            }
          }
        }
        console.log('[SETUP] Farm data refreshed:', dbFarms.length, 'farms');
      } catch (e: any) {
        console.warn('[SETUP] Force-sync failed, using cached farm data:', e.message);
      }

      const setupFarmChannels = channelConfig.farmChannels.length > 0 ? channelConfig.farmChannels : FARM_CATEGORY_CHANNELS;

      // Merge new farm channels from defaults into saved config (e.g. chat channel added later)
      if (channelConfig.farmChannels.length > 0) {
        const existingPlains = new Set(setupFarmChannels.map((ch: any) => plainName(ch.name)));
        for (const defaultCh of FARM_CATEGORY_CHANNELS) {
          if (!existingPlains.has(plainName(defaultCh.name))) {
            setupFarmChannels.push(defaultCh as any);
          }
        }
      }

      if (dbFarms.length > 0 && setupFarmChannels.length > 0) {
        log.push('');
        log.push(`**\uD83C\uDF3E Farm kategorije (${dbFarms.length} farmi):**`);

        // --- Each farm gets its own category ---
        for (let fi = 0; fi < dbFarms.length; fi++) {
          const farm = dbFarms[fi];
          const farmName = farm.name || `Farma ${farm.farmId}`;
          const farmNameBold = toBold(farmName.toUpperCase());
          const farmRole = farmRoleObjs.get(farm.farmId);

          // Category name: ── 🏡 FARM_NAME ──
          const farmCatName = `\u2500\u2500 \uD83C\uDFE1 ${farmNameBold} \u2500\u2500`;

          // Category permissions: hidden by default, visible to farm role + staff + bot
          const catOverwrites: any[] = [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          ];
          if (farmRole) {
            catOverwrites.push({ id: farmRole.id, allow: [PermissionFlagsBits.ViewChannel] });
          }
          for (const sr of staffRoleObjs) {
            catOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
          }
          if (blacklistRole) catOverwrites.push({ id: blacklistRole.id, deny: [PermissionFlagsBits.ViewChannel] });
          if (botMember) catOverwrites.push({ id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] });

          const validCatOverwrites = catOverwrites.filter((p: any) => p.id);

          // Find existing farm category or create new one
          // Search by exact name, normalized name, partial match, OR old farm name pattern (for renamed farms)
          const farmCatPlain = plainName(farmCatName);
          let farmCat = guild.channels.cache.find((c: any) => c.type === 4 && c.name === farmCatName)
            || guild.channels.cache.find((c: any) => c.type === 4 && plainName(c.name) === farmCatPlain)
            || guild.channels.cache.find((c: any) => c.type === 4 && plainName(c.name).includes(plainName(farmNameBold)));
          // Fallback: match farm categories by checking if category contains any known farm-like pattern
          // This catches renamed farms (e.g. "MY FARM" → "Slavonska Farma")
          if (!farmCat) {
            // Look for categories that have farm channels as children (statistika, ekonomija, etc.)
            const farmChannelNames = FARM_CATEGORY_CHANNELS.map(ch => plainName(ch.name));
            farmCat = guild.channels.cache.find((c: any) => {
              if (c.type !== 4) return false;
              const cPlain = plainName(c.name);
              if (!cPlain.includes('🏡') && !cPlain.includes('farm') && !cPlain.includes('farma') && !cPlain.includes('my')) return false;
              // Check if this category has farm-specific child channels
              const children = guild.channels.cache.filter((ch: any) => ch.parentId === c.id);
              return children.some((ch: any) => farmChannelNames.includes(plainName(ch.name)));
            }) || null;
          }

          if (farmCat) {
            // Update existing category permissions and name
            try {
              if ((farmCat as any).name !== farmCatName) {
                await (farmCat as any).setName(farmCatName, 'Server Setup — farm kategorija');
                await delay(500);
              }
              await (farmCat as any).permissionOverwrites.set(validCatOverwrites, 'Server Setup — farm permisije');
              log.push(`  📂 ${farmCatName} — ažurirano`);
            } catch (e: any) { log.push(`  ⚠️ Farm kat. update: ${e.message}`); }
          } else {
            farmCat = await guild.channels.create({
              name: farmCatName,
              type: 4,
              permissionOverwrites: validCatOverwrites,
              reason: `Server Setup — farm kategorija ${farmName}`,
            });
            log.push(`  📂 ${farmCatName} — kreirana`);
          }
          await delay(1000);

          // Create or update farm channels inside this farm's category
          for (const chDef of setupFarmChannels) {
            const typePart = chDef.name.split('\u2503')[1]?.trim() || '';
            const chName = chDef.name;

            // Per-channel permissions: farm role sees only their channels, staff sees all
            const chPermOverwrites: any[] = [
              { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            ];
            if (farmRole) {
              if (chDef.readOnly) {
                chPermOverwrites.push({ id: farmRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] });
              } else {
                chPermOverwrites.push({ id: farmRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
              }
            }
            for (const sr of staffRoleObjs) {
              chPermOverwrites.push({ id: sr.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
            }
            if (blacklistRole) chPermOverwrites.push({ id: blacklistRole.id, deny: [PermissionFlagsBits.ViewChannel] });
            if (botMember) chPermOverwrites.push({ id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] });

            const validChOverwrites = chPermOverwrites.filter((p: any) => p.id);

            // Find existing channel — ONLY within this farm's category (not globally, since all farms share channel names)
            let channel = guild.channels.cache.find((c: any) => c.type === 0 && c.name === chName && c.parentId === farmCat.id)
              || guild.channels.cache.find((c: any) => c.type === 0 && plainName(c.name) === plainName(chName) && c.parentId === farmCat.id);

            if (channel) {
              // Update existing
              try {
                if ((channel as any).parentId !== farmCat.id) {
                  await (channel as any).setParent(farmCat.id, { reason: 'Server Setup', lockPermissions: false });
                  await delay(300);
                }
                await (channel as any).permissionOverwrites.set(validChOverwrites, 'Server Setup — farm permisije');
                log.push(`  ✅ # ${chName} (${farmName}) — ažurirano`);
              } catch (e: any) { log.push(`  ⚠️ ${chName}: ${e.message}`); }
            } else {
              channel = await guild.channels.create({
                name: chName,
                type: 0,
                parent: farmCat.id,
                permissionOverwrites: validChOverwrites,
                reason: `Server Setup — ${farmName}`,
              });
              log.push(`  ✨ # ${chName} (${farmName})`);

              const embedDef = typePart ? FARM_CHANNEL_EMBEDS[typePart] : null;
              if (embedDef && channel) {
                try {
                  const welcomeEmbed = new EmbedBuilder()
                    .setTitle(embedDef.title)
                    .setDescription(embedDef.description.replace(/farme/gi, farmName))
                    .setColor(embedDef.color)
                    .setFooter({ text: `${farmName} • Slavonska Ravnica` })
                    .setTimestamp();
                  await (channel as any).send({ embeds: [welcomeEmbed] });
                  log.push(`    📨 Dobrodošlica poslana u ${chName}`);
                } catch (e: any) {
                  log.push(`    ⚠️ Embed greška: ${e.message}`);
                }
              }
            }
            await delay(1000);
          }
        }
      } else {
        log.push('');
        log.push('**\uD83C\uDF3E Farm kanali:** Nema farmi u bazi \u2014 pokreni /server sync prvo.');
      }

      // --- STEP 3: Update @everyone permissions ---
      console.log('[SETUP] STEP 3 — @everyone permissions');
      try {
        const everyoneRole = guild.roles.everyone;
        await everyoneRole.setPermissions(
          PermissionFlagsBits.ViewChannel |
          PermissionFlagsBits.ReadMessageHistory |
          PermissionFlagsBits.AddReactions |
          PermissionFlagsBits.UseExternalEmojis |
          PermissionFlagsBits.Connect |
          PermissionFlagsBits.Speak
        );
        log.push('');
        log.push('**⚙️ @everyone** permisije ažurirane (osnovno: gledaj, reagiraj, voice)');
      } catch (e: any) {
        log.push(`⚠️ @everyone permisije: ${e.message}`);
      }

      // STEP 4 removed — no longer nuking channels

      // --- STEP 4b: Disable "Channels & Roles" customization so members see all channels ---
      try {
        // Disable onboarding so users don't have to opt-in to see channels
        const token = process.env.DISCORD_TOKEN;
        const res = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/onboarding`, {
          method: 'PUT',
          headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompts: [],
            default_channel_ids: [],
            enabled: false,
            mode: 0, // 0 = ONBOARDING_DEFAULT (not advanced)
          }),
        });
        if (res.ok) {
          log.push('');
          log.push('**👁️ Channels & Roles** customization isključen — svi kanali vidljivi svima');
        } else {
          const errText = await res.text().catch(() => '');
          console.warn(`[SETUP] Onboarding disable failed: ${res.status} ${errText}`);
          log.push(`⚠️ Channels & Roles: ${res.status} (možda nije Community server)`);
        }
      } catch (e: any) {
        log.push(`⚠️ Channels & Roles: ${e.message}`);
      }

      // --- STEP 5: Send role-info embed ---
      log.push('');
      log.push('**✅ Server setup završen!**');

      const resultEmbed = new EmbedBuilder()
        .setTitle('🛠️ Server Setup — Rezultat')
        .setDescription(log.join('\n'))
        .setColor(0x2ecc71)
        .setTimestamp();

      console.log('[SETUP] ✅ Setup complete, sending result embed');
      try { await interaction.editReply({ embeds: [resultEmbed] }); } catch (e: any) {
        console.error('[SETUP] editReply failed (token expired?):', e.message);
      }

      // Refresh channel cache & invalidate guild settings after update
      invalidateGuildSettingsCache();
      await guild.channels.fetch();
      console.log('[SETUP] Cache refreshed, channels in cache:', guild.channels.cache.size);

      // Update warning message with completion
      if (warningMsg) {
        try {
          const doneEmbed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('✅ Server Setup Završen!')
            .setDescription('Server setup je uspješno završen.\nSvi kanali, role i permisije su ažurirani.')
            .setFooter({ text: `Pokrenuo: ${interaction.user.tag}` })
            .setTimestamp();
          await warningMsg.edit({ content: '', embeds: [doneEmbed] });
        } catch (e: any) {
          console.error('[SETUP] Warning completion edit failed:', e.message);
        }
      }

      // Trigger immediate leaderboard update so it shows player data right away
      try {
        await this.updateLeaderboardChannel();
        console.log('[SETUP] Leaderboard update completed');
      } catch (e: any) {
        console.error('[SETUP] Leaderboard update failed:', e.message);
      }

      // Trigger immediate farm role assignment so players get roles right away
      try {
        const farmResult = await this.autoAssignFarmRoles();
        if (farmResult.assigned > 0 || farmResult.removed > 0) {
          console.log(`[SETUP] Farm roles: assigned=${farmResult.assigned}, removed=${farmResult.removed}`);
        }
      } catch (e: any) {
        console.error('[SETUP] Farm role assignment failed:', e.message);
      }

      // Obavijesti announcement removed — no longer posted after setup

      } catch (setupError: any) {
        console.error('[SETUP] ❌ FATAL ERROR during setup:', setupError);
        try {
          const errorEmbed = new EmbedBuilder()
            .setTitle('❌ Server Setup — Greška')
            .setDescription(
              `Setup je pao na grešci:\n\`\`\`\n${setupError.message || setupError}\n\`\`\`\n\n` +
              (log.length > 0 ? '**Dotadašnji log:**\n' + log.slice(-20).join('\n') : 'Nema loga.')
            )
            .setColor(0xff0000)
            .setTimestamp();
          await interaction.editReply({ embeds: [errorEmbed] });
        } catch (replyError) {
          console.error('[SETUP] Could not even send error reply:', replyError);
        }
        // Update warning message with error
        if (warningMsg) {
          try {
            const errWarnEmbed = new EmbedBuilder()
              .setColor(0xff0000)
              .setTitle('❌ Server Setup — Greška!')
              .setDescription('Setup je naišao na grešku. Pogledajte admin kanal za detalje.')
              .setFooter({ text: `Pokrenuo: ${interaction.user.tag}` })
              .setTimestamp();
            await warningMsg.edit({ content: '', embeds: [errWarnEmbed] });
          } catch {}
        }
      }

    } else if (sub === 'roles') {
      // Force run auto-role assignment (playtime + farm)
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Samo administratori.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const ptResult = await this.autoAssignPlaytimeRoles();
      const farmResult = await this.autoAssignFarmRoles();
      await interaction.editReply(
        `🏆 Auto-role provjera završena.\n` +
        `**Playtime:** ${ptResult.assigned} dodijeljeno, ${ptResult.removed} uklonjeno, ${ptResult.errors} grešaka.\n` +
        `**Farm:** ${farmResult.assigned} dodijeljeno, ${farmResult.removed} uklonjeno, ${farmResult.errors} grešaka.`
      );

    } else if (sub === 'farmassign') {
      // Manual farm role assignment
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Samo administratori.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });

      const targetUser = interaction.options.getUser('user');
      const farmId = interaction.options.getString('farm');
      if (!targetUser || !farmId) {
        return interaction.editReply('❌ Potrebni su korisnik i ID farme.');
      }

      const guild = interaction.guild;
      if (!guild) return interaction.editReply('❌ Ova komanda radi samo na serveru.');

      // Find farm in DB
      const dbFarms = await storage.getFarms();
      const farm = dbFarms.find(f => f.farmId === farmId);
      if (!farm) {
        const available = dbFarms.map(f => `\`${f.farmId}\` — ${f.name}`).join('\n') || 'Nema farmi u bazi.';
        return interaction.editReply(`❌ Farma \`${farmId}\` nije pronađena.\n\n**Dostupne farme:**\n${available}`);
      }

      const farmName = farm.name || `Farma ${farm.farmId}`;
      const roleName = `${FARM_ROLE_PREFIX}${farmName}`;

      // Find the farm role
      const farmRole = guild.roles.cache.find((r: any) => r.name === roleName);
      if (!farmRole) {
        return interaction.editReply(`❌ Rola \`${roleName}\` ne postoji. Pokreni \`/server setup\` da kreiriaš farm role.`);
      }

      // Fetch member and assign role
      const member = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!member) {
        return interaction.editReply('❌ Korisnik nije pronađen na serveru.');
      }

      // Remove other farm roles first
      const allFarmRoles = guild.roles.cache.filter((r: any) => r.name.startsWith(FARM_ROLE_PREFIX));
      for (const [, r] of allFarmRoles) {
        if (member.roles.cache.has(r.id) && r.id !== farmRole.id) {
          await member.roles.remove(r, 'Farm reassignment').catch(() => {});
        }
      }

      // Add the target farm role
      if (!member.roles.cache.has(farmRole.id)) {
        await member.roles.add(farmRole, `Manual farm assignment by ${interaction.user.tag}`);
      }

      // Also update playerLink defaultFarmId if link exists
      const link = await storage.getPlayerLinkByDiscord(targetUser.id);
      if (link) {
        await storage.upsertPlayerLink({ ...link, defaultFarmId: farmId });
      }

      await interaction.editReply(`✅ **${targetUser.tag}** dodijeljen farmi **${farmName}** (rola: ${farmRole}).`);
    }
  }

  // ====== /obavijest command — notify all NotifyMe role holders ======
  private async handleObavijestCommand(interaction: any) {
    // Only staff (Upravitelj+) can use
    const member = interaction.member;
    const isStaff = member?.roles?.cache?.some((r: any) => ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n)));
    if (!isStaff && !this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '❌ Samo staff može slati obavijesti.', ephemeral: true });
      return;
    }

    const poruka = interaction.options.getString('poruka');
    if (!poruka) { await interaction.reply({ content: '❌ Moraš upisati poruku.', ephemeral: true }); return; }

    await interaction.deferReply();

    const guild = interaction.guild;
    const notifyRole = guild.roles.cache.find((r: any) => r.name.includes('NotifyMe'));
    if (!notifyRole) {
      await interaction.editReply('❌ NotifyMe rola ne postoji — pokreni /setup.');
      return;
    }

    // Find obavijesti channel via configurable key
    const obavijestCh = await getGuildChannel(guild, 'obavijesti');
    const targetCh = obavijestCh || interaction.channel;

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('📢 Nova Obavijest')
      .setDescription(poruka)
      .setFooter({ text: `Od: ${interaction.user.tag}` })
      .setTimestamp();

    await (targetCh as any).send({ content: `${notifyRole}`, embeds: [embed] });
    if (targetCh.id !== interaction.channel?.id) {
      await interaction.editReply(`✅ Obavijest poslana u ${targetCh} s pingom za ${notifyRole}.`);
    } else {
      await interaction.editReply(`✅ Obavijest poslana s pingom za ${notifyRole}.`);
    }
  }

  // ====== /poslovi command — show custom contracts overview ======
  private async handlePosloviCommand(interaction: any) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const contracts = await storage.getCustomContracts();
      const farms = await storage.getFarms();
      const farmName = (fid: string | null) => {
        if (!fid) return 'N/A';
        const f = farms.find((fm: any) => String(fm.farmId) === String(fid));
        return f?.name || `Farma ${fid}`;
      };

      const open = contracts.filter((c: any) => c.status === 'OTVORENO');
      const accepted = contracts.filter((c: any) => c.status === 'PRIHVAĆENO');

      let desc = '';
      if (open.length === 0 && accepted.length === 0) {
        desc = 'Nema aktivnih poslova na ugovor.';
      } else {
        if (open.length > 0) {
          desc += '**🟢 OTVORENO:**\n';
          for (const c of open.slice(0, 10)) {
            const wt = this.POSLOVI_WORK_TYPES[c.workType] || c.workType;
            desc += `> **#${c.gameId}** ${wt} | Polje ${c.fieldId} | ${c.reward?.toLocaleString() || 0}€ | ${farmName(c.creatorFarmId)}\n`;
          }
          if (open.length > 10) desc += `> ... i još ${open.length - 10}\n`;
          desc += '\n';
        }
        if (accepted.length > 0) {
          desc += '**🟡 PRIHVAĆENO:**\n';
          for (const c of accepted.slice(0, 10)) {
            const wt = this.POSLOVI_WORK_TYPES[c.workType] || c.workType;
            desc += `> **#${c.gameId}** ${wt} | Polje ${c.fieldId} | ${c.reward?.toLocaleString() || 0}€ | ${farmName(c.creatorFarmId)} → ${farmName(c.contractorFarmId)}\n`;
          }
          if (accepted.length > 10) desc += `> ... i još ${accepted.length - 10}\n`;
        }
      }

      const embed = new EmbedBuilder()
        .setTitle('📋 Poslovi na Ugovor')
        .setDescription(desc)
        .setColor(0xFF8C00)
        .setTimestamp()
        .setFooter({ text: `Ukupno: ${contracts.length} | Otvoreno: ${open.length} | Prihvaćeno: ${accepted.length}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (e: any) {
      console.error('[POSLOVI] Command error:', e);
      await interaction.editReply(`❌ Greška: ${e.message}`);
    }
  }

  // ====== /farme command — interactive player-farm assignment ======
  private async handleFarmeCommand(interaction: any) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) && !this.isOwner(interaction.user.id)) {
      return interaction.reply({ content: '❌ Samo administratori.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    if (!guild) return interaction.editReply('❌ Ova komanda radi samo na serveru.');

    const dbFarms = await storage.getFarms();
    const allPlayers = await storage.getPlayers();

    if (!dbFarms.length) return interaction.editReply('❌ Nema farmi u bazi — pokreni /sync prvo.');
    if (!allPlayers.length) return interaction.editReply('❌ Nema igrača u bazi — pokreni /sync prvo.');

    // Build player list grouped by farm
    const farmMap = new Map(dbFarms.map(f => [String(f.farmId), f]));
    const byFarm = new Map<string, typeof allPlayers>();
    const unassigned: typeof allPlayers = [];

    for (const p of allPlayers) {
      if ((Number(p.playTime) || 0) <= 0) continue; // skip zero-playtime ghosts
      const fid = String(p.farmId || '');
      if (fid && farmMap.has(fid)) {
        const arr = byFarm.get(fid) || [];
        arr.push(p);
        byFarm.set(fid, arr);
      } else {
        unassigned.push(p);
      }
    }

    // Build embed
    const lines: string[] = [];
    for (const [fid, farm] of farmMap) {
      const farmName = farm.name || `Farma ${fid}`;
      const players = byFarm.get(fid) || [];
      lines.push(`\n**🏠 ${farmName}** (ID: ${fid})`);
      if (players.length === 0) {
        lines.push('  _Nema igrača_');
      } else {
        for (const p of players) {
          const hours = (Number(p.playTime) || 0).toFixed(1);
          const online = p.isOnline ? '🟢' : '⚫';
          lines.push(`  ${online} **${p.name}** — ${hours}h`);
        }
      }
    }
    if (unassigned.length > 0) {
      lines.push(`\n**❓ Bez farme:**`);
      for (const p of unassigned) {
        const hours = (Number(p.playTime) || 0).toFixed(1);
        lines.push(`  ⚫ **${p.name}** — ${hours}h`);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🌾 Razvrstavanja Igrača po Farmama')
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: 'Odaberi igrača iz dropdowna ispod pa klikni farmu za premještaj' })
      .setTimestamp();

    // Player select dropdown (max 25 options)
    const activePlayers = allPlayers
      .filter(p => (Number(p.playTime) || 0) > 0)
      .sort((a, b) => (Number(b.playTime) || 0) - (Number(a.playTime) || 0))
      .slice(0, 25);

    const playerSelect = new StringSelectMenuBuilder()
      .setCustomId('farme_player_select')
      .setPlaceholder('Odaberi igrača za premještaj...')
      .addOptions(activePlayers.map(p => {
        const farm = farmMap.get(String(p.farmId || ''));
        const farmLabel = farm ? ` (${farm.name || 'F' + farm.farmId})` : ' (bez farme)';
        return {
          label: `${p.name}${farmLabel}`.slice(0, 100),
          description: `${(Number(p.playTime) || 0).toFixed(1)}h odigrano`,
          value: p.uniqueUserId,
        };
      }));

    // Farm buttons
    const farmButtons = dbFarms.slice(0, 5).map(f => {
      const farmName = (f.name || `Farma ${f.farmId}`).slice(0, 60);
      return new ButtonBuilder()
        .setCustomId(`farme_assign_${f.farmId}`)
        .setLabel(`🌾 ${farmName}`)
        .setStyle(ButtonStyle.Primary);
    });

    const rows: any[] = [
      new ActionRowBuilder().addComponents(playerSelect),
    ];
    if (farmButtons.length > 0) {
      rows.push(new ActionRowBuilder().addComponents(...farmButtons));
    }

    await interaction.editReply({ embeds: [embed], components: rows });
  }

  // Store selected player for /farme flow (keyed by interaction user ID)
  private farmeSelectedPlayer = new Map<string, string>();

  // Refresh the /farme embed after a change
  private async refreshFarmeEmbed(interaction: any, guild: any) {
    try {
      const dbFarms = await storage.getFarms();
      const allPlayers = await storage.getPlayers();
      const farmMap = new Map(dbFarms.map(f => [String(f.farmId), f]));
      const byFarm = new Map<string, typeof allPlayers>();
      const unassigned: typeof allPlayers = [];

      for (const p of allPlayers) {
        if ((Number(p.playTime) || 0) <= 0) continue;
        const fid = String(p.farmId || '');
        if (fid && farmMap.has(fid)) {
          const arr = byFarm.get(fid) || [];
          arr.push(p);
          byFarm.set(fid, arr);
        } else {
          unassigned.push(p);
        }
      }

      const lines: string[] = [];
      for (const [fid, farm] of farmMap) {
        const farmName = farm.name || `Farma ${fid}`;
        const players = byFarm.get(fid) || [];
        lines.push(`\n**🏠 ${farmName}** (ID: ${fid})`);
        if (players.length === 0) {
          lines.push('  _Nema igrača_');
        } else {
          for (const p of players) {
            const hours = (Number(p.playTime) || 0).toFixed(1);
            const online = p.isOnline ? '🟢' : '⚫';
            lines.push(`  ${online} **${p.name}** — ${hours}h`);
          }
        }
      }
      if (unassigned.length > 0) {
        lines.push(`\n**❓ Bez farme:**`);
        for (const p of unassigned) {
          const hours = (Number(p.playTime) || 0).toFixed(1);
          lines.push(`  ⚫ **${p.name}** — ${hours}h`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('🌾 Razvrstavanja Igrača po Farmama')
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: 'Odaberi igrača iz dropdowna ispod pa klikni farmu za premještaj' })
        .setTimestamp();

      const activePlayers = allPlayers
        .filter(p => (Number(p.playTime) || 0) > 0)
        .sort((a, b) => (Number(b.playTime) || 0) - (Number(a.playTime) || 0))
        .slice(0, 25);

      const playerSelect = new StringSelectMenuBuilder()
        .setCustomId('farme_player_select')
        .setPlaceholder('Odaberi igrača za premještaj...')
        .addOptions(activePlayers.map(p => {
          const farm = farmMap.get(String(p.farmId || ''));
          const farmLabel = farm ? ` (${farm.name || 'F' + farm.farmId})` : ' (bez farme)';
          return {
            label: `${p.name}${farmLabel}`.slice(0, 100),
            description: `${(Number(p.playTime) || 0).toFixed(1)}h odigrano`,
            value: p.uniqueUserId,
          };
        }));

      const farmButtons = dbFarms.slice(0, 5).map(f => {
        const farmName = (f.name || `Farma ${f.farmId}`).slice(0, 60);
        return new ButtonBuilder()
          .setCustomId(`farme_assign_${f.farmId}`)
          .setLabel(`🌾 ${farmName}`)
          .setStyle(ButtonStyle.Primary);
      });

      const rows: any[] = [new ActionRowBuilder().addComponents(playerSelect)];
      if (farmButtons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(...farmButtons));
      }

      await interaction.editReply({ embeds: [embed], components: rows });
    } catch (e) {
      console.error('[FARME] refreshFarmeEmbed error:', e);
    }
  }

  // ====== Auto-update leaderboard channel ======
  private async updateLeaderboardChannel() {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) { console.log('[LEADERBOARD] No guildId configured'); return; }
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) { console.log('[LEADERBOARD] Guild not found:', guildId); return; }

    const ch = await getGuildChannel(guild, 'leaderboard');
    if (!ch) {
      // Fallback: try to find by plainName directly
      const fallback = guild.channels.cache.find((c: any) => c.type === 0 && plainName(c.name) === 'leaderboard');
      if (!fallback) { console.log('[LEADERBOARD] Channel not found — no guild settings and no channel matching "leaderboard"'); return; }
      console.log('[LEADERBOARD] Found via plainName fallback:', fallback.name);
      return this._doLeaderboardUpdate(fallback);
    }

    return this._doLeaderboardUpdate(ch);
  }

  private async _doLeaderboardUpdate(ch: any) {

    // Gather all data
    const lb = getPlayerHoursLeaderboard(1, 15);
    const allPlayers = await storage.getPlayers();
    const allFarms = await storage.getFarms();
    const allVehicles = await storage.getVehicles();
    const allFields = await storage.getFields();

    if (!lb.rows?.length && !allPlayers.length) {
      // No data yet — post a waiting embed so channel isn't empty
      try {
        const messages = await (ch as any).messages.fetch({ limit: 10 });
        const botMsg = messages?.find((m: any) => m.author.id === this.client.user?.id);
        const waitEmbed = new EmbedBuilder()
          .setColor(0x95a5a6)
          .setTitle('🏆 Scoreboard')
          .setDescription('⏳ Čekam podatke sa servera...\n\nLeaderboard će se automatski ažurirati nakon prvog synca.')
          .setFooter({ text: 'Ažurira se svakih 15 min' })
          .setTimestamp();
        if (botMsg) {
          await botMsg.edit({ embeds: [waitEmbed] });
        } else {
          await (ch as any).send({ embeds: [waitEmbed] });
        }
      } catch {}
      return;
    }

    // Build scoreboard from leaderboard + game data
    const farmMap = new Map(allFarms.map((f: any) => [String(f.farmId), f]));

    // Prefer in-memory leaderboard (real-time from playerTimeStats.xml) over DB playTime
    // (which may have game-time-inflated values from playerStats.xml).
    // Only fall back to DB if in-memory data is truly empty.
    let allCandidates: any[];
    if (lb.rows?.length) {
      allCandidates = lb.rows;
    } else {
      // Fallback: use DB playTime but cap at reasonable values to prevent inflated display.
      // playerStats.xml uses game-time (e.g. 15x speed = 15x inflated), so if
      // runtime stats never corrected a player, their playTime may be wildly wrong.
      allCandidates = allPlayers
        .filter((p: any) => (Number(p.playTime) || 0) > 0)
        .map((p: any) => ({
          userId: p.uniqueUserId,
          name: p.name,
          secondsAllTime: (Number(p.playTime) || 0) * 3600,
          secondsAfk: 0,
          seconds30d: 0,
        }));
    }
    // Filter out players with zero playtime (never actually played on this map)
    const topPlayers = allCandidates.filter((r: any) => (r.secondsAllTime || 0) > 0).slice(0, 15);

    const lines = topPlayers.map((r: any, i: number) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
      const name = (r.name || 'Nepoznat').slice(0, 18);

      // Find game player to get farm info & online status
      const gp = allPlayers.find((p: any) => p.uniqueUserId === r.userId || p.name === r.name);
      const farm = gp ? farmMap.get(String(gp.farmId)) : null;
      const farmName = farm?.name ? `\`${farm.name.slice(0, 12)}\`` : '—';
      const online = gp?.isOnline ? '🟢' : '⚫';
      const hours = formatHours(r.secondsAllTime || 0);
      const afkSec = r.secondsAfk || 0;
      const afkStr = afkSec > 60 ? ` *(💤 ${formatHours(afkSec)})*` : '';

      return `${medal} ${online} **${name}** │ ⏱️ ${hours}${afkStr} │ 🌾 ${farmName}`;
    });

    // ── Per-farm statistics ──
    const farmStatsMap = new Map<string, { name: string; balance: number; players: number; onlinePlayers: number; fields: number; ha: number; vehicles: number }>();
    for (const f of allFarms) {
      const fid = String(f.farmId);
      if (fid === '0') continue; // skip spectator/admin farm
      farmStatsMap.set(fid, {
        name: (f as any).name || `Farma ${fid}`,
        balance: Number((f as any).balance) || 0,
        players: 0,
        onlinePlayers: 0,
        fields: 0,
        ha: 0,
        vehicles: 0,
      });
    }
    for (const p of allPlayers) {
      const fid = String(p.farmId || '');
      const fs = farmStatsMap.get(fid);
      if (fs) {
        fs.players++;
        if (p.isOnline) fs.onlinePlayers++;
      }
    }
    for (const f of allFields) {
      const fid = String((f as any).ownerFarmId || '');
      const fs = farmStatsMap.get(fid);
      if (fs) {
        fs.fields++;
        fs.ha += Number((f as any).fieldArea) || 0;
      }
    }
    for (const v of allVehicles) {
      const fid = String((v as any).farmId || '');
      const fs = farmStatsMap.get(fid);
      if (fs) fs.vehicles++;
    }

    // Server totals — use leaderboard data for playtime (real-time), DB only for player count
    const totalPlayers = allPlayers.filter((p: any) => (Number(p.playTime) || 0) > 0).length;
    const onlinePlayers = allPlayers.filter((p: any) => p.isOnline).length;
    const totalVehicles = allVehicles.length;
    const totalFields = allFields.length;
    const totalHa = allFields.reduce((s: number, f: any) => s + (Number(f.fieldArea) || 0), 0);
    // Use in-memory leaderboard total (correct real-time) if available, else DB
    const totalPlaytimeSec = lb.rows?.length
      ? lb.rows.reduce((s: number, r: any) => s + (r.secondsAllTime || 0), 0)
      : allPlayers.reduce((s: number, p: any) => s + ((Number(p.playTime) || 0) * 3600), 0);

    // Build per-farm fields for embed
    const farmFields: Array<{ name: string; value: string; inline: boolean }> = [];
    for (const [, fs] of farmStatsMap) {
      const onlineStr = fs.onlinePlayers > 0 ? ` (🟢 ${fs.onlinePlayers})` : '';
      farmFields.push({
        name: `🏠 ${fs.name}`,
        value: `👥 ${fs.players} igrača${onlineStr}\n🌾 ${fs.fields} polja (${fs.ha.toFixed(1)} ha)\n🚜 ${fs.vehicles} vozila\n💰 $${fs.balance.toLocaleString('hr-HR')}`,
        inline: true,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('🏆 Scoreboard — Top 15 Igrača')
      .setDescription(
        '```\n' +
        '  #  Status  Igrač              Sati         Farma\n' +
        '─────────────────────────────────────────────────────\n' +
        '```\n' +
        lines.join('\n') +
        '\n\n─────────────────────────────────────────'
      )
      .addFields(
        ...farmFields,
        { name: '📊 Ukupno', value: `👥 ${totalPlayers} igrača │ 🟢 ${onlinePlayers} online\n🚜 ${totalVehicles} vozila │ 🌾 ${totalFields} polja (${totalHa.toFixed(1)} ha)\n⏱️ ${formatHours(totalPlaytimeSec)}`, inline: false },
        { name: '📋 Legenda', value: '🟢 Online │ ⚫ Offline', inline: false },
      )
      .setFooter({ text: `Ukupno igrača: ${totalPlayers} • Ažurirano svakih 15 min` })
      .setTimestamp();

    // Find existing bot message or send new
    try {
      const messages = await (ch as any).messages.fetch({ limit: 10 });
      const botMsg = messages?.find((m: any) => m.author.id === this.client.user?.id && m.embeds?.[0]?.title?.includes('Scoreboard'));
      if (botMsg) {
        await botMsg.edit({ embeds: [embed] });
      } else {
        // Clean old leaderboard message if exists
        const oldMsg = messages?.find((m: any) => m.author.id === this.client.user?.id && m.embeds?.[0]?.title?.includes('Leaderboard'));
        if (oldMsg) await oldMsg.delete().catch(() => {});
        await (ch as any).send({ embeds: [embed] });
      }
    } catch (e: any) {
      console.error('[LEADERBOARD] Update error:', e.message);
    }
  }

  // ====== Auto-update weather channel ======
  private async updateWeatherChannel() {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const ch = await getGuildChannel(guild, 'vrijeme');
    if (!ch) return;

    const weather = await storage.getWeather();
    if (!weather) return;

    const current = (weather as any)?.current ?? {};
    const hourly = Array.isArray((weather as any)?.hourly) ? (weather as any).hourly : [];
    const daily = Array.isArray((weather as any)?.daily) ? (weather as any).daily : [];

    const fmtTemp = (v: any, digits: number = 1) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      return n.toFixed(digits).replace(/\.0$/, '');
    };
    const fmtInt = (v: any) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      return String(Math.round(n));
    };
    const label = (t: any) => {
      const s = String(t || '').toLowerCase();
      if (s.includes('sun') || s.includes('clear')) return 'Vedro';
      if (s.includes('overcast')) return 'Naoblaka';
      if (s.includes('cloud')) return 'Oblačno';
      if (s.includes('rain')) return 'Kiša';
      if (s.includes('storm') || s.includes('thunder')) return 'Oluja';
      if (s.includes('snow')) return 'Snijeg';
      if (s.includes('fog') || s.includes('mist')) return 'Magla';
      return String(t || 'N/A').slice(0, 18);
    };
    const icon = (t: any) => {
      const s = String(t || '').toLowerCase();
      if (s.includes('sun') || s.includes('clear')) return '☀️';
      if (s.includes('storm') || s.includes('thunder')) return '⛈️';
      if (s.includes('rain')) return '🌧️';
      if (s.includes('snow')) return '❄️';
      if (s.includes('fog') || s.includes('mist')) return '🌫️';
      if (s.includes('overcast') || s.includes('cloud')) return '☁️';
      return '🌡️';
    };
    const fmtTime = (t: any) => {
      const n = Number(t);
      if (!Number.isFinite(n)) return '--:--';
      const toHHmm = (totalMinutes: number) => {
        const safe = ((Math.floor(totalMinutes) % 1440) + 1440) % 1440;
        return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
      };
      if (n >= 0 && n <= 48) return toHHmm((n % 24) * 60);
      if (n >= 0 && n < 1440) return toHHmm(n);
      if (n >= 0 && n < 86400) return toHHmm(n / 60);
      return toHHmm((n / 1000) / 60);
    };

    // Current weather
    const cType = current.weatherType || (hourly[0]?.weatherType ?? 'N/A');
    const nowTemp = current.temperature ?? hourly[0]?.temperature;
    const nowWind = current.windSpeed ?? hourly[0]?.windSpeed;

    // Build the TV-style forecast embed
    const mainEmbed = new EmbedBuilder()
      .setColor(0x0ea5e9)
      .setTitle('⛅ Vremenska Prognoza — Slavonska Ravnica')
      .setTimestamp()
      .setFooter({ text: 'Ažurira se svakih 15 minuta • FarmBuddy' });

    // Current conditions
    let currentDesc = `## ${icon(cType)} Trenutno: ${label(cType)}\n`;
    currentDesc += `🌡️ **Temperatura:** ${fmtTemp(nowTemp)}°C\n`;
    if (nowWind !== undefined && nowWind !== null && nowWind !== '') {
      currentDesc += `💨 **Vjetar:** ${fmtTemp(nowWind, 0)} m/s\n`;
    }
    currentDesc += '\n';

    // Today's hourly forecast
    const baseDay = hourly.length ? Math.min(...hourly.map((h: any) => Number(h?.day)).filter((n: number) => Number.isFinite(n))) : 0;
    const todayHours = hourly
      .filter((h: any) => Number(h?.day) === baseDay)
      .sort((a: any, b: any) => Number(a?.time ?? 0) - Number(b?.time ?? 0))
      .slice(0, 8);

    if (todayHours.length > 0) {
      currentDesc += '### 🕐 Danas po satima\n';
      currentDesc += '```\n';
      currentDesc += 'Sat    Prognoza         Temp\n';
      currentDesc += '─────  ──────────────  ─────\n';
      for (const h of todayHours) {
        const t = fmtTime(h.time).padEnd(5);
        const w = (`${icon(h.weatherType)} ${label(h.weatherType)}`).slice(0, 14).padEnd(14);
        const temp = `${fmtTemp(h.temperature)}°`.padStart(5);
        currentDesc += `${t}  ${w}  ${temp}\n`;
      }
      currentDesc += '```\n';
    }

    // Daily forecast
    if (daily.length > 0) {
      currentDesc += '### 📅 Dnevna prognoza\n';
      currentDesc += '```\n';
      currentDesc += 'Dan   Prognoza         Min   Max\n';
      currentDesc += '────  ──────────────  ────  ────\n';
      for (let i = 0; i < Math.min(7, daily.length); i++) {
        const d = daily[i];
        const day = (`D${i}`).padEnd(4);
        const w = (`${icon(d.weatherType)} ${label(d.weatherType)}`).slice(0, 14).padEnd(14);
        const min = `${fmtInt(d.minTemp)}°`.padStart(4);
        const max = `${fmtInt(d.maxTemp)}°`.padStart(4);
        currentDesc += `${day}  ${w}  ${min}  ${max}\n`;
      }
      currentDesc += '```';
    }

    mainEmbed.setDescription(currentDesc);

    // Find existing bot message or send new
    try {
      const messages = await (ch as any).messages.fetch({ limit: 10 });
      const botMsg = messages?.find((m: any) => m.author.id === this.client.user?.id && m.embeds?.[0]?.title?.includes('Vremenska'));
      if (botMsg) {
        await botMsg.edit({ embeds: [mainEmbed] });
      } else {
        await (ch as any).send({ embeds: [mainEmbed] });
      }
    } catch (e: any) {
      console.error('[WEATHER-CH] Update error:', e.message);
    }
  }

  // ====== Auto-update karta/map channel ======
  private async updateKartaChannel() {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const ch = await getGuildChannel(guild, 'karta');
    if (!ch) return;

    // Get online players for the map
    const storedPlayers = await storage.getPlayers().catch(() => [] as any[]);
    const onlinePlayers = storedPlayers.filter((p: any) => p.isOnline);
    const farms = await storage.getFarms().catch(() => [] as any[]);

    const webBase = process.env.WEB_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '';
    const webUrl = webBase ? (webBase.startsWith('http') ? webBase : `https://${webBase}`) : '';

    let desc = '## 🗺️ Karta — Slavonska Ravnica\n\n';
    desc += 'Interaktivna karta servera s pozicijama igrača i farmama.\n\n';

    // Farm list
    if (farms.length > 0) {
      desc += '### 🏠 Farme na karti\n';
      for (const f of farms.filter(f => f.farmId !== '0')) {
        const farmPlayers = onlinePlayers.filter((p: any) => String(p.farmId) === String(f.farmId));
        const onlineIcon = farmPlayers.length > 0 ? '🟢' : '⚪';
        desc += `${onlineIcon} **${f.name || `Farma ${f.farmId}`}** — ${farmPlayers.length} online\n`;
      }
      desc += '\n';
    }

    // Online players
    if (onlinePlayers.length > 0) {
      desc += '### 👥 Online igrači\n';
      for (const p of onlinePlayers.slice(0, 15)) {
        desc += `🚜 **${(p as any).name || 'Nepoznat'}**\n`;
      }
      desc += '\n';
    } else {
      desc += '*Trenutno nema online igrača.*\n\n';
    }

    if (webUrl) {
      desc += `> 🔗 [Otvori interaktivnu kartu](${webUrl})`;
    }

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🗺️ Karta Servera — Slavonska Ravnica')
      .setDescription(desc)
      .setTimestamp()
      .setFooter({ text: 'Ažurira se svakih 15 minuta • FarmBuddy' });

    // Add map image if available
    const mapUrl = this.getTrackingImageUrl('player');
    if (mapUrl) embed.setImage(mapUrl);

    // Find existing bot message or send new
    try {
      const messages = await (ch as any).messages.fetch({ limit: 10 });
      const botMsg = messages?.find((m: any) => m.author.id === this.client.user?.id && m.embeds?.[0]?.title?.includes('Karta'));
      if (botMsg) {
        await botMsg.edit({ embeds: [embed] });
      } else {
        await (ch as any).send({ embeds: [embed] });
      }
    } catch (e: any) {
      console.error('[KARTA-CH] Update error:', e.message);
    }
  }

  // ====== Auto-update launcher channel with latest GitHub release ======
  private cachedLauncherRelease: { tag: string; url: string; publishedAt: string; checkedAt: number } | null = null;

  private async updateLauncherChannel() {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const ch = await getGuildChannel(guild, 'launcher');
    if (!ch) return;

    // Fetch latest release from GitHub (public API, no auth needed)
    const REPO = '7oncha/SRManager-Installer';
    try {
      const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'FarmBuddy-Bot' },
      });
      if (!resp.ok) {
        console.error(`[LAUNCHER-CH] GitHub API error: ${resp.status}`);
        return;
      }
      const release = await resp.json() as any;
      const tag = release.tag_name || 'latest';
      const exeAsset = (release.assets || []).find((a: any) => a.name?.endsWith('.exe'));
      const downloadUrl = exeAsset?.browser_download_url
        || `https://github.com/${REPO}/releases/latest/download/SRManager.exe`;
      const publishedAt = release.published_at || '';

      // Skip if same version is already posted in the channel (survives restarts)
      if (this.cachedLauncherRelease && this.cachedLauncherRelease.tag === tag && this.cachedLauncherRelease.url === downloadUrl) {
        return;
      }

      // Even if cache was cleared (restart), check if the current channel message already has this version
      if (!this.cachedLauncherRelease) {
        const existingMsgs = await (ch as any).messages.fetch({ limit: 10 }).catch(() => null);
        if (existingMsgs) {
          const alreadyPosted = existingMsgs.some((m: any) =>
            m.author?.id === this.client.user?.id &&
            m.embeds?.length > 0 &&
            String(m.embeds[0]?.description || '').includes(tag)
          );
          if (alreadyPosted) {
            this.cachedLauncherRelease = { tag, url: downloadUrl, publishedAt, checkedAt: Date.now() };
            return;
          }
        }
      }

      this.cachedLauncherRelease = { tag, url: downloadUrl, publishedAt, checkedAt: Date.now() };

      const versionLine = `**Verzija:** ${tag}`;
      const dateLine = publishedAt ? ` • **Objavljeno:** <t:${Math.floor(new Date(publishedAt).getTime() / 1000)}:R>` : '';

      const embed = new EmbedBuilder()
        .setTitle('🚀 Slavonska Ravnica Launcher')
        .setDescription(
          'Preuzmi službeni launcher za automatsku instalaciju i ažuriranje modova.\n\n' +
          'Launcher će automatski konfigurirati tvoj FS25 s potrebnim modovima za Slavonsku Ravnicu.\n\n' +
          `${versionLine}${dateLine}\n\n` +
          '**Instalacija:**\n' +
          '1. Preuzmi `SRManager.exe` klikom na gumb ispod\n' +
          '2. Pokreni preuzeti launcher\n' +
          '3. Prati upute u installeru\n\n' +
          '**Problemi?**\n' +
          '• Pokreni launcher kao Administrator\n' +
          '• Provjeri da ti antivirus ne blokira\n' +
          '• Ako ništa ne pomaže, javi se u support kanal'
        )
        .setColor(0x2ecc71)
        .setTimestamp()
        .setFooter({ text: 'Automatski se ažurira • FarmBuddy' });

      const thumbUrl = process.env['SERVER_ICON_URL'];
      if (thumbUrl) embed.setThumbnail(thumbUrl);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel(`⬇️ Preuzmi Launcher (${tag})`)
          .setStyle(ButtonStyle.Link)
          .setURL(downloadUrl),
        new ButtonBuilder()
          .setLabel('GitHub')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://github.com/${REPO}`)
          .setEmoji('🔗')
      );

      // Delete ALL old bot messages in the launcher channel to clear stale embeds/buttons
      const messages = await (ch as any).messages.fetch({ limit: 20 });
      const oldBotMsgs = messages?.filter((m: any) => m.author.id === this.client.user?.id);
      if (oldBotMsgs?.size > 0) {
        for (const [, msg] of oldBotMsgs) {
          await msg.delete().catch(() => {});
        }
      }

      // Post fresh embed with the correct download URL
      await (ch as any).send({ embeds: [embed], components: [row] });
      console.log(`[LAUNCHER-CH] Posted fresh launcher embed — ${tag} — URL: ${downloadUrl}`);
    } catch (e: any) {
      console.error('[LAUNCHER-CH] Update error:', e.message);
    }
  }

  // ====== Auto-update farm stat channels ======
  private async updateFarmStatChannels() {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return;
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const dbFarms = (await storage.getFarms()).filter(f => f.farmId !== '0');
    const allPlayers = await storage.getPlayers();
    const allAnimals = await storage.getAnimals();
    const allFields = await storage.getFields();
    const allVehicles = await storage.getVehicles();
    const allSilos = await storage.getSilos();
    const allProductions = await storage.getProductions();

    // Find per-farm categories (each farm has its own category)
    for (const farm of dbFarms) {
      const farmName = farm.name || `Farma ${farm.farmId}`;
      const farmNameSmall = toSmallCaps(farmName.toUpperCase());
      const farmPlayers = allPlayers.filter((p: any) => String(p.farmId) === String(farm.farmId));
      const farmAnimals = allAnimals.filter((a: any) => String(a.farmId) === String(farm.farmId));
      const farmFields = allFields.filter((f: any) => String(f.ownerFarmId) === String(farm.farmId));
      const farmVehicles = allVehicles.filter((v: any) => String(v.farmId) === String(farm.farmId));
      const farmSilos = allSilos.filter((s: any) => String(s.farmId) === String(farm.farmId));
      const farmProductions = allProductions.filter((p: any) => String(p.farmId) === String(farm.farmId));

      // Find this farm's category by name (robust fallback)
      const farmCat = findFarmCategory(guild, farmName);

      // Get all channels inside this farm's category
      let farmChannels: any[] = [];
      if (farmCat) {
        farmChannels = [...guild.channels.cache.filter((c: any) => c.parentId === farmCat.id && c.type === 0).values()];
      }

      // Fallback: find by permission overwrites if category not found
      if (farmChannels.length === 0) {
        const farmRole = guild.roles.cache.find((r: any) => r.name === `\uD83C\uDF3E ${farmName}`);
        if (farmRole) {
          farmChannels = [...guild.channels.cache.filter((c: any) =>
            c.type === 0 && c.permissionOverwrites?.cache?.has(farmRole.id) && !c.name.includes('\uD83C\uDFE1')
          ).values()];
        }
      }

      const statCh = farmChannels.find((c: any) => c.name.includes('ꜱᴛᴀᴛɪꜱᴛɪᴋᴀ') || c.name.startsWith('\uD83D\uDCCA'));
      const ekonCh = farmChannels.find((c: any) => c.name.includes('ᴇᴋᴏɴᴏᴍɪᴊᴀ') || c.name.startsWith('\uD83C\uDFE6'));
      const animalCh = farmChannels.find((c: any) => c.name.includes('žɪᴠᴏᴛɪɴᴊᴇ') || c.name.startsWith('\uD83D\uDC04'));

      // ═══════════════════════════════════════════════════
      // 📊 STATISTIKA — per-farm overview
      // ═══════════════════════════════════════════════════
      if (statCh) {
        const onlinePlayers = farmPlayers.filter((p: any) => p.isOnline);
        const totalPlaytimeSec = farmPlayers.reduce((s: number, p: any) => s + (Number(p.playTime) || 0), 0);

        // Crops
        const cropMap = new Map<string, number>();
        let harvestReady = 0;
        let growing = 0;
        for (const f of farmFields) {
          const fruit = f.fruitName || '';
          const st = String(f.fruitStatus || f.growthStage || '').toLowerCase();
          if (fruit && fruit !== 'none' && fruit !== 'unknown') {
            cropMap.set(fruit, (cropMap.get(fruit) || 0) + 1);
          }
          if (st.includes('ready')) harvestReady++;
          if (st.includes('growing')) growing++;
        }
        const cropLines = [...cropMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 9)
          .map(([crop, count]) => `• **${crop}** — ${count} polja`)
          .join('\n') || '*Nema zasijanih polja*';

        // Vehicles — show damage summary instead of types
        const totalDamaged = farmVehicles.filter((v: any) => Number(v.damage) > 0.3).length;
        const critDamaged = farmVehicles.filter((v: any) => Number(v.damage) > 0.7).length;
        const avgFuel = farmVehicles.length > 0
          ? Math.round(farmVehicles.reduce((s: number, v: any) => s + (Number(v.fuel || v.fuelLevel || 0) * 100), 0) / farmVehicles.length)
          : 0;
        let vehStatus = `🚜 **${farmVehicles.length}** vozila`;
        if (totalDamaged > 0) vehStatus += `\n⚠️ **${totalDamaged}** oštećeno${critDamaged > 0 ? ` (🔴 ${critDamaged} kritično)` : ''}`;
        vehStatus += `\n⛽ Prosječno gorivo: **${avgFuel}%**`;

        // Silos — top 5 with bars
        const topSilos = farmSilos
          .filter((s: any) => Number(s.totalFill) > 0)
          .sort((a: any, b: any) => Number(b.totalFill) - Number(a.totalFill))
          .slice(0, 5);
        const siloLines = topSilos.length > 0
          ? topSilos.map((s: any) => {
              const pct = Math.min(100, Math.max(0, Number(s.percent) || 0));
              const bar = progressBar(pct);
              return `${bar} **${(s.name || 'Silo').slice(0, 22)}** ${Math.round(pct)}%`;
            }).join('\n')
          : '*Nema punjenih silosa*';

        const totalArea = farmFields.reduce((s: number, f: any) => s + (Number(f.fieldArea) || 0), 0);

        // Build embed
        let desc = '';
        desc += `👥 **${onlinePlayers.length}** online / **${farmPlayers.length}** ukupno`;
        desc += ` · ⏱️ ${formatHours(totalPlaytimeSec * 3600)}\n`;
        desc += `🗺️ **${farmFields.length}** polja · **${totalArea.toFixed(1)} ha**`;
        if (harvestReady > 0) desc += ` · ✅ **${harvestReady}** za žetvu`;
        if (growing > 0) desc += ` · 🌱 **${growing}** raste`;

        const embed = new EmbedBuilder()
          .setColor(0x3498db)
          .setAuthor({ name: farmName, iconURL: guild.iconURL() || undefined })
          .setTitle('📊 Statistika')
          .setDescription(desc)
          .addFields(
            {
              name: '🌿 Usjevi',
              value: cropLines.slice(0, 1024),
              inline: true,
            },
            {
              name: '🚜 Vozila',
              value: vehStatus,
              inline: true,
            },
            {
              name: '🏭 Silosi',
              value: siloLines.slice(0, 1024),
              inline: false,
            },
          )
          .setFooter({ text: `${farmName} • Ažurira se svakih 10 min` })
          .setTimestamp();

        await this.upsertBotEmbed(statCh, embed, 'Statistika');
      }

      // ═══════════════════════════════════════════════════
      // 🏦 EKONOMIJA — financial overview
      // ═══════════════════════════════════════════════════
      if (ekonCh) {
        const balance = Number(farm.balance) || 0;
        const fleetValue = farmVehicles.reduce((s: number, v: any) => s + (Number(v.sellPrice) || 0), 0);
        const totalArea = farmFields.reduce((s: number, f: any) => s + (Number(f.fieldArea) || 0), 0);
        const fieldValue = farmFields.reduce((s: number, f: any) => s + (Number(f.farmlandPrice) || 0), 0);
        const totalAssets = balance + fleetValue + fieldValue;

        const fmt = (n: number) => Math.round(n).toLocaleString('hr-HR');

        // Balance indicator
        const balIcon = balance >= 500000 ? '💰' : balance >= 100000 ? '💵' : balance >= 0 ? '💳' : '📛';

        // Top vehicles by value
        const topVeh = [...farmVehicles]
          .sort((a: any, b: any) => (Number(b.sellPrice) || 0) - (Number(a.sellPrice) || 0))
          .slice(0, 5);
        const topVehLines = topVeh.length > 0
          ? topVeh.map((v: any) => `• **${(v.name || 'Vozilo').slice(0, 28)}** — $${fmt(Number(v.sellPrice) || 0)}`).join('\n')
          : '*Nema vozila*';

        // Productions
        const ownedProds = farmProductions.filter((p: any) => p.isOwned);
        const activeProds = ownedProds.filter((p: any) => p.status === 'RUNNING' || p.status === 'PRODUCING');
        const prodLines = ownedProds.length > 0
          ? ownedProds.slice(0, 6).map((p: any) => {
              const icon = (p.status === 'RUNNING' || p.status === 'PRODUCING') ? '🟢' : '🔴';
              return `${icon} **${(p.name || p.productionPoint || 'Produkcija').slice(0, 30)}**`;
            }).join('\n')
          : '*Nema kupljenih produkcija*';

        // Summary line
        let desc = `${balIcon} Balans: **$${fmt(balance)}**\n`;
        desc += `🏠 Ukupna imovina: **$${fmt(totalAssets)}**`;

        const embed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setAuthor({ name: farmName, iconURL: guild.iconURL() || undefined })
          .setTitle('🏦 Ekonomija')
          .setDescription(desc)
          .addFields(
            {
              name: `🚜 Flota (${farmVehicles.length} vozila) — $${fmt(fleetValue)}`,
              value: topVehLines.slice(0, 1024),
              inline: false,
            },
            {
              name: `🌾 Zemljište (${farmFields.length} polja)`,
              value: `Površina: **${totalArea.toFixed(1)} ha**\nVrijednost: **$${fmt(fieldValue)}**`,
              inline: true,
            },
            {
              name: `🏭 Produkcije (${activeProds.length}/${ownedProds.length} aktivno)`,
              value: prodLines.slice(0, 1024),
              inline: true,
            },
          )
          .setFooter({ text: `${farmName} • Ažurira se svakih 10 min` })
          .setTimestamp();

        await this.upsertBotEmbed(ekonCh, embed, 'Ekonomija');
      }

      // ═══════════════════════════════════════════════════
      // 🐄 ŽIVOTINJE — animal husbandry overview
      // ═══════════════════════════════════════════════════
      if (animalCh) {
        const animalTypeIcons: Record<string, string> = {
          'COW': '🐄', 'CATTLE': '🐄',
          'PIG': '🐷', 'SWINE': '🐷',
          'SHEEP': '🐑',
          'CHICKEN': '🐔', 'HEN': '🐔',
          'HORSE': '🐎',
          'BEE': '🐝', 'BEES': '🐝',
          'GOAT': '🐐',
          'DOG': '🐕',
        };

        const animalTypeNames: Record<string, string> = {
          'COW': 'Krave', 'CATTLE': 'Krave',
          'PIG': 'Svinje', 'SWINE': 'Svinje',
          'SHEEP': 'Ovce',
          'CHICKEN': 'Pilići', 'HEN': 'Pilići',
          'HORSE': 'Konji',
          'BEE': 'Pčele', 'BEES': 'Pčele',
          'GOAT': 'Koze',
          'DOG': 'Psi',
        };

        // Croatian food type names
        const foodNames: Record<string, string> = {
          'TOTAL_MIXED_RATION': 'TMR', 'TOTAL_MIXED_RATION_100': 'TMR',
          'HAY': 'Sijeno', 'HAY_80': 'Sijeno', 'DRYGRASS_WINDROW': 'Sijeno',
          'SILAGE': 'Silaža', 'SILAGE_80': 'Silaža',
          'GRASS': 'Trava', 'GRASS_40': 'Trava', 'GRASS_WINDROW': 'Trava',
          'STRAW': 'Slama', 'WHEAT': 'Pšenica', 'BARLEY': 'Ječam',
          'CORN': 'Kukuruz', 'OAT': 'Zob', 'SOYBEAN': 'Soja',
          'CANOLA': 'Uljana repica', 'SUNFLOWER': 'Suncokret',
          'SUGARBEET': 'Šeć. repa', 'POTATO': 'Krumpir',
          'MINERAL_FEED': 'Minerali', 'WATER': 'Voda',
        };
        const translateFood = (raw: string) => {
          const upper = raw.toUpperCase().replace(/\s+/g, '_');
          if (foodNames[upper]) return foodNames[upper];
          // Try without trailing number suffix like _80, _100, _40
          const stripped = upper.replace(/_\d+$/, '');
          if (foodNames[stripped]) return foodNames[stripped];
          // Fallback: capitalize first letter
          return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase().replace(/_/g, ' ');
        };

        // Normalize health/productivity (could be 0-1 float, 0-100 int, or already %)
        const normPct = (v: number) => {
          if (v > 1 && v <= 100) return Math.round(v);
          if (v <= 1) return Math.round(v * 100);
          return Math.min(100, Math.round(v)); // clamp if somehow > 100
        };

        const totalAnimals = farmAnimals.reduce((s: number, a: any) => s + (Number(a.numAnimals) || 0), 0);
        const maxAnimals = farmAnimals.reduce((s: number, a: any) => s + (Number(a.maxAnimals) || 0), 0);

        let animalDesc = '';
        if (farmAnimals.length > 0) {
          for (const a of farmAnimals) {
            const type = (a.animalType || a.name || 'Unknown').toUpperCase();
            const icon = animalTypeIcons[type] || '🐾';
            const typeName = animalTypeNames[type] || a.animalType || a.name || 'Životinje';
            const num = Number(a.numAnimals) || 0;
            const max = Number(a.maxAnimals) || 0;
            const hp = normPct(Number(a.health) || 0);
            const prod = normPct(Number(a.productivity) || 0);
            const repro = normPct(Number(a.reproduction) || 0);

            const hpBar = progressBar(hp);
            const prodBar = progressBar(prod);

            // Status badge
            const badge = hp < 70 || prod < 50 ? '🔴' : hp < 85 || prod < 70 ? '🟡' : '🟢';

            animalDesc += `### ${icon} ${typeName} — ${num}/${max} ${badge}\n`;
            animalDesc += `❤️ ${hpBar} **${hp}%** · 📈 ${prodBar} **${prod}%**`;
            if (repro > 0) animalDesc += ` · 🐣 **${repro}%**`;
            animalDesc += '\n';

            // Food details with translated names
            if (a.food && typeof a.food === 'object') {
              const foodEntries = Array.isArray(a.food)
                ? a.food
                : Object.entries(a.food).map(([k, v]: any) => ({ name: k, ...v }));
              if (foodEntries.length > 0) {
                const foodBits = foodEntries
                  .filter((f: any) => f.name || f.fillType)
                  .slice(0, 5)
                  .map((f: any) => {
                    const name = translateFood(f.name || f.fillType || '');
                    const level = Math.round(Number(f.level || f.amount || 0));
                    return `**${name}**: ${level}`;
                  })
                  .join(' │ ');
                if (foodBits) animalDesc += `🍽 ${foodBits}\n`;
              }
            }

            // Outputs
            const outArr = Array.isArray(a.outputs) ? a.outputs : [];
            const outBits: string[] = [];
            for (const o of outArr) {
              const fillType = String(o?.fillType || o?.type || '').toUpperCase();
              const amount = Number(o?.amount ?? o?.fillLevel ?? 0);
              if (amount <= 0) continue;
              const fmtAmt = Math.round(amount).toLocaleString('hr-HR');
              if (fillType.includes('MILK')) outBits.push(`🥛 ${fmtAmt}L`);
              else if (fillType.includes('MANURE')) outBits.push(`💩 ${fmtAmt}L`);
              else if (fillType.includes('SLURRY')) outBits.push(`🧪 ${fmtAmt}L`);
              else if (fillType.includes('EGG')) outBits.push(`🥚 ${fmtAmt}`);
              else if (fillType.includes('WOOL')) outBits.push(`🧶 ${fmtAmt}`);
              else outBits.push(`📦 ${fmtAmt}`);
            }
            if (outBits.length > 0) animalDesc += `📤 ${outBits.join(' · ')}\n`;

            animalDesc += '\n';
          }
        } else {
          animalDesc = '*Nema životinja na ovoj farmi.*';
        }

        const embed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setAuthor({ name: farmName, iconURL: guild.iconURL() || undefined })
          .setTitle(`🐄 Životinje${totalAnimals > 0 ? ` — ${totalAnimals}/${maxAnimals}` : ''}`)
          .setDescription(animalDesc.trim().slice(0, 3900))
          .setFooter({ text: `${farmName} • Ažurira se svakih 10 min` })
          .setTimestamp();

        await this.upsertBotEmbed(animalCh, embed, 'Životinje');
      }
    }
  }

  // Helper: upsert (edit or send) a bot embed in a channel
  private async upsertBotEmbed(channel: any, embed: any, titleKeyword: string) {
    try {
      const messages = await channel.messages.fetch({ limit: 10 });
      const botMsg = messages?.find((m: any) => m.author.id === this.client.user?.id && m.embeds?.[0]?.title?.includes(titleKeyword));
      if (botMsg) {
        await botMsg.edit({ embeds: [embed] });
      } else {
        await channel.send({ embeds: [embed] });
      }
    } catch (e: any) {
      console.error(`[FARM-STATS] ${titleKeyword} update error:`, e.message);
    }
  }

  // ====== Auto-assign playtime roles ======
  private async autoAssignPlaytimeRoles(): Promise<{ assigned: number; removed: number; errors: number }> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return { assigned: 0, removed: 0, errors: 0 };

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return { assigned: 0, removed: 0, errors: 0 };

    // Get playtime leaderboard (all players)
    const lb = getLeaderboardForAutoRole(1, 9999);
    if (!lb.rows.length) return { assigned: 0, removed: 0, errors: 0 };

    const hoursByUserId = new Map<string, number>();
    for (const row of lb.rows) {
      hoursByUserId.set(row.userId, row.secondsAllTime / 3600);
    }

    // Build game player name → userId + hours lookup (case-insensitive)
    const allGamePlayers = await storage.getPlayers();
    const hoursByNameLower = new Map<string, { uniqueUserId: string; hours: number }>();
    for (const gp of allGamePlayers) {
      const h = hoursByUserId.get(gp.uniqueUserId) ?? ((Number(gp.playTime) || 0));
      const nameLower = (gp.name || '').toLowerCase().trim();
      if (nameLower && h > 0) {
        // Keep the entry with the most hours if duplicate names
        const existing = hoursByNameLower.get(nameLower);
        if (!existing || h > existing.hours) {
          hoursByNameLower.set(nameLower, { uniqueUserId: gp.uniqueUserId, hours: h });
        }
      }
    }

    // Find playtime role objects in guild
    const roleMap = new Map<string, any>(); // role name → Role object
    for (const rDef of PLAYTIME_ROLES) {
      const role = guild.roles.cache.find((r: any) => r.name === rDef.name);
      if (role) roleMap.set(rDef.name, role);
    }

    if (roleMap.size === 0) return { assigned: 0, removed: 0, errors: 0 };

    // Build discord→game mapping: explicit links first, then auto-match by name
    const links = await storage.getPlayerLinks();
    const discordToGame = new Map<string, { uniqueUserId: string; hours: number }>();
    // 1) Explicit links (highest priority)
    for (const link of links) {
      const h = hoursByUserId.get(link.uniqueUserId) || 0;
      discordToGame.set(link.discordUserId, { uniqueUserId: link.uniqueUserId, hours: h });
    }
    // 2) Auto-match by Discord displayName/username ↔ game player name
    const linkedDiscordIds = new Set(links.map(l => l.discordUserId));
    try {
      const members = await guild.members.fetch();
      for (const [memberId, member] of members) {
        if (linkedDiscordIds.has(memberId)) continue; // already linked explicitly
        if (member.user.bot) continue;
        // Try matching displayName and username
        const candidates = [
          member.displayName.toLowerCase().trim(),
          member.user.username.toLowerCase().trim(),
          member.user.globalName?.toLowerCase().trim(),
        ].filter(Boolean) as string[];
        for (const candidate of candidates) {
          const match = hoursByNameLower.get(candidate);
          if (match && match.hours > 0) {
            discordToGame.set(memberId, match);
            break;
          }
        }
      }
    } catch (e) {
      // If members.fetch fails, continue with explicit links only
    }

    if (discordToGame.size === 0) return { assigned: 0, removed: 0, errors: 0 };

    let assigned = 0, removed = 0, errors = 0;

    for (const [discordUserId, gameData] of discordToGame) {
      try {
        const member = await guild.members.fetch(discordUserId).catch(() => null);
        if (!member) continue;

        const hours = gameData.hours;

        // Determine which role this player should have (highest tier reached)
        let targetRoleName: string | null = null;
        for (let i = PLAYTIME_ROLES.length - 1; i >= 0; i--) {
          if (hours >= PLAYTIME_ROLES[i].hours) {
            targetRoleName = PLAYTIME_ROLES[i].name;
            break;
          }
        }

        // Add target role if not already assigned
        if (targetRoleName && roleMap.has(targetRoleName)) {
          const targetRole = roleMap.get(targetRoleName);
          if (!member.roles.cache.has(targetRole.id)) {
            await member.roles.add(targetRole, `Playtime reward: ${hours.toFixed(0)}h`);
            assigned++;

            // --- PUBLIC RANK-UP EMBED ---
            try {
              const targetIdx = PLAYTIME_ROLES.findIndex(r => r.name === targetRoleName);
              const nextRole = targetIdx < PLAYTIME_ROLES.length - 1 ? PLAYTIME_ROLES[targetIdx + 1] : null;
              const currentRole = PLAYTIME_ROLES[targetIdx];

              const rankUpEmbed = new EmbedBuilder()
                .setColor(currentRole.color)
                .setTitle('🎉 Novi rang dostignut!')
                .setDescription(
                  `**${member.displayName}** je upravo dostigao rang **${targetRoleName}**!\n\n` +
                  `⏱️ Ukupno odigrano: **${Math.floor(hours)}h**\n` +
                  (nextRole
                    ? `📈 Sljedeći rang: **${nextRole.name}** za **${nextRole.hours}h**`
                    : `🏆 **Maksimalni rang dostignut!**`)
                )
                .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
                .setFooter({ text: 'Slavonska Ravnica • Playtime Rewards' })
                .setTimestamp();

              // Post to općenito (public chat)
              const publicCh = await getGuildChannel(guild, 'opcenito') as TextChannel | undefined;
              if (publicCh) await publicCh.send({ embeds: [rankUpEmbed] }).catch(() => null);

              // Log to mod-log
              const logCh = await getGuildChannel(guild, 'mod-log') as TextChannel | undefined;
              if (logCh) {
                const logEmbed = new EmbedBuilder()
                  .setColor(0x3498db)
                  .setTitle('📊 Playtime Rang Promjena')
                  .setDescription(`<@${member.id}> → **${targetRoleName}** (${Math.floor(hours)}h)`)
                  .setTimestamp();
                await logCh.send({ embeds: [logEmbed] }).catch(() => null);
              }
            } catch {}
          }
        }

        // Remove ALL playtime roles that aren't the correct tier (both above and below)
        for (const rDef of PLAYTIME_ROLES) {
          if (rDef.name === targetRoleName) continue; // keep correct tier
          const role = roleMap.get(rDef.name);
          if (role && member.roles.cache.has(role.id)) {
            await member.roles.remove(role, `Playtime role cleanup (${hours.toFixed(0)}h → ${targetRoleName || 'none'})`);
            removed++;
          }
        }
      } catch (e: any) {
        errors++;
      }
    }

    // NOTE: Do NOT strip playtime roles from unmatched members.
    // Players who haven't linked or whose Discord name doesn't match their game name
    // should keep their manually-assigned or previously-earned playtime roles.
    // Only matched players have their roles corrected above.

    if (assigned > 0 || removed > 0) {
      console.log(`[AUTO-ROLE] Assigned: ${assigned}, Removed: ${removed}, Errors: ${errors}`);
    }
    return { assigned, removed, errors };
  }

  // ====== Auto-assign farm roles based on player's farmId ======
  private async autoAssignFarmRoles(): Promise<{ assigned: number; removed: number; errors: number }> {
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return { assigned: 0, removed: 0, errors: 0 };

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return { assigned: 0, removed: 0, errors: 0 };

    // Get farms from DB
    const dbFarms = await storage.getFarms();
    if (!dbFarms.length) return { assigned: 0, removed: 0, errors: 0 };

    // Build farmId → role name map
    const farmRoleNameMap = new Map<string, string>();
    for (const farm of dbFarms) {
      const farmName = farm.name || `Farma ${farm.farmId}`;
      farmRoleNameMap.set(farm.farmId, `${FARM_ROLE_PREFIX}${farmName}`);
    }

    // Get all players to look up their current farmId
    const players = await storage.getPlayers();
    const playerFarmMap = new Map<string, string>(); // uniqueUserId → farmId
    const playerNameToUniqueId = new Map<string, string>(); // name (lower) → uniqueUserId
    for (const p of players) {
      if (p.farmId) playerFarmMap.set(p.uniqueUserId, p.farmId);
      const nameLower = (p.name || '').toLowerCase().trim();
      if (nameLower) playerNameToUniqueId.set(nameLower, p.uniqueUserId);
    }

    // Safety guard: if NO players have a farmId, the data is likely stale/corrupted.
    // Don't touch roles in that case — we'd strip everyone's farm role incorrectly.
    if (playerFarmMap.size === 0) {
      console.log('[FARM-ROLE] No players have farmId set — skipping role assignment to avoid stripping roles');
      return { assigned: 0, removed: 0, errors: 0 };
    }

    // Find all farm role objects in guild (exclude playtime roles and Ratar)
    const playtimeRoleNames = new Set(PLAYTIME_ROLES.map(r => r.name));
    const protectedRoleNames = new Set([...playtimeRoleNames, '🌾 Ratar', 'Ratar']);
    const allFarmRoles = guild.roles.cache.filter((r: any) =>
      r.name.startsWith(FARM_ROLE_PREFIX) && !protectedRoleNames.has(r.name)
    );

    // Build discord→game mapping: explicit links first, then auto-match by name
    const links = await storage.getPlayerLinks();
    const discordToGame = new Map<string, { uniqueUserId: string; defaultFarmId?: string | null }>();
    // 1) Explicit links (highest priority)
    for (const link of links) {
      discordToGame.set(link.discordUserId, { uniqueUserId: link.uniqueUserId, defaultFarmId: link.defaultFarmId });
    }
    // 2) Auto-match by Discord displayName/username ↔ game player name
    const linkedDiscordIds = new Set(links.map(l => l.discordUserId));
    try {
      const members = await guild.members.fetch();
      for (const [memberId, member] of members) {
        if (linkedDiscordIds.has(memberId)) continue;
        if (member.user.bot) continue;
        const candidates = [
          member.displayName.toLowerCase().trim(),
          member.user.username.toLowerCase().trim(),
          member.user.globalName?.toLowerCase().trim(),
        ].filter(Boolean) as string[];
        for (const candidate of candidates) {
          const uid = playerNameToUniqueId.get(candidate);
          if (uid) {
            discordToGame.set(memberId, { uniqueUserId: uid });
            break;
          }
        }
      }
    } catch (e) {
      // If members.fetch fails, continue with explicit links only
    }

    if (discordToGame.size === 0) return { assigned: 0, removed: 0, errors: 0 };

    let assigned = 0, removed = 0, errors = 0;

    for (const [discordUserId, gameData] of discordToGame) {
      try {
        const member = await guild.members.fetch(discordUserId).catch(() => null);
        if (!member) continue;

        // Determine which farm this player belongs to
        const gameFarmId = playerFarmMap.get(gameData.uniqueUserId) || null;
        const targetFarmId = gameFarmId || gameData.defaultFarmId || null;

        const targetRoleName = targetFarmId ? farmRoleNameMap.get(targetFarmId) : null;
        const targetRole = targetRoleName ? guild.roles.cache.find((r: any) => r.name === targetRoleName) : null;

        // Add the correct farm role
        if (targetRole && !member.roles.cache.has(targetRole.id)) {
          await member.roles.add(targetRole, `Farm auto-assign: ${targetFarmId}`);
          assigned++;

          // --- LOG FARM ROLE CHANGE ---
          try {
            const farmName = targetFarmId ? (dbFarms.find(f => f.farmId === targetFarmId)?.name || `Farma ${targetFarmId}`) : '?';
            const logCh = await getGuildChannel(guild, 'mod-log') as TextChannel | undefined;
            if (logCh) {
              const logEmbed = new EmbedBuilder()
                .setColor(0xe67e22)
                .setTitle('🌾 Farm Promjena')
                .setDescription(`<@${member.id}> je prešao na farmu **${farmName}**\nRole: ${targetRole}`)
                .setTimestamp();
              await logCh.send({ embeds: [logEmbed] }).catch(() => null);
            }
          } catch {}
        }

        // Remove incorrect farm roles — only if we have a confirmed target
        // (don't strip manually-assigned roles when game data is missing)
        if (targetRole) {
          for (const [, r] of allFarmRoles) {
            if (r.id === targetRole?.id) continue; // keep correct role
            if (member.roles.cache.has(r.id)) {
              await member.roles.remove(r, 'Farm role cleanup');
              removed++;

            // Log removal too
            try {
              const logCh = await getGuildChannel(guild, 'mod-log') as TextChannel | undefined;
              if (logCh) {
                const logEmbed = new EmbedBuilder()
                  .setColor(0x95a5a6)
                  .setTitle('🌾 Farm Rola Uklonjena')
                  .setDescription(`<@${member.id}> — uklonjena rola: ${r}`)
                  .setTimestamp();
                await logCh.send({ embeds: [logEmbed] }).catch(() => null);
              }
            } catch {}
          }
        }
        } // end if (targetRole)
      } catch (e: any) {
        errors++;
      }
    }

    if (assigned > 0 || removed > 0) {
      console.log(`[FARM-ROLE] Assigned: ${assigned}, Removed: ${removed}, Errors: ${errors}`);
    }
    return { assigned, removed, errors };
  }

  // ── Channel Manager API methods (for dashboard) ──

  public async getChannelConfig() {
    return readChannelConfig();
  }

  public async saveChannelConfig(config: ChannelConfig) {
    await writeChannelConfig(config);
    return { success: true };
  }

  public getDefaultChannelConfig(): ChannelConfig {
    return {
      categories: CATEGORIES.map(c => ({
        name: c.name,
        channels: c.channels.map(ch => {
          const def: any = { name: ch.name, type: ch.type || 'text' };
          if (ch.readOnly) def.readOnly = true;
          if (ch.staffOnly) def.staffOnly = true;
          if (ch.playerOnly) def.playerOnly = true;
          if (ch.freeWrite) def.freeWrite = true;
          if (ch.autoEmbed) def.autoEmbed = ch.autoEmbed;
          return def;
        }),
      })),
      farmChannels: FARM_CATEGORY_CHANNELS.map(ch => {
        const def: any = { name: ch.name, type: ch.type || 'text' };
        if (ch.readOnly) def.readOnly = true;
        if (ch.farmOnly) def.farmOnly = true;
        return def;
      }),
    };
  }

  /** Build channel config from actual Discord guild channels */
  public buildConfigFromGuild(guildId: string): ChannelConfig {
    if (!this.isConnected) return { categories: [], farmChannels: [] };
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return { categories: [], farmChannels: [] };

    const categories: CategoryDef_Saved[] = [];
    // Get all category channels sorted by position
    const discordCategories = guild.channels.cache
      .filter((c: any) => c.type === 4)
      .sort((a: any, b: any) => (a.rawPosition || 0) - (b.rawPosition || 0));

    for (const [, cat] of discordCategories) {
      const children = guild.channels.cache
        .filter((c: any) => c.parentId === cat.id && [0, 2, 5, 15].includes(c.type))
        .sort((a: any, b: any) => (a.rawPosition || 0) - (b.rawPosition || 0));

      const channels: ChannelDef_Saved[] = [];
      for (const [, ch] of children) {
        const chType = (ch as any).type === 2 ? 'voice' : (ch as any).type === 15 ? 'forum' : 'text';
        const def: ChannelDef_Saved = { name: ch.name, type: chType as any };
        // Detect permissions
        const everyoneOw = (ch as any).permissionOverwrites?.cache?.get(guild.id);
        if (everyoneOw) {
          const denyBits = everyoneOw.deny?.bitfield || 0n;
          const viewDenied = (denyBits & 1024n) !== 0n; // ViewChannel
          const sendDenied = (denyBits & 2048n) !== 0n; // SendMessages
          if (viewDenied) {
            // Check if staff roles can view
            const hasStaff = (ch as any).permissionOverwrites?.cache?.some((ow: any) => {
              const role = guild.roles.cache.get(ow.id);
              return role && ['Upravitelj', 'Admin', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => role.name.includes(n)) && (ow.allow?.bitfield & 1024n) !== 0n;
            });
            const hasPlayer = (ch as any).permissionOverwrites?.cache?.some((ow: any) => {
              const role = guild.roles.cache.get(ow.id);
              return role && (role.name === 'Player' || role.name === 'Igrač' || role.name === 'Ratar' || role.name === '🌾 Ratar') && (ow.allow?.bitfield & 1024n) !== 0n;
            });
            if (hasStaff && !hasPlayer) {
              def.staffOnly = true;
            } else if (hasPlayer) {
              def.playerOnly = true;
              if (sendDenied) def.readOnly = true;
            }
          } else if (sendDenied) {
            def.readOnly = true;
          }
        }
        channels.push(def);
      }
      categories.push({ name: cat.name, channels });
    }

    // Also include uncategorized channels
    const uncategorized = guild.channels.cache
      .filter((c: any) => !c.parentId && [0, 2, 15].includes(c.type))
      .sort((a: any, b: any) => (a.rawPosition || 0) - (b.rawPosition || 0));
    if (uncategorized.size > 0) {
      const channels: ChannelDef_Saved[] = [];
      for (const [, ch] of uncategorized) {
        const chType = (ch as any).type === 2 ? 'voice' : (ch as any).type === 15 ? 'forum' : 'text';
        channels.push({ name: ch.name, type: chType as any });
      }
      categories.unshift({ name: '── Bez kategorije ──', channels });
    }

    return { categories, farmChannels: [] };
  }

  /** Auto-assign guild channel keys by matching channel names */
  public async autoAssignGuildChannels(guildId: string): Promise<{ assigned: number; keys: Record<string, string> }> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');

    const settings = await readGuildSettings();
    if (!settings[guildId]) settings[guildId] = {};

    const keyNameMap: Record<string, string[]> = {
      'mod-log':       ['mod-log', 'ᴍᴏᴅ-ʟᴏɢ', 'mod-ʟᴏɢ'],
      'welcome':       ['dobrodošlica', 'ᴅᴏʙʀᴏᴅᴏšʟ', 'welcome', 'dobrodoslica'],
      'farm-chat':     ['farm-chat', 'ꜰᴀʀᴍ-ᴄʜᴀᴛ'],
      'console':       ['konzola', 'ᴋᴏɴᴢᴏʟᴀ', 'console'],
      'staff-chat':    ['staff-chat', 'ꜱᴛᴀꜰꜰ-ᴄʜᴀᴛ', 'staff-ᴄʜᴀᴛ'],
      'bot-dashboard': ['bot-dashboard', 'ʙᴏᴛ-ᴅᴀꜱʜʙᴏᴀʀᴅ', 'dashboard'],
      'log':           ['event-log', 'server-log', 'log'],
      'log-tracking':  ['tracking', 'tracking-log'],
      'tickets':       ['ticket', 'ᴛɪᴄᴋᴇᴛ'],
      'new-farmer':    ['novi-ratar', 'new-farmer', 'ɴᴏᴠɪ'],
    };

    let assigned = 0;
    const result: Record<string, string> = {};

    for (const [key, patterns] of Object.entries(keyNameMap)) {
      // Skip if already assigned and channel exists
      if (settings[guildId][key as GuildChannelKey]) {
        const existing = guild.channels.cache.get(settings[guildId][key as GuildChannelKey]!);
        if (existing) {
          result[key] = existing.id;
          continue;
        }
      }
      // Find by name pattern
      const channel = guild.channels.cache.find((c: any) =>
        c.type === 0 && patterns.some(p => c.name.toLowerCase().includes(p.toLowerCase()))
      );
      if (channel) {
        settings[guildId][key as GuildChannelKey] = channel.id;
        result[key] = channel.id;
        assigned++;
      }
    }

    await writeGuildSettings(settings);
    invalidateGuildSettingsCache();
    return { assigned, keys: result };
  }

  /** List all channels in a guild with permission details */
  public getGuildChannelList(guildId: string) {
    if (!this.isConnected) return [];
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];

    return guild.channels.cache
      .filter((c: any) => [0, 2, 4, 5, 15].includes(c.type))
      .sort((a: any, b: any) => (a.rawPosition || 0) - (b.rawPosition || 0))
      .map((c: any) => {
        // Extract permission overwrites
        const overwrites = c.permissionOverwrites?.cache?.map((ow: any) => ({
          id: ow.id,
          type: ow.type, // 0=role, 1=member
          allow: ow.allow?.toArray() || [],
          deny: ow.deny?.toArray() || [],
          name: ow.type === 0
            ? guild.roles.cache.get(ow.id)?.name || ow.id
            : guild.members.cache.get(ow.id)?.displayName || ow.id,
        })) || [];

        return {
          id: c.id,
          name: c.name,
          type: c.type, // 0=text, 2=voice, 4=category, 5=announcement, 15=forum
          parentId: c.parentId || null,
          parentName: c.parent?.name || null,
          position: c.rawPosition || 0,
          overwrites,
        };
      });
  }

  /** Get all Discord members with the Ratar role */
  public async getRatarMembers(): Promise<{ id: string; username: string; displayName: string; avatar: string | null; joinedAt: string | null }[]> {
    if (!this.isConnected) return [];
    const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
    if (!guildId) return [];
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    const ratarRole = guild.roles.cache.find((r: any) => r.name === 'Ratar' || r.name === '🌾 Ratar');
    if (!ratarRole) return [];
    await guild.members.fetch();
    return ratarRole.members.map((m: any) => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName || m.user.username,
      avatar: m.user.displayAvatarURL({ size: 64 }) || null,
      joinedAt: m.joinedAt?.toISOString() || null,
    }));
  }

  /** Post or re-post an autoEmbed to a channel */
  public async postAutoEmbed(guildId: string, channelId: string, autoEmbed: NonNullable<ChannelDef['autoEmbed']>) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !('send' in channel)) throw new Error('Channel not found or not text-based');

    const url = autoEmbed.buttonUrl || resolveAutoEmbedUrl(autoEmbed.buttonUrlEnv || '');
    const embed = new EmbedBuilder()
      .setTitle(autoEmbed.title)
      .setDescription(autoEmbed.description)
      .setColor(autoEmbed.color)
      .setTimestamp();

    if (autoEmbed.thumbnail) {
      const thumbUrl = process.env[autoEmbed.thumbnail];
      if (thumbUrl) embed.setThumbnail(thumbUrl);
    }

    const sendOpts: any = { embeds: [embed] };
    if (url) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel(autoEmbed.buttonLabel)
          .setStyle(ButtonStyle.Link)
          .setURL(url)
          .setEmoji(autoEmbed.buttonEmoji || '🔗')
      );
      sendOpts.components = [row];
    }

    await (channel as any).send(sendOpts);
    return { posted: true, channelId, hasButton: !!url };
  }

  /** Deploy a single channel to a guild */
  public async deployChannel(guildId: string, categoryName: string, channel: ChannelDef) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');

    // Find or create category
    let category = guild.channels.cache.find((c: any) => c.type === 4 && c.name === categoryName);
    if (!category) {
      category = await guild.channels.create({ name: categoryName, type: 4, reason: 'Dashboard deploy' });
    }

    const chType = channel.type === 'voice' ? 2 : channel.type === 'forum' ? 15 : 0;

    // Build permission overwrites
    const permOverwrites: any[] = [];
    const adminRole = guild.roles.cache.find((r: any) => r.name.includes('Upravitelj') || r.name.includes('Admin'));
    const playerRole = guild.roles.cache.find((r: any) => r.name === 'Player' || r.name === 'Igrač');
    const staffRoles = guild.roles.cache.filter((r: any) =>
      ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
    );

    if (channel.staffOnly) {
      permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
      staffRoles.forEach((r: any) => {
        permOverwrites.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      });
    } else if (channel.playerOnly) {
      permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
      if (playerRole) {
        const allow = [PermissionFlagsBits.ViewChannel];
        if (!channel.readOnly) allow.push(PermissionFlagsBits.SendMessages);
        const perms: any = { id: playerRole.id, allow };
        if (channel.readOnly) perms.deny = [PermissionFlagsBits.SendMessages];
        permOverwrites.push(perms);
      }
    } else if (channel.readOnly) {
      permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.SendMessages] });
    } else if (channel.freeWrite && channel.type === 'forum') {
      permOverwrites.push({ id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.ReadMessageHistory] });
    }

    // Check if channel already exists
    let existing = guild.channels.cache.find((c: any) =>
      c.type === chType && c.name === channel.name && c.parentId === (category as any).id
    );

    if (existing) {
      return { created: false, channelId: existing.id, name: channel.name };
    }

    const created = await guild.channels.create({
      name: channel.name,
      type: chType,
      parent: (category as any).id,
      permissionOverwrites: permOverwrites.filter((p: any) => p.id),
      reason: 'Dashboard Channel Manager deploy',
    });

    // Auto-post embed if configured
    if (channel.autoEmbed && chType === 0) {
      try {
        await this.postAutoEmbed(guildId, created.id, channel.autoEmbed);
      } catch (e: any) {
        console.log(`[DEPLOY] AutoEmbed error for ${channel.name}: ${e.message}`);
      }
    }

    return { created: true, channelId: created.id, name: channel.name };
  }

  /** Deploy all channels in a category to a guild */
  public async deployCategory(guildId: string, categoryIndex: number) {
    const config = await readChannelConfig();
    if (categoryIndex < 0 || categoryIndex >= config.categories.length) {
      throw new Error('Invalid category index');
    }
    const cat = config.categories[categoryIndex];
    const results = [];
    for (const ch of cat.channels) {
      const result = await this.deployChannel(guildId, cat.name, ch);
      results.push(result);
    }
    return { category: cat.name, results };
  }

  /** Create a Discord category channel (empty) */
  public async createDiscordCategory(guildId: string, categoryName: string) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    let existing = guild.channels.cache.find((c: any) => c.type === 4 && c.name === categoryName);
    if (existing) {
      return { created: false, categoryId: existing.id, name: categoryName };
    }
    const created = await guild.channels.create({ name: categoryName, type: 4, reason: 'Dashboard Category Manager' });
    return { created: true, categoryId: created.id, name: categoryName };
  }

  /** Convert text to small caps */
  public static toSmallCaps(text: string): string {
    return toSmallCaps(text);
  }

  /** Get available font styles for channel names */
  public static getFontStyles() {
    return {
      smallCaps: { label: 'ꜱᴍᴀʟʟ ᴄᴀᴘꜱ', example: toSmallCaps('primjer') },
      bold: { label: '𝗕𝗼𝗹𝗱', example: toBold('Primjer') },
      boldItalic: { label: '𝘽𝙤𝙡𝙙 𝙄𝙩𝙖𝙡𝙞𝙘', example: toBoldItalic('Primjer') },
      normal: { label: 'Normal', example: 'Primjer' },
    };
  }

  /** Edit an existing Discord channel (name, topic, permissions, parent) */
  public async editExistingChannel(guildId: string, channelId: string, updates: {
    name?: string;
    topic?: string;
    parentId?: string | null;
    permFlags?: { readOnly?: boolean; staffOnly?: boolean; playerOnly?: boolean; freeWrite?: boolean };
  }) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const channel = guild.channels.cache.get(channelId) as any;
    if (!channel) throw new Error('Channel not found');

    const editData: any = {};
    if (updates.name !== undefined) editData.name = updates.name;
    if (updates.topic !== undefined && 'setTopic' in channel) editData.topic = updates.topic;
    if (updates.parentId !== undefined) editData.parent = updates.parentId;

    // Apply permission changes
    if (updates.permFlags) {
      const pf = updates.permFlags;
      const permOverwrites: any[] = [];
      const staffRoles = guild.roles.cache.filter((r: any) =>
        ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
      );
      const playerRole = guild.roles.cache.find((r: any) => r.name === 'Player' || r.name === 'Igrač');

      if (pf.staffOnly) {
        permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
        staffRoles.forEach((r: any) => {
          permOverwrites.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        });
      } else if (pf.playerOnly) {
        permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
        if (playerRole) {
          const allow: any[] = [PermissionFlagsBits.ViewChannel];
          if (!pf.readOnly) allow.push(PermissionFlagsBits.SendMessages);
          permOverwrites.push({ id: playerRole.id, allow, ...(pf.readOnly ? { deny: [PermissionFlagsBits.SendMessages] } : {}) });
        }
      } else if (pf.readOnly) {
        permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.SendMessages] });
      }
      // If no flags set, clear all overwrites (freeWrite = open)
      editData.permissionOverwrites = permOverwrites.filter((p: any) => p.id);
    }

    editData.reason = 'Dashboard Channel Manager edit';
    await channel.edit(editData);
    return { success: true, channelId, name: updates.name || channel.name };
  }

  /** Create a new Discord channel with name, type, parent, and permission flags */
  public async createNewChannel(guildId: string, opts: {
    name: string;
    type: number;
    parentId: string | null;
    permFlags?: { readOnly?: boolean; staffOnly?: boolean; playerOnly?: boolean; freeWrite?: boolean };
  }) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');

    const createData: any = {
      name: opts.name,
      type: opts.type,
      reason: 'Dashboard Channel Manager create',
    };

    if (opts.parentId) {
      createData.parent = opts.parentId;
    }

    // Build permission overwrites
    if (opts.permFlags) {
      const pf = opts.permFlags;
      const permOverwrites: any[] = [];
      const staffRoles = guild.roles.cache.filter((r: any) =>
        ['Upravitelj', 'Nadzornik', 'Čuvar', 'Gazda', 'Suvlasnik'].some(n => r.name.includes(n))
      );
      const playerRole = guild.roles.cache.find((r: any) => r.name === 'Player' || r.name === 'Igrač');

      if (pf.staffOnly) {
        permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
        staffRoles.forEach((r: any) => {
          permOverwrites.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        });
      } else if (pf.playerOnly) {
        permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
        if (playerRole) {
          const allow: any[] = [PermissionFlagsBits.ViewChannel];
          if (!pf.readOnly) allow.push(PermissionFlagsBits.SendMessages);
          permOverwrites.push({ id: playerRole.id, allow, ...(pf.readOnly ? { deny: [PermissionFlagsBits.SendMessages] } : {}) });
        }
      } else if (pf.readOnly) {
        permOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.SendMessages] });
      }

      const validOverwrites = permOverwrites.filter((p: any) => p.id);
      if (validOverwrites.length > 0) {
        createData.permissionOverwrites = validOverwrites;
      }
    }

    const channel = await guild.channels.create(createData);
    return { success: true, channelId: channel.id, name: channel.name };
  }

  /** Delete an existing Discord channel */
  public async deleteExistingChannel(guildId: string, channelId: string) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const channel = guild.channels.cache.get(channelId);
    if (!channel) throw new Error('Channel not found');
    const name = channel.name;
    await channel.delete('Dashboard Channel Manager delete');
    return { success: true, name };
  }

  /** Move a channel's position within its category */
  public async moveExistingChannel(guildId: string, channelId: string, newPosition: number) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const channel = guild.channels.cache.get(channelId) as any;
    if (!channel) throw new Error('Channel not found');
    await channel.setPosition(newPosition);
    return { success: true };
  }

  /** List messages with embeds in a channel (bot messages only, last 50) */
  public async listChannelEmbeds(guildId: string, channelId: string) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const channel = guild.channels.cache.get(channelId) as any;
    if (!channel || !('messages' in channel)) throw new Error('Channel not found or not text-based');

    const messages = await channel.messages.fetch({ limit: 50 });
    const botId = this.client.user?.id;
    return messages
      .filter((m: any) => m.author.id === botId && (m.embeds.length > 0 || m.components.length > 0))
      .sort((a: any, b: any) => a.createdTimestamp - b.createdTimestamp)
      .map((m: any) => ({
        id: m.id,
        embeds: m.embeds.map((e: any) => e.toJSON()),
        components: m.components.map((row: any) => ({
          type: row.type,
          components: row.components.map((c: any) => {
            const j: any = { type: c.type ?? 2, style: c.style, label: c.label ?? undefined };
            if (c.url) j.url = c.url;
            if (c.emoji) j.emoji = { name: c.emoji.name };
            if (c.customId) j.customId = c.customId;
            return j;
          }),
        })),
      }));
  }

  /** Edit a bot message's embeds and components */
  public async editChannelMessage(guildId: string, channelId: string, messageId: string, data: { embeds?: any[]; components?: any[] }) {
    if (!this.isConnected) throw new Error('Bot not connected');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const channel = guild.channels.cache.get(channelId) as any;
    if (!channel || !('messages' in channel)) throw new Error('Channel not found or not text-based');

    const message = await channel.messages.fetch(messageId);
    if (!message) throw new Error('Message not found');
    if (message.author.id !== this.client.user?.id) throw new Error('Can only edit bot messages');

    const editData: any = {};
    if (data.embeds) editData.embeds = data.embeds;
    if (data.components) editData.components = data.components;

    await message.edit(editData);
    return { success: true, messageId };
  }

  // ── AI Assistant ──
  private aiConversations = new Map<string, { role: string; text: string }[]>();

  private getGeminiModel() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const genAI = new GoogleGenerativeAI(apiKey);
    return genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  /** Exposed for routes.ts dashboard AI chat */
  getGeminiModelPublic() {
    return this.getGeminiModel();
  }

  private getAiSystemPrompt(): string {
    return [
      'Ti si FarmBuddy AI asistent za Discord server "Slavonska Ravnica" — Farming Simulator 25 zajednica.',
      'Odgovaraj na hrvatskom jeziku, kratko i korisno.',
      '',
      'Što možeš:',
      '• Odgovarati na pitanja o serveru, pravilima, modovima, launcheru',
      '• Kreirati Discord embede — kad korisnik traži embed, odgovori SAMO JSON blok u formatu:',
      '  ```embed',
      '  {"title":"...","description":"...","color":"#hex","fields":[{"name":"...","value":"...","inline":true}]}',
      '  ```',
      '  Boje: hex string (#FF5733). Polja su opcionalna.',
      '• Pomagati s općenitim FS25 pitanjima',
      '',
      'Što NE možeš i kad trebaš eskalirati:',
      '• Mijenjati kod bota, dodavati komande, mijenjati postavke',
      '• Brisati kanale, role, podatke',
      '• Bilo što što zahtijeva promjenu koda ili konfiguracije',
      '',
      'Kad korisnik traži nešto što zahtijeva izmjenu koda/konfiguracije, odgovori normalno ali OBAVEZNO na kraju dodaj poseban marker:',
      '```code_request',
      '{"summary":"kratki opis što korisnik želi","details":"detaljniji opis zahtjeva"}',
      '```',
      'Ovaj marker će automatski obavijestiti vlasnika bota.',
      '',
      'Informacije o serveru:',
      '• Launcher: preuzmi na https://github.com/7oncha/SRManager-Installer/releases/latest/download/SRManager.exe',
      '• Modovi se automatski ažuriraju kroz launcher',
      '• Problemi s launcherom: pokreni kao Administrator, provjeri antivirus',
      '• Za whitelist trebaš Player rolu',
      '• Bot koristi FS25 Companion mod za sync podataka sa servera',
    ].join('\n');
  }

  private async handleAiCommand(interaction: any) {
    const model = this.getGeminiModel();
    if (!model) {
      await interaction.reply({ content: '❌ AI asistent nije konfiguriran. Postavi `GEMINI_API_KEY` env varijablu.', ephemeral: true });
      return;
    }

    const question = String(interaction.options.getString('pitanje') || '').trim();
    if (!question) {
      await interaction.reply({ content: '❌ Postavi pitanje.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      // Per-user conversation memory (last 10 messages, expires after 30 min)
      const memKey = `${interaction.user.id}`;
      let history = this.aiConversations.get(memKey) || [];

      // Build conversation for Gemini
      const contents = [
        { role: 'user', parts: [{ text: this.getAiSystemPrompt() + '\n\nOdgovori na pitanje korisnika.' }] },
        { role: 'model', parts: [{ text: 'Razumijem. Ja sam FarmBuddy AI asistent. Spreman sam pomoći.' }] },
        ...history.map(h => ({
          role: h.role === 'user' ? 'user' as const : 'model' as const,
          parts: [{ text: h.text }],
        })),
        { role: 'user' as const, parts: [{ text: question }] },
      ];

      const result = await model.generateContent({ contents });
      const response = result.response;
      const aiText = response.text();

      if (!aiText) {
        await interaction.editReply({ content: '❌ AI nije vratio odgovor. Pokušaj ponovo.' });
        return;
      }

      // Update conversation memory (keep last 10 exchanges)
      history.push({ role: 'user', text: question });
      history.push({ role: 'model', text: aiText });
      if (history.length > 20) history = history.slice(-20);
      this.aiConversations.set(memKey, history);
      // Auto-expire after 30 min
      setTimeout(() => {
        const current = this.aiConversations.get(memKey);
        if (current === history) this.aiConversations.delete(memKey);
      }, 30 * 60 * 1000);

      // Check for embed JSON in response
      const embedMatch = aiText.match(/```embed\s*\n([\s\S]*?)```/);
      if (embedMatch) {
        try {
          const embedData = JSON.parse(embedMatch[1].trim());
          const embed = new EmbedBuilder();
          if (embedData.title) embed.setTitle(embedData.title);
          if (embedData.description) embed.setDescription(embedData.description);
          if (embedData.color) {
            const hex = String(embedData.color).replace('#', '');
            embed.setColor(parseInt(hex, 16));
          }
          if (Array.isArray(embedData.fields)) {
            embed.addFields(embedData.fields.map((f: any) => ({
              name: String(f.name || ''),
              value: String(f.value || ''),
              inline: !!f.inline,
            })));
          }
          embed.setTimestamp();
          embed.setFooter({ text: `Kreirao AI na zahtjev ${interaction.user.tag}` });

          // Send the embed in the channel (not ephemeral)
          const textWithoutEmbed = aiText.replace(/```embed\s*\n[\s\S]*?```/, '').trim();
          const replyContent: any = { embeds: [embed] };
          if (textWithoutEmbed) {
            replyContent.content = textWithoutEmbed.slice(0, 2000);
          }
          await interaction.editReply(replyContent);
        } catch {
          // JSON parse failed — just send raw text
          await interaction.editReply({ content: aiText.slice(0, 2000) });
        }
      } else {
        // Plain text response
        await interaction.editReply({ content: aiText.slice(0, 2000) });
      }

      // Check for code_request marker
      const codeReqMatch = aiText.match(/```code_request\s*\n([\s\S]*?)```/);
      if (codeReqMatch) {
        try {
          const reqData = JSON.parse(codeReqMatch[1].trim());
          await this.handleAiCodeRequest({
            summary: String(reqData.summary || 'AI zahtjev'),
            details: String(reqData.details || ''),
            userId: interaction.user.id,
            userName: interaction.user.tag,
            channelId: interaction.channelId,
            question,
          });
        } catch {}
      }
    } catch (e: any) {
      console.error('[AI] Error:', e?.message || e);
      console.error('[AI] Full error:', JSON.stringify({ status: e?.status, code: e?.code, details: e?.errorDetails, message: e?.message }, null, 2));
      const msg = e?.message?.includes('API_KEY') ? 'Neispravan API ključ.' :
                  e?.message?.includes('quota') || e?.message?.includes('429') || e?.status === 429 ? 'AI kvota iskorištena, pokušaj kasnije.' :
                  `Greška pri komunikaciji s AI-em: ${(e?.message || '').slice(0, 100)}`;
      await interaction.editReply({ content: `❌ ${msg}` }).catch(() => {});
    }
  }

  private async handleAiCodeRequest(data: {
    summary: string;
    details: string;
    userId: string;
    userName: string;
    channelId: string;
    question: string;
  }) {
    // Store in MongoDB
    const saved = await storage.createAiRequest({
      summary: data.summary,
      details: data.details,
      userId: data.userId,
      userName: data.userName,
      channelId: data.channelId,
      conversationSnippet: data.question,
    });

    // DM every owner
    const ownerIds = String(process.env.OWNER_DISCORD_ID || process.env.DISCORD_OWNER_ID || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🤖 AI — zahtjev za promjenu koda')
      .setDescription(data.summary)
      .addFields(
        { name: 'Detalji', value: (data.details || 'Nema dodatnih detalja').slice(0, 1024) },
        { name: 'Korisnik', value: `${data.userName} (<@${data.userId}>)`, inline: true },
        { name: 'Kanal', value: `<#${data.channelId}>`, inline: true },
        { name: 'Pitanje', value: data.question.slice(0, 1024) },
      )
      .setColor(0xF59E0B)
      .setTimestamp()
      .setFooter({ text: `ID: ${saved._id}` });

    for (const ownerId of ownerIds) {
      try {
        const owner = await this.client.users.fetch(ownerId);
        await owner.send({ embeds: [embed] });
      } catch {}
    }

    // Also post to log channel
    for (const guild of this.client.guilds.cache.values()) {
      try {
        const gs = await readGuildSettings();
        const logChId = gs[guild.id]?.['log'];
        const channel = logChId
          ? guild.channels.cache.get(logChId)
          : guild.channels.cache.find(c => c.name.includes('bot-log') || c.name.includes('event-log'));
        if (channel && 'send' in channel) {
          await (channel as any).send({ embeds: [embed] });
        }
      } catch {}
    }
  }

  /** Get all pending AI code requests (for dashboard/Copilot) */
  public async getAiRequests() {
    return storage.getAiRequests();
  }

  /** Update an AI request status */
  public async updateAiRequest(id: string, updates: { status?: string; note?: string }) {
    return storage.updateAiRequest(id, updates);
  }

  // ═══════════════════════════════════════════════
  // ██  MUSIC SYSTEM — /play, /skip, /stop, etc. ██
  // ═══════════════════════════════════════════════

  private async handlePlayCommand(interaction: any) {
    if (!this.musicPlayer) {
      await interaction.reply({ content: '❌ Glazbeni sustav nije dostupan. Pokušaj ponovno kasnije.', ephemeral: true });
      return;
    }
    const query = interaction.options.getString('query', true);
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: '❌ Moraš biti u voice kanalu da pustiš glazbu!', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      this.musicTextChannel.set(interaction.guild.id, interaction.channel.id);

      // Stop any active radio before starting music
      this.stopRadio(interaction.guild.id);

      const result = await this.musicPlayer.play(voiceChannel, query, {
        requestedBy: interaction.user,
        nodeOptions: {
          metadata: { channel: interaction.channel },
          selfDeaf: false,
          leaveOnEnd: false,
          leaveOnEmpty: true,
          leaveOnEmptyCooldown: 60_000,
        },
      });

      // If autoplay mode is on, enable autoplay
      if (this.autoplayMode.get(interaction.guild.id)) {
        const queue = this.musicPlayer.queues.get(interaction.guild.id);
        if (queue) queue.setRepeatMode(QueueRepeatMode.AUTOPLAY);
      }

      const track = result.track;
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setDescription(`✅ **[${track.title}](${track.url})** dodana u red!`)
        .addFields(
          { name: '👤 Autor', value: track.author || 'Nepoznato', inline: true },
          { name: '⏱️ Trajanje', value: track.duration || '?', inline: true },
        );
      if (track.thumbnail) embed.setThumbnail(track.thumbnail);

      await interaction.editReply({ embeds: [embed] });
    } catch (e: any) {
      console.error('[MUSIC] Play error:', e?.message || e);
      await interaction.editReply({ content: `❌ Nije moguće pustiti: ${(e?.message || 'Nepoznata greška').slice(0, 200)}` }).catch(() => {});
    }
  }

  private async handleSkipCommand(interaction: any) {
    if (!this.musicPlayer) { await interaction.reply({ content: '❌ Glazbeni sustav nije dostupan.', ephemeral: true }); return; }
    const guildId = interaction.guild?.id;
    if (!guildId) return;
    const queue = this.musicPlayer.queues.get(guildId);
    if (!queue || !queue.isPlaying()) {
      await interaction.reply({ content: '❌ Ništa ne svira trenutno.', ephemeral: true });
      return;
    }
    const current = queue.currentTrack;
    queue.node.skip();
    await interaction.reply({ content: `⏭️ Preskočena: **${current?.title || 'Nepoznato'}**` });
  }

  private async handleStopCommand(interaction: any) {
    const guildId = interaction.guild?.id;
    if (!guildId) return;

    // Stop music queue if available
    if (this.musicPlayer) {
      const queue = this.musicPlayer.queues.get(guildId);
      if (queue) {
        this.autoplayMode.delete(guildId);
        queue.delete();
      }
    }

    // Always try to stop radio too
    this.stopRadio(guildId);
    await interaction.reply({ content: '⏹️ Reprodukcija zaustavljena i red očišćen.' });
  }

  private async handlePauseCommand(interaction: any) {
    if (!this.musicPlayer) { await interaction.reply({ content: '❌ Glazbeni sustav nije dostupan.', ephemeral: true }); return; }
    const guildId = interaction.guild?.id;
    if (!guildId) return;
    const queue = this.musicPlayer.queues.get(guildId);
    if (!queue || !queue.isPlaying()) {
      await interaction.reply({ content: '❌ Ništa ne svira trenutno.', ephemeral: true });
      return;
    }
    queue.node.setPaused(!queue.node.isPaused());
    const state = queue.node.isPaused() ? '⏸️ Pauzirano' : '▶️ Nastavljeno';
    await interaction.reply({ content: state });
  }

  private async handleQueueCommand(interaction: any) {
    if (!this.musicPlayer) { await interaction.reply({ content: '❌ Glazbeni sustav nije dostupan.', ephemeral: true }); return; }
    const guildId = interaction.guild?.id;
    if (!guildId) return;
    const queue = this.musicPlayer.queues.get(guildId);

    if (!queue || (!queue.currentTrack && queue.isEmpty())) {
      await interaction.reply({ content: '📜 Red je prazan. Koristi `/play` za dodavanje pjesama.', ephemeral: true });
      return;
    }

    const current = queue.currentTrack;
    const tracks = queue.tracks.toArray().slice(0, 15);
    let desc = '';

    if (current) {
      desc += `🎵 **Sada svira:** [${current.title}](${current.url}) (${current.duration})\n`;
      desc += `👤 ${current.author} — Zatražio/la: ${(current.requestedBy as any)?.username ?? '?'}\n\n`;
    }

    if (tracks.length > 0) {
      desc += '**Red čekanja:**\n';
      desc += tracks.map((t: any, i: number) => `**${i + 1}.** [${t.title}](${t.url}) (${t.duration}) — *${t.author}*`).join('\n');
      if (queue.tracks.size > 15) desc += `\n\n... i još **${queue.tracks.size - 15}** pjesama`;
    } else {
      desc += '*Nema sljedećih pjesama u redu.*';
    }

    if (this.autoplayMode.get(guildId)) {
      desc += '\n\n🔁 **Autoplay:** Uključen — automatski će svirati slične pjesme';
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📜 Red čekanja')
      .setDescription(desc)
      .setFooter({ text: `Ukupno u redu: ${queue.tracks.size} pjesama` });

    await interaction.reply({ embeds: [embed] });
  }

  private async handleAutoplayCommand(interaction: any) {
    if (!this.musicPlayer) { await interaction.reply({ content: '❌ Glazbeni sustav nije dostupan.', ephemeral: true }); return; }
    const guildId = interaction.guild?.id;
    if (!guildId) return;

    const current = this.autoplayMode.get(guildId) ?? false;
    const newState = !current;
    this.autoplayMode.set(guildId, newState);

    const queue = this.musicPlayer.queues.get(guildId);
    if (queue) {
      queue.setRepeatMode(newState ? QueueRepeatMode.AUTOPLAY : QueueRepeatMode.OFF);
    }

    if (newState) {
      await interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0x1db954)
          .setTitle('🔁 Autoplay — UKLJUČEN')
          .setDescription('Bot će automatski svirati slične pjesme kad red bude prazan.\nKoristi `/autoplay` ponovo za isključivanje.')
      ] });
    } else {
      await interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0xed4245)
          .setTitle('🔁 Autoplay — ISKLJUČEN')
          .setDescription('Kad red bude prazan, reprodukcija će se zaustaviti.')
      ] });
    }
  }

  private static RADIO_STATIONS: Record<string, { name: string; url: string }> = {
    otvoreni: { name: 'Radio Otvoreni', url: 'https://stream.otvoreni.hr/otvoreni' },
    narodni: { name: 'Narodni Radio', url: 'https://stream.narodni.hr/narodni' },
    yammat: { name: 'Yammat FM', url: 'https://stream.yammat.fm/yammat' },
    enter: { name: 'Enter Zagreb', url: 'https://stream.enterzagreb.hr/enter' },
    gold: { name: 'Gold FM', url: 'https://gold.stream.laut.fm/gold' },
    antena: { name: 'Antena Zagreb', url: 'https://stream.antenazagreb.hr/antena' },
    extra: { name: 'Extra FM', url: 'https://stream.extrafm.hr/extra' },
    bravo: { name: 'Radio Bravo', url: 'https://stream.radiobravo.hr/bravo' },
  };

  private stopRadio(guildId: string) {
    const radio = this.radioPlayers.get(guildId);
    if (radio) {
      try { radio.player.stop(true); } catch {}
      try { radio.process?.kill('SIGTERM'); } catch {}
      try {
        const conn = getVoiceConnection(guildId);
        if (conn) conn.destroy();
      } catch {}
      this.radioPlayers.delete(guildId);
      console.log(`[RADIO] Stopped radio for guild ${guildId}`);
    }
  }

  private async handleRadioCommand(interaction: any) {
    const stationKey = interaction.options.getString('stanica', true);
    const station = DiscordBot.RADIO_STATIONS[stationKey];
    if (!station) {
      await interaction.reply({ content: '❌ Nepoznata stanica.', ephemeral: true });
      return;
    }

    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: '❌ Moraš biti u voice kanalu!', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      this.musicTextChannel.set(interaction.guild.id, interaction.channel.id);

      // Stop current music queue if any
      if (this.musicPlayer) {
        const existingQueue = this.musicPlayer.queues.get(interaction.guild.id);
        if (existingQueue) {
          this.autoplayMode.delete(interaction.guild.id);
          existingQueue.delete();
        }
      }

      // Stop any existing radio
      this.stopRadio(interaction.guild.id);

      // Join voice channel using @discordjs/voice directly
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      // Wait for connection to be ready
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      } catch {
        connection.destroy();
        await interaction.editReply({ content: '❌ Nije moguće spojiti se na voice kanal (timeout).' });
        return;
      }

      // Handle connection disconnect — try to reconnect
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          // Seems to be reconnecting
        } catch {
          // Not reconnecting — stop radio
          this.stopRadio(interaction.guild.id);
        }
      });

      // Use ffmpeg to transcode the Icecast/Shoutcast stream to raw PCM
      const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
      const ffmpegProcess = spawn(ffmpegPath, [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', station.url,
        '-vn',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      // Wait a moment for ffmpeg to start producing data
      await new Promise<void>((resolve, reject) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) { resolved = true; reject(new Error('ffmpeg stream timeout')); }
        }, 10_000);

        ffmpegProcess.stdout!.once('data', () => {
          if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
        });

        ffmpegProcess.on('error', (err) => {
          if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
        });

        ffmpegProcess.on('exit', (code) => {
          if (!resolved && code !== 0) { resolved = true; clearTimeout(timeout); reject(new Error(`ffmpeg exited with code ${code}`)); }
        });
      });

      ffmpegProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes('frame=') && !msg.includes('size=')) {
          console.log(`[RADIO] ffmpeg: ${msg.slice(0, 200)}`);
        }
      });

      ffmpegProcess.on('error', (err: Error) => {
        console.error('[RADIO] ffmpeg process error:', err.message);
      });

      ffmpegProcess.on('exit', (code: number | null) => {
        console.log(`[RADIO] ffmpeg exited with code ${code}`);
      });

      const resource = createAudioResource(ffmpegProcess.stdout!, {
        inputType: StreamType.Raw,
      });

      const audioPlayer = createAudioPlayer();
      audioPlayer.play(resource);
      connection.subscribe(audioPlayer);

      audioPlayer.on('error', (error: any) => {
        console.error('[RADIO] AudioPlayer error:', error?.message || error);
        this.stopRadio(interaction.guild.id);
      });

      // Don't stop on Idle immediately for live streams — ffmpeg may buffer
      // Only stop if player stays idle for a few seconds
      audioPlayer.on(AudioPlayerStatus.Idle, () => {
        console.log('[RADIO] AudioPlayer went idle');
        setTimeout(() => {
          if (audioPlayer.state.status === AudioPlayerStatus.Idle) {
            console.log('[RADIO] Still idle after 5s — stopping radio');
            this.stopRadio(interaction.guild.id);
          }
        }, 5000);
      });

      this.radioPlayers.set(interaction.guild.id, {
        player: audioPlayer,
        process: ffmpegProcess,
        stationName: station.name,
      });

      console.log(`[RADIO] Started ${station.name} for guild ${interaction.guild.id}`);

      const embed = new EmbedBuilder()
        .setColor(0xe91e63)
        .setTitle(`📻 ${station.name}`)
        .setDescription(`Slušaš **${station.name}** uživo!\n\nKoristi \`/stop\` za zaustavljanje.`)
        .setFooter({ text: `Pokrenuo/la: ${interaction.user.username}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (e: any) {
      console.error('[RADIO] Radio command error:', e?.message || e);
      this.stopRadio(interaction.guild.id);
      await interaction.editReply({ content: `❌ Nije moguće pokrenuti radio: ${(e?.message || 'Nepoznata greška').slice(0, 200)}` }).catch(() => {});
    }
  }

  private async handleNowPlayingCommand(interaction: any) {
    if (!this.musicPlayer) { await interaction.reply({ content: '❌ Glazbeni sustav nije dostupan.', ephemeral: true }); return; }
    const guildId = interaction.guild?.id;
    if (!guildId) return;
    const queue = this.musicPlayer.queues.get(guildId);

    if (!queue || !queue.currentTrack) {
      await interaction.reply({ content: '❌ Ništa ne svira trenutno.', ephemeral: true });
      return;
    }

    const track = queue.currentTrack;
    const progress = queue.node.createProgressBar() || '';
    const nextTrack = queue.tracks.at(0);

    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle('🎵 Sada svira')
      .setDescription(`**[${track.title}](${track.url})**`)
      .addFields(
        { name: '👤 Autor', value: track.author || 'Nepoznato', inline: true },
        { name: '⏱️ Trajanje', value: track.duration || '?', inline: true },
        { name: '📊 Progress', value: progress || '▬▬▬▬▬▬▬▬▬▬', inline: false },
      )
      .setFooter({ text: `Zatražio/la: ${(track.requestedBy as any)?.username ?? 'Nepoznato'}` })
      .setTimestamp();

    if (track.thumbnail) embed.setThumbnail(track.thumbnail);

    if (nextTrack) {
      embed.addFields({ name: '⏭️ Sljedeća', value: `${nextTrack.title} (${nextTrack.duration})`, inline: false });
    } else if (this.autoplayMode.get(guildId)) {
      embed.addFields({ name: '🔁 Autoplay', value: 'Uključen — automatski će pustiti sljedeću sličnu pjesmu', inline: false });
    } else {
      embed.addFields({ name: '⏭️ Sljedeća', value: '*Nema — dodaj s `/play` ili uključi `/autoplay`*', inline: false });
    }

    const row = this.buildMusicButtons(queue);
    await interaction.reply({ embeds: [embed], components: [row] });
  }


}

export const bot = new DiscordBot();
