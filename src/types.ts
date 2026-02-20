/**
 * A2A Gateway Plugin — Standard types
 *
 * These types support the A2A v0.3.0 protocol integration via @a2a-js/sdk.
 * For gateway-internal (non-standard) types, see ./internal/types-internal.ts.
 */

// ---------------------------------------------------------------------------
// OpenClaw plugin API types
// ---------------------------------------------------------------------------

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface OpenClawDispatchEvent {
  type: string;
  taskId: string;
  contextId?: string;
  message: unknown;
}

export interface OpenClawPluginApi {
  pluginConfig: unknown;
  logger: Logger;
  on(
    hookName: string,
    handler: (event: Record<string, unknown>, ctx?: unknown) => unknown,
    options?: { priority?: number }
  ): void;
  registerGatewayMethod(
    name: string,
    handler: (args: {
      params?: Record<string, unknown>;
      respond: (ok: boolean, data: unknown) => void;
    }) => void
  ): void;
  registerService?(service: {
    id: string;
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
    [key: string]: unknown;
  }): void;
  dispatchToAgent?(
    agentId: string,
    event: OpenClawDispatchEvent
  ): Promise<{ accepted: boolean; response?: string; error?: string }>;
}

// ---------------------------------------------------------------------------
// A2A peer / auth configuration
// ---------------------------------------------------------------------------

export type InboundAuth = "none" | "bearer";
export type PeerAuthType = "bearer" | "apiKey";

export interface PeerAuthConfig {
  type: PeerAuthType;
  token: string;
}

export interface PeerConfig {
  name: string;
  agentCardUrl: string;
  auth?: PeerAuthConfig;
}

// ---------------------------------------------------------------------------
// Agent card configuration (user-provided config, NOT the A2A AgentCard)
// ---------------------------------------------------------------------------

export interface AgentSkillConfig {
  id?: string;
  name: string;
  description?: string;
}

export interface AgentCardConfig {
  name: string;
  description?: string;
  url?: string;
  skills: Array<AgentSkillConfig | string>;
}

// ---------------------------------------------------------------------------
// Gateway configuration
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  agentCard: AgentCardConfig;
  server: {
    host: string;
    port: number;
  };
  peers: PeerConfig[];
  security: {
    inboundAuth: InboundAuth;
    token?: string;
  };
  routing: {
    defaultAgentId: string;
  };
}

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export interface OutboundSendResult {
  ok: boolean;
  statusCode: number;
  response: unknown;
}
