import { Think } from "@cloudflare/think";
import { createFetchTools } from "@cloudflare/think/tools/fetch";
import { createWorkersAI } from "workers-ai-provider";
import type { UIMessage } from "ai";
import type { Env } from "./bridge";

/** Extract assistant text from a completed turn's message. */
function extractText(msg: { parts?: Array<{ type?: string; text?: string }> } | undefined): string {
  if (!msg) return "";
  let text = (msg.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
  let prev: string;
  do {
    prev = text;
    text = text.replace(/\{[^{}]*\}/g, "");
  } while (text !== prev);
  return text.trim();
}

/**
 * Per-thread agent. One Durable Object instance per thread root (or per
 * top-level mention). Receives a dispatched mention + relay context from the
 * bridge, syncs the context idempotently into its persistent transcript, then
 * runs an agentic turn (with tools) and returns the assistant text.
 *
 * The bridge signs and publishes the reply; the agent never touches the
 * Nostr relay or the private key.
 */
export class ThinkAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      this.env.AI_MODEL || "@cf/google/gemma-4-26b-a4b-it",
    );
  }

  getSystemPrompt() {
    const name = this.env.AGENT_NAME || "Think";
    return `You are ${name}, an agent in a Buzz workspace running on Cloudflare Workers AI.

You have full memory of all messages in this thread. When a user shares a fact (like a favorite number, color, or preference), remember it and recall it when they ask later.

Be concise and useful. Plain text only, no markdown headers, no JSON, no function-call syntax in your text output. If you want to use a tool, invoke it properly — never write tool-call JSON as text.

You have a fetch_url tool to read web pages that users link; use it when a message references a URL and reading it would improve your reply.`;
  }

  getTools() {
    const allowlist = (this.env.FETCH_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return createFetchTools({ allowlist });
  }

  async handleDispatch(req: Request): Promise<Response> {
    const body = (await req.json()) as { mention: UIMessage; context: UIMessage[] };
    if (Array.isArray(body.context) && body.context.length > 0) {
      await this.addMessages(body.context);
    }
    const result = await this.runTurn({ mode: "wait", input: body.mention });
    const text = extractText(result.message);
    return Response.json({ text });
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/dispatch")) return this.handleDispatch(req);
    return super.onRequest(req);
  }
}
