import { describe, expect, test } from "bun:test";
import { ADMIN_TOKEN, makeBus, tool } from "./harness";

describe("auth", () => {
  test("rejects missing and bad tokens on both /mcp and /v1", async () => {
    const bus = makeBus();
    const good = await bus.mint("a");

    const cases: [string, RequestInit & { token?: string }, number, string][] = [
      ["/v1/inbox", {}, 401, "missing_token"],
      ["/v1/inbox", { token: "ab_not-a-real-token" }, 401, "bad_token"],
      ["/mcp", { method: "POST", body: "{}" }, 401, "missing_token"],
      ["/mcp", { method: "POST", body: "{}", token: "nope" }, 401, "bad_token"],
    ];

    for (const [path, init, status, code] of cases) {
      const res = await bus.call(path, init);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(code);
      if (status === 401) expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }

    expect((await bus.call("/v1/inbox", { token: good })).status).toBe(200);
    bus.close();
  });

  test("a disabled identity cannot use its token", async () => {
    const bus = makeBus();
    const token = await bus.mint("ghost");
    bus.db.query(`UPDATE agents SET disabled = 1 WHERE name = 'ghost'`).run();

    const res = await bus.call("/v1/inbox", { token });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("agent_disabled");
    bus.close();
  });

  test("a client-supplied 'from' never changes the sender identity", async () => {
    const bus = makeBus();
    const aToken = await bus.mint("a");
    await bus.mint("b");

    // REST: spoof every plausible sender field at once.
    const rest = await bus.call("/v1/send", {
      method: "POST",
      token: aToken,
      body: JSON.stringify({
        to: "b",
        body: "rest hello",
        from: "cos",
        from_agent: "cos",
        sender: "cos",
        identity: "cos",
      }),
    });
    expect(rest.status).toBe(201);

    // MCP: same attempt through tools/call arguments.
    await tool(bus, aToken, "send", { to: "b", body: "mcp hello", from: "cos", from_agent: "cos" });

    const rows = bus.db
      .query(`SELECT from_agent, body FROM messages ORDER BY body`)
      .all() as { from_agent: string; body: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.from_agent === "a")).toBe(true);
    bus.close();
  });

  test("admin routes need the admin token, not an agent token", async () => {
    const bus = makeBus();
    const agentToken = await bus.mint("a");

    const anonymous = await bus.call("/v1/admin/agents", { method: "GET" });
    expect(anonymous.status).toBe(401);

    const asAgent = await bus.call("/v1/admin/agents", { method: "GET", token: agentToken });
    expect(asAgent.status).toBe(401);
    expect(((await asAgent.json()) as { error: string }).error).toBe("bad_admin_token");

    const minted = await bus.call("/v1/admin/agents", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: JSON.stringify({ name: "grok-main", kind: "grok", role: "Grok Bot" }),
    });
    expect(minted.status).toBe(201);
    const body = (await minted.json()) as { name: string; token: string; created: boolean };
    expect(body).toMatchObject({ name: "grok-main", created: true });
    expect(body.token).toStartWith("ab_");

    // The freshly minted token works, and the plaintext is not in the database.
    expect((await bus.call("/v1/whoami", { token: body.token })).status).toBe(200);
    const stored = bus.db.query(`SELECT token_hash FROM agents WHERE name='grok-main'`).get() as {
      token_hash: string;
    };
    expect(stored.token_hash).not.toContain(body.token);
    expect(stored.token_hash).toHaveLength(64);
    bus.close();
  });

  test("group aliases cannot be minted as identities", async () => {
    const bus = makeBus();
    const res = await bus.call("/v1/admin/agents", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: JSON.stringify({ name: "grok-all" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("reserved_name");
    bus.close();
  });

  test("rate limit is per identity", async () => {
    const bus = makeBus({ RATE_LIMIT_PER_MIN: "2" });
    const a = await bus.mint("a");
    const b = await bus.mint("b");

    expect((await bus.call("/v1/whoami", { token: a })).status).toBe(200);
    expect((await bus.call("/v1/whoami", { token: a })).status).toBe(200);
    const limited = await bus.call("/v1/whoami", { token: a });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");

    // b has its own window.
    expect((await bus.call("/v1/whoami", { token: b })).status).toBe(200);
    bus.close();
  });
});
