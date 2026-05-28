export type QueryValue = string | number | boolean | null | undefined;

interface SearchParamsLike {
  get(name: string): string | null;
}

export function buildQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export function readStringParam(source: SearchParamsLike, key: string, fallback = ""): string {
  const value = source.get(key);
  return value === null || value === undefined ? fallback : value;
}

export function readNumberParam(source: SearchParamsLike, key: string, fallback: number): number {
  const raw = source.get(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readEnumParam<T extends string>(
  source: SearchParamsLike,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = source.get(key);
  if (!raw) return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export function writeSearchParam(search: URLSearchParams, key: string, value: QueryValue) {
  if (value === undefined || value === null || value === "" || value === false) {
    search.delete(key);
    return;
  }
  search.set(key, String(value));
}
