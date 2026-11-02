/**
 * Pure, in-process workload OIDC issuer primitives. Configuration and key
 * acquisition deliberately belong to the consuming service, not this package.
 */
import { randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  exportJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWK,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyOptions,
} from "jose";

const ALGORITHM = "RS256" as const;
const STANDARD_CLAIMS = [
  "iss",
  "sub",
  "aud",
  "iat",
  "nbf",
  "exp",
  "jti",
  "groups",
] as const;
const RESERVED_CLAIMS = new Set<string>(STANDARD_CLAIMS);

type PublicJwk = Pick<JWK, "kty" | "n" | "e"> & {
  kid: string;
  use: "sig";
  alg: typeof ALGORITHM;
};

export class WorkloadOidcProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkloadOidcProviderError";
    this.code = code;
  }
}

export interface SigningKey {
  /** Stable key identifier published as JWT `kid`. */
  kid: string;
  /** RSA private key in PKCS#8 PEM format. It is never returned or logged. */
  privateKeyPem: string;
}

export interface WorkloadOidcProviderOptions {
  issuer: string;
  audience: string | readonly string[];
  tokenTtlSeconds: number;
  activeKey: SigningKey;
  previousKey?: SigningKey;
  /** Additional, stable claim names to advertise in discovery metadata. */
  additionalClaimsSupported?: readonly string[];
  /** Injectable clock for deterministic hosts/tests. Defaults to the system clock. */
  now?: () => Date;
}

export interface SignWorkloadIdTokenOptions {
  subject: string;
  groups?: readonly string[];
  /** Private application claims. Standard and `groups` claims cannot be supplied here. */
  claims?: Record<string, unknown>;
}

export interface VerifyWorkloadIdTokenOptions {
  /** Overrides the provider's configured audience for this verification only. */
  audience?: string | readonly string[];
  /** Enables deterministic verification; defaults to the system clock. */
  currentDate?: Date;
  clockToleranceSeconds?: number;
}

export interface WorkloadOidcDiscoveryMetadata {
  issuer: string;
  jwks_uri: string;
  response_types_supported: ["id_token"];
  subject_types_supported: ["public"];
  id_token_signing_alg_values_supported: [typeof ALGORITHM];
  claims_supported: string[];
}

export interface VerifiedWorkloadIdToken {
  payload: JWTPayload;
  protectedHeader: { alg?: string; kid?: string; typ?: string };
}

interface ProviderState {
  activeKey: CryptoKey;
  activeKid: string;
  publicJwks: PublicJwk[];
  jwks: ReturnType<typeof createLocalJWKSet>;
}

function fail(code: string, message: string): never {
  throw new WorkloadOidcProviderError(code, message);
}

/** Remove terminal slashes so discovery, signatures, and verification agree. */
export function normalizeIssuer(issuer: string): string {
  const normalized = issuer.trim().replace(/\/+$/, "");
  if (!normalized || !/^https?:\/\//i.test(normalized)) {
    fail("INVALID_ISSUER", "issuer must be an absolute http(s) URL");
  }
  return normalized;
}

function validateKey(
  name: string,
  key: SigningKey | undefined,
): asserts key is SigningKey {
  if (!key || !key.kid.trim() || !key.privateKeyPem.trim()) {
    fail(
      "INVALID_KEY",
      `${name} requires a non-empty kid and PKCS#8 privateKeyPem`,
    );
  }
}

function validateOptions(options: WorkloadOidcProviderOptions): void {
  normalizeIssuer(options.issuer);
  const audiences = Array.isArray(options.audience)
    ? options.audience
    : [options.audience];
  if (!audiences.length || audiences.some((audience) => !audience.trim())) {
    fail(
      "INVALID_AUDIENCE",
      "audience must contain at least one non-empty value",
    );
  }
  if (
    !Number.isFinite(options.tokenTtlSeconds) ||
    options.tokenTtlSeconds <= 0
  ) {
    fail("INVALID_TTL", "tokenTtlSeconds must be a positive number");
  }
  validateKey("activeKey", options.activeKey);
  if (options.previousKey) validateKey("previousKey", options.previousKey);
  if (options.previousKey?.kid === options.activeKey.kid) {
    fail("INVALID_KEY", "activeKey and previousKey must use different kids");
  }
}

