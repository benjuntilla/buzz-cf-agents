# buzz-cf-agents — "Think"

A [Buzz](https://github.com/block/buzz) agent that lives entirely in a Cloudflare
Durable Object. No laptop, no VM, no ACP subprocess.

Buzz's own harness (`buzz-acp`) spawns agents as **local stdio subprocesses**, so a
Worker can never be a harnessed agent. Instead this connects as a plain Nostr client:
hold a keypair, authenticate, subscribe to mentions, publish signed events. At the
protocol level that is indistinguishable from a harnessed agent — same scoping, same
audit trail, same "member" status.

## Status: works end to end except relay membership

Verified against a real hosted Buzz relay (`wss://<community>.communities.buzz.xyz`):

| Step | Result |
|---|---|
| BIP-340 Schnorr signing in Workers (`@noble/curves`) | ✅ sign + verify + tamper-detect |
| NIP-42 auth handshake | ✅ challenge received, signature **accepted** |
| NIP-98 HTTP auth on REST bridge | ✅ reached app layer |
| Plain HTTPS subrequest, deployed Worker → relay | ✅ `200` |
| **WebSocket upgrade, deployed Worker → relay** | ❌ **`526`** (see below) |
| Relay authorization | ❌ `403 relay_membership_required` |

The relay's verdict on our signed auth event was `restricted: not a relay member` —
an **authorization** failure, not a crypto one. Everything up to the permission check
works; the agent's pubkey simply has to be admitted.

### The 526 finding

A **deployed** Worker cannot open a WebSocket to a Cloudflare-fronted Buzz relay:

```json
"reachability": { "health": "200", "healthUpgrade": "526 ws=no" }
```

Same URL, same TLS — plain HTTPS returns `200`, the `Upgrade: websocket` request
returns `526` (invalid origin certificate). `wrangler dev` succeeds because the
subrequest leaves your machine directly. Hosted `*.communities.buzz.xyz` sits behind
Cloudflare, so a Worker subrequest is orange-to-orange and the upgrade fails.

**Consequence:** on Workers, the REST/poll transport is not merely the cheaper
option — against a Cloudflare-hosted relay it is the *only* one that works. That
happens to coincide with the right design anyway, because outbound WebSockets
[cannot hibernate](https://github.com/cloudflare/workerd/issues/4864) and would pin
the Durable Object in memory. A self-hosted relay not behind Cloudflare can use
either transport.

## Design

```
Buzz relay ──REST /query (NIP-98, polled)──> Think (Agent / Durable Object)
           <──REST /events (signed kind 9)──  • keypair generated in the DO
                                              • SQLite: identity, seen-event set
                                              • scheduleEvery() → hibernates between polls
```

- **Identity never leaves the DO.** The secret key is generated on first boot and
  written to DO SQLite; only the public key is ever exposed. No key in env vars, no
  key in logs, no key in a sandbox. Set `BUZZ_PRIVATE_KEY` only if you must use an
  externally-issued identity.
- **Hibernation-friendly.** `scheduleEvery(POLL_SECONDS, "poll")` is idempotent and
  safe to call from `onStart()`, so the DO sleeps between polls instead of holding a
  connection open.
- **Replay-safe.** A `seen` table de-duplicates events across restarts and overlapping
  poll windows.

## Setup

```bash
npm install
npx wrangler deploy
curl https://<your-worker>.workers.dev/status
```

`/status` reports the agent's pubkey plus a live authorization verdict and relay
reachability — that pubkey is what an owner must admit to the relay.

Config lives in `wrangler.jsonc` (`BUZZ_RELAY_URL`, `POLL_SECONDS`, `AGENT_NAME`).
Optional secrets:

```bash
npx wrangler secret put BUZZ_AUTH_TAG       # NIP-OA delegation tag, if issued
```

Workers AI is configured as the `AI` binding in `wrangler.jsonc` and uses the model in
`AI_MODEL` (currently `@cf/meta/llama-3.1-8b-instruct`). The binding is remote so local
`wrangler dev` can exercise the real Workers AI account rather than a local simulator.

`nodejs_compat` is required — the `agents` package imports `path`.

## Getting admitted to a relay

The desktop app mints agent keypairs itself and does not export them; "Share" exports
a persona pack, not credentials. The channel-member search only resolves *existing*
relay members, so there is no invite-by-pubkey in the UI. Admitting an
externally-held pubkey needs one of:

1. the community **API token** (`buzz_…`, from the hosted dashboard) — visible in
   Buzz Desktop under community settings;
2. a **NIP-OA `auth_tag`** issued by the owner, delegating to this agent's pubkey
   (this is how desktop-managed agents are authorized — set it as `BUZZ_AUTH_TAG`);
3. a **self-hosted relay**, where you control membership directly.

## Notes for reuse

`src/nostr.ts` has no Cloudflare dependencies — events, NIP-42, NIP-98, filters, and
signing. Existing Nostr libraries assume Node or browser globals; this is
Workers-native and is the piece most worth extracting into its own package.

Use `@noble/*` v2 subpaths (`/secp256k1.js`, `/sha2.js`) and
`schnorr.utils.randomSecretKey()` — the v1 paths and `randomPrivateKey()` fail the
esbuild step.
