/**
 * AI model adapter layer.
 *
 * Contract: the rest of the application NEVER references a provider or
 * model name directly — purpose-based configuration is resolved from
 * the ModelConfig table (admin-editable) with env fallback. Swapping
 * providers means implementing ModelAdapter and registering it here.
 */
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export class ModelUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Model unavailable: ${reason}`);
    this.name = "ModelUnavailableError";
  }
}

export interface CompletionRequest {
  /** logical purpose, e.g. "research", "trust-safety", "evidence-verification" */
  purpose: string;
  system: string;
  user: string;
  /** when true, the adapter requests strict JSON output */
  json: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface ModelAdapter {
  readonly provider: string;
  /** True when the adapter has credentials to run (checked without a call). */
  isConfigured(): boolean;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface ResolvedModelConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** Resolve purpose → concrete model settings (DB first, env fallback). */
export async function resolveModelConfig(purpose: string): Promise<ResolvedModelConfig> {
  const row = await prisma.modelConfig.findUnique({ where: { purpose } });
  if (row && row.enabled) {
    return { provider: row.provider, model: row.model, temperature: row.temperature, maxTokens: row.maxTokens };
  }
  return {
    provider: env.ai.provider,
    model: env.ai.model,
    temperature: 0.2,
    maxTokens: 2000,
  };
}

/**
 * Z.ai GLM adapter (OpenAI-compatible chat completions endpoint).
 * The API key comes exclusively from env at call time.
 */
export class ZaiGlmAdapter implements ModelAdapter {
  readonly provider: string;

  constructor(provider = "zai") {
    this.provider = provider;
  }

  isConfigured(): boolean {
    return env.ai.apiKey.length > 0;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!env.ai.apiKey) throw new ModelUnavailableError("No API key configured (LIPAHUB_AI_API_KEY empty)");
    const config = await resolveModelConfig(req.purpose);
    if (config.provider !== this.provider) {
      throw new ModelUnavailableError(`Purpose ${req.purpose} is configured for provider ${config.provider}, not ${this.provider}`);
    }
    return completeOpenAiCompatible(
      { provider: this.provider, baseUrl: env.ai.baseUrl, apiKey: env.ai.apiKey, timeoutMs: env.ai.timeoutMs },
      req,
      config,
    );
  }
}

/**
 * DeepSeek adapter (OpenAI-compatible /chat/completions).
 * Default model is `deepseek-flash` (DeepSeek-V4.1-Flash) as exposed by the
 * account's /models endpoint. Key from env only — never logged or exposed.
 */
export class DeepSeekAdapter implements ModelAdapter {
  readonly provider = "deepseek";

  isConfigured(): boolean {
    return env.deepseek.apiKey.length > 0;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!env.deepseek.apiKey) throw new ModelUnavailableError("No API key configured (DEEPSEEK_API_KEY empty)");
    const config = await resolveModelConfig(req.purpose);
    if (config.provider !== this.provider) {
      throw new ModelUnavailableError(`Purpose ${req.purpose} is configured for provider ${config.provider}, not ${this.provider}`);
    }
    return completeOpenAiCompatible(
      { provider: this.provider, baseUrl: env.deepseek.baseUrl, apiKey: env.deepseek.apiKey, timeoutMs: env.deepseek.timeoutMs },
      req,
      config,
    );
  }
}

interface OpenAiCompatibleTarget {
  provider: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

/** Shared OpenAI-compatible completion call used by all HTTP adapters. */
async function completeOpenAiCompatible(
  target: OpenAiCompatibleTarget,
  req: CompletionRequest,
  config: ResolvedModelConfig,
): Promise<CompletionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${target.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: req.temperature ?? config.temperature,
        max_tokens: req.maxTokens ?? config.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ModelUnavailableError(`Provider HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) throw new ModelUnavailableError("Provider returned empty completion");
    return {
      text,
      provider: target.provider,
      model: data.model ?? config.model,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    if (e instanceof ModelUnavailableError) throw e;
    const isAbort = (e as Error).name === "AbortError";
    throw new ModelUnavailableError(isAbort ? "Provider request timed out" : String((e as Error).message ?? e).slice(0, 300));
  } finally {
    clearTimeout(timer);
  }
}

const adapters = new Map<string, ModelAdapter>();

export function registerAdapter(adapter: ModelAdapter): void {
  adapters.set(adapter.provider, adapter);
}

registerAdapter(new ZaiGlmAdapter());
registerAdapter(new DeepSeekAdapter());

/** Test seam — replace or clear adapters without touching call sites. */
export function setAdaptersForTesting(map: Map<string, ModelAdapter>): void {
  adapters.clear();
  for (const [k, v] of map) adapters.set(k, v);
}

export function getAdapter(provider: string): ModelAdapter | undefined {
  return adapters.get(provider);
}

/**
 * True when the adapter that the given purpose resolves to has credentials.
 * Adapter-agnostic: adding a provider does not require touching call sites.
 */
export async function isModelConfigured(purpose = "research"): Promise<boolean> {
  const config = await resolveModelConfig(purpose);
  const adapter = getAdapter(config.provider);
  return Boolean(adapter?.isConfigured());
}

export function logAiEvent(msg: string, meta?: Record<string, unknown>): void {
  logger.info(msg, meta);
}
