import * as ftp from "basic-ftp";
import { Readable } from "stream";
import { getActiveServer, getServerById, getResolvedOutboxPath, setResolvedOutboxPath, type ServerConfig } from "./serverConfig";

function resolveServer(serverId?: string): ServerConfig {
  const srv = serverId ? getServerById(serverId) : getActiveServer();
  if (!srv) throw new Error("Nema konfiguriranog servera. Postavi FS25_SERVERS ili FS25_FTP_* env varove.");
  if (!srv.host || !srv.user || !srv.pass) throw new Error(`Server '${srv.name}' nema FTP credentials.`);
  return srv;
}

function toInboxPath(remotePath: string): string {
  let p = remotePath.replace(/\\/g, "/");
  if (/\/outbox\/?$/i.test(p)) p = p.replace(/\/outbox\/?$/i, "/inbox/");
  if (p.includes("/outbox/")) p = p.replace("/outbox/", "/inbox/");
  if (!p.includes("/inbox")) p = p.replace(/outbox/i, "inbox");
  return p;
}

/**
 * Auto-detect which companion folder the mod actually uses on this server.
 * Lists /profile/modSettings/ and returns the outbox path for the folder
 * with the most files (= the active companion).
 * Caches result per server id.
 */
export async function detectCompanionOutbox(client: ftp.Client, serverId: string, configuredPath: string): Promise<string> {
  const cached = getResolvedOutboxPath(serverId);
  if (cached) return cached;

  try {
    const entries = await client.list('/profile/modSettings/');
    const companionDirs = entries
      .filter(e => e.isDirectory && e.name.toLowerCase().includes('companion'))
      .map(e => e.name);

    if (companionDirs.length <= 1) {
      // Only one (or zero) companion folder — use configured path
      const resolved = companionDirs.length === 1
        ? `/profile/modSettings/${companionDirs[0]}/commands/outbox`
        : configuredPath;
      setResolvedOutboxPath(serverId, resolved);
      return resolved;
    }

    // Multiple companion folders — pick the one with the most outbox files
    let bestPath = configuredPath;
    let bestCount = -1;

    for (const dir of companionDirs) {
      const outboxPath = `/profile/modSettings/${dir}/commands/outbox`;
      try {
        const files = await client.list(outboxPath);
        if (files.length > bestCount) {
          bestCount = files.length;
          bestPath = outboxPath;
        }
      } catch {
        // folder doesn't have commands/outbox structure
      }
    }

    console.log(`[FTP] Auto-detected companion outbox: ${bestPath}`);
    setResolvedOutboxPath(serverId, bestPath);
    return bestPath;
  } catch (e) {
    console.log(`[FTP] Companion auto-detect failed, using configured path:`, e);
    return configuredPath;
  }
}

/**
 * Upload a JSON command to the FSG Companion inbox via FTP.
 */
export async function uploadInboxJson(filename: string, payload: any, serverId?: string) {
  const srv = resolveServer(serverId);

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({ host: srv.host, user: srv.user, password: srv.pass, port: srv.port, secure: srv.secure });

    // Auto-detect the correct companion folder
    const outboxPath = await detectCompanionOutbox(client, srv.id, srv.remotePath);
    const inboxPath = toInboxPath(outboxPath);

    await client.ensureDir(inboxPath);
    await client.cd(inboxPath);

    const jsonStr = JSON.stringify(payload, null, 2);
    const stream = Readable.from(Buffer.from(jsonStr, "utf-8"));
    await client.uploadFrom(stream as any, filename);
    console.log(`[FTP] Uploaded command to ${inboxPath}/${filename}`);
  } finally {
    client.close();
  }
}


/**
 * Upload an XML command to the FSG Companion inbox via FTP.
 * Companion remoteCmds.lua expects root key "commands" and child "command" nodes with attributes.
 */