async function makePublicKey(
  key: SigningKey,
): Promise<{ key: CryptoKey; jwk: PublicJwk }> {
  try {
    const privateKey = (await importPKCS8(key.privateKeyPem, ALGORITHM, {
      extractable: true,
    })) as CryptoKey;
    const exported = await exportJWK(privateKey);
    if (!exported.kty || !exported.n || !exported.e)
      fail("INVALID_KEY", `key ${key.kid} is not an RSA signing key`);
    return {
      key: privateKey,
      jwk: {
        kty: exported.kty,
        n: exported.n,
        e: exported.e,
        kid: key.kid,
        use: "sig",
        alg: ALGORITHM,
      },
    };
  } catch (error) {
    if (error instanceof WorkloadOidcProviderError) throw error;
    // Do not expose parser details: some crypto implementations include key input in errors.
    throw new WorkloadOidcProviderError(
      "INVALID_KEY",
      `could not import PKCS#8 RSA signing key ${key.kid}`,
    );
  }
}

/**
 * Creates a workload ID-token issuer. RSA keys are imported only on first
 * signing, JWKS, or verification operation, then cached for this instance.
 */
export function createWorkloadOidcProvider(
  options: WorkloadOidcProviderOptions,
) {
  validateOptions(options);
  const issuer = normalizeIssuer(options.issuer);
  const configuredAudience = options.audience;
  const ttl = options.tokenTtlSeconds;
  const clock = options.now ?? (() => new Date());
  const claimsSupported = [
    ...new Set([
      ...STANDARD_CLAIMS,
      ...(options.additionalClaimsSupported ?? []),
    ]),
  ];
  let statePromise: Promise<ProviderState> | undefined;

  const getState = (): Promise<ProviderState> => {
    statePromise ??= (async () => {
      const active = await makePublicKey(options.activeKey);
      const publicJwks = [active.jwk];
      if (options.previousKey)
        publicJwks.push((await makePublicKey(options.previousKey)).jwk);
      return {
        activeKey: active.key,
        activeKid: options.activeKey.kid,
        publicJwks,
        jwks: createLocalJWKSet({ keys: publicJwks }),
      };
    })();
    return statePromise;
  };

  return Object.freeze({
    issuer,
    async signIdToken(input: SignWorkloadIdTokenOptions): Promise<string> {
      if (!input.subject?.trim())
        fail("INVALID_SUBJECT", "subject must be non-empty");
      for (const claim of Object.keys(input.claims ?? {})) {
        if (RESERVED_CLAIMS.has(claim))
          fail(
            "RESERVED_CLAIM",
            `claim ${claim} is managed by the provider and cannot be overridden`,
          );
      }
      const state = await getState();
      const now = Math.floor(clock().getTime() / 1000);
      const payload = {
        ...(input.claims ?? {}),
        ...(input.groups ? { groups: [...input.groups] } : {}),
      };
      return new SignJWT(payload)
        .setProtectedHeader({
          alg: ALGORITHM,
          typ: "JWT",
          kid: state.activeKid,
        })
        .setIssuer(issuer)
        .setSubject(input.subject)
        .setAudience(configuredAudience as string | string[])
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + ttl)
        .setJti(randomUUID())
        .sign(state.activeKey);
    },
    async getJwks(): Promise<{ keys: PublicJwk[] }> {
      const { publicJwks } = await getState();
      // Return fresh objects so callers cannot mutate the cached verification set.
      return { keys: publicJwks.map((jwk) => ({ ...jwk })) };
    },
    getDiscoveryMetadata(): WorkloadOidcDiscoveryMetadata {
      return {
        issuer,
        jwks_uri: `${issuer}/oauth2/jwks`,
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: [ALGORITHM],
        claims_supported: [...claimsSupported],
      };
    },
    async verifyIdToken(
      token: string,
      verifyOptions: VerifyWorkloadIdTokenOptions = {},
    ): Promise<VerifiedWorkloadIdToken> {
      if (!token || typeof token !== "string")
        fail("INVALID_TOKEN", "token must be a non-empty JWT string");
      try {
        const result = await jwtVerify(token, (await getState()).jwks, {
          algorithms: [ALGORITHM],
          issuer,
          audience: (verifyOptions.audience ??
            configuredAudience) as JWTVerifyOptions["audience"],
          currentDate: verifyOptions.currentDate,
          clockTolerance: verifyOptions.clockToleranceSeconds,
        });
        return {
          payload: result.payload,
          protectedHeader: result.protectedHeader,
        };
      } catch (error) {
        // Token/parser errors are intentionally not surfaced: callers can log this safe code/message.
        throw new WorkloadOidcProviderError(
          "TOKEN_VERIFICATION_FAILED",
          "workload ID token verification failed",
        );
      }
    },
  });
}

export type WorkloadOidcProvider = ReturnType<
  typeof createWorkloadOidcProvider
>;
