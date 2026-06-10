export interface MiddleEllipsisParts {
  head: string;
  tail: string;
  truncated: boolean;
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

const MULTI_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz", ".user.js"];

export function splitPathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
}

function getProtectedExtension(name: string): string {
  const lower = name.toLowerCase();
  const multiExtension = MULTI_EXTENSIONS.find((extension) => lower.endsWith(extension));
  if (multiExtension) return name.slice(name.length - multiExtension.length);
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  return name.slice(dotIndex);
}

export function splitNameForMiddleEllipsis(name: string, headChars = 30, tailChars = 42): MiddleEllipsisParts {
  if (name.length <= headChars + tailChars + 1) return { head: name, tail: "", truncated: false };

  const extension = getProtectedExtension(name);
  const minTailChars = Math.max(tailChars, extension.length + 18);
  const tail = name.slice(Math.max(headChars + 1, name.length - minTailChars));
  const head = name.slice(0, headChars);
  return { head, tail, truncated: true };
}

export function compactPath(path: string, maxSegments = 5): string {
  const parts = splitPathSegments(path);
  if (parts.length <= maxSegments) return parts.join("/");
  const keepStart = Math.max(1, Math.floor((maxSegments - 1) / 2));
  const keepEnd = Math.max(1, maxSegments - keepStart - 1);
  return [...parts.slice(0, keepStart), "…", ...parts.slice(-keepEnd)].join("/");
}

export function getSearchSnippet(value: string, query: string, contextChars = 28): string {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return value;

  const lowerValue = value.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  const matchIndex = lowerValue.indexOf(lowerQuery);
  if (matchIndex < 0) return value;

  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(value.length, matchIndex + trimmedQuery.length + contextChars);
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`;
}

export function getHighlightParts(value: string, query: string): HighlightPart[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [{ text: value, match: false }];

  const parts: HighlightPart[] = [];
  const lowerValue = value.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  let cursor = 0;

  while (cursor < value.length) {
    const matchIndex = lowerValue.indexOf(lowerQuery, cursor);
    if (matchIndex < 0) break;
    if (matchIndex > cursor) parts.push({ text: value.slice(cursor, matchIndex), match: false });
    parts.push({ text: value.slice(matchIndex, matchIndex + trimmedQuery.length), match: true });
    cursor = matchIndex + trimmedQuery.length;
  }

  if (cursor < value.length) parts.push({ text: value.slice(cursor), match: false });
  return parts.length > 0 ? parts : [{ text: value, match: false }];
}

export function getVisualTreeDepth(depth: number, maxDepth = 7): number {
  return Math.max(0, Math.min(depth, maxDepth));
}

export function getOverflowTreeDepth(depth: number, maxDepth = 7): number {
  return Math.max(0, depth - maxDepth);
}
