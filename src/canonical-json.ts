import { createHash } from "node:crypto";

/** Canonical JSON for signed request bindings: object keys sort lexicographically; arrays preserve order. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || !item)
      throw new TypeError("Expected a JSON value");
    if (ancestors.has(item)) throw new TypeError("Cyclic JSON value");

    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) {
          if (!(i in item)) throw new TypeError("Expected a dense JSON array");
        }
        return `[${Array.from(item, encode).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Expected a JSON object");
      }
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  }

  return encode(value);
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}
