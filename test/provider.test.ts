import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair, type CryptoKey } from "jose";
import {
  createWorkloadOidcProvider,
  WorkloadOidcProviderError,
} from "../src/testing/index.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
let activePem: string;
let previousPem: string;

async function pem(): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return exportPKCS8(privateKey as CryptoKey);
}

function provider(
  overrides: Partial<Parameters<typeof createWorkloadOidcProvider>[0]> = {},
) {
  return createWorkloadOidcProvider({
    issuer: "https://issuer.example.test/",
    audience: "example-workload",
    tokenTtlSeconds: 3600,
    activeKey: { kid: "active-2026", privateKeyPem: activePem },
    now: () => NOW,
    ...overrides,
  });
}

beforeAll(async () => {
  [activePem, previousPem] = await Promise.all([pem(), pem()]);
});
afterAll(() => undefined);

describe("workload OIDC provider", () => {
  it("signs and strictly verifies an RS256 workload ID token", async () => {
    const oidc = provider();
    const token = await oidc.signIdToken({
      subject: "bot:123",
      groups: ["bot:123"],
      claims: { service: "mcp" },
    });
    const verified = await oidc.verifyIdToken(token, { currentDate: NOW });
    expect(verified.protectedHeader).toMatchObject({
      alg: "RS256",
      kid: "active-2026",
      typ: "JWT",
    });
    expect(verified.payload).toMatchObject({
      iss: "https://issuer.example.test",
      sub: "bot:123",
      aud: "example-workload",
      groups: ["bot:123"],
      service: "mcp",
    });
    expect(verified.payload.exp).toBe(Math.floor(NOW.getTime() / 1000) + 3600);
  });

  it("rejects a tampered token without exposing it in the error", async () => {
    const oidc = provider();
    const token = await oidc.signIdToken({ subject: "bot:123" });
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature)
      throw new Error("expected signed JWT");
    const signatureBytes = Buffer.from(signature, "base64url");
    signatureBytes[0] = signatureBytes[0]! ^ 1;
    const tampered = `${header}.${payload}.${signatureBytes.toString("base64url")}`;
    await expect(
      oidc.verifyIdToken(tampered, { currentDate: NOW }),
    ).rejects.toMatchObject({ code: "TOKEN_VERIFICATION_FAILED" });
    await expect(
      oidc.verifyIdToken(tampered, { currentDate: NOW }),
    ).rejects.not.toThrow(tampered);
  });

  it("rejects expired tokens and issuer/audience mismatches", async () => {
    const oidc = provider({ tokenTtlSeconds: 1 });
    const token = await oidc.signIdToken({ subject: "bot:123" });
    await expect(
      oidc.verifyIdToken(token, {
        currentDate: new Date(NOW.getTime() + 2_000),
      }),
    ).rejects.toMatchObject({ code: "TOKEN_VERIFICATION_FAILED" });
    await expect(
      provider({
        issuer: "https://other-issuer.example.test",
        activeKey: { kid: "active-2026", privateKeyPem: activePem },
      }).verifyIdToken(token, { currentDate: NOW }),
    ).rejects.toMatchObject({ code: "TOKEN_VERIFICATION_FAILED" });
    await expect(
      oidc.verifyIdToken(token, {
        audience: "other-audience",
        currentDate: NOW,
      }),
    ).rejects.toMatchObject({ code: "TOKEN_VERIFICATION_FAILED" });
  });

  it("rejects alg=none and cannot be algorithm-downgraded", async () => {
    const oidc = provider();
    const token = await oidc.signIdToken({ subject: "bot:123" });
    const [, payload] = token.split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
    await expect(
      oidc.verifyIdToken(none, { currentDate: NOW }),
    ).rejects.toMatchObject({ code: "TOKEN_VERIFICATION_FAILED" });
  });

  it("publishes active and previous public keys and verifies a previous-key token", async () => {
    const old = provider({
      activeKey: { kid: "previous-2025", privateKeyPem: previousPem },
    });
    const oldToken = await old.signIdToken({ subject: "bot:old" });
    const rotated = provider({
      previousKey: { kid: "previous-2025", privateKeyPem: previousPem },
    });
    await expect(
      rotated.verifyIdToken(oldToken, { currentDate: NOW }),
    ).resolves.toMatchObject({ payload: { sub: "bot:old" } });
    const jwks = await rotated.getJwks();
    expect(jwks.keys.map((key) => key.kid)).toEqual([
      "active-2026",
      "previous-2025",
    ]);
    for (const key of jwks.keys) {
      expect(key).toMatchObject({ kty: "RSA", use: "sig", alg: "RS256" });
      expect(Object.keys(key)).not.toEqual(
        expect.arrayContaining(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]),
      );
    }
  });

  it("does not allow standard claims to be overridden", async () => {
    const oidc = provider();
    await expect(
      oidc.signIdToken({
        subject: "bot:123",
        claims: { iss: "https://attacker.example" },
      }),
    ).rejects.toMatchObject({ code: "RESERVED_CLAIM" });
    await expect(
      oidc.signIdToken({ subject: "bot:123", claims: { groups: ["admin"] } }),
    ).rejects.toMatchObject({ code: "RESERVED_CLAIM" });
  });

  it("normalizes a terminal issuer slash in signing and discovery metadata", async () => {
    const oidc = provider({ additionalClaimsSupported: ["service"] });
    expect(oidc.issuer).toBe("https://issuer.example.test");
    expect(oidc.getDiscoveryMetadata()).toMatchObject({
      issuer: "https://issuer.example.test",
      jwks_uri: "https://issuer.example.test/oauth2/jwks",
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(oidc.getDiscoveryMetadata().claims_supported).toEqual(
      expect.arrayContaining(["iss", "groups", "service"]),
    );
  });

  it("reports configuration errors without secret key material", () => {
    try {
      provider({ activeKey: { kid: "bad", privateKeyPem: "" } });
      throw new Error("expected provider construction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkloadOidcProviderError);
      expect((error as Error).message).not.toContain(activePem);
    }
  });
});
