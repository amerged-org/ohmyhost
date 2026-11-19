/** Navigation hints never identify or authorize an account. */
export class McpChatReturnInputError extends TypeError {}

export function mcpChatClient(clientId: string) {
  if (
    clientId === "https://chatgpt.com/oauth/client.json" ||
    /^https:\/\/chatgpt\.com\/oauth\/[^/?#]+\/client\.json$/u.test(clientId)
  )
    return { name: "ChatGPT", origin: "https://chatgpt.com", path: "c" };
  if (clientId === "https://claude.ai/oauth/mcp-oauth-client-metadata")
    return { name: "Claude", origin: "https://claude.ai", path: "chat" };
  return null;
}

/** Accept actual host/caller URLs, never an anonymized MCP session identifier. */
export function mcpChatReturnUrl(clientId: string, candidate?: string | null) {
  const client = mcpChatClient(clientId);
  if (candidate === undefined || candidate === null) return client ? `${client.origin}/` : null;
  if (!client || candidate.length > 2048 || /[\s\p{Cc}]/u.test(candidate))
    throw new McpChatReturnInputError("Invalid chat return destination");
  let target: URL;
  try {
    target = new URL(candidate);
  } catch {
    throw new McpChatReturnInputError("Invalid chat return destination");
  }
  const thread = new RegExp(
    `^/${client.path}/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`,
    "u",
  );
  if (
    target.origin !== client.origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.pathname !== "/" && !thread.test(target.pathname)) ||
    target.href !== candidate
  )
    throw new McpChatReturnInputError("Invalid chat return destination");
  return target.href;
}
