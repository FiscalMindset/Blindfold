# Graph Report - /Volumes/algsoch/terminal 3  (2026-06-29)

## Corpus Check
- 86 files · ~205,987 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 470 nodes · 816 edges · 57 communities (23 shown, 34 thin omitted)
- Extraction: 92% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 37 edges (avg confidence: 0.82)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Blindfold SDK Core|Blindfold SDK Core]]
- [[_COMMUNITY_Project Architecture & Docs|Project Architecture & Docs]]
- [[_COMMUNITY_Demo Agent Runners|Demo Agent Runners]]
- [[_COMMUNITY_CLI Entry Point|CLI Entry Point]]
- [[_COMMUNITY_E2E Testing & T3 Client|E2E Testing & T3 Client]]
- [[_COMMUNITY_Key Sealing & Init|Key Sealing & Init]]
- [[_COMMUNITY_CLI Commands & Aurora|CLI Commands & Aurora]]
- [[_COMMUNITY_Blindfold Module Index|Blindfold Module Index]]
- [[_COMMUNITY_Compatibility Scanner|Compatibility Scanner]]
- [[_COMMUNITY_Migration & Prompt|Migration & Prompt]]
- [[_COMMUNITY_Test Runner|Test Runner]]
- [[_COMMUNITY_Brand & Identity|Brand & Identity]]
- [[_COMMUNITY_Mock OpenAI Server|Mock OpenAI Server]]
- [[_COMMUNITY_WASM Forward Contract|WASM Forward Contract]]
- [[_COMMUNITY_SMTP Demo Script|SMTP Demo Script]]
- [[_COMMUNITY_Logo Symbolism|Logo Symbolism]]
- [[_COMMUNITY_Demo Proxy|Demo Proxy]]
- [[_COMMUNITY_Example Docs|Example Docs]]
- [[_COMMUNITY_WASM Component Root|WASM Component Root]]
- [[_COMMUNITY_LangChain Example|LangChain Example]]
- [[_COMMUNITY_Tenant SDK Auth|Tenant SDK Auth]]
- [[_COMMUNITY_WIT Interface Contracts|WIT Interface Contracts]]
- [[_COMMUNITY_Diagnostics|Diagnostics]]
- [[_COMMUNITY_OpenAI Node Example|OpenAI Node Example]]
- [[_COMMUNITY_OpenAI Python Example|OpenAI Python Example]]
- [[_COMMUNITY_Anthropic Example|Anthropic Example]]
- [[_COMMUNITY_Key Sharing|Key Sharing]]
- [[_COMMUNITY_Key Rotation|Key Rotation]]
- [[_COMMUNITY_Audit & Sealed Keys|Audit & Sealed Keys]]
- [[_COMMUNITY_Compatibility Docs|Compatibility Docs]]
- [[_COMMUNITY_Sealed Ledger|Sealed Ledger]]
- [[_COMMUNITY_Forward Input Type|Forward Input Type]]
- [[_COMMUNITY_Forward Output Type|Forward Output Type]]
- [[_COMMUNITY_Release Input Type|Release Input Type]]
- [[_COMMUNITY_Release Output Type|Release Output Type]]
- [[_COMMUNITY_CLI Namespace|CLI Namespace]]
- [[_COMMUNITY_CLI Publish|CLI Publish]]
- [[_COMMUNITY_CLI Init|CLI Init]]
- [[_COMMUNITY_CLI Migrate|CLI Migrate]]
- [[_COMMUNITY_CLI Dashboard|CLI Dashboard]]
- [[_COMMUNITY_CLI Status|CLI Status]]
- [[_COMMUNITY_Env Map Tool|Env Map Tool]]
- [[_COMMUNITY_Constants|Constants]]
- [[_COMMUNITY_Package Index|Package Index]]
- [[_COMMUNITY_Demo Types|Demo Types]]
- [[_COMMUNITY_T3 Analysis Doc|T3 Analysis Doc]]
- [[_COMMUNITY_Architecture Doc|Architecture Doc]]
- [[_COMMUNITY_Usage Recipes|Usage Recipes]]
- [[_COMMUNITY_Agents Doc|Agents Doc]]
- [[_COMMUNITY_Key Rotation Op|Key Rotation Op]]
- [[_COMMUNITY_Contributing Guide|Contributing Guide]]
- [[_COMMUNITY_FAQ|FAQ]]
- [[_COMMUNITY_Teams Doc|Teams Doc]]
- [[_COMMUNITY_Examples Doc|Examples Doc]]

