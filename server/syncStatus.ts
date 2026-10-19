import { promises as fs } from 'fs';
import path from 'path';

export type SyncFileResult = {
  name: string;
  ok: boolean;
  bytes?: number;
  parsed?: boolean;
  error?: string;
};

export type SyncStatus = {
  runId?: string;
  inProgress: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  ftpHost?: string;
  ftpPort?: number;
  ftpSecure?: boolean;
  basePath?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  files: SyncFileResult[];
  counts: Record<string, number>;
  // Persisted player-hours state (public leaderboard)
  playerHours?: any;
};

const status: SyncStatus = {
  inProgress: false,
  files: [],
  counts: {},
};

export function getSyncStatus(): SyncStatus {
  return status;
}

export function setSyncStatus(patch: Partial<SyncStatus>) {
  Object.assign(status, patch);
}

export function pushFileResult(entry: SyncFileResult) {
  status.files = [...(status.files || []).filter(f => f.name !== entry.name), entry].slice(-30);
}

export function bumpCount(key: string, delta = 1) {
  status.counts = status.counts || {};
  status.counts[key] = (status.counts[key] || 0) + delta;
}

// Persist minimal “last good sync” snapshot so panels can show something even after restart.
const SNAPSHOT_PATH = process.env.FS25_SYNC_SNAPSHOT_PATH || 'data/lastSyncSnapshot.json';

export async function writeSyncSnapshot(): Promise<void> {
  try {
    const p = path.resolve(process.cwd(), SNAPSHOT_PATH);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(status, null, 2), 'utf8');
    await fs.rename(tmp, p);
  } catch {
    // non-fatal
  }
}

export async function readSyncSnapshot(): Promise<void> {
  try {
    const p = path.resolve(process.cwd(), SNAPSHOT_PATH);
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      Object.assign(status, parsed);
      status.inProgress = false;
    }
  } catch {
    // ignore
  }
}
