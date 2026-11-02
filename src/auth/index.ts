import { createHash } from "node:crypto";
import {
  createRemoteJWKSet,
  createLocalJWKSet,
  customFetch,
  jwtVerify,
  errors,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { canonicalJsonSha256 } from "../canonical-json.js";
export { canonicalJson, canonicalJsonSha256 } from "../canonical-json.js";

export const NIA_DEFAULT_ISSUER = "https://nia-teams.com";
export const NIA_WORKLOAD_AUDIENCE = "nia-teams-workload";
export const NIA_PLATFORM_SERVICE_SUBJECT = "nia-teams-platform";

/** Safe HTTP-facing error. Never includes a token or raw JOSE parser details. */
export class WorkloadOidcError extends Error {
  constructor(
    readonly statusCode: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "WorkloadOidcError";
  }
}
export interface WorkloadOidcVerifierOptions {
  issuer?: string;
  audience?: string | string[];
  jwksUrl?: string;
  jwks?: JSONWebKeySet;
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic offline verification. */
  now?: () => Date;
}
export interface WorkloadAuthorizationOptions {
  allowedSubjects?: readonly string[];
  requiredGroups?: readonly string[];
  allowServicePrincipal?: boolean;
}
export interface VerifiedWorkloadIdentity {
  issuer: string;
  subject: string;
  principalType: "workload" | "service";
  groups: string[];
  teams: string[];
  orgs: string[];
  roles: string[];
  elevatedRoles: string[];
  claims: JWTPayload;
}
export interface ExpectedCallContext {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  maxAgeSeconds?: number;
}
export interface ExpectedHumanActionContext extends ExpectedCallContext {
  intent?: "confirm" | "view";
  expectedCardId?: string;
}
export interface VerifiedSourceTeam {
  id: string;
  subject: string;
  groups: string[];
  role?: "owner" | "admin" | "member";
}
export interface VerifiedHumanActionContext {
  confirmedBy: string;
  confirmedByName: string;
  cardId: string;
  jti: string;
  identityToken?: string;
  sourceTeam?: VerifiedSourceTeam;
  claims: JWTPayload;
}
export interface VerifiedSourceContext {
  sourceTeam: VerifiedSourceTeam;
  humanActorUserId?: string;
  jti: string;
  claims: JWTPayload;
}
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim();
function forbidden(message: string): never {
  throw new WorkloadOidcError(403, message);
}
function service(claims: JWTPayload): boolean {
  return (
    claims.sub === NIA_PLATFORM_SERVICE_SUBJECT &&
    claims.principal_type === "service"
  );
}
function sourceTeam(claims: JWTPayload): VerifiedSourceTeam {
  const id = claims.source_team_id,
    subject = claims.source_team_subject,
    groups = claims.source_team_groups;
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{24}$/.test(id) ||
    typeof subject !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(subject) ||
    subject === NIA_PLATFORM_SERVICE_SUBJECT ||
    (/^[a-f0-9]{24}$/.test(subject) && subject !== id) ||
    !Array.isArray(groups) ||
    !groups.every((g): g is string => typeof g === "string") ||
    !groups.includes(`team:${subject}`) ||
    groups.some(
      (g) =>
        !/^(team:|org:|role:).+/.test(g) ||
        (g.startsWith("role:") && g.endsWith(":elevated")),
    )
  ) {
    forbidden("Invalid source Team binding");
  }
  const role = claims.source_team_role;
  if (
    role !== undefined &&
    role !== "owner" &&
    role !== "admin" &&
    role !== "member"
  )
    forbidden("Invalid source Team role");
  return { id, subject, groups: [...groups], ...(role ? { role } : {}) };
}

