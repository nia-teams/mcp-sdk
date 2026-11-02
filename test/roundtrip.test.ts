import { expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
} from "../src/cards/index.js";
import {
  createWorkloadOidcVerifier,
  NIA_DEFAULT_ISSUER,
  NIA_WORKLOAD_AUDIENCE,
} from "../src/auth/index.js";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "../src/testing/index.js";
it("round-trips a proposal and signed exact-card mutation over standard MCP", async () => {
  const provider = createWorkloadOidcProvider({
    issuer: NIA_DEFAULT_ISSUER,
    audience: NIA_WORKLOAD_AUDIENCE,
    tokenTtlSeconds: 300,
    activeKey: await generateTestRsaKeyPair(),
  });
  const verifier = createWorkloadOidcVerifier({
    jwks: await provider.getJwks(),
  });
  const server = new McpServer({ name: "demo", version: "1" });
  let applied = false;
  server.registerTool("propose", {}, async () =>
    cardToolResult(
      "Review",
      createMcpConfirmCard({
        cardId: "demo:1",
        title: "Apply",
        server: "demo",
        toolName: "apply",
        arguments: { id: 1 },
      }),
    ),
  );
  server.registerTool(
    "apply",
    { inputSchema: { id: z.number() } },
    async (args, extra) => {
      await verifier.verifyHumanActionContext(extra._meta, {
        server: "demo",
        tool: "apply",
        arguments: args,
        expectedCardId: "demo:1",
      });
      if (applied) throw new Error("Already applied"); // Durable CAS in a real datastore.
      applied = true;
      return cardActionSuccess();
    },
  );
  const client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    expect(
      (await client.callTool({ name: "propose" })).structuredContent,
    ).toMatchObject({ _niaCard: true, card: { id: "demo:1" } });
    expect(applied).toBe(false);
    expect(
      (await client.callTool({ name: "apply", arguments: { id: 1 } })).isError,
    ).toBe(true);
    const jwt = await signTestConfirmationToken(provider, {
      server: "demo",
      tool: "apply",
      arguments: { id: 1 },
      cardId: "demo:1",
    });
    const params = {
      name: "apply",
      arguments: { id: 1 },
      _meta: { "nia/confirmationToken": jwt },
    };
    expect((await client.callTool(params)).structuredContent).toEqual({
      ok: true,
      status: "success",
    });
    expect(applied).toBe(true);
    expect((await client.callTool(params)).isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
