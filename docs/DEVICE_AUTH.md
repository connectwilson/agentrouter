# Agent connection authorization

## Product requirement

An ordinary AgentRouter user must never copy a secret into a chat or edit an MCP configuration to use prepaid credits. Installation and account authorization are separate, deliberate actions:

1. The user installs AgentRouter once and reloads the AI client.
2. On the first paid request, the local bridge starts a short-lived device authorization and returns a browser link plus a human-readable code.
3. The user signs in to AgentRouter and approves the named client in the browser.
4. The bridge polls for completion, receives the credential once, and writes it to an origin-scoped local credential store with owner-only permissions.
5. Future calls authenticate automatically. The Dashboard lists the connected client and lets the user disconnect it.

Developer API keys remain available only as an advanced fallback for CI and headless servers that cannot complete browser approval.

## Security and privacy requirements

- The device secret is high entropy and is stored server-side only as a hash.
- The human code is short-lived, expires after ten minutes, and is never itself a bearer credential.
- Polling has a minimum interval and returns standard pending, slow-down, expired, and denied states.
- Approval requires an authenticated AgentRouter browser session and displays the requesting client name.
- The access credential is returned exactly once and is never returned to the main AI agent as tool output.
- The local bridge stores credentials by AgentRouter origin in `~/.agentrouter/credentials.json`; the directory is mode `0700` and the file is mode `0600`.
- An explicit `AGENT_ROUTER_API_KEY` environment variable remains a compatible override for managed server deployments.
- Disconnecting a client immediately revokes its credential. GitHub credentials, provider credentials, browser cookies, and local social data are outside this flow.

## Protocol choice

Remote HTTP MCP authorization should use the MCP authorization profile built on OAuth 2.1 and PKCE. A local stdio server does not participate in that HTTP transport flow, so AgentRouter uses the OAuth device authorization interaction for its local bridge: a non-browser process asks the user to approve in a separate browser and polls for the result.

References: [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628), and [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

## Operational scope

Pending authorizations are ephemeral. A server restart invalidates an unfinished ten-minute flow and the bridge starts a new one; issued device credentials use the persistent credit-key store and survive restarts. Multi-instance deployments should move pending grants to a shared TTL store before horizontal scaling.
