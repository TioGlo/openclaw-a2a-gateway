/**
 * A2A Gateway plugin endpoints:
 * - /.well-known/agent.json
 * - /a2a/jsonrpc
 * - /a2a/rest
 */

import type { Server } from "node:http";

import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { UserBuilder, agentCardHandler, jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";
import express from "express";

import { buildAgentCard } from "./src/agent-card.js";
import { A2AClient } from "./src/client.js";
import { OpenClawAgentExecutor } from "./src/executor.js";
import type {
  AgentCardConfig,
  GatewayConfig,
  InboundAuth,
  OpenClawPluginApi,
  PeerConfig,
} from "./src/types.js";

/** Build a JSON-RPC error response. */
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return fallback;
}

function parseAgentCard(raw: Record<string, unknown>): AgentCardConfig {
  const skills = Array.isArray(raw.skills) ? raw.skills : [];

  return {
    name: asString(raw.name, "OpenClaw A2A Gateway"),
    description: asString(raw.description, "A2A bridge for OpenClaw agents"),
    url: asString(raw.url, ""),
    skills: skills.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const skill = asObject(entry);
      return {
        id: asString(skill.id, ""),
        name: asString(skill.name, "unknown"),
        description: asString(skill.description, ""),
      };
    }),
  };
}

function parsePeers(raw: unknown): PeerConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const peers: PeerConfig[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const name = asString(value.name, "");
    const agentCardUrl = asString(value.agentCardUrl, "");
    if (!name || !agentCardUrl) {
      continue;
    }

    const authRaw = asObject(value.auth);
    const authType = asString(authRaw.type, "") as "bearer" | "apiKey";
    const token = asString(authRaw.token, "");

    peers.push({
      name,
      agentCardUrl,
      auth: authType && token ? { type: authType, token } : undefined,
    });
  }

  return peers;
}

function parseConfig(raw: unknown): GatewayConfig {
  const config = asObject(raw);
  const server = asObject(config.server);
  const security = asObject(config.security);
  const routing = asObject(config.routing);

  const inboundAuth = asString(security.inboundAuth, "none") as InboundAuth;

  return {
    agentCard: parseAgentCard(asObject(config.agentCard)),
    server: {
      host: asString(server.host, "0.0.0.0"),
      port: asNumber(server.port, 18800),
    },
    peers: parsePeers(config.peers),
    security: {
      inboundAuth: inboundAuth === "bearer" ? "bearer" : "none",
      token: asString(security.token, ""),
    },
    routing: {
      defaultAgentId: asString(routing.defaultAgentId, "default"),
    },
  };
}

function normalizeCardPath(): string {
  if (AGENT_CARD_PATH.startsWith("/")) {
    return AGENT_CARD_PATH;
  }

  return `/${AGENT_CARD_PATH}`;
}

const plugin = {
  id: "a2a-gateway",
  name: "A2A Gateway",
  description: "OpenClaw plugin that serves A2A v0.3.0 endpoints",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    const client = new A2AClient();
    const taskStore = new InMemoryTaskStore();
    const executor = new OpenClawAgentExecutor(api, config);
    const agentCard = buildAgentCard(config);

    // SDK expects userBuilder(req) -> Promise<User>
    // v0.3.0 SDK ships only UnauthenticatedUser helper in UserBuilder.
    const userBuilder = async (_req: unknown) => UserBuilder.noAuthentication();

    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);


    const app = express();

    const cardPath = normalizeCardPath();
    const cardEndpointHandler = agentCardHandler({ agentCardProvider: requestHandler });

    app.use(cardPath, cardEndpointHandler);
    if (cardPath != "/.well-known/agent.json") {
      app.use("/.well-known/agent.json", cardEndpointHandler);
    }

    app.use(
      "/a2a/jsonrpc",
      jsonRpcHandler({
        requestHandler,
        userBuilder,
      })
    );

    // Ensure errors return JSON-RPC style responses (avoid Express HTML error pages)
    app.use("/a2a/jsonrpc", (err: unknown, _req: unknown, res: any, next: (e?: unknown) => void) => {
      if (err instanceof SyntaxError) {
        res.status(400).json(jsonRpcError(null, -32700, "Parse error"));
        return;
      }

      // Surface A2A-specific errors with proper codes
      const a2aErr = err as { code?: number; message?: string; taskId?: string } | undefined;
      if (a2aErr && typeof a2aErr.code === "number") {
        const status = a2aErr.code === -32601 ? 404 : 400;
        res.status(status).json(jsonRpcError(null, a2aErr.code, a2aErr.message || "Unknown error"));
        return;
      }

      // Generic internal error
      res.status(500).json(jsonRpcError(null, -32603, "Internal error"));
    });

    app.use(
      "/a2a/rest",
      restHandler({
        requestHandler,
        userBuilder,
      })
    );

    let server: Server | null = null;

    api.registerGatewayMethod("a2a.send", ({ params, respond }) => {
      const payload = asObject(params);
      const peerName = asString(payload.peer || payload.name, "");
      const message = asObject(payload.message || payload.payload);

      const peer = config.peers.find((candidate) => candidate.name === peerName);
      if (!peer) {
        respond(false, { error: `Peer not found: ${peerName}` });
        return;
      }

      client
        .sendMessage(peer, message)
        .then((result) => {
          if (result.ok) {
            respond(true, {
              statusCode: result.statusCode,
              response: result.response,
            });
            return;
          }

          respond(false, {
            statusCode: result.statusCode,
            response: result.response,
          });
        })
        .catch((error) => {
          respond(false, { error: String(error?.message || error) });
        });
    });

    if (!api.registerService) {
      api.logger.warn("a2a-gateway: registerService is unavailable; HTTP endpoints are not started");
      return;
    }

    api.registerService({
      id: "a2a-gateway",
      __app: app,
      async start() {
        if (server) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          server = app.listen(config.server.port, config.server.host, () => {
            api.logger.info(
              `a2a-gateway: listening on ${config.server.host}:${config.server.port}`
            );
            resolve();
          });

          server!.once("error", reject);
        });
      },
      async stop() {
        if (!server) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const activeServer = server!;
          server = null;
          activeServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });
  },
};

export default plugin;
