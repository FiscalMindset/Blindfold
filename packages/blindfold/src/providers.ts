/**
 * Blindfold provider registry — concrete, first-class integrations.
 *
 * This is deliberately NOT a generic passthrough. Each entry is a real,
 * named provider with its exact upstream host, the logical name of the sealed
 * secret it uses, and — crucially — the *auth scheme* the enclave must apply.
 *
 * Three schemes, matching contract/src/forward.rs:
 *   - bearer : `Authorization: Bearer <secret>`  (sentinel swap)
 *   - basic  : `Authorization: Basic base64(user:secret)`  (computed in-enclave)
 *   - sigv4  : AWS Signature Version 4  (secret SIGNS the request, never sent)
 *
 * The basic/sigv4 providers are the proof that Blindfold is properly
 * provider-aware: for those, the raw secret is *consumed by a computation*
 * inside TDX, so it never exists as a standalone header value anywhere.
 */

/** Auth descriptor resolved for a single outbound request. Serialises 1:1 into
 * the contract's tagged `AuthSpec` enum. */
export type ForwardAuth =
  | { scheme: "bearer" }
  | { scheme: "basic"; username: string }
  | { scheme: "sigv4"; access_key_id: string; region: string; service: string; amz_date: string };

/** For bearer providers: which header carries the sentinel, and its prefix.
 * Defaults to Authorization / "Bearer ". Google Gemini uses `x-goog-api-key`
 * with no prefix — a real, distinct industry auth pattern (API key in a
 * provider-specific header, not `Authorization`). */
export interface SentinelHeader {
  name: string;
  prefix: string;
}

export interface ResolvedProvider {
  /** Provider id for telemetry, e.g. "stripe". */
  id: string;
  /** Absolute upstream URL to call. */
  upstream: string;
  /** Sealed-secret name. `undefined` → use the proxy's default secret_key
   *  (preserves back-compat for the OpenAI-shaped LLM providers). */
  secretKey?: string;
  /** How the enclave should authenticate this request. */
  auth: ForwardAuth;
  /** Bearer-only: header to plant the sentinel in. Defaults to Authorization. */
  sentinelHeader?: SentinelHeader;
}

interface ProviderDef {
  id: string;
  /** Path prefix the agent hits on the local proxy, e.g. "/stripe/". */
  prefix: string;
  /** Build the real upstream URL from the incoming proxy path. */
  upstream: (path: string) => string;
  secretKey?: string;
  /** Resolve the auth descriptor (may read non-secret config from env). */
  auth: () => ForwardAuth;
  /** Bearer-only override for where the sentinel goes. */
  sentinelHeader?: SentinelHeader;
}

/** AWS-style timestamp `YYYYMMDDTHHMMSSZ` (UTC). Not a secret — the enclave has
 * no wall clock, so the caller supplies it. */
