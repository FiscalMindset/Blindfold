/**
 * Intent patterns — the rule set the classifier uses.
 *
 * Each pattern has a weight. Multiple matches within one intent are summed.
 * Order does not matter; classifier returns sorted results.
 *
 * Adding intents here is the typical way to extend the chatbot without
 * touching the KB or the responder.
 */

import type { Intent, IntentPattern } from "./types.js";

export const INTENT_PATTERNS: IntentPattern[] = [
  // ── Greetings / meta ────────────────────────────────────────────────────────
  {
    intent: "greeting",
    patterns: [
      { type: "phrase", value: "hello", weight: 1.5 },
      { type: "phrase", value: "hi ", weight: 1.5 },
      { type: "phrase", value: "hey ", weight: 1.5 },
      { type: "phrase", value: "good morning", weight: 1.5 },
      { type: "phrase", value: "good afternoon", weight: 1.5 },
      { type: "phrase", value: "what is this", weight: 2 },
      { type: "phrase", value: "what are you", weight: 3 },
      { type: "phrase", value: "who are you", weight: 3 },
      { type: "exact", value: "hi", weight: 2 },
      { type: "exact", value: "hello", weight: 2 },
      { type: "exact", value: "hey", weight: 2 },
    ],
    examples: ["hi", "hello", "what is this?"],
  },
  {
    intent: "thanks",
    patterns: [
      { type: "phrase", value: "thank you", weight: 2 },
      { type: "phrase", value: "thanks", weight: 2 },
      { type: "phrase", value: "appreciate it", weight: 1.5 },
      { type: "phrase", value: "great, ", weight: 1 },
      { type: "phrase", value: "perfect, ", weight: 1 },
      { type: "exact", value: "thx", weight: 2 },
      { type: "exact", value: "ty", weight: 2 },
    ],
    examples: ["thanks!", "thank you so much"],
  },
  {
    intent: "goodbye",
    patterns: [
      { type: "phrase", value: "bye", weight: 1.5 },
      { type: "phrase", value: "goodbye", weight: 2 },
      { type: "phrase", value: "see you", weight: 2 },
      { type: "phrase", value: "that's all", weight: 1 },
      { type: "phrase", value: "that's it", weight: 1 },
    ],
    examples: ["bye", "see you"],
  },
  {
    intent: "about_chatbot",
    patterns: [
      { type: "phrase", value: "how are you built", weight: 3 },
      { type: "phrase", value: "how were you built", weight: 3 },
      { type: "phrase", value: "what ai", weight: 2 },
      { type: "phrase", value: "which model", weight: 2 },
      { type: "phrase", value: "what model", weight: 2 },
      { type: "phrase", value: "what powers", weight: 2 },
      { type: "phrase", value: "are you an llm", weight: 3 },
      { type: "phrase", value: "are you rule-based", weight: 4 },
      { type: "phrase", value: "rule-based", weight: 2 },
      { type: "phrase", value: "knowledge base", weight: 2 },
    ],
    examples: ["how are you built?", "what ai are you"],
  },

  // ── Onboarding ──────────────────────────────────────────────────────────────
  {
    intent: "what_is_blindfold",
    patterns: [
      { type: "phrase", value: "what is blindfold", weight: 4 },
      { type: "phrase", value: "what's blindfold", weight: 4 },
      { type: "phrase", value: "tell me about blindfold", weight: 4 },
      { type: "phrase", value: "explain blindfold", weight: 3 },
      { type: "phrase", value: "blindfold is", weight: 2 },
      { type: "phrase", value: "blindfold project", weight: 2 },
      { type: "phrase", value: "this project", weight: 1 },
      { type: "phrase", value: "overview", weight: 1 },
    ],
    examples: ["what is blindfold?", "tell me about blindfold"],
  },
  {
    intent: "what_problem_does_it_solve",
    patterns: [
      { type: "phrase", value: "what problem", weight: 3 },
      { type: "phrase", value: "what does blindfold solve", weight: 5 },
      { type: "phrase", value: "why do i need", weight: 3 },
      { type: "phrase", value: "why blindfold", weight: 4 },
      { type: "phrase", value: "what's the point", weight: 2 },
      { type: "phrase", value: "what's the use case", weight: 2 },
      { type: "phrase", value: "use case", weight: 1 },
    ],
    examples: ["what problem does it solve?", "why blindfold"],
  },
  {
    intent: "how_does_it_work",
    patterns: [
      { type: "phrase", value: "how does blindfold work", weight: 5 },
      { type: "phrase", value: "how does it work", weight: 4 },
      { type: "phrase", value: "how it works", weight: 3 },
      { type: "phrase", value: "internals", weight: 2 },
      { type: "phrase", value: "explain how", weight: 2 },
      { type: "phrase", value: "architecture", weight: 2 },
      { type: "phrase", value: "under the hood", weight: 3 },
      { type: "phrase", value: "mechanism", weight: 2 },
    ],
    examples: ["how does blindfold work?", "under the hood"],
  },
  {
    intent: "one_line_change",
    patterns: [
      { type: "phrase", value: "one line", weight: 4 },
      { type: "phrase", value: "one-line", weight: 4 },
      { type: "phrase", value: "minimal change", weight: 3 },
      { type: "phrase", value: "smallest change", weight: 3 },
      { type: "phrase", value: "adopt", weight: 1 },
      { type: "phrase", value: "getting started", weight: 2 },
      { type: "phrase", value: "quickstart", weight: 3 },
      { type: "phrase", value: "install", weight: 1 },
    ],
    examples: ["one-line adoption", "quickstart"],
  },
  {
    intent: "is_production_ready",
    patterns: [
      { type: "phrase", value: "production ready", weight: 4 },
      { type: "phrase", value: "production-ready", weight: 4 },
      { type: "phrase", value: "is it stable", weight: 2 },
      { type: "phrase", value: "is this ready", weight: 2 },
      { type: "phrase", value: "ready for production", weight: 3 },
      { type: "phrase", value: "stable", weight: 1 },
      { type: "phrase", value: "maturity", weight: 3 },
      { type: "phrase", value: "sla", weight: 2 },
    ],
    examples: ["is it production-ready?", "is this stable"],
  },

  // ── Concepts ────────────────────────────────────────────────────────────────
  {
    intent: "what_is_tdx",
    patterns: [
      { type: "phrase", value: "what is tdx", weight: 5 },
      { type: "phrase", value: "what's tdx", weight: 4 },
      { type: "phrase", value: "intel tdx", weight: 4 },
      { type: "phrase", value: "tdx mean", weight: 3 },
      { type: "phrase", value: "trust domain extension", weight: 5 },
    ],
    examples: ["what is TDX?", "what is intel TDX"],
  },
  {
    intent: "what_is_terminal3",
    patterns: [
      { type: "phrase", value: "what is terminal 3", weight: 5 },
      { type: "phrase", value: "what's terminal 3", weight: 5 },
      { type: "phrase", value: "what is t3", weight: 4 },
      { type: "phrase", value: "terminal3", weight: 3 },
      { type: "phrase", value: "who runs the enclave", weight: 3 },
    ],
    examples: ["what is Terminal 3?"],
  },
  {
    intent: "what_is_enclave",
    patterns: [
      { type: "phrase", value: "what is an enclave", weight: 5 },
      { type: "phrase", value: "what is a enclave", weight: 5 },
      { type: "phrase", value: "what's an enclave", weight: 4 },
      { type: "phrase", value: "enclave", weight: 2 },
    ],
    examples: ["what is an enclave?"],
  },
  {
    intent: "what_is_sentinel",
    patterns: [
      { type: "phrase", value: "what is the sentinel", weight: 5 },
      { type: "phrase", value: "what's the sentinel", weight: 5 },
      { type: "phrase", value: "sentinel", weight: 2 },
      { type: "phrase", value: "__blindfold__", weight: 4 },
      { type: "phrase", value: "placeholder", weight: 1 },
    ],
    examples: ["what is the sentinel?"],
  },
  {
    intent: "what_is_canonical_copy",
    patterns: [
      { type: "phrase", value: "canonical copy", weight: 5 },
      { type: "phrase", value: "source of truth", weight: 3 },
      { type: "phrase", value: "where is the real key", weight: 3 },
      { type: "phrase", value: "where does the key live", weight: 4 },
    ],
    examples: ["what is the canonical copy?"],
  },
  {
    intent: "what_is_substitution_in_enclave",
    patterns: [
      { type: "phrase", value: "substitution in enclave", weight: 5 },
      { type: "phrase", value: "in-enclave substitution", weight: 5 },
      { type: "phrase", value: "substitute in tdx", weight: 4 },
      { type: "phrase", value: "in-enclave", weight: 3 },
    ],
    examples: ["what is substitution in enclave?"],
  },

  // ── Security ────────────────────────────────────────────────────────────────
  {
    intent: "can_blindfold_see_key",
    patterns: [
      { type: "phrase", value: "can blindfold see", weight: 4 },
      { type: "phrase", value: "can the proxy see", weight: 3 },
      { type: "phrase", value: "can the enclave see", weight: 3 },
      { type: "phrase", value: "who can see my key", weight: 5 },
      { type: "phrase", value: "where is my key", weight: 3 },
      { type: "phrase", value: "is my key safe", weight: 2 },
      { type: "phrase", value: "does blindfold store", weight: 3 },
    ],
    examples: ["can blindfold see my key?"],
  },
  {
    intent: "prompt_injection_explained",
    patterns: [
      { type: "phrase", value: "prompt injection", weight: 5 },
      { type: "phrase", value: "injection", weight: 3 },
      { type: "phrase", value: "jailbreak", weight: 3 },
      { type: "phrase", value: "adversarial", weight: 2 },
      { type: "phrase", value: "attack", weight: 2 },
      { type: "phrase", value: "leak the key", weight: 3 },
      { type: "phrase", value: "steal my key", weight: 3 },
    ],
    examples: ["what is prompt injection?"],
  },
  {
    intent: "vs_env_vars",
    patterns: [
      { type: "phrase", value: "vs env", weight: 3 },
      { type: "phrase", value: "vs .env", weight: 4 },
      { type: "phrase", value: "vs environment variables", weight: 4 },
      { type: "phrase", value: "compared to env", weight: 3 },
      { type: "phrase", value: "compared to .env", weight: 3 },
      { type: "phrase", value: "instead of .env", weight: 3 },
    ],
    examples: ["how is this different from .env?"],
  },
  {
    intent: "vs_secrets_manager",
    patterns: [
      { type: "phrase", value: "vs vault", weight: 5 },
      { type: "phrase", value: "from vault", weight: 4 },
      { type: "phrase", value: "different from vault", weight: 5 },
      { type: "phrase", value: "vs doppler", weight: 5 },
      { type: "phrase", value: "vs aws secrets manager", weight: 5 },
      { type: "phrase", value: "vs secrets manager", weight: 5 },
      { type: "phrase", value: "compared to vault", weight: 4 },
      { type: "phrase", value: "instead of vault", weight: 4 },
      { type: "phrase", value: "vs 1password", weight: 3 },
    ],
    examples: ["how is this different from Vault?"],
  },
  {
    intent: "trust_model",
    patterns: [
      { type: "phrase", value: "trust model", weight: 5 },
      { type: "phrase", value: "who do i have to trust", weight: 5 },
      { type: "phrase", value: "who do i trust", weight: 3 },
      { type: "phrase", value: "trust boundary", weight: 4 },
      { type: "phrase", value: "tcb", weight: 3 },
    ],
    examples: ["what's the trust model?"],
  },
  {
    intent: "audit_model",
    patterns: [
      { type: "phrase", value: "how to audit", weight: 4 },
      { type: "phrase", value: "audit", weight: 2 },
      { type: "phrase", value: "security review", weight: 3 },
      { type: "phrase", value: "what should i audit", weight: 4 },
      { type: "phrase", value: "auditable", weight: 3 },
      { type: "phrase", value: "one file", weight: 2 },
    ],
    examples: ["how is this auditable?"],
  },

  // ── Workflows ───────────────────────────────────────────────────────────────
  {
    intent: "how_to_register",
    patterns: [
      { type: "regex", value: /how\s+(do\s+I|to|should\s+I|can\s+I)\s+(register|seal|store)\s+(a|my)?\s*(secret|key|token)/i, weight: 6 },
      { type: "phrase", value: "register a secret", weight: 3 },
      { type: "phrase", value: "seal a key", weight: 4 },
      { type: "phrase", value: "seal my key", weight: 4 },
      { type: "phrase", value: "blindfold register", weight: 5 },
      { type: "phrase", value: "register command", weight: 3 },
    ],
    examples: ["how do I register a key?", "blindfold register"],
  },
  {
    intent: "how_to_use",
    patterns: [
      { type: "regex", value: /how\s+(do\s+I|to|should\s+I|can\s+I)\s+use\s+(a|my)?\s*(sealed|secret|key)/i, weight: 6 },
      { type: "phrase", value: "blindfold use", weight: 5 },
      { type: "phrase", value: "use a sealed", weight: 4 },
      { type: "phrase", value: "inject into a command", weight: 4 },
      { type: "phrase", value: "cli tool with", weight: 2 },
    ],
    examples: ["how do I use a sealed secret?"],
  },
  {
    intent: "how_to_proxy",
    patterns: [
      { type: "phrase", value: "start the proxy", weight: 4 },
      { type: "phrase", value: "run the proxy", weight: 4 },
      { type: "phrase", value: "blindfold proxy", weight: 5 },
      { type: "phrase", value: "openai-shaped", weight: 3 },
      { type: "phrase", value: "swap base url", weight: 3 },
      { type: "phrase", value: "proxy port", weight: 3 },
      { type: "phrase", value: "the proxy work", weight: 5 },
      { type: "phrase", value: "how the proxy", weight: 5 },
      { type: "phrase", value: "proxy does", weight: 4 },
      { type: "phrase", value: "what the proxy", weight: 4 },
      { type: "phrase", value: "proxy do", weight: 3 },
      { type: "regex", value: /\bhow\s+(do\s+)?(the\s+)?proxy\b/i, weight: 4 },
    ],
    examples: ["how does the proxy work?", "how do I run the proxy?"],
  },
  {
    intent: "how_to_release",
    patterns: [
      { type: "regex", value: /release\s*\(/i, weight: 5 },
      { type: "phrase", value: "release()", weight: 5 },
      { type: "phrase", value: "release function", weight: 5 },
      { type: "phrase", value: "wrap function", weight: 3 },
      { type: "phrase", value: "wrap()", weight: 5 },
      { type: "phrase", value: "in-process", weight: 2 },
    ],
    examples: ["how does release() work?"],
  },
  {
    intent: "how_to_migrate",
    patterns: [
      { type: "phrase", value: "migrate my .env", weight: 5 },
      { type: "phrase", value: "blindfold migrate", weight: 5 },
      { type: "phrase", value: "bulk seal", weight: 4 },
      { type: "phrase", value: "migrate", weight: 2 },
    ],
    examples: ["how do I migrate my .env?"],
  },
  {
    intent: "how_to_rotate",
    patterns: [
      { type: "phrase", value: "rotate", weight: 3 },
      { type: "phrase", value: "rotate a key", weight: 5 },
      { type: "phrase", value: "blindfold rotate", weight: 5 },
      { type: "phrase", value: "change the key", weight: 3 },
      { type: "phrase", value: "new api key", weight: 2 },
    ],
    examples: ["how do I rotate a key?"],
  },
  {
    intent: "how_to_rollback",
    patterns: [
      { type: "phrase", value: "rollback", weight: 4 },
      { type: "phrase", value: "undo rotate", weight: 4 },
      { type: "phrase", value: "revert", weight: 2 },
    ],
    examples: ["how do I rollback a rotation?"],
  },
  {
    intent: "how_to_grant_egress",
    patterns: [
      { type: "phrase", value: "grant", weight: 2 },
      { type: "phrase", value: "egress", weight: 3 },
      { type: "phrase", value: "allowlist", weight: 3 },
      { type: "phrase", value: "blindfold grant", weight: 5 },
      { type: "phrase", value: "authorize host", weight: 4 },
    ],
    examples: ["how do I grant egress?"],
  },

  // ── Providers ───────────────────────────────────────────────────────────────
  {
    intent: "supported_providers",
    patterns: [
      { type: "phrase", value: "supported providers", weight: 5 },
      { type: "phrase", value: "which providers", weight: 5 },
      { type: "phrase", value: "what providers", weight: 4 },
      { type: "phrase", value: "supported apis", weight: 5 },
      { type: "phrase", value: "what integrations", weight: 4 },
      { type: "phrase", value: "providers supported", weight: 5 },
    ],
    examples: ["what providers are supported?"],
  },
  ...["openai", "anthropic", "gemini", "stripe", "github", "twilio", "aws", "sendgrid", "slack", "grok", "groq"].map((p): IntentPattern => ({
    intent: `provider_${p}` as Intent,
    patterns: [
      { type: "keyword", value: p, weight: 4 },
      { type: "phrase", value: `with ${p}`, weight: 3 },
      { type: "phrase", value: `${p} integration`, weight: 4 },
      { type: "phrase", value: `${p} provider`, weight: 4 },
    ],
    examples: [`how do I use Blindfold with ${p}?`],
  })),
  {
    intent: "add_new_provider",
    patterns: [
      { type: "phrase", value: "add a provider", weight: 5 },
      { type: "phrase", value: "add new provider", weight: 5 },
      { type: "phrase", value: "add a new provider", weight: 5 },
      { type: "phrase", value: "how do i add", weight: 4 },
      { type: "phrase", value: "add a new integration", weight: 4 },
      { type: "phrase", value: "extend blindfold", weight: 3 },
      { type: "phrase", value: "custom provider", weight: 4 },
    ],
    examples: ["how do I add a new provider?"],
  },

  // ── CI / Production ─────────────────────────────────────────────────────────
  {
    intent: "ci_cd_integration",
    patterns: [
      { type: "phrase", value: "ci/cd", weight: 5 },
      { type: "phrase", value: "github actions", weight: 4 },
      { type: "phrase", value: "ci pipeline", weight: 4 },
      { type: "phrase", value: "production deploy", weight: 4 },
      { type: "phrase", value: "deploy blindfold", weight: 3 },
      { type: "phrase", value: "add-mask", weight: 4 },
    ],
    examples: ["how do I use this in CI?"],
  },
  {
    intent: "github_actions",
    patterns: [
      { type: "phrase", value: "github actions", weight: 5 },
      { type: "phrase", value: "gh actions", weight: 4 },
      { type: "phrase", value: "github workflow", weight: 4 },
      { type: "phrase", value: "ci yaml", weight: 3 },
    ],
    examples: ["how do I integrate with GitHub Actions?"],
  },
  {
    intent: "compliance",
    patterns: [
      { type: "phrase", value: "soc 2", weight: 5 },
      { type: "phrase", value: "soc2", weight: 5 },
      { type: "phrase", value: "iso 27001", weight: 5 },
      { type: "phrase", value: "gdpr", weight: 4 },
      { type: "phrase", value: "hipaa", weight: 4 },
      { type: "phrase", value: "pci", weight: 4 },
      { type: "phrase", value: "compliance", weight: 3 },
    ],
    examples: ["is this SOC 2 compliant?"],
  },

  // ── Architecture ────────────────────────────────────────────────────────────
  {
    intent: "architecture_overview",
    patterns: [
      { type: "phrase", value: "architecture", weight: 3 },
      { type: "phrase", value: "high level", weight: 2 },
      { type: "phrase", value: "diagram", weight: 2 },
      { type: "phrase", value: "how it all fits", weight: 3 },
    ],
    examples: ["what's the architecture?"],
  },
  {
    intent: "contract_details",
    patterns: [
      { type: "phrase", value: "the contract", weight: 2 },
      { type: "phrase", value: "wasm contract", weight: 5 },
      { type: "phrase", value: "rust contract", weight: 4 },
      { type: "phrase", value: "forward.rs", weight: 5 },
      { type: "phrase", value: "forward()", weight: 4 },
    ],
    examples: ["how does the contract work?"],
  },
  {
    intent: "wit_interface",
    patterns: [
      { type: "phrase", value: "wit", weight: 3 },
      { type: "phrase", value: "world.wit", weight: 5 },
      { type: "phrase", value: "interface", weight: 2 },
    ],
    examples: ["what's the WIT interface?"],
  },
  {
    intent: "kv_map",
    patterns: [
      { type: "phrase", value: "kv map", weight: 5 },
      { type: "phrase", value: "z:tid:secrets", weight: 5 },
      { type: "phrase", value: "tenant map", weight: 3 },
      { type: "phrase", value: "where are secrets stored", weight: 4 },
    ],
    examples: ["how is the KV map structured?"],
  },
  {
    intent: "egress",
    patterns: [
      { type: "phrase", value: "egress", weight: 4 },
      { type: "phrase", value: "outbound call", weight: 2 },
      { type: "phrase", value: "http::call", weight: 5 },
      { type: "phrase", value: "outbound from the enclave", weight: 4 },
    ],
    examples: ["how does egress work?"],
  },

  // ── Compatibility ───────────────────────────────────────────────────────────
  {
    intent: "node_compatibility",
    patterns: [
      { type: "phrase", value: "node", weight: 2 },
      { type: "phrase", value: "node.js", weight: 3 },
      { type: "phrase", value: "javascript", weight: 2 },
      { type: "phrase", value: "typescript", weight: 3 },
    ],
    examples: ["does this work with Node?"],
  },
  {
    intent: "python_compatibility",
    patterns: [
      { type: "phrase", value: "python", weight: 4 },
      { type: "phrase", value: "py", weight: 2 },
      { type: "phrase", value: "pip", weight: 2 },
    ],
    examples: ["does this work with Python?"],
  },
  {
    intent: "languages_supported",
    patterns: [
      { type: "phrase", value: "languages", weight: 3 },
      { type: "phrase", value: "what languages", weight: 4 },
      { type: "phrase", value: "rust", weight: 2 },
      { type: "phrase", value: "go", weight: 2 },
    ],
    examples: ["what languages are supported?"],
  },
  {
    intent: "wrap_function",
    patterns: [
      { type: "phrase", value: "wrap", weight: 2 },
      { type: "phrase", value: "wrap function", weight: 5 },
      { type: "phrase", value: "openai wrap", weight: 5 },
    ],
    examples: ["what's the wrap() function?"],
  },
  {
    intent: "release_function",
    patterns: [
      { type: "phrase", value: "release function", weight: 5 },
      { type: "phrase", value: "release()", weight: 5 },
    ],
    examples: ["what's the release() function?"],
  },

  // ── Troubleshooting ─────────────────────────────────────────────────────────
  {
    intent: "doctor_command",
    patterns: [
      { type: "phrase", value: "blindfold doctor", weight: 5 },
      { type: "phrase", value: "doctor", weight: 2 },
      { type: "phrase", value: "readiness check", weight: 3 },
      { type: "phrase", value: "check everything is working", weight: 4 },
    ],
    examples: ["what does doctor do?"],
  },
  {
    intent: "verify_command",
    patterns: [
      { type: "phrase", value: "blindfold verify", weight: 5 },
      { type: "phrase", value: "verify", weight: 1 },
      { type: "phrase", value: "round trip", weight: 2 },
    ],
    examples: ["what does verify do?"],
  },
  {
    intent: "common_errors",
    patterns: [
      { type: "phrase", value: "error", weight: 1 },
      { type: "phrase", value: "common errors", weight: 5 },
      { type: "phrase", value: "troubleshoot", weight: 4 },
      { type: "phrase", value: "doesn't work", weight: 2 },
      { type: "phrase", value: "not working", weight: 2 },
      { type: "phrase", value: "fails", weight: 1 },
    ],
    examples: ["what are common errors?"],
  },
  {
    intent: "egress_denied",
    patterns: [
      { type: "phrase", value: "egress_denied", weight: 5 },
      { type: "phrase", value: "egress denied", weight: 5 },
      { type: "phrase", value: "not authorized for host", weight: 5 },
    ],
    examples: ["egress_denied error"],
  },
  {
    intent: "rate_limit",
    patterns: [
      { type: "phrase", value: "rate limit", weight: 5 },
      { type: "phrase", value: "fuel_per_minute", weight: 5 },
      { type: "phrase", value: "429", weight: 2 },
      { type: "phrase", value: "too many requests", weight: 3 },
    ],
    examples: ["rate limit errors"],
  },
  {
    intent: "secret_not_found",
    patterns: [
      { type: "phrase", value: "secret not found", weight: 5 },
      { type: "phrase", value: "in the secrets map", weight: 4 },
    ],
    examples: ["secret not found error"],
  },

  // ── Misc ────────────────────────────────────────────────────────────────────
  {
    intent: "license",
    patterns: [
      { type: "phrase", value: "license", weight: 4 },
      { type: "phrase", value: "licence", weight: 4 },
      { type: "phrase", value: "mit", weight: 2 },
      { type: "phrase", value: "apache", weight: 2 },
      { type: "phrase", value: "can i use", weight: 2 },
    ],
    examples: ["what license is this?"],
  },
  {
    intent: "contributing",
    patterns: [
      { type: "phrase", value: "contribute", weight: 4 },
      { type: "phrase", value: "contributing", weight: 5 },
      { type: "phrase", value: "how to contribute", weight: 5 },
      { type: "phrase", value: "open a pr", weight: 4 },
      { type: "phrase", value: "pull request", weight: 2 },
    ],
    examples: ["how can I contribute?"],
  },
  {
    intent: "roadmap",
    patterns: [
      { type: "phrase", value: "roadmap", weight: 5 },
      { type: "phrase", value: "what's next", weight: 2 },
      { type: "phrase", value: "future", weight: 1 },
      { type: "phrase", value: "coming soon", weight: 3 },
      { type: "phrase", value: "planned", weight: 2 },
    ],
    examples: ["what's on the roadmap?"],
  },
  {
    intent: "performance",
    patterns: [
      { type: "phrase", value: "performance", weight: 4 },
      { type: "phrase", value: "latency", weight: 3 },
      { type: "phrase", value: "how fast", weight: 3 },
      { type: "phrase", value: "overhead", weight: 4 },
      { type: "phrase", value: "benchmark", weight: 3 },
    ],
    examples: ["what's the performance overhead?"],
  },
  {
    intent: "pricing",
    patterns: [
      { type: "phrase", value: "pricing", weight: 5 },
      { type: "phrase", value: "cost", weight: 3 },
      { type: "phrase", value: "free", weight: 1 },
      { type: "phrase", value: "how much", weight: 3 },
      { type: "phrase", value: "subscription", weight: 4 },
      { type: "phrase", value: "billing", weight: 4 },
    ],
    examples: ["how much does it cost?"],
  },
  {
    intent: "open_source",
    patterns: [
      { type: "phrase", value: "open source", weight: 5 },
      { type: "phrase", value: "open-source", weight: 5 },
      { type: "phrase", value: "github", weight: 2 },
      { type: "phrase", value: "source code", weight: 3 },
    ],
    examples: ["is this open source?"],
  },
  {
    intent: "signup_self_serve",
    patterns: [
      { type: "phrase", value: "sign up", weight: 5 },
      { type: "phrase", value: "signup", weight: 5 },
      { type: "phrase", value: "get started", weight: 3 },
      { type: "phrase", value: "getting started", weight: 3 },
      { type: "phrase", value: "create a tenant", weight: 4 },
      { type: "phrase", value: "create an account", weight: 4 },
      { type: "phrase", value: "how do i start", weight: 3 },
      { type: "phrase", value: "onboard", weight: 3 },
      { type: "phrase", value: "self-serve", weight: 3 },
      { type: "keyword", value: "tenant", weight: 1 },
    ],
    examples: ["how do I sign up?", "how do I get started with Blindfold?", "create a Terminal 3 tenant"],
  },
  {
    intent: "install_from_npm",
    patterns: [
      { type: "phrase", value: "on npm", weight: 5 },
      { type: "phrase", value: "npm install", weight: 4 },
      { type: "phrase", value: "npm i -g", weight: 4 },
      { type: "phrase", value: "install blindfold", weight: 4 },
      { type: "phrase", value: "how do i install", weight: 3 },
      { type: "phrase", value: "published", weight: 2 },
      { type: "phrase", value: "package name", weight: 3 },
      { type: "keyword", value: "npm", weight: 2 },
    ],
    examples: ["is Blindfold on npm?", "how do I install Blindfold?", "what's the npm package?"],
  },
  {
    intent: "signup_vs_login",
    patterns: [
      { type: "phrase", value: "signup vs login", weight: 9 },
      { type: "phrase", value: "signup or login", weight: 9 },
      { type: "phrase", value: "sign up vs log in", weight: 9 },
      { type: "phrase", value: "difference between signup and login", weight: 9 },
      { type: "phrase", value: "signup and login", weight: 6 },
      { type: "phrase", value: "login or signup", weight: 9 },
    ],
    examples: ["what's the difference between signup and login?"],
  },
];