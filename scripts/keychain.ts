/** macOS Keychain access for agent-bus tokens. Service `agent-bus`, account = agent name. */

export const SERVICE = "agent-bus";
export const BASE_URL_ACCOUNT = "_base_url";
export const ADMIN_ACCOUNT = "_admin";

export function keychainGet(account: string, service = SERVICE): string | null {
  const out = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-a", account, "-w"]);
  if (out.exitCode !== 0) return null;
  const value = new TextDecoder().decode(out.stdout).trim();
  return value || null;
}

export function keychainSet(account: string, value: string, service = SERVICE): void {
  // -U updates in place when the item already exists.
  const out = Bun.spawnSync([
    "security",
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-w",
    value,
    "-D",
    "agent-bus token",
  ]);
  if (out.exitCode !== 0) {
    throw new Error(`keychain write failed for ${service}/${account}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

export function baseUrl(): string {
  const value = process.env.AGENT_BUS_URL ?? keychainGet(BASE_URL_ACCOUNT);
  if (!value) {
    throw new Error(
      `No base URL. Set AGENT_BUS_URL, or store it: security add-generic-password -U -s ${SERVICE} -a ${BASE_URL_ACCOUNT} -w https://...`,
    );
  }
  return value.replace(/\/+$/, "");
}

export function adminToken(): string {
  const value = process.env.AGENT_BUS_ADMIN_TOKEN ?? keychainGet(ADMIN_ACCOUNT);
  if (!value) {
    throw new Error(
      `No admin token. Set AGENT_BUS_ADMIN_TOKEN, or store it: security add-generic-password -U -s ${SERVICE} -a ${ADMIN_ACCOUNT} -w <token>`,
    );
  }
  return value;
}

export interface ApiOptions {
  method?: string;
  token?: string;
  body?: unknown;
  base?: string;
}

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: ApiOptions = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${opts.base ?? baseUrl()}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await res.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: "non_json_response", message: text.slice(0, 400) };
    }
  }
  return { status: res.status, body: body as T };
}

/** Calls one MCP tool over Streamable HTTP and returns its structured payload. */
export async function mcpTool<T = Record<string, unknown>>(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  base?: string,
): Promise<T> {
  const { status, body } = await api<{
    result?: { structuredContent?: T; isError?: boolean; content?: { text: string }[] };
    error?: { message: string };
  }>("/mcp", {
    method: "POST",
    token,
    base,
    body: { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
  });

  if (status !== 200) throw new Error(`/mcp ${name} returned HTTP ${status}`);
  if (body.error) throw new Error(`/mcp ${name} rpc error: ${body.error.message}`);
  if (body.result?.isError) throw new Error(`/mcp ${name} tool error: ${body.result.content?.[0]?.text}`);
  return body.result?.structuredContent as T;
}
