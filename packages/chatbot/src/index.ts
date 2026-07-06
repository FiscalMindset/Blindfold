/**
 * Public surface of the Blindfold Chatbot package.
 *
 * Programmatic API — for embedding the chatbot in another app. The CLI
 * (`bin/chatbot.ts`) and the web server (`src/server.ts`) both go through
 * this same `ChatbotEngine` class.
 */

export { ChatbotEngine } from "./engine.js";
export { classify } from "./classifier.js";
export { detectAudience } from "./audiences.js";
export { extractEntities } from "./entities.js";
export { loadKB, findByIntent, findByQuestionMatch } from "./knowledge.js";
export { INTENT_PATTERNS } from "./intents.js";
export { runFallback } from "./llm-fallback.js";

export type {
  Audience,
  Intent,
  ChatMessage,
  KnowledgeEntry,
  IntentPattern,
  ChatRequest,
  ChatResponse,
  EngineOptions,
  EngineStats,
} from "./types.js";