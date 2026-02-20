import type { AgentCard, AgentSkill } from "@a2a-js/sdk";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";

import type { GatewayConfig } from "./types.js";

function normalizePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }

  return `/${path}`;
}

function toSkill(entry: string | { id?: string; name: string; description?: string }, index: number): AgentSkill {
  if (typeof entry === "string") {
    return {
      id: `skill-${index + 1}`,
      name: entry,
      description: entry,
      tags: [],
    };
  }

  return {
    id: entry.id || `skill-${index + 1}`,
    name: entry.name,
    description: entry.description || entry.name,
    tags: [],
  };
}

export function buildAgentCard(config: GatewayConfig): AgentCard {
  const configuredUrl = config.agentCard.url;
  const cardPath = normalizePath(AGENT_CARD_PATH);
  const fallbackUrl = `http://${config.server.host}:${config.server.port}${cardPath}`;

  const securitySchemes: AgentCard["securitySchemes"] = {};
  const security: AgentCard["security"] = [];

  if (config.security.inboundAuth === "bearer") {
    securitySchemes["bearer"] = {
      type: "http",
      scheme: "bearer",
    };
    security.push({ bearer: [] });
  }

  return {
    protocolVersion: "0.3.0",
    version: "1.0.0",
    name: config.agentCard.name,
    description: config.agentCard.description || "A2A bridge for OpenClaw agents",
    url: configuredUrl || fallbackUrl,
    skills: config.agentCard.skills.map((entry, index) => toSkill(entry, index)),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    securitySchemes,
    security,
    supportsAuthenticatedExtendedCard: false,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };
}
