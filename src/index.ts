import { routeAgentRequest } from "agents";
import type { Env } from "./bridge";

export { BuzzBridge } from "./bridge";
export { ThinkAgent } from "./session";

const bridgePaths = ["/", "/status", "/setup", "/poll", "/reset-seen"];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (bridgePaths.includes(url.pathname)) {
      const stub = env.BuzzBridge.get(env.BuzzBridge.idFromName("think"));
      const target = new URL(request.url);
      target.pathname = `/BuzzBridge/think${url.pathname === "/" ? "" : url.pathname}`;
      return stub.fetch(new Request(target.toString(), request));
    }

    const agentResponse = await routeAgentRequest(request, env as unknown as Record<string, unknown>);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
