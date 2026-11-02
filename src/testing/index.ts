import { createHash } from "node:crypto";
import { exportPKCS8, generateKeyPair } from "jose";
import {
  canonicalJsonSha256,
  NIA_PLATFORM_SERVICE_SUBJECT,
} from "../auth/index.js";
import type { SigningKey, WorkloadOidcProvider } from "./provider.js";
export * from "./provider.js";

/** Generates an ephemeral test-only RSA key; never use it as a persisted production key. */
export async function generateTestRsaKeyPair(
  kid = "test-key",
): Promise<SigningKey> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return { kid, privateKeyPem: await exportPKCS8(privateKey) };
}
export interface TestHumanContextOptions {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  cardId: string;
  confirmedBy?: string;
  confirmedByName?: string;
  identityToken?: string;
  /** Extra claims are useful for negative tests; protocol fields take precedence. */
  claims?: Record<string, unknown>;
}
function signHumanContext(
  provider: WorkloadOidcProvider,
  options: TestHumanContextOptions,
  confirmed: boolean,
): Promise<string> {
  return provider.signIdToken({
    subject: NIA_PLATFORM_SERVICE_SUBJECT,
    claims: {
      ...options.claims,
      principal_type: "service",
      human_confirmed: confirmed,
      confirmed_by: options.confirmedBy ?? "0123456789abcdef01234567",
      confirmed_by_name: options.confirmedByName ?? "Test User",
      confirmation_card_id: options.cardId,
      context_server: options.server,
      context_tool: options.tool,
      context_arguments_sha256: canonicalJsonSha256(options.arguments),
      ...(options.identityToken !== undefined
        ? {
            context_identity_token_sha256: createHash("sha256")
              .update(options.identityToken)
              .digest("hex"),
          }
        : {}),
    },
  });
}
/** Configure the provider with tokenTtlSeconds <= 300 for bounded human contexts. */
export function signTestConfirmationToken(
  provider: WorkloadOidcProvider,
  options: TestHumanContextOptions,
): Promise<string> {
  return signHumanContext(provider, options, true);
}
export function signTestViewerContextToken(
  provider: WorkloadOidcProvider,
  options: TestHumanContextOptions,
): Promise<string> {
  return signHumanContext(provider, options, false);
}
