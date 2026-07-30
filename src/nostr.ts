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
    ],
  });
  // btoa is available in Workers; JSON is ASCII-safe here.
  return `Nostr ${btoa(JSON.stringify(ev))}`;
}

export type AuthProbe = {
  ok: boolean;
  challenge: string | null;
  /** Raw relay frames, for diagnosing membership vs signature failures. */
  transcript: string[];
  reason: string | null;
};

/**
 * Open a WebSocket to a Nostr relay, complete the NIP-42 challenge, and report
 * the outcome. Diagnoses the difference between a crypto failure and an
 * authorization failure ("restricted: not a relay member").
 */
export async function probeAuth(
  relayUrl: string,
  sk: Uint8Array,
  authTag?: string[] | null,
  timeoutMs = 8000
): Promise<AuthProbe> {
  const httpUrl = relayUrl.replace(/^ws/, "http");
  const resp = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) {
    return {
      ok: false,
      challenge: null,
      transcript: [`no webSocket on response (status ${resp.status})`],
      reason: "upgrade-failed",
    };
  }
  ws.accept();

  const transcript: string[] = [];
  let challenge: string | null = null;
  let ok = false;
  let reason: string | null = null;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };

    ws.addEventListener("message", (ev: MessageEvent) => {
      const raw = String(ev.data);
      transcript.push(`<< ${raw.slice(0, 300)}`);
      let m: unknown[];
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m[0] === "AUTH" && typeof m[1] === "string") {
        challenge = m[1];
        const tags: string[][] = [
          ["relay", relayUrl],
          ["challenge", challenge],
        ];
        if (authTag && authTag.length) tags.push(authTag);
        const auth = finalizeEvent(sk, { kind: KIND.AUTH, tags });
        transcript.push(`>> AUTH kind:${KIND.AUTH}${authTag ? " (with auth tag)" : ""}`);
        ws.send(JSON.stringify(["AUTH", auth]));
      } else if (m[0] === "OK") {
        ok = m[2] === true;
        reason = typeof m[3] === "string" && m[3] ? m[3] : null;
        finish();
      } else if (m[0] === "CLOSED" || m[0] === "NOTICE") {
        if (!reason && typeof m[m.length - 1] === "string") reason = String(m[m.length - 1]);
      }
    });
    ws.addEventListener("close", finish);
    ws.addEventListener("error", () => {
      transcript.push("ERROR");
      finish();
    });
  });

  try {
    ws.close();
  } catch {
    /* already closed */
  }
  return { ok, challenge, transcript, reason };
}

/** Query stored events over the relay's REST bridge using NIP-98 auth. */
export async function queryEvents(
  relayHttpUrl: string,
  sk: Uint8Array,
  filter: Record<string, unknown>
): Promise<{ ok: boolean; status: number; events: NostrEvent[]; body?: string }> {
  const url = `${relayHttpUrl.replace(/\/$/, "")}/query`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: nip98Header(sk, url, "POST"),
    },
    body: JSON.stringify(filter),
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
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: nip98Header(sk, url, "POST"),
    },
    body: JSON.stringify(event),
  });
  return { ok: resp.ok, status: resp.status, body: (await resp.text()).slice(0, 400) };
}

/** Build a threaded reply to a Buzz chat message (NIP-29 `h` channel tag). */
export function buildReply(
  sk: Uint8Array,
  parent: NostrEvent,
  content: string
): NostrEvent {
  const channel = parent.tags.find((t) => t[0] === "h")?.[1];
  const tags: string[][] = [];
  if (channel) tags.push(["h", channel]);
  tags.push(["e", parent.id, "", "reply"]);
  tags.push(["p", parent.pubkey]);
  return finalizeEvent(sk, { kind: KIND.CHAT, tags, content });
}
