/**
 * The sentinel string that stands in for a secret as it flows through
 * the agent process and the Blindfold proxy. Inside the T3 contract,
 * every occurrence of this string in any header value is replaced with
 * the real secret from the enclave's KV map.
 *
 * KEEP IN SYNC with `contract/src/forward.rs::SENTINEL`.
 */
export const SENTINEL = "__BLINDFOLD__";

/** Default port for the local OpenAI-shaped proxy. */
export const DEFAULT_PORT = 8787;

/** The contract tail we publish under in the developer's tenant. */
export const CONTRACT_TAIL = "blindfold-proxy";

/** Default contract version (semver, used at register time). */
export const CONTRACT_VERSION = "0.1.0";

/** Marker the proxy uses to surface "registered but mock" status in /health. */
export const HEALTH_BANNER = "blindfold/0.1.0";

/** Default port for the dashboard server (separate from the proxy port). */
export const DEFAULT_DASHBOARD_PORT = 8799;
