export function createExpiringTokenCache({
  now = () => Date.now(),
  ttlMs = 30 * 60_000,
  maxEntries = 500
} = {}) {
  const entries = new Map();

  function sweep() {
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(key);
    }
  }

  return {
    set(key, token) {
      sweep();
      const normalizedKey = String(key || "");
      entries.delete(normalizedKey);
      entries.set(normalizedKey, { token, expiresAt: now() + Math.max(1, Number(ttlMs) || 1) });
      while (entries.size > Math.max(1, Number(maxEntries) || 1)) entries.delete(entries.keys().next().value);
    },
    get(key) {
      sweep();
      return entries.get(String(key || ""))?.token;
    },
    delete(key) {
      return entries.delete(String(key || ""));
    },
    get size() {
      sweep();
      return entries.size;
    }
  };
}
