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
  it.each([{ value: [,] }, { value: [1, , 3] }, { value: { nested: [,] } }])(
    "explicitly rejects sparse arrays, including nested holes: %j",
    ({ value }) => {
      const array = Array.isArray(value) ? value : value.nested;
      expect(
        Array.from({ length: array.length }, (_, i) => i in array),
      ).toContain(false);
      expect(() => canonicalJson(value)).toThrow("Expected a dense JSON array");
      expect(() => canonicalJsonSha256(value)).toThrow(
        "Expected a dense JSON array",
      );
    },
  );
  it("distinguishes a present undefined element from a sparse hole", () => {
    const array = [undefined];
    expect(0 in array).toBe(true);
    expect(() => canonicalJson(array)).toThrow("Expected a JSON value");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson([null, false, 0])).toBe("[null,false,0]");
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
