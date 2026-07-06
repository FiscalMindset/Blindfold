/**
 * The chatbot engine.
 *
 * Public surface: `ChatbotEngine` class with `ask()` method. Stateless across
 * calls unless you provide conversation history in the request.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify } from "./classifier.js";
import { detectAudience } from "./audiences.js";
import { extractEntities } from "./entities.js";
import { findByIntent, findByQuestionMatch, loadKB } from "./knowledge.js";
import { buildResponse } from "./responder.js";
import { runFallback } from "./llm-fallback.js";
import { INTENT_PATTERNS } from "./intents.js";
import type {
  Audience,
  ChatRequest,
  ChatResponse,
  EngineOptions,
  EngineStats,
  KnowledgeEntry,
} from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INTENTS_PATH = path.resolve(HERE, "..", "data", "intents.json");
const DEFAULT_KB_PATH = path.resolve(HERE, "..", "data", "knowledge.json");

export class ChatbotEngine {
  private readonly opts: EngineOptions;
  private readonly intents = INTENT_PATTERNS;
  private readonly stats: EngineStats = {
    totalQueries: 0,
    intentCounts: {},
    audienceCounts: {},
    fallbackCount: 0,
    avgConfidence: 0,
    kbSize: 0,
    intentCount: INTENT_PATTERNS.length,
  };
  private confidenceSum = 0;
  private customIntentsLoaded = false;

  constructor(opts: EngineOptions = {}) {
    this.opts = {
      minConfidence: 0.45,
      defaultAudience: "general",
      ...opts,
    };
    // Pre-warm KB.
    const kb = loadKB(this.opts.knowledgePath ?? DEFAULT_KB_PATH);
    this.stats.kbSize = kb.entries.length;
    // Optionally load extra custom intent patterns from a JSON file.
    if (this.opts.intentsPath && this.opts.intentsPath !== DEFAULT_INTENTS_PATH) {
      try {
        const extra = JSON.parse(fs.readFileSync(this.opts.intentsPath, "utf8")) as Array<typeof INTENT_PATTERNS[number]>;
        (this as any).intents = [...INTENT_PATTERNS, ...extra];
        this.stats.intentCount = this.intents.length;
        this.customIntentsLoaded = true;
      } catch (e) {
        console.warn(`[chatbot] failed to load custom intents from ${this.opts.intentsPath}: ${(e as Error).message}`);
      }
    }
  }

  async ask(req: ChatRequest, askOpts: { disableLLMFallback?: boolean } = {}): Promise<ChatResponse> {
    this.stats.totalQueries++;
    const start = performance.now();

    const kb = loadKB(this.opts.knowledgePath ?? DEFAULT_KB_PATH);
    const audience = detectAudience(req.message, req.history ?? [], req.audience ?? this.opts.defaultAudience);
    const entities = extractEntities(req.message);

    const classifications = classify(req.message, this.intents);
    const top = classifications[0];
    const intent = top?.intent ?? "fallback";

    this.stats.intentCounts[intent] = (this.stats.intentCounts[intent] ?? 0) + 1;
    this.stats.audienceCounts[audience.audience] = (this.stats.audienceCounts[audience.audience] ?? 0) + 1;

    // Look up KB by intent.
    let entry: KnowledgeEntry | undefined;
    if (top) {
      const exact = findByIntent(kb, intent);
      // Prefer the entry whose `audience` includes the detected audience.
      const audienceMatch = exact.find((e) => e.audience.includes(audience.audience));
      entry = audienceMatch ?? exact[0];
    }

    // Fallback: question-text matching.
    if (!entry) {
      const candidates = findByQuestionMatch(kb, req.message, 5);
      if (candidates.length > 0) entry = candidates[0];
    }

    // Compute confidence.
    const patternScore = top?.score ?? 0;
    const kbConfidence = entry?.confidence ?? 0.3;
    const audienceBonus = entry && entry.audience.includes(audience.audience) ? 0.1 : 0;
    const confidence = Math.min(1, patternScore * 0.5 + kbConfidence * 0.4 + audienceBonus);

    let usedFallback = false;
    let response: ChatResponse;

    if (entry && confidence >= (this.opts.minConfidence ?? 0.45)) {
      // Strong KB match — answer directly.
      const related = findRelated(kb, entry, 5);
      response = buildResponse(
        entry,
        audience.audience,
        intent as any,
        confidence,
        top?.matchedPatterns ?? [],
        entitiesToObj(entities),
        false,
        related,
      );
    } else if (this.opts.enableLLMFallback && this.opts.llmApiKey && !askOpts.disableLLMFallback) {
      // Optional LLM fallback.
      usedFallback = true;
      this.stats.fallbackCount++;
      const top3 = findByQuestionMatch(kb, req.message, 3);
      try {
        const fb = await runFallback(req, top3, {
          apiKey: this.opts.llmApiKey,
          baseUrl: this.opts.llmBaseUrl ?? "https://samagama.in/platform/proxy/v1",
          model: this.opts.llmModel ?? "MiniMax-M3",
        });
        response = {
          message: fb.text || "I couldn't generate a confident answer. Try rephrasing or ask about a specific topic.",
          intent: intent as any,
          audience: audience.audience,
          confidence: 0.4,
          sources: top3.flatMap((t) => (t.sources ?? []).map((s) => ({ label: s, url: s, type: "doc" }))),
          related: top3.map((t) => ({ intent: t.intent as any, question: t.question })),
          usedFallback: true,
          debug: { matchedPatterns: top?.matchedPatterns ?? [], extractedEntities: entitiesToObj(entities) },
        };
        if (fb.citations.length > 0) {
          response.message += `\n\n> _Fallback grounded in KB entries: ${fb.citations.join(", ")}_`;
        }
      } catch (e) {
        response = {
          message: `I don't have a confident answer for that yet, and the LLM fallback failed: ${(e as Error).message.slice(0, 120)}\n\nTry one of:\n- ${kb.entries.slice(0, 5).map((e) => `\`${e.question}\``).join("\n- ")}`,
          intent: "fallback",
          audience: audience.audience,
          confidence: 0.1,
          sources: [],
          related: [],
          usedFallback: false,
        };
      }
    } else {
      // No LLM fallback configured.
      const suggestionEntries = findByQuestionMatch(kb, req.message, 5);
      const suggestions = suggestionEntries.map((e) => `\`${e.question}\``);
      response = {
        message: [
          `I don't have a confident answer for that yet.`,
          ``,
          `Detected audience: **${audience.audience}** (confidence ${audience.confidence.toFixed(2)}).`,
          ``,
          `Did you mean one of these?`,
          ...(suggestions.length > 0 ? suggestions : [`- Run \`npm run chatbot -- audit\` to see what topics are covered.`]),
          ``,
          `Or try asking with a few more keywords — for example: *how do I register a key?*, *how does the sentinel work?*, *vs Vault?*, *how to use in CI?*.`,
        ].join("\n"),
        intent: "fallback",
        audience: audience.audience,
        confidence: 0.1,
        sources: [],
        related: suggestionEntries.map((e) => ({ intent: e.intent as any, question: e.question })),
        usedFallback: false,
      };
    }

    this.confidenceSum += response.confidence;
    this.stats.avgConfidence = this.confidenceSum / this.stats.totalQueries;
    return response;
  }

  /** Get engine stats. */
  getStats(): EngineStats {
    return { ...this.stats };
  }

  /** Reset stats. */
  resetStats(): void {
    this.stats.totalQueries = 0;
    this.stats.intentCounts = {};
    this.stats.audienceCounts = {};
    this.stats.fallbackCount = 0;
    this.stats.avgConfidence = 0;
    this.confidenceSum = 0;
  }
}

function findRelated(kb: ReturnType<typeof loadKB>, entry: KnowledgeEntry, limit: number): KnowledgeEntry[] {
  return kb.entries
    .filter((e) => e.id !== entry.id)
    .map((e) => {
      // Simple shared-intent + shared-audience scoring.
      const intentMatch = e.intent.split("_")[0] === entry.intent.split("_")[0] ? 2 : 0;
      const audienceOverlap = e.audience.filter((a) => entry.audience.includes(a)).length;
      const score = intentMatch + audienceOverlap;
      return { entry: e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}

function entitiesToObj(e: ReturnType<typeof extractEntities>): Record<string, string> {
  return {
    providers: e.providers.join(","),
    secrets: e.secrets.join(","),
    files: e.files.join(","),
    urls: e.urls.join(","),
    commands: e.commands.join(","),
    topics: e.topics.join(","),
  };
}