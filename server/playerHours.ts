export type PresenceSnapshotUser = {
  userId?: string;
  name?: string;
  playTime?: number | string;
  afkTime?: number | string;
  isOnline?: boolean;
  joinedAt?: string;
  leftAt?: string;
};

type HoursRow = {
  userId: string;
  name: string;
  secondsAllTime: number;
  secondsAfk: number;
  seconds30d: number;
  lastReportedTotalSec?: number;
  lastReportedAfkSec?: number;
  lastSeenAt?: number;
};

const DB = new Map<string, HoursRow>();

export function clearAllPlayerHours() {
  DB.clear();
}

function nowMs() { return Date.now(); }

export function updatePlayerHoursFromPresenceSnapshot(snapshot: { users?: PresenceSnapshotUser[] } | null | undefined) {
  if (!snapshot?.users?.length) return;

  const t = nowMs();

  for (const u of snapshot.users) {
    // Only use uniqueUserId or userId, never name
    const userId = (u.userId || '').toString().trim();
    if (!userId) continue;

    const name = (u.name || userId).toString();
    const row = DB.get(userId) ?? { userId, name, secondsAllTime: 0, secondsAfk: 0, seconds30d: 0 };

    row.name = name;
    row.lastSeenAt = t;

    const playTimeHours = Number((u as any).playTime);
    const hasReportedTotal = Number.isFinite(playTimeHours) && playTimeHours >= 0;
    if (hasReportedTotal) {
      const reportedTotalSec = Math.max(0, Math.floor(playTimeHours * 3600));

      if (row.lastReportedTotalSec == null) {
        row.lastReportedTotalSec = reportedTotalSec;
        row.secondsAllTime = reportedTotalSec;
      } else if (reportedTotalSec >= row.lastReportedTotalSec) {
        const deltaSec = reportedTotalSec - row.lastReportedTotalSec;
        row.lastReportedTotalSec = reportedTotalSec;
        row.secondsAllTime = reportedTotalSec;
        row.seconds30d += deltaSec;
      } else {
        // Source reported lower value (e.g. game server restart) — accept the new reality
        row.lastReportedTotalSec = reportedTotalSec;
        row.secondsAllTime = reportedTotalSec;
      }
    }

    // Track AFK separately
    const afkTimeHours = Number((u as any).afkTime);
    if (Number.isFinite(afkTimeHours) && afkTimeHours >= 0) {
      const reportedAfkSec = Math.max(0, Math.floor(afkTimeHours * 3600));
      row.lastReportedAfkSec = reportedAfkSec;
      row.secondsAfk = reportedAfkSec;
    }

    if (!hasReportedTotal) {
      const joinedAt = u.joinedAt ? Date.parse(u.joinedAt) : NaN;
      const leftAt = u.leftAt ? Date.parse(u.leftAt) : NaN;

      if (Number.isFinite(joinedAt) && Number.isFinite(leftAt) && leftAt > joinedAt) {
        const deltaSec = Math.floor((leftAt - joinedAt) / 1000);
        row.secondsAllTime += deltaSec;
        row.seconds30d += deltaSec;
      }
    }

    DB.set(userId, row);
  }
}

export function getPlayerHoursLeaderboard(page = 1, pageSize = 25) {
  const p = Math.max(1, page);
  const size = Math.min(50, Math.max(1, pageSize));
  const start = (p - 1) * size;

  const rows = Array.from(DB.values()).sort((a, b) => b.secondsAllTime - a.secondsAllTime);
  const slice = rows.slice(start, start + size);

  return {
    page: p,
    pageSize: size,
    total: rows.length,
    rows: slice.map(r => ({
      userId: r.userId,
      name: r.name,
      secondsAllTime: r.secondsAllTime,
      secondsAfk: r.secondsAfk,
      seconds30d: r.seconds30d
    }))
  };
}

export function formatHours(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
