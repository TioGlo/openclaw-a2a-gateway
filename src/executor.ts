import { v4 as uuidv4 } from "uuid";

import type { Message, Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { A2AError } from "@a2a-js/sdk/server";

import type { GatewayConfig, OpenClawPluginApi } from "./types.js";

function pickAgentId(requestContext: RequestContext, fallbackAgentId: string): string {
  const msg = requestContext.userMessage as unknown as Record<string, unknown> | undefined;
  const explicit = msg && typeof msg.agentId === "string" ? msg.agentId : "";
  return explicit || fallbackAgentId;
}

/**
 * Bridges A2A inbound messages to OpenClaw agent dispatch.
 *
 * - Dispatches to an OpenClaw agent via `api.dispatchToAgent` (if available)
 * - On success: publishes a complete Task with "completed" state and artifacts
 * - On failure: publishes a Task with "failed" state (does not throw)
 */
export class OpenClawAgentExecutor implements AgentExecutor {
  private readonly api: OpenClawPluginApi;
  private readonly defaultAgentId: string;

  constructor(api: OpenClawPluginApi, config: GatewayConfig) {
    this.api = api;
    this.defaultAgentId = config.routing.defaultAgentId;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const agentId = pickAgentId(requestContext, this.defaultAgentId);
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;

    let responseText = "";

    try {
      if (this.api.dispatchToAgent) {
        const dispatchResult = await this.api.dispatchToAgent(agentId, {
          type: "a2a.inbound",
          taskId,
          contextId,
          message: requestContext.userMessage,
        });

        if (!dispatchResult.accepted) {
          this.publishFailedTask(eventBus, taskId, contextId, dispatchResult.error || "Agent rejected inbound A2A request");
          return;
        }

        responseText = dispatchResult.response || "Request processed";
      } else {
        responseText = "Request accepted (no agent dispatch available)";
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.publishFailedTask(eventBus, taskId, contextId, errorMessage);
      return;
    }

    // Publish completed Task with artifact
    const responseMessage: Message = {
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      parts: [{ kind: "text", text: responseText }],
      contextId,
    };

    const completedTask: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "completed",
        message: responseMessage,
        timestamp: new Date().toISOString(),
      },
      artifacts: [
        {
          artifactId: uuidv4(),
          parts: [{ kind: "text", text: responseText }],
        },
      ],
    };

    eventBus.publish(completedTask);
    eventBus.finished();
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  }

  private publishFailedTask(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    errorMessage: string,
  ): void {
    const failedMessage: Message = {
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      parts: [{ kind: "text", text: errorMessage }],
      contextId,
    };

    const failedTask: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "failed",
        message: failedMessage,
        timestamp: new Date().toISOString(),
      },
    };

    eventBus.publish(failedTask);
    eventBus.finished();
  }
}
