import { afterEach, describe, expect, test } from "bun:test";
import { makeBus, stubFetch, tool, type FetchStub } from "./harness";

let stub: FetchStub | null = null;
afterEach(() => {
  stub?.restore();
  stub = null;
});

describe("wake webhooks", () => {
  test("delivering to an agent with a webhook POSTs the message envelope", async () => {
    stub = stubFetch();
    const bus = makeBus();
    const a = await bus.mint("a");
    await bus.mint("grok-main", {
      kind: "grok",
      wake_url: "https://hooks.example.com/grok",
      wake_key: "hook-secret",
    });

    const sent = (await tool(bus, a, "send", {
      to: "grok-main",
      subject: "PR 12 needs review",
      body: "look at the diff",
    })) as unknown as { message_ids: string[]; thread_id: string; woke: string[] };
    await bus.flush();

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe("https://hooks.example.com/grok");
    expect(stub.calls[0]!.headers.authorization).toBe("Bearer hook-secret");
    // Exactly the four documented fields, nothing from the body.
    expect(stub.calls[0]!.body).toEqual({
      message_id: sent.message_ids[0]!,
      thread_id: sent.thread_id,
      from: "a",
      subject: "PR 12 needs review",
    });
    expect(sent.woke).toEqual(["grok-main"]);

    const log = bus.db.query(`SELECT agent, status, error FROM wake_log`).all() as {
      agent: string;
      status: number;
      error: string | null;
    }[];
    expect(log).toEqual([{ agent: "grok-main", status: 200, error: null }]);
    bus.close();
  });

  test("a burst of messages wakes an agent once per 60 s window", async () => {
    stub = stubFetch();
    const bus = makeBus();
    const a = await bus.mint("a");
    await bus.mint("grok-main", { kind: "grok", wake_url: "https://hooks.example.com/grok" });

    for (let i = 0; i < 5; i++) {
      await tool(bus, a, "send", { to: "grok-main", body: `burst ${i}` });
      await bus.flush();
    }
    expect(stub.calls).toHaveLength(1);
    expect(bus.db.query(`SELECT COUNT(*) AS n FROM wake_log`).get()).toEqual({ n: 1 });

    // All five messages are still queued; only the wake was debounced.
    const inbox = await bus.call("/v1/inbox", {
      token: await bus.mint("x"),
    });
    expect(inbox.status).toBe(200);
    expect(bus.db.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 5 });

    // Once the window has passed, the next message wakes it again.
    bus.db.query(`UPDATE agents SET last_wake_at = ? WHERE name = 'grok-main'`).run(Date.now() - 61_000);
    await tool(bus, a, "send", { to: "grok-main", body: "after the window" });
    await bus.flush();
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]!.body.subject).toBe("");
    bus.close();
  });

  test("the debounce window is per agent", async () => {
    stub = stubFetch();
    const bus = makeBus();
    const a = await bus.mint("a");
    await bus.mint("grok-main", { kind: "grok", wake_url: "https://hooks.example.com/main" });
    await bus.mint("grok-ops", { kind: "grok", wake_url: "https://hooks.example.com/ops" });

    await tool(bus, a, "send", { to: "grok-all", body: "both of you" });
    await bus.flush();
    expect(stub.calls.map((c) => c.url).sort()).toEqual([
      "https://hooks.example.com/main",
      "https://hooks.example.com/ops",
    ]);
    bus.close();
  });

  test("pull-based identities are never POSTed, and a failed wake does not fail the send", async () => {
    stub = stubFetch();
    const bus = makeBus();
    const a = await bus.mint("a");
    await bus.mint("cos", { kind: "claude" }); // no wake_url: polled by the iMac
    await bus.mint("grok-main", { kind: "grok", wake_url: "https://hooks.example.com/dead" });

    await tool(bus, a, "send", { to: "cos", body: "pulled" });
    await bus.flush();
    expect(stub.calls).toHaveLength(0);

    stub.fail = true;
    const sent = (await tool(bus, a, "send", { to: "grok-main", body: "wake fails" })) as unknown as {
      message_ids: string[];
    };
    await bus.flush();
    expect(sent.message_ids).toHaveLength(1);

    const log = bus.db.query(`SELECT agent, status, error FROM wake_log`).get() as {
      agent: string;
      status: number | null;
      error: string | null;
    };
    expect(log.agent).toBe("grok-main");
    expect(log.status).toBeNull();
    expect(log.error).toContain("unreachable");
    bus.close();
  });

  test("an ack is stored but never spends a wake", async () => {
    stub = stubFetch();
    const bus = makeBus();
    const a = await bus.mint("a");
    await bus.mint("grok-main", { kind: "grok", wake_url: "https://hooks.example.com/grok" });

    const sent = (await tool(bus, a, "send", { to: "grok-main", body: "got it", kind: "ack" })) as unknown as {
      woke: string[];
      wake_held: { agent: string; reason: string }[];
    };
    await bus.flush();

    expect(stub.calls).toHaveLength(0);
    expect(sent.woke).toEqual([]);
    expect(sent.wake_held).toMatchObject([{ agent: "grok-main", reason: "quiet_kind" }]);
    expect(bus.db.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 1 });
    bus.close();
  });

  test("past the daily wake budget a message is stored, held and reported to the sender", async () => {
    stub = stubFetch();
    const bus = makeBus({ WAKE_DAILY_CAP: "2" });
    const a = await bus.mint("a");
    await bus.mint("grok-main", { kind: "grok", wake_url: "https://hooks.example.com/grok" });
    const nextWindow = () =>
      bus.db.query(`UPDATE agents SET last_wake_at = ? WHERE name = 'grok-main'`).run(Date.now() - 61_000);

    for (let i = 0; i < 2; i++) {
      await tool(bus, a, "send", { to: "grok-main", body: `job ${i}` });
      await bus.flush();
      nextWindow();
    }
    expect(stub.calls).toHaveLength(2);

    const held = (await tool(bus, a, "send", { to: "grok-main", body: "one too many" })) as unknown as {
      woke: string[];
      wake_held: { agent: string; reason: string; note: string }[];
    };
    await bus.flush();
    expect(stub.calls).toHaveLength(2);
    expect(held.woke).toEqual([]);
    expect(held.wake_held).toMatchObject([{ agent: "grok-main", reason: "daily_cap" }]);
    expect(held.wake_held[0]!.note).toContain("2 wakes");
    expect(bus.db.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 3 });

    // The budget is per calendar day: yesterday's wakes don't count against today.
    bus.db.query(`UPDATE wake_log SET at = ?`).run(Date.now() - 25 * 3_600_000);
    nextWindow();
    await tool(bus, a, "send", { to: "grok-main", body: "next day" });
    await bus.flush();
    expect(stub.calls).toHaveLength(3);
    bus.close();
  });

  test("kind urgent wakes even when the daily budget is spent", async () => {
    stub = stubFetch();
    const bus = makeBus({ WAKE_DAILY_CAP: "1" });
    const a = await bus.mint("a");
    await bus.mint("grok-main", { kind: "grok", wake_url: "https://hooks.example.com/grok" });

    await tool(bus, a, "send", { to: "grok-main", body: "the one allowed wake" });
    await bus.flush();
    bus.db.query(`UPDATE agents SET last_wake_at = ? WHERE name = 'grok-main'`).run(Date.now() - 61_000);

    const sent = (await tool(bus, a, "send", { to: "grok-main", body: "cannot wait", kind: "urgent" })) as unknown as {
      woke: string[];
      wake_held?: unknown;
    };
    await bus.flush();
    expect(stub.calls).toHaveLength(2);
    expect(sent.woke).toEqual(["grok-main"]);
    expect(sent.wake_held).toBeUndefined();
    bus.close();
  });

  test("wake_url and wake_key are never returned to callers", async () => {
    stub = stubFetch();
    const bus = makeBus();
    const a = await bus.mint("a");
    await bus.mint("grok-main", {
      kind: "grok",
      wake_url: "https://hooks.example.com/secret-path",
      wake_key: "super-secret",
    });

    const listed = JSON.stringify(await tool(bus, a, "agents"));
    expect(listed).not.toContain("secret-path");
    expect(listed).not.toContain("super-secret");
    expect(listed).toContain('"wake":true');
    bus.close();
  });
});
