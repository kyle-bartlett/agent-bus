/**
 * Minimal hand-written D1 + Workers types.
 *
 * Deliberately NOT @cloudflare/workers-types: that package collides with
 * @types/bun on Response/WebSocket/etc, and `bunx tsc --noEmit` has to cover
 * src, test and scripts in one pass. This is the whole runtime surface we use.
 */

export interface D1Meta {
  changes: number;
  last_row_id: number;
  duration?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<V = unknown>(column: string): Promise<V | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface Env {
  DB: D1Database;
  /** Admin bearer for identity minting. Set with `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN?: string;
  WAKE_DEBOUNCE_MS?: string;
  ASK_POLL_MS?: string;
  RATE_LIMIT_PER_MIN?: string;
  SERVICE_VERSION?: string;
}
