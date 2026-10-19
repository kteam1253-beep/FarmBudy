// Parsing helpers (EN): defensive conversions for XML attrs coming from different companion builds.
// Komentar (HR): Companion/mod zna promijeniti nazive kljuceva; ovo daje fallback i normalizaciju.

export function pickFirst<T = any>(obj: any, keys: string[], fallback: T): T {
  if (!obj) return fallback;
  for (const k of keys) {
    const v = (obj as any)[k];
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return fallback;
}

export function toNumber(value: any, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const s = String(value).trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

export function toStringSafe(value: any, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  const s = String(value);
  return s.length ? s : fallback;
}

export function toLowerSafe(value: any, fallback = ''): string {
  return toStringSafe(value, fallback).toLowerCase();
}