export function createWorkloadOidcVerifier(
  options: WorkloadOidcVerifierOptions = {},
) {
  const issuer = (options.issuer ?? NIA_DEFAULT_ISSUER)
    .trim()
    .replace(/\/+$/, "");
  const audience = options.audience ?? NIA_WORKLOAD_AUDIENCE;
  const now = options.now ?? (() => new Date());
  const jwks = options.jwks
    ? createLocalJWKSet(options.jwks)
    : createRemoteJWKSet(new URL(options.jwksUrl ?? `${issuer}/oauth2/jwks`), {
        ...(options.fetchImpl ? { [customFetch]: options.fetchImpl } : {}),
        cooldownDuration: 30_000,
        cacheMaxAge: 3_600_000,
      });
  async function verify(token: unknown): Promise<JWTPayload> {
    if (!nonempty(token))
      throw new WorkloadOidcError(401, "Signed OIDC token required");
    try {
      return (
        await jwtVerify(token, jwks, {
          issuer,
          audience,
          algorithms: ["RS256"],
          currentDate: now(),
          requiredClaims: ["sub", "exp"],
        })
      ).payload;
    } catch (error) {
      if (error instanceof errors.JWTExpired)
        throw new WorkloadOidcError(401, "OIDC token expired");
      if (error instanceof errors.JOSEError) forbidden("Invalid OIDC token");
      throw error;
    }
  }
  function checkContext(claims: JWTPayload, expected: ExpectedCallContext) {
    const age = expected.maxAgeSeconds ?? 300;
    if (!Number.isFinite(age) || age <= 0 || age > 300)
      throw new TypeError("maxAgeSeconds must be in (0, 300]");
    const time = Math.floor(now().getTime() / 1000),
      iat = claims.iat,
      exp = claims.exp;
    if (
      !Number.isInteger(iat) ||
      !Number.isInteger(exp) ||
      iat! > time ||
      exp! <= time ||
      exp! <= iat! ||
      exp! - iat! > age ||
      time - iat! > age
    )
      forbidden("Invalid context lifetime (maximum five minutes)");
    if (!nonempty(claims.jti)) forbidden("Context jti required");
    if (
      claims.context_server !== expected.server ||
      claims.context_tool !== expected.tool ||
      claims.context_arguments_sha256 !==
        canonicalJsonSha256(expected.arguments)
    )
      forbidden("Context tool or arguments mismatch");
  }
  return {
    async verifyBearerHeader(
      header: string | undefined,
      opts: WorkloadAuthorizationOptions = {},
    ): Promise<VerifiedWorkloadIdentity> {
      const match =
        typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
      if (!match)
        throw new WorkloadOidcError(401, "Bearer OIDC token required");
      const claims = await verify(match[1]);
      if (!nonempty(claims.sub)) forbidden("OIDC subject required");
      const principalType = claims.principal_type;
      if (principalType !== "workload" && principalType !== "service")
        forbidden("Invalid principal type");
      if (claims.sub === NIA_PLATFORM_SERVICE_SUBJECT && !service(claims))
        forbidden("Reserved platform subject");
      if (principalType === "service" && !opts.allowServicePrincipal)
        forbidden("Workload principal required");
      if (opts.allowedSubjects && !opts.allowedSubjects.includes(claims.sub))
        forbidden("Workload subject is not allowed");
      if (
        claims.groups !== undefined &&
        (!Array.isArray(claims.groups) ||
          !claims.groups.every((g) => typeof g === "string"))
      )
        forbidden("Invalid workload groups");
      const groups = (claims.groups ?? []) as string[];
      if (opts.requiredGroups?.some((g) => !groups.includes(g)))
        forbidden("Required workload group missing");
      const extract = (prefix: string) => [
        ...new Set(
          groups
            .filter((g) => g.startsWith(prefix) && g.length > prefix.length)
            .map((g) => g.slice(prefix.length)),
        ),
      ];
      return {
        issuer,
        subject: claims.sub,
        principalType,
        groups: [...groups],
        teams: extract("team:"),
        orgs: extract("org:"),
        roles: extract("role:"),
        elevatedRoles: extract("nia:elevated:role:"),
        claims,
      };
    },
    async verifyHumanActionContext(
      meta: Record<string, unknown> | undefined,
      expected: ExpectedHumanActionContext,
    ): Promise<VerifiedHumanActionContext> {
      const confirmed = expected.intent !== "view";
      const claims = await verify(
        meta?.[confirmed ? "nia/confirmationToken" : "nia/viewerContextToken"],
      );
      if (!service(claims)) forbidden("Platform service context required");
      checkContext(claims, expected);
      if (
        claims.human_confirmed !== confirmed ||
        !nonempty(claims.confirmed_by) ||
        !nonempty(claims.confirmed_by_name) ||
        !nonempty(claims.confirmation_card_id)
      )
        forbidden("Invalid human or card binding");
      if (
        expected.expectedCardId !== undefined &&
        claims.confirmation_card_id !== expected.expectedCardId
      )
        forbidden("Confirmation card mismatch");
      const identityToken = meta?.["nia/identityToken"];
      if (
        identityToken !== undefined ||
        claims.context_identity_token_sha256 !== undefined
      ) {
        if (
          !nonempty(identityToken) ||
          claims.context_identity_token_sha256 !==
            createHash("sha256").update(identityToken, "utf8").digest("hex")
        )
          forbidden("Bound identity token missing or digest mismatch");
      }
      const hasSource = [
        "source_team_id",
        "source_team_subject",
        "source_team_groups",
      ].some((key) => claims[key] !== undefined);
      return {
        confirmedBy: claims.confirmed_by,
        confirmedByName: claims.confirmed_by_name,
        cardId: claims.confirmation_card_id,
        jti: claims.jti!,
        ...(typeof identityToken === "string" ? { identityToken } : {}),
        ...(hasSource ? { sourceTeam: sourceTeam(claims) } : {}),
        claims,
      };
    },
    async verifySourceContext(
      meta: Record<string, unknown> | undefined,
      expected: ExpectedCallContext,
    ): Promise<VerifiedSourceContext> {
      const claims = await verify(meta?.["nia/sourceContextToken"]);
      checkContext(claims, expected);
      const source = sourceTeam(claims);
      const actor = claims.human_actor_user_id;
      if (
        actor !== undefined &&
        (typeof actor !== "string" || !/^[a-f0-9]{24}$/i.test(actor))
      )
        forbidden("Invalid human actor");
      // Production uses service contexts for AI calls, ordinary workload contexts for App calls.
      const ordinaryApp =
        claims.principal_type === "workload" &&
        claims.sub === source.subject &&
        typeof actor === "string" &&
        Array.isArray(claims.groups) &&
        claims.groups.length === source.groups.length &&
        new Set(claims.groups).size === new Set(source.groups).size &&
        claims.groups.every(
          (g) => typeof g === "string" && source.groups.includes(g),
        );
      const elevatedRole =
        typeof claims.sub === "string"
          ? /^role:(.+):elevated$/.exec(claims.sub)?.[1]
          : undefined;
      const elevatedApp =
        claims.principal_type === "workload" &&
        typeof actor === "string" &&
        claims.human_app_elevation === true &&
        elevatedRole &&
        source.groups.includes(`role:${elevatedRole}`) &&
        Array.isArray(claims.groups) &&
        claims.groups.length === 2 &&
        claims.groups.includes(`role:${elevatedRole}`) &&
        claims.groups.includes(`nia:elevated:role:${elevatedRole}`);
      if (!service(claims) && !ordinaryApp && !elevatedApp)
        forbidden("Invalid source context principal");
      return {
        sourceTeam: source,
        ...(typeof actor === "string" ? { humanActorUserId: actor } : {}),
        jti: claims.jti!,
        claims,
      };
    },
  };
}
export type WorkloadOidcVerifier = ReturnType<
  typeof createWorkloadOidcVerifier
>;
