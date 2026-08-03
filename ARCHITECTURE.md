# Architecture

## Components

| Component | File | Role |
|---|---|---|
| Bridge | `src/bridge.ts` | Owns the Nostr identity, polls for mentions on an alarm, dispatches to ThinkAgent, signs and publishes replies. Never calls a model. |
| Agent | `src/session.ts` | One instance per thread root. Runs `runTurn({ mode: "wait" })` with tools and persistent per-thread memory. |
| Buzz logic | `src/buzz.ts` | Identity, polling, replies, thread context, reactions, seen-event cleanup. |
| Nostr | `src/nostr.ts` | BIP-340 signing, NIP-98 auth, event building, relay queries, signature verification. No Cloudflare deps. Reusable as a standalone package. |
| Entry | `src/index.ts` | Routes HTTP to BuzzBridge; falls through to `routeAgentRequest`. |

## Why REST polling instead of WebSocket?

Deployed Workers cannot open WebSockets to Cloudflare-hosted relays (526 on upgrade). Even if they could, outbound WebSockets would pin the Durable Object in memory and defeat hibernation. REST polling via `setAlarm` is the correct design. The bridge sleeps between polls, costing nothing when idle. ThinkAgent instances are lazy: created on first dispatch, only awake to run a turn.

## Per-thread memory

Thread context from the relay is synced **idempotently** into each ThinkAgent's persistent transcript via `addMessages`, keyed by Nostr event id. Re-syncing the same messages across polls is a no-op. The agent's own replies are never re-synced. Each thread accumulates durable conversation memory with Think's compaction handling long threads.

## Reaction status

When the bridge picks up a mention, it publishes a 👀 reaction (NIP-25, kind 7). After the agent completes its turn and the reply is published, the 👀 is deleted (NIP-09, kind 5). Wrapped in `try/finally` so the reaction is always cleaned up, even on failure.

## How it differs from Buzz's native agents

Buzz's agent integration (`buzz-acp`) spawns coding agents as **local stdio subprocesses** on your machine. The desktop app is the host: it manages the process lifecycle, pipes JSON-RPC over stdio, and connects the agent to the relay via WebSocket. When your laptop sleeps, the agent stops.

This project takes a different bet: the agent lives **on Cloudflare**, not on your laptop. It polls the relay on an alarm, runs an agentic turn per mention, and signs Nostr events back. It's always on, costs nothing when idle, and never needs a human's machine to stay alive.

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

At the protocol level both approaches are identical: signed Nostr events, NIP-98 auth, same audit trail, same member status. The difference is where the process lives and how it reaches the relay.
