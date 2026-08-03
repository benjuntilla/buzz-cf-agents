import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  KIND,
  buildDeletion,
  buildReaction,
  buildReply,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  publishEvent,
  queryEvents,
  verifyEvent,
  type NostrEvent,
} from "./nostr";

export type BuzzEnv = {
  BUZZ_RELAY_URL: string;
  POLL_SECONDS: string;
  BUZZ_PRIVATE_KEY?: string;
  BUZZ_AUTH_TAG?: string;
  BUZZ_CHANNEL_IDS?: string;
};

export type BuzzIdentity = {
  sk: Uint8Array;
  pubkey: string;
};

export type BuzzMention = {
  event: NostrEvent;
  content: string;
};

export type SqlAgent = {
  sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T[];
};

export function relayHttp(env: Pick<BuzzEnv, "BUZZ_RELAY_URL">): string {
  return env.BUZZ_RELAY_URL.replace(/^wss?:\/\//, "https://");
}

export function envString(env: unknown, key: string): string | undefined {
  return (env as Record<string, unknown>)[key] as string | undefined;
}

function isSeen(agent: SqlAgent, id: string): boolean {
  return agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM seen WHERE event_id = ${id}`[0].n > 0;
}

export function markSeen(agent: SqlAgent, id: string): void {
  agent.sql`INSERT OR IGNORE INTO seen (event_id, at) VALUES (${id}, ${Date.now()})`;
}

export function clearSeen(agent: SqlAgent): void {
  agent.sql`DELETE FROM seen`;
  agent.sql`DELETE FROM seen WHERE at < ${Date.now() - 7 * 86_400_000}`;
}

/** Load or generate the agent's Nostr keypair. */
export function initIdentity(
  agent: SqlAgent,
  privateKeyHex: string | undefined,
): BuzzIdentity {
  agent.sql`
    CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY, sk TEXT NOT NULL);
  `;
  agent.sql`
    CREATE TABLE IF NOT EXISTS seen (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `;

  if (privateKeyHex?.trim()) {
    const sk = hexToBytes(privateKeyHex.trim());
    return { sk, pubkey: getPublicKey(sk) };
  }

  const rows = agent.sql<{ sk: string }>`SELECT sk FROM identity WHERE id = 1`;
  if (rows.length) {
    const sk = hexToBytes(rows[0].sk);
    return { sk, pubkey: getPublicKey(sk) };
  }

  const sk = generateSecretKey();
  agent.sql`INSERT INTO identity (id, sk) VALUES (1, ${bytesToHex(sk)})`;
  return { sk, pubkey: getPublicKey(sk) };
}

/** Poll the relay for unhandled @mentions of this agent's pubkey. */
export async function pollMentions(
  env: BuzzEnv,
  identity: BuzzIdentity,
  agent: SqlAgent,
  lastPollAt: number | null,
): Promise<{ mentions: BuzzMention[]; newestAt: number; ok: boolean }> {
  const since = Math.floor((lastPollAt ?? Date.now() - 3600_000) / 1000);
  const res = await queryEvents(relayHttp(env), identity.sk, {
    kinds: [KIND.CHAT],
    "#p": [identity.pubkey],
    since,
    limit: 20,
  });

  if (!res.ok) {
    console.log(`poll rejected status=${res.status} body=${res.body}`);
    return { mentions: [], newestAt: Math.floor(Date.now() / 1000), ok: false };
  }

  const fresh = res.events
    .filter((e) => verifyEvent(e) && e.pubkey !== identity.pubkey && !isSeen(agent, e.id))
    .sort((a, b) => a.created_at - b.created_at);

  const mentions: BuzzMention[] = fresh.map((event) => ({
    event,
    content: event.content,
  }));

  const newestAt = fresh.length ? fresh[fresh.length - 1].created_at : Math.floor(Date.now() / 1000);
  return { mentions, newestAt, ok: true };
}

/** Publish a threaded reply to the Buzz relay. Returns true on success. */
export async function publishReply(
  env: BuzzEnv,
  identity: BuzzIdentity,
  agent: SqlAgent,
  mention: BuzzMention,
  content: string,
): Promise<boolean> {
  const signed = buildReply(identity.sk, mention.event, content);
  const res = await publishEvent(relayHttp(env), identity.sk, signed);
  if (res.ok) {
    markSeen(agent, mention.event.id);
    return true;
  }
  console.log(`publish failed status=${res.status} body=${res.body}`);
  return false;
}

/** Publish a 👀 reaction to a mention event (visual "thinking" indicator). */
export async function publishReaction(
  env: BuzzEnv,
  identity: BuzzIdentity,
  target: NostrEvent,
  emoji: string,
): Promise<string | null> {
  const signed = buildReaction(identity.sk, target, emoji);
  const res = await publishEvent(relayHttp(env), identity.sk, signed);
  if (res.ok) return signed.id;
  console.log(`reaction publish failed status=${res.status} body=${res.body}`);
  return null;
}

/** Delete a previously published event (e.g. remove a 👀 reaction). */
export async function deleteEvent(
  env: BuzzEnv,
  identity: BuzzIdentity,
  targetId: string,
): Promise<boolean> {
  const signed = buildDeletion(identity.sk, targetId);
  const res = await publishEvent(relayHttp(env), identity.sk, signed);
  return res.ok;
}

/** Publish a kind 0 profile and join channels. */
export async function setupAgent(
  env: BuzzEnv,
  identity: BuzzIdentity,
  name: string,
  channelIds: string,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};

  const profileEvent = finalizeEvent(identity.sk, {
    kind: 0,
    content: JSON.stringify({
      name,
      about: `An agent running on Cloudflare Workers AI.`,
    }),
  });
  const profileRes = await publishEvent(relayHttp(env), identity.sk, profileEvent);
  results.profile = { ok: profileRes.ok, status: profileRes.status, body: profileRes.body };

  const ids = channelIds.split(",").map((s) => s.trim()).filter(Boolean);
  const joins: unknown[] = [];
  for (const channelId of ids) {
    const joinEvent = finalizeEvent(identity.sk, {
      kind: 9021,
      tags: [["h", channelId]],
    });
    const joinRes = await publishEvent(relayHttp(env), identity.sk, joinEvent);
    joins.push({ channelId, ok: joinRes.ok, status: joinRes.status, body: joinRes.body });
  }
  results.joins = joins;
  return results;
}

export type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

function eventsToMessages(events: NostrEvent[], agentPubkey: string): ChatMessage[] {
  return events.map((ev) => ({
    id: ev.id,
    role: ev.pubkey === agentPubkey ? "assistant" as const : "user" as const,
    content: ev.content,
  }));
}

/** Fetch previous messages in the same thread as a mention (including the root). */
export async function fetchThreadContext(
  env: BuzzEnv,
  identity: BuzzIdentity,
  mention: BuzzMention,
): Promise<ChatMessage[]> {
  const rootTag = mention.event.tags.find((t) => t[0] === "e");
  const rootId = rootTag ? rootTag[1] : mention.event.id;

  const res = await queryEvents(relayHttp(env), identity.sk, {
    kinds: [KIND.CHAT],
    "#e": [rootId],
    limit: 30,
  });

  const allEvents: NostrEvent[] = [];

  if (rootTag) {
    const [rootRes, threadRes] = await Promise.all([
      queryEvents(relayHttp(env), identity.sk, { ids: [rootId] }),
      Promise.resolve(res),
    ]);
    if (rootRes.ok) allEvents.push(...rootRes.events);
    if (threadRes.ok) allEvents.push(...threadRes.events);
  } else if (res.ok) {
    allEvents.push(...res.events);
  }

  const events = allEvents
    .filter((e) => e.id !== mention.event.id && e.pubkey !== identity.pubkey)
    .sort((a, b) => a.created_at - b.created_at);

  return eventsToMessages(events, identity.pubkey);
}

export function cleanupSeen(agent: SqlAgent): void {
  agent.sql`DELETE FROM seen WHERE at < ${Date.now() - 7 * 86_400_000}`;
}
