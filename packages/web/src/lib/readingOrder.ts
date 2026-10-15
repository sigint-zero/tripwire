const TOP = [
  "version",
  "name",
  "description",
  "contract",
  "severity",
  "when",
  "trip_when",
  "on_trip",
];

/**
 * A rule document laid out to read top-down: its fields in the order the
 * language gives them, and each node's kind first.
 */
export function readingOrder(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((v) => readingOrder(v, false));
  if (!value || typeof value !== "object") return value;
  const rank = (key: string) => {
    const at = top ? TOP.indexOf(key) : ["node", "op"].indexOf(key);
    return at === -1 ? Infinity : at;
  };
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([key, v]) => [key, readingOrder(v, false)]),
  );
}
