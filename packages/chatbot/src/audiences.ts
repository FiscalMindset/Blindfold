/**
 * Audience detection — picks user / developer / founder / enterprise / researcher / general.
 *
 * Strategy: signal-based with explicit overrides. The user can say "I'm a founder"
 * and we lock onto that for the rest of the session unless they switch.
 *
 * Order of precedence:
 *   1. Explicit declaration in this turn (highest)
 *   2. Conversation history (cross-turn memory)
 *   3. Question-shape heuristics (lowest)
 */

import type { Audience, ChatMessage } from "./types.js";

const EXPLICIT_PATTERNS: Array<{ re: RegExp; audience: Audience }> = [
  { re: /\b(i[\u2019']?m|im|i am)\s+(an?\s+)?(end[-\s]?user|user|beginner|newbie|newcomer|noob)\b/i, audience: "user" },
  { re: /\b(i[\u2019']?m|im|i am)\s+(an?\s+)?(developer|engineer|dev|programmer|coder|builder)\b/i, audience: "developer" },
  { re: /\b(i[\u2019']?m|im|i am)\s+(an?\s+)?(founder|co-?founder|ceo|investor|cto|vp|executive)\b/i, audience: "founder" },
  { re: /\b(i[\u2019']?m|im|i am)\s+(an?\s+)?(enterprise|ciso|cso|security\s+architect|compliance|procurement|it\s+manager)\b/i, audience: "enterprise" },
  { re: /\b(i[\u2019']?m|im|i am)\s+(an?\s+)?(researcher|academic|professor|student|scientist)\b/i, audience: "researcher" },
  { re: /\b(as\s+a|for\s+a)\s+(user|developer|founder|enterprise|researcher)\b/i, audience: "user" }, // overridden below per match
];

// Phrasing-shape signals (lowest precedence).
const SHAPE_HINTS: Array<{ re: RegExp; audience: Audience; weight: number }> = [
  // Developer-shaped
  { re: /\b(api|sdk|cli|endpoint|typescript|javascript|python|node\.js|ts|js)\b/i, audience: "developer", weight: 1 },
  { re: /\bhow\s+(do\s+I|to|should\s+I|can\s+I)\s+(register|use|run|invoke|wire|integrate|deploy|build|configure|setup|set\s+up|install)\b/i, audience: "developer", weight: 2 },
  { re: /\b(code|snippet|example|sample|repo|repository|pr|pull\s+request|merge|commit)\b/i, audience: "developer", weight: 1 },
  { re: /\b(env\s+var|environment\s+variable|secret\s+name|proxy\s+port|tsx|node)\b/i, audience: "developer", weight: 2 },

  // Enterprise-shaped
  { re: /\b(soc\s?2|iso\s?27001|gdpr|hipaa|pci|compliance|audit|attestation)\b/i, audience: "enterprise", weight: 3 },
  { re: /\b(threat\s+model|security\s+review|risk\s+assessment|vendor\s+review|procurement)\b/i, audience: "enterprise", weight: 3 },
  { re: /\b(enterprise|tier|seat|annual\s+contract|pricing|cost|tco|budget|contract)\b/i, audience: "founder", weight: 2 },

  // Founder-shaped
  { re: /\b(go[-\s]?to[-\s]?market|gtm|positioning|messaging|market\s+size|tam|sam|som|funding|series\s+[a-c]|investor|pitch)\b/i, audience: "founder", weight: 3 },
  { re: /\b(competitors?|alternatives?|vs\.?|compared?\s+to|moat|wedge)\b/i, audience: "founder", weight: 2 },

  // Researcher-shaped
  { re: /\b(paper|preprint|cite|citation|threat\s+model|adversarial|cve|tcb|trust\s+boundary)\b/i, audience: "researcher", weight: 3 },
  { re: /\b(tdx|sgx|sev|trusted\s+execution|attestation|quote|enclave\s+attestation)\b/i, audience: "researcher", weight: 2 },

  // User-shaped
  { re: /\b(what\s+is|what[\u2019']?s|tell\s+me\s+about|explain|simpl(e|ify)|in\s+plain\s+english|for\s+dummies|eli5)\b/i, audience: "user", weight: 1 },
  { re: /\b(can\s+i|how\s+do\s+i\s+get\s+started|is\s+it\s+(safe|easy|worth|good)|should\s+i)\b/i, audience: "user", weight: 1 },
];

export function detectAudience(
  message: string,
  history: ChatMessage[] = [],
  hint?: Audience,
): { audience: Audience; confidence: number } {
  // 1. Explicit hint wins.
  if (hint) return { audience: hint, confidence: 1 };

  // 2. Explicit declaration in this turn.
  for (const p of EXPLICIT_PATTERNS) {
    // Skip the generic "as a|for a" pattern unless other specific words apply
    const m = message.match(p.re);
    if (m) {
      const explicit = inferExplicitAudience(m);
      if (explicit) return { audience: explicit, confidence: 0.95 };
    }
  }

  // 3. Look back through the last few turns for an explicit declaration.
  for (let i = history.length - 1; i >= Math.max(0, history.length - 6); i--) {
    const msg = history[i];
    if (!msg || msg.role !== "user") continue;
    for (const p of EXPLICIT_PATTERNS) {
      const m = msg.content.match(p.re);
      if (m) {
        const explicit = inferExplicitAudience(m);
        if (explicit) return { audience: explicit, confidence: 0.8 };
      }
    }
  }

  // 4. Shape-based heuristics.
  const scores: Record<Audience, number> = {
    user: 0,
    developer: 0,
    founder: 0,
    enterprise: 0,
    researcher: 0,
    general: 0,
  };
  for (const h of SHAPE_HINTS) {
    if (h.re.test(message)) scores[h.audience] += h.weight;
  }
  let best: Audience = "general";
  let bestScore = 0;
  for (const [a, s] of Object.entries(scores) as Array<[Audience, number]>) {
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return { audience: best, confidence: bestScore > 0 ? Math.min(0.7, bestScore / 5) : 0.2 };
}

function inferExplicitAudience(match: RegExpMatchArray): Audience | null {
  const text = match[0].toLowerCase();
  if (/developer|engineer|builder|programmer|coder/.test(text)) return "developer";
  if (/founder|co-?founder|ceo|investor|cto|vp|executive/.test(text)) return "founder";
  if (/enterprise|ciso|cso|security\s+architect|compliance|procurement|it\s+manager/.test(text)) return "enterprise";
  if (/researcher|academic|professor|student|scientist/.test(text)) return "researcher";
  if (/end[-\s]?user|user|beginner|newbie|newcomer|noob/.test(text)) return "user";
  return null;
}