## God Nodes (most connected - your core abstractions)
1. `loadBlindfoldEnv()` - 46 edges
2. `main()` - 31 edges
3. `runInit()` - 23 edges
4. `openT3Client()` - 17 edges
5. `Sentinel Substitution Pattern (__BLINDFOLD__ replaced in-enclave)` - 14 edges
6. `runVerify()` - 13 edges
7. `runAgentA()` - 11 edges
8. `runAgentB()` - 11 edges
9. `registerSecret()` - 11 edges
10. `ensureEnvOrPrompt()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `CLI export command (CI/GitHub Actions)` --implements--> `Release-broker pattern — plaintext returned to authenticated tenant only`  [INFERRED]
  packages/blindfold/bin/blindfold.ts → contract/src/forward.rs
- `main()` --calls--> `loadBlindfoldEnv()`  [EXTRACTED]
  scripts/real-e2e-test.ts → packages/blindfold/src/env.ts
- `main()` --calls--> `loadBlindfoldEnv()`  [EXTRACTED]
  scripts/grant-egress.ts → packages/blindfold/src/env.ts
- `main()` --calls--> `loadBlindfoldEnv()`  [EXTRACTED]
  scripts/init-tenant.ts → packages/blindfold/src/env.ts
- `main()` --calls--> `loadBlindfoldEnv()`  [EXTRACTED]
  scripts/probe-map-get.ts → packages/blindfold/src/env.ts

## Hyperedges (group relationships)
- **Secret lifecycle — register, use, rotate, rollback, audit** — blindfold_cli_register, blindfold_cli_use, blindfold_cli_rotate, blindfold_cli_rollback, blindfold_cli_audit, blindfold_cli_sealed [EXTRACTED 0.95]
- **Enclave call pipeline — seal → grant egress → contract forward → http::call** — forward_forward, forward_read_secret, egress_grant_mechanism, sentinel_substitution_pattern, enclave_egress_pattern [EXTRACTED 0.95]
- **T3 API probing scripts — discovery of correct T3 control-plane shapes** — grant_egress_main, probe_map_get_main, probe_egress_map_main, probe_funcs_main, init_tenant_main [INFERRED 0.85]
- **Secret Sealing Pipeline (plaintext enters once, sealed into enclave, metadata logged)** — register, t3_client, sealed_ledger, env, prompt [EXTRACTED 0.95]
- **Secret Consumption Paths (proxy HTTP path + programmatic release path)** — proxy, release, t3_client, usage_log, sentinel_substitution [EXTRACTED 0.95]
- **Observability & Audit Surface (dashboard reads both logs, reconciles against enclave)** — dashboard, usage_log, sealed_ledger, env, t3_client [EXTRACTED 0.95]
- **prompt injection exfiltration chain** — injection_page, mock_openai_server, demo_tools, attacker_server [INFERRED 0.95]
- **cross-SDK sentinel proof** — openai_node_quickstart, openai_python_quickstart, langchain_summarizer, anthropic_quickstart [INFERRED 0.85]
- **demo infrastructure components** — mock_openai_server, attacker_server, injection_page, demo_proxy [INFERRED 0.85]
- **Blindfold Security Property Proven End-to-End** — forward_rs, secrets_map, sentinel_substitution, enclave_egress_mode, demo_agent_b [INFERRED]
- **Root Cause Investigation Chain** — unprovisioned_key_root_cause, tenant_did, http_response_mismatch, canonical_host_wits [INFERRED]
- **Four Usage Modes (increasing trust level)** — blindfold_use_cli, blindfold_proxy, release_broker_pattern, enclave_egress_mode [INFERRED]

## Communities (57 total, 34 thin omitted)

### Community 0 - "Blindfold SDK Core"
Cohesion: 0.07
Nodes (33): main(), main(), ROOT, WASM_PATH, main(), ROOT, WASM, main() (+25 more)

### Community 1 - "Project Architecture & Docs"
Cohesion: 0.05
Nodes (51): Agent A (no Blindfold), Agent B (with Blindfold), Anthropic quickstart, API providers README, attacker-server.ts, blindfold migrate, Blindfold, Blindfold Proxy (proxy.ts) (+43 more)

### Community 2 - "Demo Agent Runners"
Cohesion: 0.1
Nodes (32): banner(), info(), redactish(), runAgentA(), RunOutcome, banner(), info(), runAgentB() (+24 more)

### Community 3 - "CLI Entry Point"
Cohesion: 0.11
Nodes (32): Argv, die(), fingerprint(), HERE, main(), parseArgv(), printHelp(), REPO_ROOT (+24 more)

### Community 4 - "E2E Testing & T3 Client"
Cohesion: 0.09
Nodes (34): flushReport(), HERE, log(), main(), record(), REPORT, results, ROOT (+26 more)

### Community 5 - "Key Sealing & Init"
Cohesion: 0.14
Nodes (33): ENV_PATH, HERE, main(), loadEnvFromFile(), pluckSecret(), ask(), bold(), collectSeedPlan() (+25 more)

### Community 6 - "CLI Commands & Aurora"
Cohesion: 0.08
Nodes (25): Aurora EnclaveBroker, CLI doctor command, CLI export command (CI/GitHub Actions), CLI grant command, CLI proxy command, CLI register command, CLI use command, blindfold use CLI (+17 more)

### Community 7 - "Blindfold Module Index"
Cohesion: 0.2
Nodes (17): Usage Dashboard (self-contained HTTP + inline HTML), Environment Loader (loadBlindfoldEnv, pluckSecret, assertRealReady), Bootstrap Wizard (blindfold init), Safe Logger (redacts secrets from output), Bulk .env-to-Enclave Migration, Mock T3 Client (local stub for dev/CI), Stdin Secret Reader (no-echo TTY input), OpenAI-shaped Local HTTP Proxy (+9 more)

### Community 8 - "Compatibility Scanner"
Cohesion: 0.2
Nodes (13): bold(), cyan(), DetectionResult, dim(), green(), HERE, red(), renderTool() (+5 more)

### Community 9 - "Migration & Prompt"
Cohesion: 0.21
Nodes (13): defaultEnvPath(), isAltT3(), isConfigName(), looksSecret(), MigratePlanItem, MigrateResult, NEVER_SEAL, planMigration() (+5 more)

### Community 10 - "Test Runner"
Cohesion: 0.21
Nodes (10): HERE, httpGet(), main(), record(), REPORT, results, ROOT, step() (+2 more)

### Community 11 - "Brand & Identity"
Cohesion: 0.25
Nodes (11): AI Agent Security, Blindfold, Favicon 32x32, Favicon on White, Icon Only Variant, Blindfold Logo, Shield Icon, Tagline (+3 more)

### Community 12 - "Mock OpenAI Server"
Cohesion: 0.36
Nodes (9): decide(), extractFirstUrl(), extractLeakBase(), handleRequest(), MockOpenAIHandle, OAIMessage, textResponse(), toolCallResponse() (+1 more)

### Community 13 - "WASM Forward Contract"
Cohesion: 0.27
Nodes (8): forward(), ForwardInput, ForwardOutput, parse_verb(), read_secret(), release_to_tenant(), ReleaseInput, ReleaseOutput

### Community 14 - "SMTP Demo Script"
Cohesion: 0.54
Nodes (7): bold(), dim(), fingerprint(), green(), main(), red(), yellow()

### Community 15 - "Logo Symbolism"
Cohesion: 0.39
Nodes (8): Blindfold, Blindfold Visor Band, Circuit Node Branches, Hexagonal Sentinel Eye, Shield Shape, Terminal 3 Logo, Sentinel, Terminal 3

### Community 16 - "Demo Proxy"
Cohesion: 0.38
Nodes (6): DemoProxyHandle, HOP_BY_HOP, nodeFetch(), proxyRequest(), truncate(), UpstreamResponse

### Community 17 - "Example Docs"
Cohesion: 0.4
Nodes (5): CLI tools README, DigitalOcean README, Examples README, grok-via-blindfold.ts, three Blindfold use surfaces

### Community 21 - "WIT Interface Contracts"
Cohesion: 0.67
Nodes (3): Canonical Host WITs, Root Cause: http.response Headers Mismatch, world.wit

### Community 22 - "Diagnostics"
Cohesion: 0.67
Nodes (3): blindfold doctor, Tenant DID (server-assigned), Root Cause: Unprovisioned API Key

## Knowledge Gaps
- **111 isolated node(s):** `ROOT`, `WASM`, `HERE`, `ROOT`, `REPORT` (+106 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **34 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `loadBlindfoldEnv()` connect `Blindfold SDK Core` to `Migration & Prompt`, `CLI Entry Point`, `E2E Testing & T3 Client`, `Key Sealing & Init`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Why does `main()` connect `CLI Entry Point` to `Blindfold SDK Core`, `E2E Testing & T3 Client`, `Key Sealing & Init`, `Compatibility Scanner`, `Migration & Prompt`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `Sentinel Substitution Pattern (__BLINDFOLD__ replaced in-enclave)` connect `Project Architecture & Docs` to `Blindfold Module Index`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `main()` (e.g. with `release()` and `openT3Client()`) actually correct?**
  _`main()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `ROOT`, `WASM`, `HERE` to the rest of the system?**
  _111 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Blindfold SDK Core` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Project Architecture & Docs` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._