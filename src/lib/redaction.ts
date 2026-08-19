const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PARTS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "bearer_token",
  "client_secret",
  "cookie",
  "credential",
  "credentials",
  "id_token",
  "password",
  "passwd",
  "private_key",
  "proxy_authorization",
  "refresh_token",
  "secret",
  "set_cookie",
  "token",
  "access_token",
  "access_key",
  "access_key_id",
  "secret_access_key",
]);

function normalizedKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[.\-\s]+/g, "_")
    .toLowerCase();
}

export function isSensitiveKey(key: string) {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEY_PARTS.has(normalized)) return true;
  return normalized.endsWith("_api_key")
    || normalized.endsWith("_access_token")
    || normalized.endsWith("_access_key")
    || normalized.endsWith("_access_key_id")
    || normalized.endsWith("_auth_token")
    || normalized.endsWith("_client_secret")
    || normalized.endsWith("_credential")
    || normalized.endsWith("_password")
    || normalized.endsWith("_private_key")
    || normalized.endsWith("_refresh_token")
    || normalized.endsWith("_secret");
}

/**
 * Removes common credentials from diagnostic text while deliberately leaving
 * harmless token metrics such as `tokensUsed` and `tokenBudget` untouched.
 */
export function redactText(input: string): string {
  return input
    .replace(/(\b(?:Authorization|Proxy-Authorization)\s*:\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;"']+/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, `Basic ${REDACTED}`)
    .replace(/\b(?:sk-(?:ant-)?|rk-|gh[opusr]_|github_pat_|glpat-|npm_|xox[baprs]-|AIza)[A-Za-z0-9_.\-]{8,}/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer[_-]?token|client[_-]?secret|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,
      `$1$2${REDACTED}$2`,
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer[_-]?token|client[_-]?secret|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret)["']?\s*[:=]\s*)(["']?)(?!\[REDACTED\])([^\s,;&\]}"']+)(\2)/gi,
      `$1$2${REDACTED}$4`,
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|refresh[_-]?token|secret)=)[^&#\s]+/gi,
      `$1${encodeURIComponent(REDACTED)}`,
    )
    .replace(
      /(\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY|REFRESH_TOKEN|SECRET)\s*=\s*)(["']?)([^\s"']+)(\2)/g,
      `$1$2${REDACTED}$4`,
    )
    .replace(
      /(\s--(?:api-key|access-token|auth-token|client-secret|password|private-key|refresh-token|secret)(?:=|\s+))(["']?)([^\s"']+)(\2)/gi,
      `$1$2${REDACTED}$4`,
    );
}

/** Returns a redacted clone suitable for persisted diagnostics and activity logs. */
export function redactValue<T>(value: T): T {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, key?: string): unknown => {
    if (key && isSensitiveKey(key)) return REDACTED;
    if (typeof current === "string") return redactText(current);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[Circular]";
    seen.add(current);

    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (current instanceof Date) return current;
    if (current instanceof Error) {
      return {
        name: current.name,
        message: redactText(current.message),
        stack: current.stack ? redactText(current.stack) : undefined,
      };
    }

    const clone: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(current)) {
      clone[entryKey] = visit(entryValue, entryKey);
    }
    return clone;
  };

  return visit(value) as T;
}
