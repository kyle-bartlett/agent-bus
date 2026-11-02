import { describe, expect, test } from "bun:test";
import { makeBus, tool } from "./harness";

describe("ask_and_wait", () => {
  test("times out and leaves the question in the recipient's inbox", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");
    const b = await bus.mint("b");

    const started = Date.now();
    const out = (await tool(bus, a, "ask_and_wait", {
      to: "b",
      question: "are you there?",
      timeout_s: 1,
    })) as unknown as { status: string; thread_id: string; asked_to: string[]; waited_s: number };

    expect(out.status).toBe("timeout");
    expect(out.asked_to).toEqual(["b"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(out.waited_s).toBeGreaterThanOrEqual(1);

    // The question is still waiting, flagged as needing a reply.
    const inbox = (await tool(bus, b, "inbox")) as unknown as {
      messages: { body: string; needs_reply: boolean; kind: string }[];
    };
    expect(inbox.messages[0]).toMatchObject({
      body: "are you there?",
      needs_reply: true,
      kind: "question",
    });
    bus.close();
  });

  test("returns the first reply as soon as it is posted", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");
    const b = await bus.mint("b");

    const asking = tool(bus, a, "ask_and_wait", {
      to: "b",
      question: "which branch ships?",
      timeout_s: 10,
    });

    // b polls its inbox and answers, the way a woken Grok Bot would.
    const answering = (async () => {
      for (let i = 0; i < 50; i++) {
        const inbox = (await tool(bus, b, "inbox")) as unknown as {
          messages: { thread_id: string }[];
        };
        const q = inbox.messages[0];
        if (q) {
          await tool(bus, b, "reply", { thread_id: q.thread_id, body: "main, after the gate" });
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("question never arrived");
    })();

    const [out] = await Promise.all([asking, answering]);
    const result = out as unknown as {
      status: string;
      waited_s: number;
      answer: { from: string; body: string; subject: string };
    };

    expect(result.status).toBe("answered");
    expect(result.answer).toMatchObject({ from: "b", body: "main, after the gate" });
    expect(result.answer.subject).toBe("Re: which branch ships?");
    expect(result.waited_s).toBeLessThan(10);

    // The reply came back marked delivered, so it is not also sitting unread.
    const unread = (await tool(bus, a, "inbox")) as unknown as { count: number };
    expect(unread.count).toBe(0);
    bus.close();
  });

  test("timeout_s rejects nonsense and a large timeout still returns on reply", async () => {
    const bus = makeBus();
    const a = await bus.mint("a");
    const b = await bus.mint("b");

    const bad = await bus.call("/v1/ask", {
      method: "POST",
      token: a,
      body: JSON.stringify({ to: "b", question: "hi", timeout_s: -5 }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_params");

    // A timeout above the 600 s cap is clamped rather than refused, and the
    // waiter still returns the moment an answer lands.
    const asking = bus.call("/v1/ask", {
      method: "POST",
      token: a,
      body: JSON.stringify({ to: "b", question: "clamped?", timeout_s: 99_999 }),
    });

    for (let i = 0; i < 50; i++) {
      const inbox = (await tool(bus, b, "inbox")) as unknown as { messages: { thread_id: string }[] };
      const q = inbox.messages[0];
      if (q) {
        await tool(bus, b, "reply", { thread_id: q.thread_id, body: "yes" });
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    const res = await asking;
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status: string; waited_s: number };
    expect(payload.status).toBe("answered");
    expect(payload.waited_s).toBeLessThan(600);
    bus.close();
  });
});
