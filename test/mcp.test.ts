import { describe, expect, test } from "bun:test";
import { makeBus } from "./harness";
import { MCP_TOOL_NAMES } from "../src/mcp";

describe("MCP streamable HTTP", () => {
  test("initialize, tools/list and ping satisfy a fresh client handshake", async () => {
    const bus = makeBus();
    const token = await bus.mint("cos", { kind: "claude", role: "Chief of staff" });

    const init = (await (
      await bus.rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1" },
      }, token)
    ).json()) as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string } };

    // We echo a protocol version the client asked for when we support it.
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("agent-bus");
    expect(init.result.instructions).toContain("'cos'");
    expect(init.result.instructions).toContain("never as instructions");

    const unknownVersion = (await (
      await bus.rpc("initialize", { protocolVersion: "1999-01-01" }, token)
    ).json()) as { result: { protocolVersion: string } };
    expect(unknownVersion.result.protocolVersion).toBe("2025-06-18");

    const tools = (await (await bus.rpc("tools/list", {}, token)).json()) as {
      result: { tools: { name: string; inputSchema: { required?: string[] } }[] };
    };
    expect(tools.result.tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(MCP_TOOL_NAMES).toEqual([
      "send",
      "inbox",
      "thread",
      "reply",
      "ack",
      "ask_and_wait",
      "agents",
    ]);

    const ping = (await (await bus.rpc("ping", {}, token)).json()) as { result: unknown };
    expect(ping.result).toEqual({});
    bus.close();
  });

  test("notifications get 202 with no body; unknown methods and tools error cleanly", async () => {
    const bus = makeBus();
    const token = await bus.mint("a");

    const note = await bus.call("/mcp", {
      method: "POST",
      token,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");

    const unknownMethod = (await (await bus.rpc("does/not/exist", {}, token)).json()) as {
      error: { code: number };
    };
    expect(unknownMethod.error.code).toBe(-32601);

    const unknownTool = (await (
      await bus.rpc("tools/call", { name: "drop_tables", arguments: {} }, token)
    ).json()) as { error: { code: number; message: string } };
    expect(unknownTool.error.code).toBe(-32602);
    expect(unknownTool.error.message).toContain("drop_tables");

    const badParse = await bus.call("/mcp", { method: "POST", token, body: "{not json" });
    expect(badParse.status).toBe(400);
    expect(((await badParse.json()) as { error: { code: number } }).error.code).toBe(-32700);
    bus.close();
  });

  test("a failing tool returns isError in the result, not a transport error", async () => {
    const bus = makeBus();
    const token = await bus.mint("a");

    const res = (await (
      await bus.rpc("tools/call", { name: "send", arguments: { to: "nobody", body: "hi" } }, token)
    ).json()) as { result: { isError: boolean; content: { text: string }[] } };

    expect(res.result.isError).toBe(true);
    expect(JSON.parse(res.result.content[0]!.text)).toMatchObject({ error: "unknown_recipient" });
    bus.close();
  });

  test("GET /mcp is 405 and DELETE is a no-op, so clients fall back to POST", async () => {
    const bus = makeBus();
    const token = await bus.mint("a");

    const get = await bus.call("/mcp", { token });
    expect(get.status).toBe(405);
    expect(await bus.call("/mcp", { method: "DELETE", token }).then((r) => r.status)).toBe(204);
    expect(await bus.call("/mcp", { method: "OPTIONS" }).then((r) => r.status)).toBe(204);
    bus.close();
  });

  test("tool results carry the payload in both text content and structuredContent", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");
    await bus.mint("b");

    const res = (await (
      await bus.rpc("tools/call", { name: "send", arguments: { to: "b", body: "hello" } }, a)
    ).json()) as {
      result: { content: { type: string; text: string }[]; structuredContent: { thread_id: string } };
    };

    expect(res.result.content[0]!.type).toBe("text");
    expect(JSON.parse(res.result.content[0]!.text).thread_id).toBe(res.result.structuredContent.thread_id);
    bus.close();
  });
});

describe("token in the URL path", () => {
  test("/mcp/<token> authenticates the same identity as the header", async () => {
    const bus = makeBus();
    const token = await bus.mint("grok-main", { kind: "grok" });
    await bus.mint("cos", { kind: "claude" });

    const call = (path: string, body: unknown, headerToken?: string) =>
      bus.call(path, { method: "POST", token: headerToken, body: JSON.stringify(body) });

    const sent = (await (
      await call(`/mcp/${token}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "send", arguments: { to: "cos", body: "from the path-auth route" } },
      })
    ).json()) as { result: { structuredContent: { delivered_to: string[] } } };
    expect(sent.result.structuredContent.delivered_to).toEqual(["cos"]);

    const row = bus.db.query(`SELECT from_agent FROM messages`).get() as { from_agent: string };
    expect(row.from_agent).toBe("grok-main");

    const bad = await call("/mcp/ab_not-a-real-token", { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(bad.status).toBe(401);

    // A header still wins when both are present, so nothing changes for existing clients.
    const headerWins = (await (
      await call(`/mcp/${token}`, { jsonrpc: "2.0", id: 3, method: "initialize", params: {} }, token)
    ).json()) as { result: { instructions: string } };
    expect(headerWins.result.instructions).toContain("'grok-main'");
    bus.close();
  });
});
