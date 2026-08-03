import { Think } from "@cloudflare/think";
import type { UIMessage } from "ai";
import {
  initIdentity,
  pollMentions,
  publishReply,
  publishReaction,
  deleteEvent,
  setupAgent,
  clearSeen,
  cleanupSeen,
  fetchThreadContext,
  envString,
  type BuzzEnv,
  type BuzzIdentity,
  type ChatMessage,
  type SqlAgent,
} from "./buzz";

export type Env = {
  BuzzBridge: DurableObjectNamespace;
  ThinkAgent: DurableObjectNamespace;
  AI: Ai;
  BUZZ_RELAY_URL: string;
  POLL_SECONDS: string;
  AI_MODEL: string;
  BUZZ_PRIVATE_KEY?: string;
  BUZZ_AUTH_TAG?: string;
  BUZZ_CHANNEL_IDS?: string;
  FETCH_ALLOWLIST?: string;
  AGENT_NAME?: string;
  ADMIN_SECRET?: string;
};

type BridgeState = {
  lastPollAt: number | null;
  handled: number;
};

/** A relay message mapped to the AI SDK UIMessage shape (id = Nostr event id). */
function toUIMessage(m: ChatMessage): UIMessage {
  return {
    id: m.id,
    role: m.role,
    parts: [{ type: "text", text: m.content }],
  };
}

/**
 * BuzzBridge — the relay↔agent bridge. A single Durable Object that owns the
 * Nostr identity, polls the relay on a 15s alarm for @mentions, and dispatches
 * each mention to a per-thread ThinkAgent Durable Object that runs the
 * agentic turn. BuzzBridge signs and publishes the agent's reply.
 *
 * This is infrastructure, not an agent: it never calls a model and holds no
 * conversation state. All agentic work lives in ThinkAgent.
 */
export class BuzzBridge extends Think<Env> {
  private identity: BuzzIdentity | null = null;

  async onStart() {
    await super.onStart();
    this.identity = initIdentity(this as unknown as SqlAgent, envString(this.env, "BUZZ_PRIVATE_KEY"));
    await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalMs());
  }

  private pollIntervalMs(): number {
    return (parseInt(this.env.POLL_SECONDS || "15") || 15) * 1000;
  }

  async alarm() {
    try { await super.alarm(); } catch (e) {
      console.error("Think alarm error:", String(e));
    }
    try {
      await this.pollBuzz();
    } catch (e) {
      console.error("BuzzBridge pollBuzz error:", String(e));
    }
    await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalMs());
  }

  async pollBuzz() {
    if (!this.identity) return;
    const identity = this.identity;
    const state = (this.state ?? {}) as unknown as BridgeState;

    cleanupSeen(this as unknown as SqlAgent);

    const { mentions, newestAt } = await pollMentions(
      this.env as unknown as BuzzEnv,
      identity,
      this as unknown as SqlAgent,
      state.lastPollAt,
    );

    let handled = 0;
    await Promise.all(mentions.slice(0, 5).map(async (mention) => {
      try {
        const replyTag = mention.event.tags.find((t) => t[0] === "e");
        const hasThread = Boolean(replyTag);

        const context = hasThread
          ? await fetchThreadContext(this.env as unknown as BuzzEnv, identity, mention)
          : [];

        // 👀 reaction: signal the agent is processing
        const reactionId = await publishReaction(
          this.env as unknown as BuzzEnv, identity, mention.event, "👀",
        );

        try {
          const sessionKey = hasThread ? (replyTag![1] as string) : mention.event.id;
          const stub = this.env.ThinkAgent.get(this.env.ThinkAgent.idFromName(sessionKey));
          const res = await stub.fetch(new Request("https://buzz.internal/dispatch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mention: toUIMessage({ id: mention.event.id, role: "user", content: mention.content }),
              context: context.map(toUIMessage),
            }),
            signal: AbortSignal.timeout(60_000),
          }));
          if (!res.ok) {
            console.log(`session dispatch failed status=${res.status}`);
          } else {
            const { text } = (await res.json()) as { text: string };
            if (text) {
              const published = await publishReply(
                this.env as unknown as BuzzEnv,
                identity,
                this as unknown as SqlAgent,
                mention,
                text,
              );
              if (published) handled++;
            } else {
              console.log("empty agent response, skipping publish");
            }
          }
        } finally {
          // Always remove 👀 reaction, even on failure
          if (reactionId) {
            await deleteEvent(this.env as unknown as BuzzEnv, identity, reactionId);
          }
        }
      } catch (e) {
        console.error("BuzzBridge handle error:", String(e));
      }
    }));

    this.setState({
      ...(this.state ?? {}),
      lastPollAt: newestAt * 1000,
      handled: ((this.state ?? {}) as unknown as BridgeState).handled + handled,
    });
  }

  async buzzSetup(): Promise<Response> {
    if (!this.identity) return Response.json({ error: "not started" }, { status: 500 });
    const name = envString(this.env, "AGENT_NAME") || "Think";
    const results = await setupAgent(
      this.env as unknown as BuzzEnv,
      this.identity,
      name,
      this.env.BUZZ_CHANNEL_IDS ?? "",
    );
    return Response.json({ agent: name, ...results });
  }

  async buzzStatus(): Promise<Response> {
    if (!this.identity) return Response.json({ error: "not started" }, { status: 500 });
    const name = envString(this.env, "AGENT_NAME") || "Think";
    const s = (this.state ?? {}) as unknown as BridgeState;
    return Response.json({
      agent: name,
      pubkey: this.identity.pubkey,
      relay: this.env.BUZZ_RELAY_URL,
      handled: s.handled,
      lastPollAt: s.lastPollAt,
    });
  }

  async buzzResetSeen(): Promise<Response> {
    clearSeen(this as unknown as SqlAgent);
    this.setState({ ...(this.state ?? {}), lastPollAt: null, handled: 0 });
    return Response.json({ cleared: true });
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Auth-gated management endpoints
    if (url.pathname.endsWith("/setup") || url.pathname.endsWith("/reset-seen") || url.pathname.endsWith("/poll")) {
      const adminSecret = envString(this.env, "ADMIN_SECRET");
      if (adminSecret && req.headers.get("authorization") !== `Bearer ${adminSecret}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    if (url.pathname.endsWith("/setup")) return this.buzzSetup();
    if (url.pathname.endsWith("/status")) return this.buzzStatus();
    if (url.pathname.endsWith("/reset-seen")) return this.buzzResetSeen();
    if (url.pathname.endsWith("/poll")) {
      await this.pollBuzz();
      return Response.json({ polled: true });
    }
    return super.onRequest(req);
  }
}
