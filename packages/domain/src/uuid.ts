/** PostgreSQL accepts UUIDs independently of hexadecimal casing. */
export function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

/** Normalize UUIDs entered or linked in the browser before sending them to the API. */
export function normalizeUuid(value: string): string | null {
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
    ? canonicalUuid(trimmed)
    : null;
}
