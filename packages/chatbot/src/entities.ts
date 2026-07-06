/**
 * Entity extraction — pull out provider names, secret names, file paths, URLs.
 *
 * Used by the responder to scope answers (e.g. "How do I use it with Stripe?"
 * narrows to the stripe provider entry).
 */

export interface ExtractedEntities {
  providers: string[];
  secrets: string[];
  files: string[];
  urls: string[];
  commands: string[];          // matched CLI verbs
  topics: string[];            // derived topic hints
}

const PROVIDER_NAMES = [
  "openai",
  "anthropic",
  "claude",
  "grok",
  "xai",
  "groq",
  "gemini",
  "google",
  "stripe",
  "github",
  "sendgrid",
  "slack",
  "twilio",
  "aws",
  "ses",
  "s3",
  "notion",
  "deepgram",
  "blogger",
  "digitalocean",
  "doctl",
  "hostinger",
  "stripe",
];

const PROVIDER_PATTERNS: Array<{ re: RegExp; provider: string }> = [
  { re: /\b(openai|gpt-?[0-9]|chatgpt|dall[\u00b7-]?e)\b/i, provider: "openai" },
  { re: /\b(anthropic|claude)\b/i, provider: "anthropic" },
  { re: /\b(xai|grok)\b/i, provider: "xai" },
  { re: /\bgroq\b/i, provider: "groq" },
  { re: /\b(gemini|google\s+ai|generativelanguage)\b/i, provider: "gemini" },
  { re: /\bstripe\b/i, provider: "stripe" },
  { re: /\b(github|gh\s+cli|\bgh\b)\b/i, provider: "github" },
  { re: /\bsendgrid\b/i, provider: "sendgrid" },
  { re: /\bslack\b/i, provider: "slack" },
  { re: /\btwilio\b/i, provider: "twilio" },
  { re: /\b(aws|amazon\s+web\s+services)\b/i, provider: "aws" },
  { re: /\b(simple\s+email\s+service|aws\s+ses)\b/i, provider: "aws-ses" },
  { re: /\b(aws\s+s3|\bs3\b)\b/i, provider: "aws-s3" },
  { re: /\bnotion\b/i, provider: "notion" },
  { re: /\bdeepgram\b/i, provider: "deepgram" },
  { re: /\bblogger\b/i, provider: "blogger" },
  { re: /\b(digital\s+ocean|doctl)\b/i, provider: "digitalocean" },
  { re: /\bhostinger\b/i, provider: "hostinger" },
];

const SECRET_PATTERNS: RegExp[] = [
  /\b(api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|client[_-]?secret)\b/gi,
  /\b(env\s+var(iable)?|environment\s+variable)\b/gi,
  /\b__BLINDFOLD__\b/g,
];

const FILE_PATTERNS: RegExp[] = [
  /packages\/blindfold\/src\/[\w.\-]+\.ts\b/g,
  /packages\/blindfold\/bin\/[\w.\-]+\.ts\b/g,
  /contract\/src\/[\w.\-]+\.rs\b/g,
  /contract\/wit\/[\w.\-]+\.wit\b/g,
  /docs\/[\w.\-]+\.md\b/g,
  /examples\/[\w.\-\/]+\b/g,
  /scripts\/[\w.\-]+\.ts\b/g,
];

const URL_PATTERN = /https?:\/\/[^\s)>"']+/g;

const COMMAND_PATTERNS: RegExp[] = [
  /\b(blindfold\s+(register|use|proxy|publish|doctor|verify|migrate|rotate|rollback|grant|dashboard|compat|export|init))\b/g,
  /\b(npm\s+run\s+(blindfold|demo|setup|test:report|test:providers))\b/g,
  /\b(tsx\s+\S+)\b/g,
];

export function extractEntities(message: string): ExtractedEntities {
  const providers = new Set<string>();
  for (const p of PROVIDER_PATTERNS) {
    const m = message.match(p.re);
    if (m) providers.add(p.provider);
  }

  const secrets = new Set<string>();
  for (const p of SECRET_PATTERNS) {
    const matches = message.match(p);
    if (matches) for (const m of matches) secrets.add(m.trim().toLowerCase());
  }

  const files = new Set<string>();
  for (const p of FILE_PATTERNS) {
    const matches = message.match(p);
    if (matches) for (const m of matches) files.add(m);
  }

  const urls = new Set<string>();
  const urlMatches = message.match(URL_PATTERN);
  if (urlMatches) for (const u of urlMatches) urls.add(u);

  const commands = new Set<string>();
  for (const p of COMMAND_PATTERNS) {
    const matches = message.match(p);
    if (matches) for (const c of matches) commands.add(c.trim());
  }

  // Topics — derived phrases.
  const topics: string[] = [];
  const topicPatterns: Array<[RegExp, string]> = [
    [/\b(security|secure|hardening)\b/i, "security"],
    [/\b(performance|latency|speed|fast|throughput)\b/i, "performance"],
    [/\b(cost|pricing|billing|tier|free|paid)\b/i, "pricing"],
    [/\b(trust|attestation|attest)\b/i, "trust"],
    [/\b(audit|review|compliance|soc|iso)\b/i, "audit"],
    [/\b(sca?m|threat|attack|exploit|injection|jailbreak)\b/i, "threat-model"],
    [/\b(open[-\s]?source|github|repository|repo|contrib)\b/i, "open-source"],
    [/\b(setup|install|getting\s+started|onboard|adopt)\b/i, "onboarding"],
    [/\b(release|version|publish|deploy|rollout)\b/i, "release"],
  ];
  for (const [re, topic] of topicPatterns) {
    if (re.test(message)) topics.push(topic);
  }

  return {
    providers: Array.from(providers),
    secrets: Array.from(secrets),
    files: Array.from(files),
    urls: Array.from(urls),
    commands: Array.from(commands),
    topics,
  };
}