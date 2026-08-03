import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type Unsigned = Omit<NostrEvent, "id" | "sig">;

export const KIND = {
  CHAT: 9,
  REACTION: 7, // NIP-25
  DELETION: 5, // NIP-09
  AUTH: 22242, // NIP-42
  HTTP_AUTH: 27235, // NIP-98
} as const;

/** NIP-01 event id: sha256 over the canonical serialization. */
export function eventId(e: Unsigned): string {
  const ser = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return bytesToHex(sha256(new TextEncoder().encode(ser)));
}

export function getPublicKey(sk: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(sk));
}

export function generateSecretKey(): Uint8Array {
  return schnorr.utils.randomSecretKey();
}

/** Sign an event draft with BIP-340 Schnorr. */
export function finalizeEvent(
  sk: Uint8Array,
  draft: { kind: number; tags?: string[][]; content?: string; created_at?: number }
): NostrEvent {
  const unsigned: Unsigned = {
    pubkey: getPublicKey(sk),
    created_at: draft.created_at ?? Math.floor(Date.now() / 1000),
    kind: draft.kind,
    tags: draft.tags ?? [],
    content: draft.content ?? "",
  };
  const id = eventId(unsigned);
  return { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}

export function verifyEvent(e: NostrEvent): boolean {
  try {
    const { id, sig, ...rest } = e;
    if (eventId(rest as Unsigned) !== id) return false;
    return schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

/** NIP-98 Authorization header value for an HTTP request. */
export function nip98Header(sk: Uint8Array, url: string, method: string): string {
  const ev = finalizeEvent(sk, {
    kind: KIND.HTTP_AUTH,
    tags: [
      ["u", url],
      ["method", method.toUpperCase()],
      ["nonce", crypto.randomUUID()],
    ],
  });
  // btoa is available in Workers; JSON is ASCII-safe here.
  return `Nostr ${btoa(JSON.stringify(ev))}`;
}

/** Fetch with retry on 526 (orange-to-orange Cloudflare TLS issue). */
async function fetchRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const resp = await fetch(url, init);
    if (resp.status !== 526) return resp;
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return fetch(url, init);
}

/** Query stored events over the relay's REST bridge using NIP-98 auth. */
export async function queryEvents(
  relayHttpUrl: string,
  sk: Uint8Array,
  filter: Record<string, unknown>
): Promise<{ ok: boolean; status: number; events: NostrEvent[]; body?: string }> {
  const url = `${relayHttpUrl.replace(/\/$/, "")}/query`;
  const resp = await fetchRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: nip98Header(sk, url, "POST"),
    },
    body: JSON.stringify([filter]),
  });
  if (!resp.ok) {
    return { ok: false, status: resp.status, events: [], body: (await resp.text()).slice(0, 400) };
  }
  const data = (await resp.json()) as unknown;
  const events = Array.isArray(data) ? (data as NostrEvent[]) : [];
  return { ok: true, status: resp.status, events };
}

/** Publish a signed event over the relay's REST bridge. */
export async function publishEvent(
  relayHttpUrl: string,
  sk: Uint8Array,
  event: NostrEvent
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${relayHttpUrl.replace(/\/$/, "")}/events`;
  const resp = await fetchRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: nip98Header(sk, url, "POST"),
    },
    body: JSON.stringify(event),
  });
  return { ok: resp.ok, status: resp.status, body: (await resp.text()).slice(0, 400) };
}

/** Build a threaded reply matching Buzz Desktop's convention: a single #e tag
 *  with "reply" marker that always points to the thread root (not the immediate
 *  parent). Top-level mentions have no #e tags, so the replied-to event IS the root. */
export function buildReply(
  sk: Uint8Array,
  parent: NostrEvent,
  content: string
): NostrEvent {
  const channel = parent.tags.find((t) => t[0] === "h")?.[1];
  const tags: string[][] = [];
  if (channel) tags.push(["h", channel]);

  // Find the thread root: check parent's #e tags.
  // Buzz Desktop uses a single #e tag with "reply" marker pointing to the root.
  // If parent has no #e tags, the parent itself is the root.
  const parentETag = parent.tags.find((t) => t[0] === "e");
  const rootId = parentETag
    ? parentETag[1]                       // parent's e tag points to the root
    : parent.id;                          // parent IS the root

  tags.push(["e", rootId, "", "reply"]);
  tags.push(["p", parent.pubkey]);
  return finalizeEvent(sk, { kind: KIND.CHAT, tags, content });
}

/** Build a NIP-25 reaction event (kind 7) targeting a specific message. */
export function buildReaction(
  sk: Uint8Array,
  target: NostrEvent,
  content: string,
): NostrEvent {
  const tags: string[][] = [
    ["e", target.id, "", "reaction"],
    ["p", target.pubkey],
  ];
  const channel = target.tags.find((t) => t[0] === "h")?.[1];
  if (channel) tags.push(["h", channel]);
  return finalizeEvent(sk, { kind: KIND.REACTION, tags, content });
}

/** Build a NIP-09 deletion event (kind 5) targeting a specific event id. */
export function buildDeletion(
  sk: Uint8Array,
  targetId: string,
): NostrEvent {
  return finalizeEvent(sk, { kind: KIND.DELETION, tags: [["e", targetId]], content: "" });
}