export function amzDate(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

const awsRegion = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const awsAccessKeyId = () => process.env.AWS_ACCESS_KEY_ID || "";

/** Strip a leading `/<segment>` from the path (e.g. "/stripe/v1/x" → "/v1/x"). */
function stripPrefix(path: string, prefix: string): string {
  const rest = path.slice(prefix.length - 1); // keep the leading slash
  return rest.startsWith("/") ? rest : `/${rest}`;
}

const PROVIDERS: ProviderDef[] = [
  // ---- LLM providers (OpenAI-shaped, bearer). Back-compatible. --------------
  { id: "openai", prefix: "/v1/", upstream: (p) => `https://api.openai.com${p}`, auth: () => ({ scheme: "bearer" }) },
  { id: "openai", prefix: "/openai/", upstream: (p) => `https://api.openai.com${stripPrefix(p, "/openai/")}`, auth: () => ({ scheme: "bearer" }) },
  { id: "anthropic", prefix: "/anthropic/", upstream: (p) => `https://api.anthropic.com${stripPrefix(p, "/anthropic/")}`, auth: () => ({ scheme: "bearer" }) },
  { id: "xai", prefix: "/x/", upstream: (p) => `https://api.x.ai${stripPrefix(p, "/x/")}`, auth: () => ({ scheme: "bearer" }) },
  { id: "groq", prefix: "/groq/", upstream: (p) => `https://api.groq.com/openai${stripPrefix(p, "/groq/")}`, auth: () => ({ scheme: "bearer" }) },

  // ---- LLM: Google Gemini (native API — key rides in `x-goog-api-key`). ------
  // Not OpenAI-shaped and NOT `Authorization: Bearer`. The sentinel is planted
  // in Google's provider-specific header and swapped for the sealed key inside
  // the enclave — proving Blindfold handles a provider's real auth convention,
  // not just the one bearer shape.
  {
    id: "gemini",
    prefix: "/gemini/",
    upstream: (p) => `https://generativelanguage.googleapis.com${stripPrefix(p, "/gemini/")}`,
    secretKey: "gemini_api_key",
    auth: () => ({ scheme: "bearer" }),
    sentinelHeader: { name: "x-goog-api-key", prefix: "" },
  },

  // ---- Payments: Stripe (bearer, restricted keys, form-encoded bodies). -----
  {
    id: "stripe",
    prefix: "/stripe/",
    upstream: (p) => `https://api.stripe.com${stripPrefix(p, "/stripe/")}`,
    secretKey: "stripe_secret_key",
    auth: () => ({ scheme: "bearer" }),
  },

  // ---- Dev infra: GitHub (bearer token). ------------------------------------
  {
    id: "github",
    prefix: "/github/",
    upstream: (p) => `https://api.github.com${stripPrefix(p, "/github/")}`,
    secretKey: "github_token",
    auth: () => ({ scheme: "bearer" }),
  },

  // ---- Email: SendGrid (bearer). --------------------------------------------
  {
    id: "sendgrid",
    prefix: "/sendgrid/",
    upstream: (p) => `https://api.sendgrid.com${stripPrefix(p, "/sendgrid/")}`,
    secretKey: "sendgrid_api_key",
    auth: () => ({ scheme: "bearer" }),
  },

  // ---- Comms: Slack (bearer bot token). -------------------------------------
  {
    id: "slack",
    prefix: "/slack/",
    upstream: (p) => `https://slack.com/api${stripPrefix(p, "/slack/")}`,
    secretKey: "slack_bot_token",
    auth: () => ({ scheme: "bearer" }),
  },

  // ---- Telephony: Twilio (HTTP Basic — base64 computed IN the enclave). -----
  // Username = Account SID (not secret; also appears in the URL path). The
  // sealed secret is the Auth Token. A generic proxy CANNOT do this: the
  // base64 must be computed after the secret is joined, inside TDX.
  {
    id: "twilio",
    prefix: "/twilio/",
    upstream: (p) => `https://api.twilio.com${stripPrefix(p, "/twilio/")}`,
    secretKey: "twilio_auth_token",
    auth: () => ({ scheme: "basic", username: process.env.TWILIO_ACCOUNT_SID || "" }),
  },

  // ---- Cloud: AWS SES (SigV4 — secret SIGNS, never transmitted). ------------
  {
    id: "aws-ses",
    prefix: "/aws/ses/",
    upstream: (p) => `https://email.${awsRegion()}.amazonaws.com${stripPrefix(p, "/aws/ses/")}`,
    secretKey: "aws_secret_access_key",
    auth: () => ({ scheme: "sigv4", access_key_id: awsAccessKeyId(), region: awsRegion(), service: "ses", amz_date: amzDate() }),
  },

  // ---- Cloud: AWS S3 (SigV4). -----------------------------------------------
  {
    id: "aws-s3",
    prefix: "/aws/s3/",
    upstream: (p) => `https://s3.${awsRegion()}.amazonaws.com${stripPrefix(p, "/aws/s3/")}`,
    secretKey: "aws_secret_access_key",
    auth: () => ({ scheme: "sigv4", access_key_id: awsAccessKeyId(), region: awsRegion(), service: "s3", amz_date: amzDate() }),
  },
];

/**
 * Resolve the incoming proxy path to a concrete provider. Longest-prefix match
 * so "/aws/s3/" wins over any shorter prefix. Returns null for unmapped paths.
 */
export function resolveProvider(path: string): ResolvedProvider | null {
  const def = PROVIDERS
    .filter((d) => path.startsWith(d.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!def) return null;
  return { id: def.id, upstream: def.upstream(path), secretKey: def.secretKey, auth: def.auth(), sentinelHeader: def.sentinelHeader };
}

/** Names of the providers Blindfold ships first-class support for. */
export function supportedProviders(): string[] {
  return [...new Set(PROVIDERS.map((p) => p.id))];
}
