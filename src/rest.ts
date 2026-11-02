import { listIdentities, listWakes, mintIdentity, setDisabled, setWake } from "./admin";
import { askAndWait } from "./ask";
import { authenticate, enforceRateLimit, requireAdmin, type Agent } from "./auth";
import { ack, agents, clampLimit, inbox, markDeliveredIds, reply, send, thread } from "./bus";
import type { Env, ExecutionContext } from "./d1";
import { BusError } from "./errors";

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new BusError(400, "invalid_json", "Request body must be a JSON object");
  }
}

function truthy(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value !== "0" && value.toLowerCase() !== "false";
}

/** Admin routes: identity minting and wake-webhook config. Guarded by ADMIN_TOKEN. */
async function handleAdmin(
  req: Request,
  env: Env,
  url: URL,
  segments: string[],
): Promise<Response> {
  requireAdmin(env, req);
  const body = await jsonBody(req);

  // /v1/admin/agents
  if (segments.length === 1 && segments[0] === "agents") {
    if (req.method === "GET") return Response.json(await listIdentities(env));
    if (req.method === "POST") return Response.json(await mintIdentity(env, body), { status: 201 });
    throw new BusError(405, "method_not_allowed", `${req.method} not allowed here`);
  }

  // /v1/admin/agents/:name/(wake|disable|enable)
  if (segments.length === 3 && segments[0] === "agents") {
    const name = decodeURIComponent(segments[1]!);
    if (req.method !== "POST") throw new BusError(405, "method_not_allowed", "POST required");
    if (segments[2] === "wake") return Response.json(await setWake(env, name, body));
    if (segments[2] === "disable") return Response.json(await setDisabled(env, name, true));
    if (segments[2] === "enable") return Response.json(await setDisabled(env, name, false));
  }

  // /v1/admin/wakes
  if (segments.length === 1 && segments[0] === "wakes" && req.method === "GET") {
    return Response.json(
      await listWakes(env, url.searchParams.get("agent"), clampLimit(url.searchParams.get("limit"))),
    );
  }

  throw new BusError(404, "not_found", `No admin route for ${req.method} ${url.pathname}`);
}

/**
 * Plain-JSON mirror of the MCP tools, for shell scripts and the iMac poller.
 * Same auth, same identity rules, same storage.
 */
export async function handleRest(
  req: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  url: URL,
): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean).slice(1); // drop 'v1'

  if (segments[0] === "admin") {
    return handleAdmin(req, env, url, segments.slice(1));
  }

  const caller: Agent = await authenticate(env, req);
  await enforceRateLimit(env, caller.name);
  const body = await jsonBody(req);
  const route = `${req.method} ${segments.join("/")}`;

  switch (route) {
    case "GET whoami":
      return Response.json({ name: caller.name, role: caller.role, kind: caller.kind, wake: !!caller.wake_url });

    case "GET agents":
      return Response.json(await agents(env));

    // Does NOT mark delivered unless ?mark=1, so a poller can retry safely.
    case "GET inbox":
      return Response.json(
        await inbox(env, caller, {
          unreadOnly: truthy(url.searchParams.get("unread_only"), true),
          limit: url.searchParams.get("limit"),
          mark: truthy(url.searchParams.get("mark"), false),
        }),
      );

    case "POST delivered":
      return Response.json(await markDeliveredIds(env, caller, body.message_ids));

    case "POST send":
      return Response.json(await send(env, ctx, caller, body as never), { status: 201 });

    case "POST reply":
      return Response.json(await reply(env, ctx, caller, body as never), { status: 201 });

    case "POST ack":
      return Response.json(await ack(env, caller, body.message_id));

    case "POST ask":
      return Response.json(await askAndWait(env, ctx, caller, body as never));
  }

  if (req.method === "GET" && segments[0] === "thread" && segments.length === 2) {
    return Response.json(
      await thread(env, caller, decodeURIComponent(segments[1]!), {
        mark: truthy(url.searchParams.get("mark"), true),
      }),
    );
  }

  throw new BusError(404, "not_found", `No route for ${req.method} ${url.pathname}`);
}
