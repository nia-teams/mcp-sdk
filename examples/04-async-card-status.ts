import assert from "node:assert/strict";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
import { cardActionRunning, postCardStatus } from "@nia-teams/mcp-sdk/cards";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";

// Offline fixtures: no business mutation or request to Nia Teams occurs here.
const issuer = "https://teams.example";
const activeKey = await generateTestRsaKeyPair();
const executionProvider = createWorkloadOidcProvider({
  issuer, audience: "nia-teams-workload", tokenTtlSeconds: 300, activeKey,
});
const statusProvider = createWorkloadOidcProvider({
  issuer, audience: "nia-teams-workload", tokenTtlSeconds: 7200, activeKey,
});
const auth = createWorkloadOidcVerifier({
  issuer, jwks: await executionProvider.getJwks(),
});
const args = { buildNumber: 11 };
const binding = {
  server: "jenkins", tool: "execute_build", arguments: args, cardId: "build:11",
};
const meta = {
  "nia/confirmationToken": await signTestConfirmationToken(executionProvider, binding),
  "nia/cardCallbackToken": await statusProvider.signIdToken({
    subject: "nia-teams-platform",
    claims: {
      principal_type: "service", token_use: "card_callback",
      confirmation_card_id: binding.cardId, context_server: binding.server,
      context_config_sha256: "a".repeat(64),
    },
  }),
};
const human = await auth.verifyHumanActionContext(meta, {
  ...binding, expectedCardId: binding.cardId,
});
// Production executors recheck business permissions and enqueue with durable CAS.
assert.equal(human.confirmedBy, "0123456789abcdef01234567");
const callback = await auth.verifyCardCallbackContext(meta, {
  server: binding.server, expectedCardId: human.cardId,
});
const queued = cardActionRunning({ statusLabel: "Queued #11", result: args });
assert.equal(queued.structuredContent?.status, "running");

// A worker loads the verified callback from private job storage.
const updates: unknown[] = [];
const fetchImpl: typeof fetch = async (url, init) => {
  assert.equal(url, "https://teams.example/api/cards/build%3A11/webhook");
  assert.equal(init?.redirect, "error");
  assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${callback.token}`);
  updates.push(JSON.parse(String(init?.body)));
  return new Response(null, { status: 204 });
};
await postCardStatus(callback, {
  status: "running", statusLabel: "Stage 2/4",
}, { fetchImpl });
await postCardStatus(callback, {
  status: "success", statusLabel: "Build succeeded #11", result: args,
}, { fetchImpl });
assert.equal(updates.length, 2);
console.log("Verified confirmation, queued result, and two mocked status updates.");
