import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import type { D1Database, D1PreparedStatement, Env, ExecutionContext } from "../src/d1";
import { newToken, sha256Hex } from "../src/ids";

const SCHEMA = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");

function normalize(params: unknown[]): unknown[] {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
}

/**
 * D1 shim over bun:sqlite so `bun test` exercises the real worker code without
 * a network or wrangler. batch() runs sequentially rather than in a
 * transaction: nesting BEGIN under interleaved async tests is more trouble than
 * the atomicity is worth here, and production D1 provides the real guarantee.
 */
function d1(db: Database): D1Database {
  class Stmt {
    constructor(
      readonly sql: string,
      readonly params: unknown[] = [],
    ) {}
    bind(...values: unknown[]) {
      return new Stmt(this.sql, values);
    }
    async first(column?: string) {
      const row = db.query(this.sql).get(...(normalize(this.params) as never[])) as Record<
        string,
        unknown
      > | null;
      if (!row) return null;
      return column === undefined ? row : (row[column] ?? null);
    }
    async all() {
      const results = db.query(this.sql).all(...(normalize(this.params) as never[]));
      return { success: true, results, meta: { changes: 0, last_row_id: 0 } };
    }
    async run() {
      const info = db.query(this.sql).run(...(normalize(this.params) as never[])) as {
        changes?: number;
        lastInsertRowid?: number | bigint;
      };
      return {
        success: true,
        results: [],
        meta: {
          changes: Number(info?.changes ?? 0),
          last_row_id: Number(info?.lastInsertRowid ?? 0),
        },
      };
    }
  }

  return {
    prepare: (sql: string) => new Stmt(sql) as unknown as D1PreparedStatement,
    batch: async (statements: D1PreparedStatement[]) => {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out as never;
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

export interface TestBus {
  env: Env;
  db: Database;
  ctx: ExecutionContext;
  /** Awaits everything the worker handed to ctx.waitUntil (wake webhooks). */
  flush(): Promise<void>;
  call(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  rpc(method: string, params?: unknown, token?: string, id?: number | null): Promise<Response>;
  mint(name: string, opts?: { kind?: string; role?: string; wake_url?: string; wake_key?: string }): Promise<string>;
  close(): void;
}

export const ADMIN_TOKEN = "test-admin-token";
export const BASE = "https://bus.test";

export function makeBus(vars: Partial<Env> = {}): TestBus {
  const db = new Database(":memory:");
  db.exec(SCHEMA);

  const env: Env = {
    DB: d1(db),
    ADMIN_TOKEN,
    ASK_POLL_MS: "40",
    SERVICE_VERSION: "test",
    ...vars,
  };

  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil: (p) => void pending.push(p),
    passThroughOnException: () => {},
  };

  const call: TestBus["call"] = (path, init = {}) => {
    const { token, headers, ...rest } = init;
    const h = new Headers(headers);
    if (token) h.set("authorization", `Bearer ${token}`);
    if (rest.body && !h.has("content-type")) h.set("content-type", "application/json");
    return worker.fetch(new Request(new URL(path, BASE).toString(), { ...rest, headers: h }), env, ctx);
  };

  return {
    env,
    db,
    ctx,
    flush: async () => {
      await Promise.all(pending.splice(0, pending.length));
    },
    call,
    rpc: (method, params, token, id = 1) =>
      call("/mcp", {
        method: "POST",
        token,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
    mint: async (name, opts = {}) => {
      const token = newToken();
      db.query(
        `INSERT INTO agents (name, role, kind, token_hash, wake_url, wake_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        name,
        opts.role ?? `${name} test identity`,
        opts.kind ?? "agent",
        await sha256Hex(token),
        opts.wake_url ?? null,
        opts.wake_key ?? null,
        Date.now(),
      );
      return token;
    },
    close: () => db.close(),
  };
}

/** Calls one MCP tool and returns the parsed structuredContent, or throws on isError. */
export async function tool(
  bus: TestBus,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await bus.rpc("tools/call", { name, arguments: args }, token);
  const payload = (await res.json()) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text: string }[] };
    error?: { message: string };
  };
  if (payload.error) throw new Error(`rpc error: ${payload.error.message}`);
  if (payload.result?.isError) throw new Error(`tool error: ${payload.result.content?.[0]?.text}`);
  return payload.result?.structuredContent ?? {};
}

export interface FetchStub {
  calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[];
  status: number;
  fail: boolean;
  restore(): void;
}

/** Captures wake-webhook POSTs. */
export function stubFetch(): FetchStub {
  const original = globalThis.fetch;
  const stub: FetchStub = {
    calls: [],
    status: 200,
    fail: false,
    restore: () => {
      globalThis.fetch = original;
    },
  };

  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    stub.calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), headers });
    if (stub.fail) throw new Error("wake endpoint unreachable");
    return new Response("ok", { status: stub.status });
  }) as typeof fetch;

  return stub;
}
