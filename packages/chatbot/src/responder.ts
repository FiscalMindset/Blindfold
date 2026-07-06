/**
 * Response generation.
 *
 * Takes a KB entry, an audience, and the matched intent, then produces the
 * final markdown response. Audience-aware depth adjustment: developers get
 * code, founders get positioning, enterprise gets audit + threat model.
 */

import type { Audience, ChatResponse, Intent, KnowledgeEntry } from "./types.js";

export function buildResponse(
  entry: KnowledgeEntry,
  audience: Audience,
  intent: Intent,
  confidence: number,
  matchedPatterns: string[],
  extractedEntities: Record<string, string>,
  usedFallback: boolean,
  related: KnowledgeEntry[],
): ChatResponse {
  const body = audienceAdjust(entry, audience);

  return {
    message: body,
    intent,
    audience,
    confidence: Math.min(1, Math.max(0, confidence)),
    sources: entry.links ?? entry.sources?.map((s) => ({ label: s, url: s, type: "doc" })) ?? [],
    related: related.slice(0, 5).map((r) => ({ intent: r.intent, question: r.question })),
    usedFallback,
    debug: {
      matchedPatterns,
      extractedEntities,
    },
  };
}

/**
 * Audience-aware shaping of the KB entry.
 * - Adds an "at a glance" prefix for executives.
 * - Adds a "TL;DR for developers" if the entry is long.
 * - Adds a "Sources" footer if sources are present.
 * - Always preserves the original entry content.
 */
function audienceAdjust(entry: KnowledgeEntry, audience: Audience): string {
  const parts: string[] = [];

  // Header: question + short answer (always).
  parts.push(`## ${entry.question}\n`);
  parts.push(`> ${entry.shortAnswer}\n`);

  // Audience hint.
  if (entry.audience && !entry.audience.includes(audience) && !entry.audience.includes("general")) {
    parts.push(
      `_Heads up: this answer is typically aimed at ${entry.audience.join(", ")} — let me know if you want me to recalibrate._`,
    );
  }

  // Body.
  parts.push(entry.longAnswer);

  // Code snippets.
  if (entry.codeSnippets && entry.codeSnippets.length > 0) {
    parts.push(`\n### Runnable examples\n`);
    for (const snippet of entry.codeSnippets) {
      parts.push("```ts");
      parts.push(snippet);
      parts.push("```");
    }
  }

  // Sources / links footer.
  if (entry.links && entry.links.length > 0) {
    parts.push(`\n### Sources`);
    for (const link of entry.links) {
      const type = link.type ? ` (${link.type})` : "";
      parts.push(`- [${link.label}](${link.url})${type}`);
    }
  } else if (entry.sources && entry.sources.length > 0) {
    parts.push(`\n### Sources`);
    for (const s of entry.sources) {
      parts.push(`- \`${s}\``);
    }
  }

  // Audience-specific append.
  const tail = audienceTail(entry, audience);
  if (tail) parts.push(tail);

  return parts.join("\n");
}

function audienceTail(entry: KnowledgeEntry, audience: Audience): string {
  switch (audience) {
    case "founder":
      return `\n\n---\n📌 **For the founder:** ${founderNote(entry.intent)}`;
    case "enterprise":
      return `\n\n---\n🛡️ **For the security reviewer:** ${enterpriseNote(entry.intent)}`;
    case "researcher":
      return `\n\n---\n🔬 **For the researcher:** ${researcherNote(entry.intent)}`;
    case "developer":
      return `\n\n---\n👩‍💻 **For the developer:** see the snippets above. The full file path is cited in the Sources section.`;
    default:
      return "";
  }
}

function founderNote(intent: string): string {
  switch (intent) {
    case "what_is_blindfold":
      return "The pitch: *your AI agent can use a key it can never read.* Removes an entire category of breach that no existing tool can fix structurally. The market — every team running an agent that touches untrusted text — is everyone building on top of OpenAI/Anthropic today.";
    case "is_production_ready":
      return "Treat the testnet as a strong reference implementation. Production rollout is gated by T3's SLA, not Blindfold's code. Pilot it on one workflow first; the rotation story means you can roll forward/back without rewriting anything.";
    case "vs_secrets_manager":
      return "Vaults protect *storage*. Blindfold protects *runtime exposure*. Same customer, different threat. Sell it as a complementary layer, not a replacement.";
    case "pricing":
      return "Blindfold itself is MIT-licensed and free. T3's infra has a free testnet; production is fuel-based (compute). Your cost is operations + T3 fuel, not per-seat licensing.";
    case "license":
      return "MIT — commercial-friendly, no per-seat fees. Sell software that includes Blindfold without attribution headaches.";
    default:
      return "If you have a question I haven't anticipated, just ask — I'll either answer it or be honest about not knowing.";
  }
}

function enterpriseNote(intent: string): string {
  switch (intent) {
    case "can_blindfold_see_key":
      return "Read `packages/blindfold/src/register.ts` end to end — that's the only file that ever holds a plaintext. The TDX primitive is Intel-root-key attested; T3 (the operator) cannot read your TD RAM.";
    case "trust_model":
      return "Trust root: Intel TDX + Terminal 3 (opaque infra) + your discipline (don't paste keys). DO NOT trust: your agent runtime (key isn't there), other tenants (TD isolation), or Blindfold maintainers with plaintext (they never have it post-register).";
    case "audit_model":
      return "Audit checklist: (1) read register.ts; (2) read forward.rs; (3) grep for `__BLINDFOLD__`; (4) run BLINDFOLD_MOCK=1 npm run test:report (9/9); (5) check the usage-log scrubber for header redaction.";
    case "compliance":
      return "Blindfold's audit invariant (`register.ts` is the only plaintext path) is the standard 'single-file-in-scope' pattern SOC 2 / ISO 27001 reviewers accept. Map this to your narrative for 'secret never crosses the trust boundary at rest OR in transit.'";
    case "is_production_ready":
      return "Testnet today. Sign an MSA / DPA with T3 before promoting production traffic. Add Blindfold to your threat model under 'agent-runtime exposure'; keep egress allowlists in your runbook.";
    default:
      return "Add Blindfold to your third-party-attestation review. The MIT licence and the one-file invariant simplify procurement.";
  }
}

function researcherNote(intent: string): string {
  switch (intent) {
    case "what_is_tdx":
      return "TDX differs from SGX in isolation granularity (whole-VM trust domains vs. user-level enclaves). Side-channel surface is narrower than SGX but not zero. See Intel's TDX module 1.0 spec for the SEAM instructions.";
    case "what_is_substitution_in_enclave":
      return "Substitution happens on the contract's stack between `kv::get` and `http::call`. The substituted bytes never spill to host memory because the TD's page tables map them as encrypted-and-integrity-protected; the host's dirty-bit tracking never sees them in plaintext.";
    case "trust_model":
      return "TCB = { CPU microcode (Intel), TDX module (signed by Intel root key), Terminal 3's hypervisor + signing infra, your terminal-3 tenant credentials, Blindfold's WASM contract }. Side-channels: see the TDX threat model in the module spec.";
    case "audit_model":
      return "Reproducible builds for the contract: `cd contract && cargo build --target wasm32-wasip2 --release`; hash the resulting `.wasm` and verify it against the on-chain attested hash. The `wit/` directory is the canonical interface contract.";
    default:
      return "Cite this work via the GitHub repo. The architecture section of the README links the canonical threat-model writeup.";
  }
}