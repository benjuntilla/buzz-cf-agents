import { Agent, routeAgentRequest } from "agents";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  KIND,
  buildReply,
  generateSecretKey,
  getPublicKey,
  probeAuth,
  publishEvent,
  queryEvents,
  type NostrEvent,
} from "./nostr";

export type Env = {
  Think: DurableObjectNamespace;
  AI: AiBinding;
  BUZZ_RELAY_URL: string;
  POLL_SECONDS: string;
  AGENT_NAME: string;
  AI_MODEL: string;
  /** Optional: injected only if the operator provisions an externally-issued identity. */
  BUZZ_PRIVATE_KEY?: string;
  BUZZ_AUTH_TAG?: string;
};

type AiBinding = {
  run(model: string, input: {
    messages: Array<{ role: "system" | "user"; content: string }>;
    max_tokens?: number;
  }): Promise<unknown>;
};

type ThinkState = {
  npub: string | null;
  lastPollAt: number | null;
  lastAuth: { ok: boolean; reason: string | null; at: number } | null;
  handled: number;
};

/**
 * "Think" — a Buzz agent that lives entirely in a Durable Object.
 *
 * Identity is generated inside the DO on first boot and never leaves it: the
 * secret key is written to DO SQLite and only the public key is exposed. That
 * keeps the agent's keypair out of env vars, logs, and any sandbox.
 */
export class Think extends Agent<Env, ThinkState> {
  initialState: ThinkState = { npub: null, lastPollAt: null, lastAuth: null, handled: 0 };

  private sk: Uint8Array | null = null;

