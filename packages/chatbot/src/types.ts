/**
 * Public type surface for the Blindfold Chatbot.
 *
 * The chatbot is intentionally a small, well-typed engine so it can be
 * embedded anywhere — CLI, web, REST API, third-party integration — without
 * dragging in any opinion about transport.
 */

export type Audience =
  | "user"          // End user / curious newcomer
  | "developer"     // Engineer integrating Blindfold
  | "founder"       // Founder / investor / executive
  | "enterprise"    // Enterprise / security architect / compliance
  | "researcher"    // Security researcher / academic
  | "general";      // Auto-detected / unknown

export type Intent =
  // Onboarding
  | "what_is_blindfold"
  | "what_problem_does_it_solve"
  | "how_does_it_work"
  | "signup_self_serve"
  | "install_from_npm"
  | "signup_vs_login"
  | "one_line_change"
  | "is_production_ready"
  // Concepts
  | "what_is_tdx"
  | "what_is_terminal3"
  | "what_is_enclave"
  | "what_is_sentinel"
  | "what_is_canonical_copy"
  | "what_is_substitution_in_enclave"
  // Security
  | "can_blindfold_see_key"
  | "prompt_injection_explained"
  | "vs_env_vars"
  | "vs_secrets_manager"
  | "vs_vault"
  | "trust_model"
  | "audit_model"
  // Workflows
  | "how_to_register"
  | "how_to_use"
  | "how_to_proxy"
  | "how_to_release"
  | "how_to_migrate"
  | "how_to_rotate"
  | "how_to_rollback"
  | "how_to_grant_egress"
  // Providers
  | "supported_providers"
  | "provider_openai"
  | "provider_anthropic"
  | "provider_gemini"
  | "provider_stripe"
  | "provider_github"
  | "provider_twilio"
  | "provider_aws"
  | "provider_sendgrid"
  | "provider_slack"
  | "provider_grok"
  | "provider_groq"
  | "add_new_provider"
  // CI / Production
  | "ci_cd_integration"
  | "github_actions"
  | "production_readiness"
  | "compliance"
  // Architecture
  | "architecture_overview"
  | "contract_details"
  | "wit_interface"
  | "kv_map"
  | "egress"
  // Compatibility
  | "node_compatibility"
  | "python_compatibility"
  | "languages_supported"
  | "wrap_function"
  | "release_function"
  // Troubleshooting
  | "doctor_command"
  | "verify_command"
  | "common_errors"
  | "egress_denied"
  | "rate_limit"
  | "secret_not_found"
  // Misc
  | "license"
  | "contributing"
  | "roadmap"
  | "performance"
  | "pricing"
  | "open_source"
  // Meta
  | "greeting"
  | "about_chatbot"
  | "fallback"
  | "goodbye"
  | "thanks";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
}

export interface KnowledgeEntry {
  id: string;
  intent: Intent;
  audience: Audience[];          // Which audiences this entry is best suited for
  question: string;              // Canonical form of the question
  shortAnswer: string;           // 1-3 sentence answer
  longAnswer: string;            // Detailed explanation with code/markdown
  codeSnippets?: string[];       // Runnable code blocks
  links?: Array<{ label: string; url: string; type: "doc" | "code" | "external" }>;
  sources?: string[];            // Doc files this was sourced from
  confidence: number;            // 0..1 — verified vs inferred
  lastVerified: string;          // ISO date
}

export interface IntentPattern {
  intent: Intent;
  patterns: Array<{
    type: "regex" | "keyword" | "exact" | "phrase";
    value: string | RegExp;
    weight: number;
  }>;
  examples: string[];
}

export interface ChatRequest {
  message: string;
  audience?: Audience;           // Hint, optional
  history?: ChatMessage[];       // Optional conversation context
  meta?: {
    provider?: string;           // E.g. "openai" — used to scope provider questions
  };
}

export interface ChatResponse {
  message: string;
  intent: Intent;
  audience: Audience;
  confidence: number;             // 0..1
  sources: Array<{ label: string; url: string; type: string }>;
  related: Array<{ intent: Intent; question: string }>;
  usedFallback: boolean;          // true if LLM fallback was used
  debug?: {
    matchedPatterns: string[];
    extractedEntities: Record<string, string>;
  };
}

export interface EngineOptions {
  knowledgePath?: string;
  intentsPath?: string;
  enableLLMFallback?: boolean;
  llmApiKey?: string;            // If provided, used for fallback ONLY
  llmBaseUrl?: string;
  llmModel?: string;
  defaultAudience?: Audience;
  minConfidence?: number;        // 0..1, default 0.45
}

export interface EngineStats {
  totalQueries: number;
  intentCounts: Record<string, number>;
  audienceCounts: Record<string, number>;
  fallbackCount: number;
  avgConfidence: number;
  kbSize: number;
  intentCount: number;
}