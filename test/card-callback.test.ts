import { beforeAll, describe, expect, it, vi } from "vitest";
import { importPKCS8, SignJWT } from "jose";
import { canonicalJsonSha256, createWorkloadOidcVerifier, NIA_WORKLOAD_AUDIENCE, NIA_PLATFORM_SERVICE_SUBJECT } from "../src/auth/index.js";
import { createWorkloadOidcProvider, generateTestRsaKeyPair } from "../src/testing/index.js";
import { CardStatusError, cardActionRunning, postCardStatus } from "../src/cards/index.js";
const issuer = "https://teams.example", now = new Date("2026-11-10T00:00:00Z"), time = now.getTime() / 1000;
let key: Awaited<ReturnType<typeof importPKCS8>>;
let jwks: Awaited<ReturnType<ReturnType<typeof createWorkloadOidcProvider>["getJwks"]>>;
const base = { iss: issuer, sub: NIA_PLATFORM_SERVICE_SUBJECT, aud: NIA_WORKLOAD_AUDIENCE,
  iat: time, exp: time + 7200, principal_type: "service", token_use: "card_callback", confirmation_card_id: "build:1/2",
  context_server: "jenkins", context_config_sha256: "a".repeat(64),
  callback_url: `${issuer}/api/cards/build%3A1%2F2/webhook` };
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ ...base, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(key);
}
beforeAll(async () => {
  const signingKey = await generateTestRsaKeyPair(); key = await importPKCS8(signingKey.privateKeyPem, "RS256");
  jwks = await createWorkloadOidcProvider({ issuer, audience: NIA_WORKLOAD_AUDIENCE, tokenTtlSeconds: 300, activeKey: signingKey }).getJwks();
});
function verifier(seconds = 0) { return createWorkloadOidcVerifier({ issuer, jwks, now: () => new Date(now.getTime() + seconds * 1000) }); }
describe("card status callback", () => {
  it("works after 30 minutes, expires after two hours, and cannot authorize execution", async () => {
    const proof = await token();
    const callback = await verifier(1800).verifyCardCallbackContext({ callbackToken: proof }, { server: "jenkins", expectedCardId: "build:1/2" });
    expect(callback.callbackUrl).toBe(base.callback_url);
    await expect(verifier(7201).verifyCardCallbackContext({ callbackToken: proof }, { server: "jenkins" })).rejects.toThrow("expired");
    await expect(verifier().verifyHumanActionContext({ "nia/confirmationToken": proof }, { server: "jenkins", tool: "execute", arguments: {} })).rejects.toThrow();
  });
  it("rejects callback tokens older than 7200 seconds at context validation", async () => {
    const proof = await token();
    // JWT verification sees a valid token; context validation sees its age exceed the limit.
    const clock = vi.fn<() => Date>()
      .mockReturnValueOnce(now)
      .mockReturnValue(new Date(now.getTime() + 7201 * 1000));
    const auth = createWorkloadOidcVerifier({ issuer, jwks, now: clock });
    await expect(auth.verifyCardCallbackContext(
      { callbackToken: proof }, { server: "jenkins" },
    )).rejects.toThrow("Invalid card callback lifetime");
  });
  it.each([true, false])("rejects callback credentials as human contexts (confirmed=%s)", async confirmed => {
    const args = { buildNumber: 11 };
    const proof = await token({ exp: time + 300, human_confirmed: confirmed,
      confirmed_by: "65f000000000000000000001", confirmed_by_name: "Alice", jti: "callback-id",
      context_tool: "execute", context_arguments_sha256: canonicalJsonSha256(args) });
    await expect(verifier().verifyHumanActionContext({
      [confirmed ? "nia/confirmationToken" : "nia/viewerContextToken"]: proof,
    }, { server: "jenkins", tool: "execute", arguments: args, intent: confirmed ? "confirm" : "view" }))
      .rejects.toThrow("human context");
  });
  it("rejects confirmation tokens even within their execution lifetime", async () => {
    const proof = await token({ token_use: undefined, callback_url: undefined, human_confirmed: true, exp: time + 300 });
    await expect(verifier().verifyCardCallbackContext({ callbackToken: proof }, { server: "jenkins" })).rejects.toThrow("binding");
    await expect(verifier(301).verifyCardCallbackContext({ callbackToken: proof }, { server: "jenkins" })).rejects.toThrow("expired");
  });
  it("accepts MCP metadata and webhook dispatch envelopes with the same callback proof", async () => {
    const proof = await token();
    const expected = { server: "jenkins", expectedCardId: "build:1/2" };
    expect(await verifier().verifyCardCallbackContext({ "nia/cardCallbackToken": proof }, expected))
      .toEqual(await verifier().verifyCardCallbackContext({ callbackToken: proof }, expected));
  });
  it.each([undefined, {}, { callbackToken: "" }, { callbackToken: 42 }])("rejects missing or invalid callback tokens %j", async context => {
    await expect(verifier().verifyCardCallbackContext(context, { server: "jenkins" })).rejects.toThrow("token required");
  });
  it.each([{ iss: "https://evil.example" }, { sub: "other" }, { aud: "other" }, { principal_type: "workload" },
    { context_server: "other" }, { confirmation_card_id: "other" }, { context_config_sha256: undefined },
    { callback_url: "https://evil.example/steal" }, { token_use: "view" }, { token_use: "confirmation", human_confirmed: true }, { exp: time + 7201 }, { iat: time + 1 }, { iat: time + 0.5 },
    { iat: undefined }, { exp: time }, { exp: time - 1 }, { exp: time + 0.5 },
    { context_config_sha256: " " }, { confirmation_card_id: " " }])("rejects invalid bindings %j", async overrides => {
    await expect(verifier().verifyCardCallbackContext({ callbackToken: await token(overrides) }, { server: "jenkins", expectedCardId: "build:1/2" })).rejects.toThrow();
  });
  it("sends stage and terminal patches to one endpoint without redirects or leaking server errors", async () => {
    const callback = await verifier().verifyCardCallbackContext({ callbackToken: await token() }, { server: "jenkins" });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}'));
    await postCardStatus(callback, { status: "running", statusLabel: "Stage 2/4", result: { buildNumber: 11 } }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(base.callback_url, expect.objectContaining({ redirect: "error", method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${callback.token}` },
      body: JSON.stringify({ status: "running", statusLabel: "Stage 2/4", result: { buildNumber: 11 } }) }));
    fetchImpl.mockResolvedValue(new Response("sensitive details", { status: 401 }));
    await expect(postCardStatus(callback, { status: "failed", errorMessage: "Build failed" }, { fetchImpl })).rejects.toThrow("HTTP 401");
  });
  it("derives an absent callback URL from the trusted issuer", async () => {
    const callback = await verifier().verifyCardCallbackContext(
      { callbackToken: await token({ callback_url: undefined }) }, { server: "jenkins" });
    expect(callback.callbackUrl).toBe(base.callback_url);
  });
  it("forwards a caller signal and nullable labels and propagates transport errors", async () => {
    const callback = await verifier().verifyCardCallbackContext({ callbackToken: await token() }, { server: "jenkins" });
    const signal = new AbortController().signal;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const update = { status: "failed" as const, statusLabel: null, errorMessage: "Build failed" };
    await postCardStatus(callback, update, { signal, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(base.callback_url, expect.objectContaining({ signal, body: JSON.stringify(update) }));
    fetchImpl.mockRejectedValue(new TypeError("Network unavailable"));
    await expect(postCardStatus(callback, update, { fetchImpl })).rejects.toThrow("Network unavailable");
  });
  it.each([401, 403, 409, 500])("exposes HTTP %s and the response body without including it in the message", async status => {
    const callback = await verifier().verifyCardCallbackContext({ callbackToken: await token() }, { server: "jenkins" });
    const body = '{"error":"private rejection detail"}';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const error = await postCardStatus(callback, { status: "running" }, { fetchImpl }).catch(error => error);
    expect(error).toBeInstanceOf(CardStatusError);
    expect(error.status).toBe(status);
    expect(error.body).toBe(body);
    expect(error.message).toBe(`Card status callback failed (HTTP ${status})`);
    expect(error.message).not.toContain("private rejection detail");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("preserves HTTP status when a rejected response body cannot be read", async () => {
    const callback = await verifier().verifyCardCallbackContext({ callbackToken: await token() }, { server: "jenkins" });
    const response = new Response(null, { status: 409 });
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("Unreadable body"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(postCardStatus(callback, { status: "running" }, { fetchImpl })).rejects.toMatchObject({ status: 409, body: "" });
  });
  it("provides an explicit running result helper", () => {
    expect(cardActionRunning().content).toEqual([{ type: "text", text: "Action running" }]);
    expect(cardActionRunning({ text: "Queued" }).content).toEqual([{ type: "text", text: "Queued" }]);
    expect(cardActionRunning({ statusLabel: "Queued #11", result: { buildNumber: 11 } }).structuredContent)
      .toEqual({ ok: true, status: "running", statusLabel: "Queued #11", result: { buildNumber: 11 } });
  });
});
