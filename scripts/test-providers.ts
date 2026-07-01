/**
 * Unit tests for the provider registry (packages/blindfold/src/providers.ts).
 * Pure-function assertions — no network, no enclave. Run:
 *   npm run test:providers
 * Exits non-zero on any failure (CI gate).
 */
import { resolveProvider, supportedProviders, amzDate } from "../packages/blindfold/src/providers.ts";

// Deterministic env for the config-driven providers.
process.env.TWILIO_ACCOUNT_SID = "AC_test_sid";
process.env.AWS_REGION = "us-west-2";
process.env.AWS_ACCESS_KEY_ID = "AKIATESTID";

let failures = 0;
function ok(cond: boolean, label: string): void {
  process.stdout.write(`  ${cond ? "✅" : "🚨"}  ${label}\n`);
  if (!cond) failures++;
}

// --- routing + upstream ------------------------------------------------------
const openai = resolveProvider("/v1/chat/completions");
ok(openai?.id === "openai" && openai.upstream === "https://api.openai.com/v1/chat/completions", "openai /v1 → api.openai.com, bearer");
ok(openai?.auth.scheme === "bearer", "openai auth is bearer");

const anthropic = resolveProvider("/anthropic/v1/messages");
ok(anthropic?.upstream === "https://api.anthropic.com/v1/messages", "anthropic strips /anthropic prefix");
ok(anthropic?.defaultHeaders?.["anthropic-version"] === "2023-06-01", "anthropic supplies anthropic-version header");

// --- Gemini: non-Bearer, sentinel in x-goog-api-key --------------------------
const gemini = resolveProvider("/gemini/v1beta/models/gemini-2.5-flash:generateContent");
ok(gemini?.id === "gemini" && gemini.secretKey === "gemini_api_key", "gemini → gemini_api_key");
ok(gemini?.sentinelHeader?.name === "x-goog-api-key" && gemini.sentinelHeader.prefix === "", "gemini sentinel rides in x-goog-api-key (no prefix)");
ok(gemini?.upstream === "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", "gemini upstream host");

// --- Stripe / GitHub required headers ---------------------------------------
const stripe = resolveProvider("/stripe/v1/balance");
ok(stripe?.secretKey === "stripe_secret_key" && stripe.auth.scheme === "bearer", "stripe → stripe_secret_key, bearer");
ok(stripe?.defaultHeaders?.["stripe-version"] !== undefined, "stripe pins Stripe-Version");

const github = resolveProvider("/github/user");
ok(github?.secretKey === "github_token", "github → github_token");
ok(github?.defaultHeaders?.["user-agent"] === "blindfold" && !!github.defaultHeaders?.["x-github-api-version"], "github supplies User-Agent + API version (else 403)");

// --- Twilio: HTTP Basic, username from env ----------------------------------
const twilio = resolveProvider("/twilio/2010-04-01/Accounts/AC_test_sid/Messages.json");
ok(twilio?.auth.scheme === "basic", "twilio auth is basic");
ok(twilio?.auth.scheme === "basic" && twilio.auth.username === "AC_test_sid", "twilio Basic username from TWILIO_ACCOUNT_SID");
ok(twilio?.secretKey === "twilio_auth_token", "twilio → twilio_auth_token");

// --- AWS: SigV4, region + service + longest-prefix ---------------------------
const s3 = resolveProvider("/aws/s3/my-bucket/key.txt");
ok(s3?.id === "aws-s3" && s3.auth.scheme === "sigv4", "aws-s3 → sigv4");
ok(s3?.auth.scheme === "sigv4" && s3.auth.service === "s3" && s3.auth.region === "us-west-2", "aws-s3 sigv4 service=s3, region from env");
ok(s3?.upstream === "https://s3.us-west-2.amazonaws.com/my-bucket/key.txt", "aws-s3 regional host");
ok(s3?.auth.scheme === "sigv4" && s3.auth.access_key_id === "AKIATESTID", "aws access key id from env");

const ses = resolveProvider("/aws/ses/v2/email/outbound-emails");
ok(ses?.id === "aws-ses" && ses.auth.scheme === "sigv4", "aws-ses → sigv4, service=ses (longest-prefix beats /aws/)");

// --- unmapped + coverage -----------------------------------------------------
ok(resolveProvider("/unmapped/thing") === null, "unmapped path → null (no generic catch-all)");
const providers = supportedProviders();
for (const p of ["openai", "anthropic", "xai", "groq", "gemini", "stripe", "github", "sendgrid", "slack", "twilio", "aws-ses", "aws-s3"]) {
  ok(providers.includes(p), `registry includes ${p}`);
}

// --- amzDate format ----------------------------------------------------------
ok(/^\d{8}T\d{6}Z$/.test(amzDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))), "amzDate is YYYYMMDDTHHMMSSZ");
ok(amzDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))) === "20260102T030405Z", "amzDate exact value");

process.stdout.write(`\n${failures === 0 ? "✅ all provider tests passed" : `🚨 ${failures} provider test(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
