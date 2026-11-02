import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson, canonicalJsonSha256 } from "../src/auth/index.js";
describe("canonical JSON", () => {
  it("sorts nested and integer-like keys lexicographically and preserves arrays", () => {
    expect(
      canonicalJson({
        z: [3, { b: false, a: null }],
        "2": 2,
        "10": 10,
        a: "雪",
      }),
    ).toBe('{"10":10,"2":2,"a":"雪","z":[3,{"a":null,"b":false}]}');
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(
      createHash("sha256").update('{"a":1,"b":2}', "utf8").digest("hex"),
    );
    expect(canonicalJsonSha256("雪")).toBe(
      createHash("sha256").update('"雪"', "utf8").digest("hex"),
    );
  });
  it("accepts null prototypes and shared non-cyclic references", () => {
    const a = Object.assign(Object.create(null), { a: 1 });
    expect(canonicalJson([a, a])).toBe('[{"a":1},{"a":1}]');
  });
  it("rejects cycles", () => {
    const a: unknown[] = [];
    a.push(a);
    expect(() => canonicalJson(a)).toThrow("Cyclic");
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    Symbol(),
    new Date(),
    new Map(),
    new Set(),
    /x/,
    [,],
  ])("rejects non-JSON value %s", (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});
