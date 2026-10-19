/**
 * Multi-server FTP configuration.
 *
 * Reads FS25_SERVERS env var (JSON array) or falls back to individual FS25_FTP_* vars.
 *
 * Example FS25_SERVERS:
 * [{"id":"sr","name":"Slavonska Ravnica","host":"1.2.3.4","user":"u","pass":"p","port":21,"remotePath":"/profile/modSettings/FS25_FSG_Companion/commands/outbox"}]
 */

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  user: string;
  pass: string;
  port: number;
  remotePath: string;
  secure: boolean;
  statsUrl?: string;
  modsUrl?: string;
  mapImageUrl?: string;
  gportalServerId?: string;
}

let servers: ServerConfig[] = [];
let activeServerId: string | null = null;

// Cache for auto-detected companion outbox paths (per server id)
const resolvedOutboxPaths = new Map<string, string>();

export function getResolvedOutboxPath(serverId: string): string | null {
  return resolvedOutboxPaths.get(serverId) || null;
}

export function setResolvedOutboxPath(serverId: string, path: string) {
  resolvedOutboxPaths.set(serverId, path);
}

function loadServers(): ServerConfig[] {
  const raw = process.env.FS25_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((s: any, i: number) => ({
          id: s.id || `server-${i}`,
          name: s.name || `Server ${i + 1}`,
          host: s.host || '',
          user: s.user || '',
          pass: s.pass || '',
          port: Number(s.port) || 21,
          remotePath: s.remotePath || '/profile/modSettings/FS25_FSG_Companion/commands/outbox',
          secure: s.secure === true || s.secure === 'true',
          statsUrl: s.statsUrl || undefined,
          modsUrl: s.modsUrl || undefined,
          mapImageUrl: s.mapImageUrl || undefined,
          gportalServerId: s.gportalServerId || undefined,
        }));
      }
    } catch (e) {
      console.error('Failed to parse FS25_SERVERS env var:', e);
    }
  }

  // Fallback: build single server from individual env vars
  const host = process.env.FS25_FTP_HOST || '';
  const user = process.env.FS25_FTP_USER || '';
  const pass = process.env.FS25_FTP_PASS || process.env.FS25_FTP_PASSWORD || '';
  if (host && user && pass) {
    const secureEnv = (process.env.FS25_FTP_SECURE || '').toLowerCase();
    return [{
      id: 'default',
      name: 'FS25 Server',
      host,
      user,
      pass,
      port: Number(process.env.FS25_FTP_PORT) || 21,
      remotePath: process.env.FS25_FTP_REMOTE_PATH || process.env.FS25_FTP_PATH || '/profile/modSettings/FS25_FSG_Companion/commands/outbox',
      secure: ['1', 'true', 'yes', 'on'].includes(secureEnv),
      statsUrl: process.env.WEBSTATS_STATS_XML_URL || undefined,
      modsUrl: process.env.WEBSTATS_MODS_URL || undefined,
      mapImageUrl: process.env.WEBSTATS_MAP_IMAGE_URL || undefined,
    }];
  }

  return [];
}

export function initServers() {
  servers = loadServers();
  if (servers.length > 0 && !activeServerId) {
    activeServerId = servers[0].id;
  }
  console.log(`[ServerConfig] Loaded ${servers.length} server(s). Active: ${activeServerId}`);
}

export function getServers(): Omit<ServerConfig, 'pass'>[] {
  return servers.map(({ pass, ...rest }) => rest);
}

export function getActiveServerUrls(): { statsUrl?: string; modsUrl?: string; mapImageUrl?: string } {
  const srv = getActiveServer();
  return { statsUrl: srv?.statsUrl, modsUrl: srv?.modsUrl, mapImageUrl: srv?.mapImageUrl };
}

export function getActiveServer(): ServerConfig | null {
  if (!activeServerId) return servers[0] || null;
  return servers.find(s => s.id === activeServerId) || servers[0] || null;
}

export function getActiveServerId(): string | null {
  return activeServerId || (servers[0]?.id ?? null);
}

export function setActiveServer(id: string): boolean {
  const found = servers.find(s => s.id === id);
  if (!found) return false;
  activeServerId = id;
  console.log(`[ServerConfig] Active server changed to: ${id} (${found.name})`);
  return true;
}

export function getServerById(id: string): ServerConfig | null {
  return servers.find(s => s.id === id) || null;
}

// Initialize on import
initServers();
