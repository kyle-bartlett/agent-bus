import { describe, expect, test } from "bun:test";
import { makeBus, tool } from "./harness";

interface MessageView {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  acked: boolean;
}

describe("routing", () => {
  test("send to a name lands in that inbox only", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");
    const b = await bus.mint("b");
    await bus.mint("c");

    const sent = (await tool(bus, a, "send", {
      to: "b",
      subject: "status",
      body: "deploy is green",
    })) as unknown as { delivered_to: string[]; thread_id: string };
    expect(sent.delivered_to).toEqual(["b"]);

    const bInbox = (await tool(bus, b, "inbox")) as unknown as { messages: MessageView[] };
    expect(bInbox.messages).toHaveLength(1);
    expect(bInbox.messages[0]).toMatchObject({ from: "a", to: "b", body: "deploy is green" });

    const cInbox = (await tool(bus, await bus.mint("c2"), "inbox")) as unknown as {
      messages: MessageView[];
    };
    expect(cInbox.messages).toHaveLength(0);

    // inbox marked them delivered, so a second unread pass is empty.
    const again = (await tool(bus, b, "inbox")) as unknown as { messages: MessageView[] };
    expect(again.messages).toHaveLength(0);
    bus.close();
  });

  test("unknown recipient and an oversized body are rejected", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");

    const unknown = await bus.call("/v1/send", {
      method: "POST",
      token: a,
      body: JSON.stringify({ to: "nobody", body: "hi" }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown_recipient");

    await bus.mint("b");
    const huge = await bus.call("/v1/send", {
      method: "POST",
      token: a,
      body: JSON.stringify({ to: "b", body: "x".repeat(32 * 1024 + 1) }),
    });
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as { error: string }).error).toBe("too_large");
    bus.close();
  });

  test("grok-all fans out to every grok but never the sender", async () => {
    const bus = makeBus();
    const g1 = await bus.mint("grok-main", { kind: "grok" });
    await bus.mint("grok-ops", { kind: "grok" });
    await bus.mint("cos", { kind: "claude" });

    const sent = (await tool(bus, g1, "send", { to: "grok-all", body: "all grok" })) as unknown as {
      delivered_to: string[];
      message_ids: string[];
    };
    expect(sent.delivered_to).toEqual(["grok-ops"]);
    expect(sent.message_ids).toHaveLength(1);

    const cos = await bus.mint("cos2", { kind: "claude" });
    const fromClaude = (await tool(bus, cos, "send", {
      to: "grok-all",
      body: "ping grok",
    })) as unknown as { delivered_to: string[] };
    expect(fromClaude.delivered_to.sort()).toEqual(["grok-main", "grok-ops"]);
    bus.close();
  });

  test("claude-any picks exactly one claude, the least loaded", async () => {
    const bus = makeBus();
    const g = await bus.mint("grok-main", { kind: "grok" });
    await bus.mint("claude-busy", { kind: "claude" });
    await bus.mint("claude-idle", { kind: "claude" });

    // Give claude-busy two undelivered messages so it is not the least loaded.
    await tool(bus, g, "send", { to: "claude-busy", body: "1" });
    await tool(bus, g, "send", { to: "claude-busy", body: "2" });

    const sent = (await tool(bus, g, "send", { to: "claude-any", body: "pick one" })) as unknown as {
      delivered_to: string[];
    };
    expect(sent.delivered_to).toEqual(["claude-idle"]);

    bus.close();
  });

  test("a group that resolves to nobody is an error, not a silent no-op", async () => {
    const solo = makeBus();
    const lonely = await solo.mint("lonely", { kind: "grok" });

    // The only grok on the bus, and nobody ever sends to themselves.
    const res = await solo.call("/v1/send", {
      method: "POST",
      token: lonely,
      body: JSON.stringify({ to: "grok-all", body: "anyone?" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no_recipients");
    solo.close();
  });

  test("thread replies route back to the sender and stay readable by both", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");
    const b = await bus.mint("b");

    const sent = (await tool(bus, a, "send", {
      to: "b",
      subject: "question",
      body: "which branch?",
      needs_reply: true,
    })) as unknown as { thread_id: string };

    const replied = (await tool(bus, b, "reply", {
      thread_id: sent.thread_id,
      body: "main",
    })) as unknown as { delivered_to: string[]; thread_id: string };
    expect(replied.delivered_to).toEqual(["a"]);
    expect(replied.thread_id).toBe(sent.thread_id);

    const aThread = (await tool(bus, a, "thread", { thread_id: sent.thread_id })) as unknown as {
      count: number;
      messages: MessageView[];
    };
    expect(aThread.count).toBe(2);
    expect(aThread.messages.map((m) => m.body)).toEqual(["which branch?", "main"]);
    expect(aThread.messages[1]!.subject).toBe("Re: question");

    // b replying again with nobody else's post since is fine; a replying into
    // its own thread with no counterpart is not.
    const soloThread = (await tool(bus, a, "send", { to: "b", body: "x" })) as unknown as {
      thread_id: string;
    };
    const noTarget = await bus.call("/v1/reply", {
      method: "POST",
      token: a,
      body: JSON.stringify({ thread_id: soloThread.thread_id, body: "talking to myself" }),
    });
    expect(noTarget.status).toBe(409);
    expect(((await noTarget.json()) as { error: string }).error).toBe("no_reply_target");
    bus.close();
  });

  test("outsiders cannot read or inject into someone else's thread", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");
    const b = await bus.mint("b");
    const snoop = await bus.mint("snoop");

    const sent = (await tool(bus, a, "send", { to: "b", body: "private" })) as unknown as {
      thread_id: string;
    };

    const read = await bus.call(`/v1/thread/${sent.thread_id}`, { token: snoop });
    expect(read.status).toBe(404);

    const inject = await bus.call("/v1/send", {
      method: "POST",
      token: snoop,
      body: JSON.stringify({ to: "b", body: "me too", thread_id: sent.thread_id }),
    });
    expect(inject.status).toBe(403);
    expect(((await inject.json()) as { error: string }).error).toBe("not_in_thread");

    expect((await bus.call(`/v1/thread/${sent.thread_id}`, { token: b })).status).toBe(200);
    bus.close();
  });

  test("REST inbox is non-destructive until delivered is posted; ack marks handled", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");
    const b = await bus.mint("b", { kind: "claude" });

    await tool(bus, a, "send", { to: "b", body: "poll me" });

    // The iMac poller reads twice and still sees the message.
    for (let i = 0; i < 2; i++) {
      const res = await bus.call("/v1/inbox?unread_only=1", { token: b });
      expect(((await res.json()) as { count: number }).count).toBe(1);
    }

    const listed = (await (await bus.call("/v1/inbox?unread_only=1", { token: b })).json()) as {
      messages: MessageView[];
    };
    const id = listed.messages[0]!.id;

    const marked = await bus.call("/v1/delivered", {
      method: "POST",
      token: b,
      body: JSON.stringify({ message_ids: [id] }),
    });
    expect(((await marked.json()) as { marked: number }).marked).toBe(1);

    const after = await bus.call("/v1/inbox?unread_only=1", { token: b });
    expect(((await after.json()) as { count: number }).count).toBe(0);

    // Another identity cannot mark or ack a message that is not addressed to it.
    const foreign = await bus.call("/v1/delivered", {
      method: "POST",
      token: a,
      body: JSON.stringify({ message_ids: [id] }),
    });
    expect(((await foreign.json()) as { marked: number }).marked).toBe(0);
    const badAck = await bus.call("/v1/ack", {
      method: "POST",
      token: a,
      body: JSON.stringify({ message_id: id }),
    });
    expect(badAck.status).toBe(404);

    await tool(bus, b, "ack", { message_id: id });
    const row = bus.db.query(`SELECT acked_at FROM messages WHERE id = ?`).get(id) as {
      acked_at: number | null;
    };
    expect(row.acked_at).toBeGreaterThan(0);
    bus.close();
  });

  test("agents() lists identities with roles and the group aliases", async () => {
    const bus = makeBus();
    const a = await bus.mint("cos", { kind: "claude", role: "Chief of staff" });
    await bus.mint("grok-main", { kind: "grok", role: "Grok Bot" });
    await bus.mint("retired", { kind: "agent" });
    bus.db.query(`UPDATE agents SET disabled = 1 WHERE name = 'retired'`).run();

    const out = (await tool(bus, a, "agents")) as unknown as {
      groups: string[];
      agents: { name: string; role: string; kind: string; wake: boolean }[];
    };
    expect(out.groups).toContain("grok-all");
    expect(out.groups).toContain("claude-any");
    expect(out.agents.map((x) => x.name)).toEqual(["cos", "grok-main"]);
    expect(out.agents[0]).toMatchObject({ role: "Chief of staff", kind: "claude", wake: false });
    bus.close();
  });
});
