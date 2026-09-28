/**
 * Read a list from an API response without trusting the upstream response
 * shape. Some optional services return an error object (or a keyed list)
 * while still passing through a successful HTTP response in local setups.
 */
export function responseArray<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const nested = (payload as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
}
