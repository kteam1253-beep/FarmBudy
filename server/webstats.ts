import { parseStringPromise } from 'xml2js';

export type WebStatsPlayer = {
  name: string;
  onlineMinutes?: number | null;
};

export type WebStatsSummary = {
  serverName?: string | null;
  mapName?: string | null;
  isOnline?: boolean | null;
  playersOnline?: number | null;
  players?: WebStatsPlayer[];
  rawUpdatedAt?: string | null;
};

const DEFAULT_TIMEOUT_MS = 2000;

// Hrvatski komentar: fail-safe fetch s timeoutom da bot ne zapne na webstatsu.
async function fetchWithTimeout(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' as any });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function asNumber(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickFirstString(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length) return pickFirstString(v[0]);
  if (typeof v === 'object') {
    // common xml2js shape: { _: 'text' }
    if (typeof (v as any)._ === 'string') return (v as any)._;
  }
  return null;
}

// Recursive scan to extract players from unknown xml schema.
function extractPlayers(node: any, out: WebStatsPlayer[] = []): WebStatsPlayer[] {
  if (!node) return out;

  if (Array.isArray(node)) {
    for (const it of node) extractPlayers(it, out);
    return out;
  }

  if (typeof node !== 'object') return out;

  // Common patterns: <player name="X" /> or <player><name>X</name></player>
  const keys = Object.keys(node);

  for (const k of keys) {
    const v = (node as any)[k];

    if (/player/i.test(k)) {
      // could be object or array
      if (Array.isArray(v)) {
        for (const p of v) {
          const name = pickFirstString(p?.name) || pickFirstString(p?.Name) || pickFirstString(p?.playerName) || pickFirstString(p?.PlayerName) || pickFirstString(p?._) || pickFirstString(p?.$?.name) || pickFirstString(p?.$?.Name);
          if (name) {
            const mins = asNumber(p?.onlineMinutes ?? p?.minutes ?? p?.$?.minutes ?? p?.$?.onlineMinutes) ?? null;
            out.push({ name, onlineMinutes: mins });
          } else {
            extractPlayers(p, out);
          }
        }
      } else if (typeof v === 'object') {
        const name = pickFirstString(v?.name) || pickFirstString(v?.Name) || pickFirstString(v?.playerName) || pickFirstString(v?.PlayerName) || pickFirstString(v?._) || pickFirstString(v?.$?.name) || pickFirstString(v?.$?.Name);
        if (name) {
          const mins = asNumber(v?.onlineMinutes ?? v?.minutes ?? v?.$?.minutes ?? v?.$?.onlineMinutes) ?? null;
          out.push({ name, onlineMinutes: mins });
        } else {
          extractPlayers(v, out);
        }
      }
      continue;
    }

    extractPlayers(v, out);
  }

  return out;
}

function extractScalarByKey(node: any, regex: RegExp): string | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const it of node) {
      const r = extractScalarByKey(it, regex);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  for (const [k, v] of Object.entries(node)) {
    if (regex.test(k)) {
      const s = pickFirstString(v);
      if (s) return s;
      const attr = pickFirstString((v as any)?.$?.value) || pickFirstString((v as any)?.$?.name);
      if (attr) return attr;
    }
    const r = extractScalarByKey(v, regex);
    if (r) return r;
  }
  return null;
}

export async function getWebStatsSummaryFromEnv(): Promise<{ summary: WebStatsSummary | null; mods: { companionActive: boolean | null; modCount: number | null } }> {
  // Use active server URLs if available, fallback to env vars
  let statsUrl = process.env.WEBSTATS_STATS_XML_URL;
  let modsUrl = process.env.WEBSTATS_MODS_URL;
  try {
    const { getActiveServerUrls } = await import("./serverConfig");
    const urls = getActiveServerUrls();
    if (urls.statsUrl) statsUrl = urls.statsUrl;
    if (urls.modsUrl) modsUrl = urls.modsUrl;
  } catch {}

  let summary: WebStatsSummary | null = null;
  let companionActive: boolean | null = null;
  let modCount: number | null = null;

  if (statsUrl) {
    try {
      const xml = await fetchWithTimeout(statsUrl);
      const parsed = await parseStringPromise(xml, { explicitArray: true, mergeAttrs: true });
      const players = extractPlayers(parsed, []).filter(p => p.name).slice(0, 50);

      const serverName = extractScalarByKey(parsed, /(serverName|name)$/i);
      const mapName = extractScalarByKey(parsed, /(mapName|map)$/i);
      const updated = extractScalarByKey(parsed, /(lastUpdate|updated|timestamp)$/i);

      // best-effort online flag
      const statusStr = extractScalarByKey(parsed, /(status|state)$/i);
      const isOnline = statusStr ? /online|running|up/i.test(statusStr) : null;

      // players online count (fallback to list length)
      const countStr = extractScalarByKey(parsed, /(playersOnline|onlinePlayers|numPlayers|playerCount)$/i);
      const playersOnline = (countStr ? asNumber(countStr) : null) ?? (players.length ? players.length : null);

      summary = {
        serverName,
        mapName,
        isOnline,
        playersOnline,
        players,
        rawUpdatedAt: updated
      };
    } catch {
      summary = null;
    }
  }

  if (modsUrl) {
    try {
      const html = await fetchWithTimeout(modsUrl);
      // common mod names to detect
      const needles = [
        'FS25_SlavonskaRavnica_Companion',
        'SlavonskaRavnica_Companion',
        'FSG_Companion',
        'Companion'
      ];
      companionActive = needles.some(n => html.toLowerCase().includes(n.toLowerCase()));
      // crude count: list items or table rows
      const liCount = (html.match(/<li\b/gi) || []).length;
      const trCount = (html.match(/<tr\b/gi) || []).length;
      modCount = Math.max(liCount, trCount ? trCount - 1 : 0) || null;
    } catch {
      companionActive = null;
      modCount = null;
    }
  }

  return { summary, mods: { companionActive, modCount } };
}
