/**
 * AI orchestrator — runs a bounded agent invocation with:
 *  - persistent AgentRun tracking (status, tokens, latency, error)
 *  - structured output validation via zod schema
 *  - bounded retries on invalid output
 *  - timeout enforcement
 *  - audit events
 *
 * Guarantees:
 *  - Output is validated before callers see it.
 *  - No agent can touch the ledger or payments (no such capability is
 *    passed to or reachable from this module).
 *  - Unavailable/failed runs are explicit — never fabricated.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getAdapter, resolveModelConfig, ModelUnavailableError, type CompletionRequest } from "./adapter";
import type { ZodType } from "zod";

export interface AgentSpec<T> {
  /** agent identifier, e.g. "research", "trust-safety" */
  agent: string;
  purpose: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  entityType?: string;
  entityId?: string;
  maxRetries?: number;
  maxTokens?: number;
  temperature?: number;
}

export type AgentOutcome<T> =
  | { ok: true; output: T; runId: string; model: string; provider: string; tokensIn: number; tokensOut: number; latencyMs: number; replayed?: boolean }
  | { ok: false; runId: string; reason: "UNAVAILABLE" | "FAILED" | "INVALID_OUTPUT"; error?: string };

/** Extract a JSON object from a completion even with markdown fences. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found in completion");
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function runAgent<T>(spec: AgentSpec<T>): Promise<AgentOutcome<T>> {
  const run = await prisma.agentRun.create({
    data: {
      agent: spec.agent,
      entityType: spec.entityType,
      entityId: spec.entityId,
      status: "RUNNING",
      input: { user: spec.user.slice(0, 8000) } as never,
      startedAt: new Date(),
    },
  });

  const finish = async (patch: {
    status: "SUCCEEDED" | "FAILED" | "TIMEOUT" | "UNAVAILABLE";
    output?: unknown;
    error?: string;
    provider?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    latencyMs?: number;
  }) => {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: patch.status,
        output: (patch.output ?? undefined) as never,
        error: patch.error,
        provider: patch.provider,
        model: patch.model,
        tokensIn: patch.tokensIn,
        tokensOut: patch.tokensOut,
        latencyMs: patch.latencyMs,
        finishedAt: new Date(),
      },
    });
    await prisma.agentEvent
      .create({
        data: { runId: run.id, type: `agent.${patch.status.toLowerCase()}`, payload: { error: patch.error } as never },
      })
      .catch(() => {});
  };

  const maxRetries = spec.maxRetries ?? 1;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const request: CompletionRequest = {
      purpose: spec.purpose,
      system: spec.system,
      user: attempt === 0 ? spec.user : `${spec.user}\n\nIMPORTANT: Your previous reply was not valid JSON matching the schema. Reply with ONLY the JSON object.`,
      json: true,
      maxTokens: spec.maxTokens,
      temperature: attempt === 0 ? spec.temperature : 0,
    };

    let result;
    try {
      const config = await resolveModelConfig(spec.purpose);
      const adapter = getAdapter(config.provider);
      if (!adapter) throw new ModelUnavailableError(`No adapter registered for provider ${config.provider}`);
      result = await adapter.complete(request);
    } catch (e) {
      if (e instanceof ModelUnavailableError) {
        await finish({ status: "UNAVAILABLE", error: e.reason });
        return { ok: false, runId: run.id, reason: "UNAVAILABLE", error: e.reason };
      }
      lastError = String((e as Error).message ?? e).slice(0, 500);
      await prisma.agentEvent.create({ data: { runId: run.id, type: "agent.retry", payload: { attempt, error: lastError } as never } }).catch(() => {});
      continue;
    }

    try {
      const parsed = spec.schema.parse(extractJson(result.text));
      await finish({
        status: "SUCCEEDED",
        output: parsed as never,
        provider: result.provider,
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
      });
      return {
        ok: true,
        output: parsed,
        runId: run.id,
        model: result.model,
        provider: result.provider,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
      };
    } catch (e) {
      lastError = `Invalid structured output: ${String((e as Error).message ?? e).slice(0, 400)}`;
      logger.warn("agent_invalid_output", { agent: spec.agent, attempt, error: lastError });
    }
  }

  await finish({ status: "FAILED", error: lastError });
  return { ok: false, runId: run.id, reason: "INVALID_OUTPUT", error: lastError };
}