export async function uploadInboxXml(filename: string, xml: string, serverId?: string) {
  const srv = resolveServer(serverId);

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({ host: srv.host, user: srv.user, password: srv.pass, port: srv.port, secure: srv.secure });

    // Auto-detect the correct companion folder
    const outboxPath = await detectCompanionOutbox(client, srv.id, srv.remotePath);
    const inboxPath = toInboxPath(outboxPath);

    await client.ensureDir(inboxPath);
    await client.cd(inboxPath);

    const stream = Readable.from(Buffer.from(xml, "utf-8"));
    await client.uploadFrom(stream as any, filename);
    console.log(`[FTP] Uploaded command to ${inboxPath}/${filename}`);
  } finally {
    client.close();
  }
}

/**
 * Upload an XML command to the Poslovi mod inbox via FTP.
 * Path: /profile/modSettings/FS25_Poslovi/inbox/
 */
export async function uploadPosloviInboxXml(filename: string, xml: string, serverId?: string) {
  const srv = resolveServer(serverId);

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({ host: srv.host, user: srv.user, password: srv.pass, port: srv.port, secure: srv.secure });

    const inboxPath = '/profile/modSettings/FS25_Poslovi/inbox';
    await client.ensureDir(inboxPath);
    await client.cd(inboxPath);

    const stream = Readable.from(Buffer.from(xml, "utf-8"));
    await client.uploadFrom(stream as any, filename);
    console.log(`[FTP] Uploaded Poslovi command to ${inboxPath}/${filename}`);
  } finally {
    client.close();
  }
}

/**
 * Read a file from FTP (debug).
 */
export async function readFtpFile(remotePath: string, serverId?: string): Promise<string | null> {
  const srv = resolveServer(serverId);
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({ host: srv.host, user: srv.user, password: srv.pass, port: srv.port, secure: srv.secure });
    const chunks: Buffer[] = [];
    const writable = new (require('stream').Writable)({
      write(chunk: Buffer, _enc: string, cb: () => void) { chunks.push(chunk); cb(); }
    });
    await client.downloadTo(writable, remotePath);
    return Buffer.concat(chunks).toString('utf-8');
  } catch { return null; }
  finally { client.close(); }
}

/**
 * List files in an FTP directory (debug).
 */
export async function listFtpDir(remotePath: string, serverId?: string): Promise<string[]> {
  const srv = resolveServer(serverId);
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({ host: srv.host, user: srv.user, password: srv.pass, port: srv.port, secure: srv.secure });
    const list = await client.list(remotePath);
    return list.map(f => `${f.isDirectory ? '[DIR] ' : ''}${f.name} (${f.size}b)`);
  } catch { return ['[error listing]']; }
  finally { client.close(); }
}

export async function listInboxFiles(serverId?: string): Promise<{ inbox: string[]; outbox: string[]; inboxPath: string; outboxPath: string; altInbox: string[]; altOutbox: string[]; altInboxPath: string; altOutboxPath: string; detectedPath: string }> {
  const srv = resolveServer(serverId);
  const configuredOutbox = srv.remotePath;
  const configuredInbox = toInboxPath(configuredOutbox);

  // Also check under FS25_SlavonskaRavnica_Companion
  const altOutboxPath = configuredOutbox.replace('FS25_FSG_Companion', 'FS25_SlavonskaRavnica_Companion').replace('FS25_FSG_Companion', 'FS25_SlavonskaRavnica_Companion');
  const altInboxPath = configuredInbox.replace('FS25_FSG_Companion', 'FS25_SlavonskaRavnica_Companion').replace('FS25_FSG_Companion', 'FS25_SlavonskaRavnica_Companion');

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({ host: srv.host, user: srv.user, password: srv.pass, port: srv.port, secure: srv.secure });

    // Auto-detect companion path
    const detected = await detectCompanionOutbox(client, srv.id, configuredOutbox);
    const detectedInbox = toInboxPath(detected);

    const listSafe = async (p: string) => {
      try { return (await client.list(p)).map(f => `${f.name} (${f.size}b)`); }
      catch { return ['[folder not found]']; }
    };

    return {
      inbox: await listSafe(detectedInbox), outbox: await listSafe(detected),
      inboxPath: detectedInbox, outboxPath: detected,
      altInbox: await listSafe(altInboxPath), altOutbox: await listSafe(altOutboxPath),
      altInboxPath, altOutboxPath,
      detectedPath: detected,
    };
  } finally {
    client.close();
  }
}
