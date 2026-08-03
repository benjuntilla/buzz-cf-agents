# buzz-cf-agent

An AI agent for [Buzz](https://github.com/block/buzz) workspaces that runs entirely on Cloudflare Workers. No laptop, no VM, no local subprocess — just Durable Objects and a relay.

## Features

- **Per-thread memory.** Each Buzz thread gets its own persistent ThinkAgent session. Ask it to remember something in one message, it will in the next.
- **Agentic turns.** Built on [`@cloudflare/think`](https://developers.cloudflare.com/agents/harnesses/think/) — each mention triggers a full model + tools turn with the thread's full context.
- **👀 status reactions.** The agent reacts with 👀 when it picks up a mention, then removes it after replying.
- **Signed Nostr events.** BIP-340 Schnorr signatures, NIP-98 HTTP auth. Indistinguishable from a human member at the protocol level.
- **Zero infrastructure.** One `wrangler deploy` and you're done.

## Quickstart

**Prerequisites:** Node.js 20+, a Cloudflare account with Workers AI, a Buzz relay where the agent's pubkey is admitted.

```bash
git clone https://github.com/your-username/buzz-cf-agent.git
cd buzz-cf-agent
npm install
```

Configure `wrangler.jsonc` with your relay URL and channel IDs, then set secrets:

```bash
npx wrangler secret put BUZZ_PRIVATE_KEY    # hex-encoded secp256k1 secret key
npx wrangler secret put ADMIN_SECRET          # bearer token for management endpoints
npx wrangler deploy
```

Wake the bridge (Durable Objects are lazy):

```bash
curl https://<your-worker>.workers.dev/status
# → {"agent":"Think","pubkey":"8f30...","relay":"wss://...","handled":0}
```

The pubkey in the response is what a relay owner must admit as a member. Once admitted, `@mention` the agent in your Buzz workspace — it will react with 👀, think, and reply.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `BUZZ_RELAY_URL` | Relay WebSocket URL (`wss://...`) | — |
| `BUZZ_CHANNEL_IDS` | Comma-separated channel UUIDs to join | — |
| `POLL_SECONDS` | Poll interval in seconds | `15` |
| `AI_MODEL` | Workers AI model ID | `@cf/google/gemma-4-26b-a4b-it` |
| `AGENT_NAME` | Display name in Buzz | `Think` |
| `FETCH_ALLOWLIST` | Comma-separated URL globs for the `fetch_url` tool | _(empty — fetch disabled)_ |
| `BUZZ_PRIVATE_KEY` | Agent's Nostr secret key (hex) — wrangler secret | auto-generated if unset |
| `ADMIN_SECRET` | Bearer token for `/setup`, `/poll`, `/reset-seen` | _(open if unset)_ |

## Getting admitted to a relay

The agent's pubkey must be admitted as a relay member. Options:

1. **Community API token** — use the relay's admin API to add the pubkey as a member.
2. **NIP-OA auth tag** — if the owner delegates to the agent's pubkey, set it as a `BUZZ_AUTH_TAG` secret.
3. **Self-hosted relay** — control membership directly.

## Security

- Incoming relay events are **signature-verified** before processing.
- Management endpoints are **auth-gated** with a bearer token.
- The `fetch_url` tool is **disabled by default** — opt in via `FETCH_ALLOWLIST`.
- The `seen` table auto-cleans entries older than 7 days.

## Architecture

For the full architecture, component breakdown, and comparison with Buzz's native `buzz-acp` agents, see [ARCHITECTURE.md](ARCHITECTURE.md).

```
  Buzz native agents (buzz-acp)              buzz-cf-agent (this project)
  ─────────────────────────────              ─────────────────────────────

  ┌─────────────┐    stdio                   ┌──────────────────────┐
  │ Buzz Desktop │    JSON-RPC               │  Cloudflare Worker   │
  │ (your laptop)│◄──────► buzz-agent        │                      │
  │              │         │                 │  ┌────────────────┐  │
  │              │    ┌────▼─────┐            │  │  BuzzBridge    │  │
  │              │    │   LLM    │            │  │  (1 instance)  │  │
  │              │    │  + MCP   │            │  │  poll + sign   │  │
  │              │    │  tools   │            │  └───────┬────────┘  │
  │              │    └────┬─────┘            │          │ dispatch  │
  │              │         │ WebSocket        │  ┌───────▼────────┐  │
  └──────┬───────┘         │                  │  │  ThinkAgent    │  │
         │                 │                  │  │  (1 per thread)│  │
         │      ┌──────────▼────┐              │  │  runTurn + AI │  │
         └─────►│   Buzz relay   │◄─── REST ───┘  └───────────────┘  │
                │   (Nostr)      │◄─── NIP-98 ──────────────────────┘
                └────────────────┘

  Agent dies when laptop sleeps          Agent is always on, costs nothing idle
  Full filesystem + shell access         Bounded tools (fetch_url with allowlist)
  WebSocket to relay                      REST polling (Workers can't open WS)
  Desktop app manages lifecycle           Durable Objects manage lifecycle
```

## License

[MIT](LICENSE)
