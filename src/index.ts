import { authenticate, enforceRateLimit } from "./auth";
import type { Env, ExecutionContext } from "./d1";
import { asBusError } from "./errors";
import { handleMcp, SERVER_NAME } from "./mcp";
import { handleRest } from "./rest";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id",
  "access-control-max-age": "86400",
};

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

function errorResponse(e: unknown): Response {
  const err = asBusError(e);
  const res = Response.json({ error: err.code, message: err.message }, { status: err.status });
  if (err.status === 401) res.headers.set("www-authenticate", 'Bearer realm="agent-bus"');
  return res;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (req.method === "OPTIONS") return withHeaders(new Response(null, { status: 204 }));

      if (url.pathname === "/" || url.pathname === "/health") {
        return withHeaders(
          Response.json({
            ok: true,
            name: SERVER_NAME,
            version: env.SERVICE_VERSION ?? "0.1.0",
            mcp: new URL("/mcp", url).toString(),
            rest: new URL("/v1", url).toString(),
          }),
        );
      }

      if (url.pathname === "/mcp") {
        if (req.method === "DELETE") return withHeaders(new Response(null, { status: 204 }));
        if (req.method !== "POST") {
          // No server-initiated stream: clients must POST their JSON-RPC.
          return withHeaders(
            Response.json({ error: "method_not_allowed", message: "POST JSON-RPC to /mcp" }, { status: 405 }),
          );
        }
        const caller = await authenticate(env, req);
        await enforceRateLimit(env, caller.name);
        return withHeaders(await handleMcp(req, env, ctx, caller));
      }

      if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
        return withHeaders(await handleRest(req, env, ctx, url));
      }

      return withHeaders(
        Response.json({ error: "not_found", message: `No route for ${url.pathname}` }, { status: 404 }),
      );
    } catch (e) {
      return withHeaders(errorResponse(e));
    }
  },
};
