import { beforeAll, describe, expect, it, vi } from "vitest";
import { importPKCS8, SignJWT, type JWTPayload } from "jose";
import {
  canonicalJsonSha256,
  createWorkloadOidcVerifier,
  NIA_DEFAULT_ISSUER,
  NIA_WORKLOAD_AUDIENCE,
  NIA_PLATFORM_SERVICE_SUBJECT,
} from "../src/auth/index.js";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
  signTestViewerContextToken,
  type WorkloadOidcProvider,
  type SigningKey,
} from "../src/testing/index.js";
const now = new Date("2026-10-01T12:00:00Z"),
  time = now.getTime() / 1000;
const expected = {
  server: "demo",
  tool: "apply",
  arguments: { id: 1, value: { b: 2, a: 1 } },
};
const input = { ...expected, cardId: "demo:1" };
let provider: WorkloadOidcProvider,
  key: SigningKey,
  verifier: ReturnType<typeof createWorkloadOidcVerifier>;
async function token(overrides: JWTPayload = {}) {
  return new SignJWT({
    iss: NIA_DEFAULT_ISSUER,
    aud: NIA_WORKLOAD_AUDIENCE,
    sub: "demo",
    principal_type: "workload",
    iat: time,
    nbf: time,
    exp: time + 300,
    jti: "test-jti",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .sign(await importPKCS8(key.privateKeyPem, "RS256"));
}
function humanClaims(): JWTPayload {
  return {
    sub: NIA_PLATFORM_SERVICE_SUBJECT,
    principal_type: "service",
    human_confirmed: true,
    confirmed_by: "0123456789abcdef01234567",
    confirmed_by_name: "Test User",
    confirmation_card_id: "demo:1",
    context_server: expected.server,
    context_tool: expected.tool,
    context_arguments_sha256: canonicalJsonSha256(expected.arguments),
  };
}
const source = {
  source_team_id: "0123456789abcdef01234567",
  source_team_subject: "demo",
  source_team_groups: ["team:demo", "role:reader"],
};
beforeAll(async () => {
  key = await generateTestRsaKeyPair();
  provider = createWorkloadOidcProvider({
    issuer: NIA_DEFAULT_ISSUER,
    audience: NIA_WORKLOAD_AUDIENCE,
    tokenTtlSeconds: 300,
    activeKey: key,
    now: () => now,
  });
  verifier = createWorkloadOidcVerifier({
    jwks: await provider.getJwks(),
    now: () => now,
  });
});
describe("workload verifier", () => {
  it("verifies RS256 and parses all group families", async () => {
    const jwt = await provider.signIdToken({
      subject: "demo",
      groups: [
        "team:demo",
        "org:example",
        "role:reader",
        "nia:elevated:role:operator",
      ],
      claims: { principal_type: "workload" },
    });
    expect(
      await verifier.verifyBearerHeader(`Bearer ${jwt}`, {
        allowedSubjects: ["demo"],
        requiredGroups: ["role:reader"],
      }),
    ).toMatchObject({
      subject: "demo",
      issuer: NIA_DEFAULT_ISSUER,
      principalType: "workload",
      teams: ["demo"],
      orgs: ["example"],
      roles: ["reader"],
      elevatedRoles: ["operator"],
    });
    await expect(
      verifier.verifyBearerHeader(`Bearer ${jwt}`, { allowedSubjects: [] }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      verifier.verifyBearerHeader(`Bearer ${jwt}`, {
        requiredGroups: ["role:writer"],
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it.each([undefined, "", "Basic abc", "Bearer ", "Bearer x y"])(
    "rejects missing/malformed bearer %s",
    async (header) => {
      await expect(verifier.verifyBearerHeader(header)).rejects.toMatchObject({
        statusCode: 401,
      });
    },
  );
  it.each([
    [{ exp: time - 1 }, 401],
    [{ aud: "wrong" }, 403],
    [{ iss: "https://other.example.com" }, 403],
    [{ nbf: time + 1 }, 403],
    [{ exp: undefined }, 403],
    [{ sub: "" }, 403],
    [{ principal_type: undefined }, 403],
    [{ groups: ["team:demo", 1] }, 403],
    [{ sub: NIA_PLATFORM_SERVICE_SUBJECT }, 403],
  ] as const)(
    "rejects invalid signed claims %j",
    async (claims, statusCode) => {
      await expect(
        verifier.verifyBearerHeader(
          `Bearer ${await token(claims as JWTPayload)}`,
        ),
      ).rejects.toMatchObject({ statusCode });
    },
  );
  it("rejects tampering, alg=none, and accepts service only by explicit opt-in", async () => {
    const jwt = await token({
      principal_type: "service",
      sub: NIA_PLATFORM_SERVICE_SUBJECT,
    });
    await expect(
      verifier.verifyBearerHeader(`Bearer ${jwt}`),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      verifier.verifyBearerHeader(`Bearer ${jwt}`, {
        allowServicePrincipal: true,
      }),
    ).resolves.toMatchObject({ principalType: "service" });
    const [h, p, s] = jwt.split(".");
    const bytes = Buffer.from(s!, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    for (const bad of [
      `${h}.${p}.${bytes.toString("base64url")}`,
      `${Buffer.from('{"alg":"none"}').toString("base64url")}.${p}.`,
    ]) {
      await expect(
        verifier.verifyBearerHeader(`Bearer ${bad}`),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  });
  it("uses official remote JWKS caching with injectable fetch and default URL", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(await provider.getJwks()), {
          headers: { "content-type": "application/json" },
        }),
    );
    const remote = createWorkloadOidcVerifier({ fetchImpl, now: () => now });
    const jwt = await token();
    await remote.verifyBearerHeader(`Bearer ${jwt}`);
    await remote.verifyBearerHeader(`Bearer ${jwt}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `${NIA_DEFAULT_ISSUER}/oauth2/jwks`,
    );
  });
});
describe("human contexts", () => {
  it("accepts canonical argument order and binds identity/card", async () => {
    const jwt = await signTestConfirmationToken(provider, {
      ...input,
      identityToken: "external-token",
    });
    expect(
      await verifier.verifyHumanActionContext(
        { "nia/confirmationToken": jwt, "nia/identityToken": "external-token" },
        { ...expected, expectedCardId: "demo:1" },
      ),
    ).toMatchObject({
      cardId: "demo:1",
      identityToken: "external-token",
      confirmedByName: "Test User",
    });
    await expect(
      verifier.verifyHumanActionContext(
        { "nia/confirmationToken": jwt },
        expected,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      verifier.verifyHumanActionContext(
        { "nia/confirmationToken": jwt, "nia/identityToken": "changed" },
        expected,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("separates confirm from view and never falls back to another meta key", async () => {
    const confirm = await signTestConfirmationToken(provider, input),
      view = await signTestViewerContextToken(provider, input);
    await expect(
      verifier.verifyHumanActionContext(
        { "nia/viewerContextToken": view },
        { ...expected, intent: "view" },
      ),
    ).resolves.toMatchObject({ cardId: "demo:1" });
    for (const meta of [
      undefined,
      { "nia/viewerContextToken": view },
      { "nia/confirmationToken": view },
    ])
      await expect(
        verifier.verifyHumanActionContext(meta, expected),
      ).rejects.toThrow();
    await expect(
      verifier.verifyHumanActionContext(
        { "nia/viewerContextToken": confirm },
        { ...expected, intent: "view" },
      ),
    ).rejects.toThrow();
  });
  it.each([
    { context_server: "other" },
    { context_tool: "other" },
    { context_arguments_sha256: "changed" },
    { iat: time - 301 },
    { iat: time + 1 },
    { iat: undefined },
    { iat: time + 0.5 },
    { exp: time + 301 },
    { exp: time - 1 },
    { nbf: time + 1 },
    { jti: "" },
    { confirmed_by: "" },
    { confirmed_by_name: " " },
    { confirmation_card_id: "" },
    { principal_type: "workload" },
    { sub: "demo" },
  ])("rejects context mutation %j", async (patch) => {
    const jwt = await token({ ...humanClaims(), ...patch });
    await expect(
      verifier.verifyHumanActionContext(
        { "nia/confirmationToken": jwt },
        expected,
      ),
    ).rejects.toThrow();
  });
  it("rejects tampered arguments, unexpected card, short max age, and unbound identity", async () => {
    const jwt = await signTestConfirmationToken(provider, input),
      meta = { "nia/confirmationToken": jwt };
    await expect(
      verifier.verifyHumanActionContext(meta, {
        ...expected,
        arguments: { id: 2 },
      }),
    ).rejects.toThrow();
    await expect(
      verifier.verifyHumanActionContext(meta, {
        ...expected,
        expectedCardId: "other",
      }),
    ).rejects.toThrow();
    await expect(
      verifier.verifyHumanActionContext(meta, {
        ...expected,
        maxAgeSeconds: 60,
      }),
    ).rejects.toThrow();
    await expect(
      verifier.verifyHumanActionContext(
        { ...meta, "nia/identityToken": "unbound" },
        expected,
      ),
    ).rejects.toThrow();
    await expect(
      verifier.verifyHumanActionContext(meta, {
        ...expected,
        maxAgeSeconds: 301,
      }),
    ).rejects.toThrow(TypeError);
  });
});
it("returns validated ordinary source Team claims on human confirmations", async () => {
  const jwt = await signTestConfirmationToken(provider, {
    ...input,
    claims: { ...source, source_team_role: "admin" },
  });
  expect(
    await verifier.verifyHumanActionContext(
      { "nia/confirmationToken": jwt },
      expected,
    ),
  ).toMatchObject({
    sourceTeam: {
      id: source.source_team_id,
      subject: "demo",
      groups: source.source_team_groups,
      role: "admin",
    },
  });
  const bad = await signTestConfirmationToken(provider, {
    ...input,
    claims: { ...source, source_team_groups: ["team:other"] },
  });
  await expect(
    verifier.verifyHumanActionContext(
      { "nia/confirmationToken": bad },
      expected,
    ),
  ).rejects.toThrow();
});

describe("source context", () => {
  const context = () => ({
    sub: NIA_PLATFORM_SERVICE_SUBJECT,
    principal_type: "service",
    ...source,
    context_server: expected.server,
    context_tool: expected.tool,
    context_arguments_sha256: canonicalJsonSha256(expected.arguments),
  });
  it("validates service, ordinary App and explicit elevated App source contexts", async () => {
    for (const claims of [
      context(),
      {
        ...context(),
        principal_type: "workload",
        sub: "demo",
        groups: source.source_team_groups,
        human_actor_user_id: source.source_team_id,
      },
      {
        ...context(),
        principal_type: "workload",
        sub: "role:reader:elevated",
        groups: ["role:reader", "nia:elevated:role:reader"],
        human_app_elevation: true,
        human_actor_user_id: source.source_team_id,
      },
    ]) {
      expect(
        await verifier.verifySourceContext(
          { "nia/sourceContextToken": await token(claims) },
          expected,
        ),
      ).toMatchObject({
        sourceTeam: { subject: "demo", groups: source.source_team_groups },
      });
    }
  });
  it.each([
    { source_team_id: "invalid" },
    { source_team_subject: NIA_PLATFORM_SERVICE_SUBJECT },
    { source_team_groups: ["nia:elevated:role:reader"] },
    { source_team_groups: ["team:other"] },
    { human_actor_user_id: "invalid" },
    { context_tool: "other" },
    { iat: time - 301 },
    { jti: "" },
    { sub: "demo", principal_type: "workload" },
    {
      sub: "role:reader:elevated",
      principal_type: "workload",
      human_actor_user_id: source.source_team_id,
    },
  ])("rejects bad source %j", async (patch) => {
    await expect(
      verifier.verifySourceContext(
        { "nia/sourceContextToken": await token({ ...context(), ...patch }) },
        expected,
      ),
    ).rejects.toThrow();
  });
});
