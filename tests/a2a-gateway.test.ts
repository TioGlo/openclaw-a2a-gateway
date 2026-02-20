import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";

import plugin from "../index.js";

interface Service {
  id: string;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  __app?: unknown;
}

interface GatewayMethodResult {
  ok: boolean;
  data: unknown;
}

interface Harness {
  methods: Map<string, (args: { params?: Record<string, unknown>; respond: (ok: boolean, data: unknown) => void }) => void>;
  service: Service;
  dispatchCalls: Array<{ agentId: string; event: unknown }>;
}

function createHarness(config: Record<string, unknown>): Harness {
  let service: Service | null = null;
  const methods = new Map<string, (args: { params?: Record<string, unknown>; respond: (ok: boolean, data: unknown) => void }) => void>();
  const dispatchCalls: Array<{ agentId: string; event: unknown }> = [];

  plugin.register({
    pluginConfig: config,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    on: () => {},
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    },
    registerService(nextService) {
      service = nextService as Service;
    },
    async dispatchToAgent(agentId, event) {
      dispatchCalls.push({ agentId, event });
      return { accepted: true, response: "Request processed" };
    },
  });

  assert(service, "service should be registered");

  return {
    methods,
    service,
    dispatchCalls,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentCard: {
      name: "Test Agent",
      description: "test card",
      url: "http://127.0.0.1:18800/.well-known/agent.json",
      skills: [{ name: "chat" }],
    },
    server: {
      host: "127.0.0.1",
      port: 18800,
    },
    peers: [],
    security: {
      inboundAuth: "none",
    },
    routing: {
      defaultAgentId: "default-agent",
    },
    ...overrides,
  };
}

async function invokeGatewayMethod(
  harness: Harness,
  methodName: string,
  params: Record<string, unknown>
): Promise<GatewayMethodResult> {
  const method = harness.methods.get(methodName);
  assert(method, `missing gateway method ${methodName}`);

  return await new Promise<GatewayMethodResult>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${methodName}`)), 3000);

    method({
      params,
      respond: (ok, data) => {
        clearTimeout(timeout);
        resolve({ ok, data });
      },
    });
  });
}

describe("a2a-gateway plugin", () => {
  it("serves the Agent Card with protocolVersion 0.3.0 and required fields", async () => {
    const harness = createHarness(makeConfig());
    const app = harness.service.__app;
    assert(app, "app should be available for in-memory tests");

    const response = await request(app as any)
      .get("/.well-known/agent.json");

    assert.equal(response.status, 200);
    const payload = response.body as Record<string, unknown>;
    assert.equal(payload.protocolVersion, "0.3.0");
    assert.equal(payload.name, "Test Agent");

    // Verify spec-required fields
    assert.ok(payload.securitySchemes !== undefined, "securitySchemes should be present");
    assert.ok(payload.security !== undefined, "security should be present");

    const capabilities = payload.capabilities as Record<string, unknown>;
    assert.equal(capabilities.streaming, false);
    assert.equal(capabilities.pushNotifications, false);
    assert.equal(capabilities.stateTransitionHistory, false);
  });

  it("accepts JSON-RPC requests and dispatches to OpenClaw agent bridge", async () => {
    const harness = createHarness(makeConfig());
    const app = harness.service.__app;
    assert(app, "app should be available for in-memory tests");

    const response = await request(app as any)
      .post("/a2a/jsonrpc")
      .set("content-type", "application/json")
      .send({
        jsonrpc: "2.0",
        id: "req-1",
        method: "message/send",
        params: {
          message: {
            messageId: "msg-1",
            role: "user",
            agentId: "writer-agent",
            parts: [{ kind: "text", text: "hello" }]
          },
        },
      });

    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.jsonrpc, "2.0");

    const result = body.result as Record<string, unknown>;
    // Executor now returns a proper Task with lifecycle states
    assert.equal(typeof result.id, "string", "Task should have an id");
    assert.equal(result.kind, "task", "Result should be a Task");
    const status = result.status as Record<string, unknown>;
    assert.equal(status.state, "completed", "Task should be in completed state");

    assert.equal(harness.dispatchCalls.length, 1);
    assert.equal(harness.dispatchCalls[0].agentId, "writer-agent");

    const restResponse = await request(app as any)
      .post("/a2a/rest/v1/message:send")
      .set("content-type", "application/json")
      .send({
        message: {
          messageId: "msg-2",
          role: "ROLE_USER",
          agentId: "writer-agent",
          parts: [{ kind: "text", text: "hello" }],
        },
      });
    assert.equal(restResponse.status, 201);
  });

  it("a2a.send sends to mocked peer JSON-RPC endpoint", async () => {
    const received: Array<Record<string, unknown>> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "http://mock-peer/.well-known/agent.json") {
        return new Response(
          JSON.stringify({
            protocolVersion: "0.3.0",
            name: "Peer Agent",
            url: "http://mock-peer/.well-known/agent.json",
            skills: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      if (url === "http://mock-peer/a2a/jsonrpc") {
        const bodyText = String(init?.body || "{}");
        const payload = JSON.parse(bodyText) as Record<string, unknown>;
        received.push(payload);

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              accepted: true,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const harness = createHarness(
        makeConfig({
          peers: [
            {
              name: "peer-1",
              agentCardUrl: "http://mock-peer/.well-known/agent.json",
            },
          ],
        })
      );

      const result = await invokeGatewayMethod(harness, "a2a.send", {
        peer: "peer-1",
        message: {
          agentId: "peer-agent",
          text: "ping",
        },
      });

      assert.equal(result.ok, true);
      assert.equal(received.length, 1);
      assert.equal(received[0].method, "message/send");

      const params = received[0].params as Record<string, unknown>;
      assert.equal(typeof params, "object");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