  async onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY, sk TEXT NOT NULL);
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS seen (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `;

    // An operator-provisioned key wins; otherwise self-generate once and persist.
    const injected = this.env.BUZZ_PRIVATE_KEY?.trim();
    if (injected) {
      this.sk = hexToBytes(injected);
    } else {
      const rows = this.sql<{ sk: string }>`SELECT sk FROM identity WHERE id = 1`;
      if (rows.length) {
        this.sk = hexToBytes(rows[0].sk);
      } else {
        const sk = generateSecretKey();
        this.sql`INSERT INTO identity (id, sk) VALUES (1, ${bytesToHex(sk)})`;
        this.sk = sk;
      }
    }

    this.setState({ ...this.state, npub: getPublicKey(this.sk) });

    // Hibernation-friendly transport: no pinned outbound WebSocket.
    const interval = Math.max(5, Number(this.env.POLL_SECONDS ?? "15") || 15);
    await this.scheduleEvery(interval, "poll");
  }

  private key(): Uint8Array {
    if (!this.sk) throw new Error("identity not initialised");
    return this.sk;
  }

  private relayHttp(): string {
    return this.env.BUZZ_RELAY_URL.replace(/^ws/, "http");
  }

  private authTag(): string[] | null {
    const raw = this.env.BUZZ_AUTH_TAG?.trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  }

  /** Live diagnostic: who am I, and does the relay accept me? */
  async status() {
    const pubkey = getPublicKey(this.key());

    // Reachability diagnostic: distinguish a TLS/edge failure from an auth failure,
    // and a plain HTTPS subrequest from a WebSocket upgrade.
    const reach: Record<string, string> = {};
    for (const [label, path, upgrade] of [
      ["health", "/health", false],
      ["healthUpgrade", "/health", true],
    ] as const) {
      try {
        const r = await fetch(`${this.relayHttp()}${path}`, {
          headers: upgrade ? { Upgrade: "websocket" } : {},
        });
        reach[label] = `${r.status}${upgrade ? ` ws=${r.webSocket ? "yes" : "no"}` : ""}`;
      } catch (err) {
        reach[label] = `throw: ${String(err).slice(0, 120)}`;
      }
    }

    const probe = await probeAuth(this.env.BUZZ_RELAY_URL, this.key(), this.authTag());
    this.setState({
      ...this.state,
      npub: pubkey,
      lastAuth: { ok: probe.ok, reason: probe.reason, at: Date.now() },
    });
    return {
      agent: this.env.AGENT_NAME ?? "Think",
      pubkey,
      relay: this.env.BUZZ_RELAY_URL,
      authorized: probe.ok,
      reason: probe.reason,
      hasAuthTag: this.authTag() !== null,
      identitySource: this.env.BUZZ_PRIVATE_KEY ? "provisioned" : "self-generated-in-DO",
      reachability: reach,
      transcript: probe.transcript,
      handled: this.state.handled,
    };
  }

  /** Scheduled poll for @mentions. Replaces a pinned WebSocket. */
  async poll() {
    const pubkey = getPublicKey(this.key());
    const since = Math.floor(Date.now() / 1000) - 300;
    const res = await queryEvents(this.relayHttp(), this.key(), {
      kinds: [KIND.CHAT],
      "#p": [pubkey],
      since,
      limit: 20,
    });
    this.setState({ ...this.state, lastPollAt: Date.now() });

    if (!res.ok) {
      // Most likely "not a relay member" until the identity is authorized.
      console.log(`poll rejected status=${res.status} body=${res.body}`);
      return;
    }

    // Oldest first so a burst is answered in order.
    const fresh = res.events
      .filter((e) => e.pubkey !== pubkey && !this.isSeen(e.id))
      .sort((a, b) => a.created_at - b.created_at);

    for (const ev of fresh) {
      this.markSeen(ev.id);
      await this.handleMention(ev);
    }
  }

  private isSeen(id: string): boolean {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM seen WHERE event_id = ${id}`[0].n > 0;
  }

  private markSeen(id: string) {
    this.sql`INSERT OR IGNORE INTO seen (event_id, at) VALUES (${id}, ${Date.now()})`;
  }

  private async handleMention(ev: NostrEvent) {
    const reply = await this.think(ev.content);
    const signed = buildReply(this.key(), ev, reply);
    const res = await publishEvent(this.relayHttp(), this.key(), signed);
    if (res.ok) {
      this.setState({ ...this.state, handled: this.state.handled + 1 });
    } else {
      console.log(`publish failed status=${res.status} body=${res.body}`);
    }
  }

  /** The model loop. Runs in the Worker; the relay only ever sees a signed event. */
  private async think(prompt: string): Promise<string> {
    try {
      const result = await this.env.AI.run(this.env.AI_MODEL, {
        max_tokens: 800,
        messages: [
          {
            role: "system",
            content: `You are ${this.env.AGENT_NAME ?? "Think"}, an agent in a Buzz workspace running on Cloudflare Workers. Be concise and useful. Plain text, no markdown headers.`,
          },
          { role: "user", content: prompt },
        ],
      });

      const text = extractAiText(result);
      return text || "(empty response)";
    } catch (error) {
      console.error(JSON.stringify({ event: "workers_ai_error", error: String(error) }));
      return "(model unavailable)";
    }
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/poll")) {
      await this.poll();
      return Response.json({ polled: true, state: this.state });
    }
    return Response.json(await this.status());
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Convenience: / and /status target the single "think" instance.
    if (url.pathname === "/" || url.pathname === "/status" || url.pathname === "/poll") {
      const stub = env.Think.get(env.Think.idFromName("think"));
      const target = new URL(req.url);
      target.pathname = url.pathname === "/poll" ? "/poll" : "/status";
      return stub.fetch(new Request(target.toString(), req));
    }

    return (
      (await routeAgentRequest(req, env)) ?? new Response("not found", { status: 404 })
    );
  },
};

function extractAiText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (typeof record.response === "string") return record.response.trim();

  const choices = record.choices;
  if (!Array.isArray(choices) || !choices.length || !choices[0] || typeof choices[0] !== "object") {
    return null;
  }

  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content.trim() : null;
}
