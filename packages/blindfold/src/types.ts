export interface ForwardRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
  /** Name of the secret in z:<tid>:secrets to substitute into headers. */
  secret_key: string;
}

export interface ForwardResponse {
  status: number;
  headers: Array<[string, string]>;
  /** Response body bytes (transported as base64 in mock mode for safety). */
  body: number[] | string;
}

export interface BlindfoldEnv {
  t3nApiKey: string;
  did: string;
  port: number;
  t3Env: "testnet" | "production";
  /**
   * Optional override for the T3 node URL (from T3_BASE_URL / BLINDFOLD_BASE_URL).
   * Lets you point at a healthy/leader node when the SDK's default node is
   * unhealthy. Empty string = use the SDK's built-in NODE_URLS[t3Env].
   */
  t3BaseUrl: string;
  /** When true, all T3 calls are simulated locally. */
  mock: boolean;
}

export interface RegisterOpts {
  /** Logical name (the KV key inside z:<tid>:secrets). */
  name: string;
  /** Optional: env var to read the plaintext value from (scripting). */
  fromEnv?: string;
  /** Optional: explicit value (programmatic API). */
  value?: string;
}
