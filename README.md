<p align="center">
  <img src="assets/logo.svg" alt="buzz-cf-agent logo" width="112" height="112" />
</p>

<h1 align="center">buzz-cf-agent</h1>

<p align="center">An AI agent for Buzz workspaces that runs on Cloudflare Workers. No laptop, no VM, no subprocess.</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#security">Security</a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="https://github.com/block/buzz">Buzz</a>
</p>

## Features

- **Per-thread memory.** Each Buzz thread gets its own persistent ThinkAgent session. Ask it to remember something in one message, it will in the next.
- **Agentic turns.** Built on [`@cloudflare/think`](https://developers.cloudflare.com/agents/harnesses/think/). Each mention triggers a full model + tools turn with the thread's full context.
- **Eye status reactions.** The agent reacts with a 👀 when it picks up a mention, then removes it after replying.
- **Signed Nostr events.** BIP-340 Schnorr signatures, NIP-98 HTTP auth. Same protocol, same audit trail as a human member.
- **Zero infrastructure.** One `wrangler deploy`.

## Quickstart

**Prerequisites:** Node.js 20+, a Cloudflare account with Workers AI, a Buzz relay where the agent's pubkey is admitted.

```bash
git clone https://github.com/your-username/buzz-cf-agent.git
cd buzz-cf-agent
npm install
```

Configure `wrangler.jsonc` with your relay URL and channel IDs, then set secrets:

```bash
npx wrangler secret put BUZZ_PRIVATE_KEY    # hex secp256k1 secret key
npx wrangler secret put ADMIN_SECRET          # bearer token for management endpoints
npx wrangler deploy
```

Wake the bridge (Durable Objects are lazy):

```bash
curl https://<your-worker>.workers.dev/status
# {"agent":"Think","pubkey":"8f30...","relay":"wss://...","handled":0}
```

The pubkey in the response is what a relay owner must admit as a member. Once admitted, @mention the agent in your Buzz workspace. It will react with 👀, think, and reply.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `BUZZ_RELAY_URL` | Relay WebSocket URL (`wss://...`) | |
| `BUZZ_CHANNEL_IDS` | Comma-separated channel UUIDs to join | |
| `POLL_SECONDS` | Poll interval in seconds | `15` |
| `AI_MODEL` | Workers AI model ID | `@cf/google/gemma-4-26b-a4b-it` |
| `AGENT_NAME` | Display name in Buzz | `Think` |
| `FETCH_ALLOWLIST` | URL globs for the `fetch_url` tool | empty (disabled) |
| `BUZZ_PRIVATE_KEY` | Nostr secret key (hex), wrangler secret | auto-generated if unset |
| `ADMIN_SECRET` | Bearer token for `/setup`, `/poll`, `/reset-seen` | open if unset |

## Getting admitted to a relay

The agent's pubkey must be admitted as a relay member. Options:

1. **Community API token.** Use the relay's admin API to add the pubkey as a member.
2. **NIP-OA auth tag.** If the owner delegates to the agent's pubkey, set it as a `BUZZ_AUTH_TAG` secret.
3. **Self-hosted relay.** Control membership directly.

## Security

- Incoming relay events are **signature-verified** before processing.
- Management endpoints are **auth-gated** with a bearer token.
- The `fetch_url` tool is **disabled by default**. Opt in via `FETCH_ALLOWLIST`.
- The `seen` table auto-cleans entries older than 7 days.

## Architecture

Buzz's native agents (`buzz-acp`) run as local stdio subprocesses on your laptop. When it sleeps, they die. This agent lives on Cloudflare Workers: always on, costs nothing idle, bounded tools instead of full filesystem access. Same Nostr protocol, same audit trail, different host.

For the full architecture and component breakdown, see [ARCHITECTURE.md](ARCHITECTURE.md).

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
