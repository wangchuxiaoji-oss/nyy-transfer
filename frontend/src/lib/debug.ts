export type DebugLogFn = (scope: string, event: string, data?: Record<string, unknown>) => void;

export interface DebugMessage {
  ts: number;
  scope: string;
  event: string;
  data?: Record<string, unknown>;
}

export function formatDebugLine(elapsedMs: number, scope: string, event: string, data?: Record<string, unknown>): string {
  const time = `+${Math.round(elapsedMs).toString().padStart(6, "0")}ms`;
  const detail = data && Object.keys(data).length > 0 ? ` ${safeStringify(data)}` : "";
  return `[${time}][${scope}] ${event}${detail}`;
}

export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, input) => {
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "function") return `[Function ${input.name || "anonymous"}]`;
    if (input instanceof Error) {
      return {
        name: input.name,
        message: input.message,
        stack: input.stack?.split("\n").slice(0, 2).join(" | "),
      };
    }
    if (typeof DOMException !== "undefined" && input instanceof DOMException) {
      return { name: input.name, message: input.message, code: input.code };
    }
    if (input && typeof input === "object") {
      if (seen.has(input)) return "[Circular]";
      seen.add(input);
    }
    return input;
  });
}

export function toDebugRecord(payload: unknown): DebugMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Partial<DebugMessage> & { type?: string };
  if (data.type !== "NYY_DEBUG_LOG") return null;
  if (typeof data.ts !== "number" || typeof data.scope !== "string" || typeof data.event !== "string") return null;
  return {
    ts: data.ts,
    scope: data.scope,
    event: data.event,
    data: data.data && typeof data.data === "object" ? data.data : undefined,
  };
}
