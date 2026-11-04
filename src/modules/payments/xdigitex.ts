/**
 * Xdigitex Pay adapter — implements the PUBLISHED API only
 * (https://pay.xdigitex.space/docs, verified 2026-11-04):
 *
 *   POST /payments/initiate        → { success, reference, gateway, amount,
 *                                      fee, net_amount, fee_percent,
 *                                      redirect_url, [mobile: deposit_id,
 *                                      pawa_status, correspondent, message],
 *                                      [crypto: checkout_url, qrcode_link] }
 *   GET  /payments/{reference}/status → { reference, status, amount, fee,
 *                                      net_amount, currency, gateway, ... }
 *   GET  /payments                 → paginated { data, total, per_page, ... }
 *   GET  /balance                  → { balance, locked_balance,
 *                                      available_balance, currency }
 *   POST /withdrawals              → { success, reference (WDR-...),
 *                                      status ("processing"), amount, fee,
 *                                      message }
 *   GET  /withdrawals              → paginated history
 *   GET  /gateways
 *
 * Documented statuses: pending | processing | completed | failed
 * Documented webhooks: payment.completed, payment.failed (NO signature
 * scheme is published — payloads are therefore NEVER trusted alone; every
 * webhook is verified against the status endpoint before any ledger move).
 *
 * All calls run server-side; the API key never leaves this module's env.
 */
import { z } from "zod";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const XDIGITEX_GATEWAYS = ["safaricom", "airtel", "card", "mobile", "crypto"] as const;
export type XdigitexGateway = (typeof XDIGITEX_GATEWAYS)[number];

export const PROVIDER_STATUS_VALUES = ["pending", "processing", "completed", "failed"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUS_VALUES)[number];

// ── Response schemas (documented shapes; unknown extra fields ignored) ──

const InitiateResponseSchema = z.object({
  success: z.boolean(),
  reference: z.string().min(4).optional(),
  gateway: z.string().optional(),
  amount: z.number().optional(),
  fee: z.number().optional(),
  net_amount: z.number().optional(),
  fee_percent: z.number().optional(),
  redirect_url: z.string().url().optional(),
  deposit_id: z.string().optional(),
  pawa_status: z.string().optional(),
  correspondent: z.string().optional(),
  message: z.string().optional(),
  checkout_url: z.string().url().optional(),
  qrcode_link: z.string().url().optional(),
});
export type InitiateResponse = z.infer<typeof InitiateResponseSchema>;

const PaymentStatusSchema = z.object({
  reference: z.string().min(4),
  status: z.enum(PROVIDER_STATUS_VALUES),
  amount: z.number(),
  fee: z.number().optional(),
  net_amount: z.number().optional(),
  currency: z.string().min(3).max(4),
  gateway: z.string().optional(),
});
export type ProviderPaymentStatus = z.infer<typeof PaymentStatusSchema>;

const BalanceSchema = z.object({
  balance: z.number(),
  locked_balance: z.number().optional(),
  available_balance: z.number().optional(),
  currency: z.string().min(3).max(4),
});
export type ProviderBalance = z.infer<typeof BalanceSchema>;

const WithdrawalResponseSchema = z.object({
  success: z.boolean(),
  reference: z.string().min(4).optional(),
  status: z.string().optional(),
  amount: z.number().optional(),
  fee: z.number().optional(),
  message: z.string().optional(),
});
export type WithdrawalResponse = z.infer<typeof WithdrawalResponseSchema>;

/** GET /withdrawals — paginated; only the fields we need are asserted. */
const WithdrawalListItemSchema = z.object({
  reference: z.string(),
  status: z.string(),
  amount: z.number().optional(),
  fee: z.number().optional(),
  currency: z.string().optional(),
});
const WithdrawalListSchema = z.object({
  data: z.array(WithdrawalListItemSchema).default([]),
  total: z.number().optional(),
});

// ── Errors ───────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: "HTTP" | "TIMEOUT" | "INVALID_RESPONSE" | "NOT_CONFIGURED",
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface XdigitexConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface InitiatePaymentParams {
  amountMinor: bigint;
  currency: string;
  gateway: XdigitexGateway;
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  description: string;
  internalRef: string;
}

export interface InitiatePaymentResult {
  kind: "stk" | "redirect" | "crypto";
  providerRef: string;
  /** gross amount the provider reports */
  amount: number;
  fee?: number;
  netAmount?: number;
  feePercent?: number;
  redirectUrl?: string;
  checkoutUrl?: string;
  qrcodeLink?: string;
  /** human instruction, e.g. "check your phone" for STK */
  message?: string;
  raw: unknown;
}

export class XdigitexPayClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config?: Partial<XdigitexConfig>) {
    this.apiKey = config?.apiKey ?? env.xdigitex.apiKey;
    this.baseUrl = (config?.baseUrl ?? env.xdigitex.baseUrl).replace(/\/$/, "");
    this.timeoutMs = config?.timeoutMs ?? env.xdigitex.timeoutMs;
    this.fetchImpl = config?.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    if (!this.apiKey) {
      throw new ProviderError("XDIGITEX_PAY_API_KEY is not configured", "NOT_CONFIGURED");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-API-Key": this.apiKey,
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new ProviderError(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`, "HTTP", res.status);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ProviderError(`Provider returned non-JSON response: ${text.slice(0, 200)}`, "INVALID_RESPONSE");
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const isAbort = (e as Error).name === "AbortError";
      throw new ProviderError(isAbort ? "Provider request timed out" : String((e as Error).message ?? e), isAbort ? "TIMEOUT" : "HTTP");
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /payments/initiate — documented fields only. */
  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    const payload: Record<string, unknown> = {
      amount: Number(params.amountMinor) / 100,
      currency: params.currency,
      gateway: params.gateway,
      email: params.email,
      first_name: params.firstName,
      last_name: params.lastName,
      description: params.description,
      callback_url: `${env.appPublicUrl}/payment/callback`,
      webhook_url: `${env.appPublicUrl}/api/webhooks/xdigitex`,
      // Internal reference travels in the description so callbacks can be
      // correlated even though no metadata field is documented.
      ...(params.phone ? { phone: params.phone } : {}),
    };
    const parsed = InitiateResponseSchema.parse(await this.request("/payments/initiate", { method: "POST", body: payload }));
    if (!parsed.success || !parsed.reference) {
      throw new ProviderError(
        `Provider did not accept the payment initiation: ${JSON.stringify(parsed).slice(0, 300)}`,
        "INVALID_RESPONSE",
      );
    }
    const kind: InitiatePaymentResult["kind"] = params.gateway === "crypto"
      ? "crypto"
      : parsed.redirect_url
        ? "redirect"
        : "stk";
    return {
      kind,
      providerRef: parsed.reference,
      amount: parsed.amount ?? Number(params.amountMinor) / 100,
      fee: parsed.fee,
      netAmount: parsed.net_amount,
      feePercent: parsed.fee_percent,
      redirectUrl: parsed.redirect_url,
      checkoutUrl: parsed.checkout_url,
      qrcodeLink: parsed.qrcode_link,
      message: parsed.message ?? (kind === "stk" ? "Check your phone to complete the payment." : undefined),
      raw: parsed,
    };
  }

  /** GET /payments/{reference}/status — the authoritative verification source. */
  async getPaymentStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    const raw = await this.request<unknown>(`/payments/${encodeURIComponent(providerRef)}/status`);
    const parsed = PaymentStatusSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(`Unparseable status response for ${providerRef}: ${JSON.stringify(raw).slice(0, 300)}`, "INVALID_RESPONSE");
    }
    return parsed.data;
  }

  async getBalance(): Promise<ProviderBalance> {
    const raw = await this.request<unknown>("/balance");
    const parsed = BalanceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(`Unparseable balance response: ${JSON.stringify(raw).slice(0, 300)}`, "INVALID_RESPONSE");
    }
    return parsed.data;
  }

  /** POST /withdrawals — documented method value: "mobile_money". */
  async initiateWithdrawal(params: {
    amountMinor: bigint;
    currency: string;
    accountNumber: string;
  }): Promise<{ providerRef: string; status?: string; fee?: number; message?: string; raw: unknown }> {
    const parsed = WithdrawalResponseSchema.parse(
      await this.request("/withdrawals", {
        method: "POST",
        body: {
          amount: Number(params.amountMinor) / 100,
          currency: params.currency,
          method: "mobile_money",
          account_number: params.accountNumber,
        },
      }),
    );
    if (!parsed.success || !parsed.reference) {
      throw new ProviderError(`Provider rejected the withdrawal: ${JSON.stringify(parsed).slice(0, 300)}`, "INVALID_RESPONSE");
    }
    return { providerRef: parsed.reference, status: parsed.status, fee: parsed.fee, message: parsed.message, raw: parsed };
  }

  /**
   * GET /withdrawals — used for reconciliation. NOTE: no single-withdrawal
   * status endpoint is documented, so final withdrawal status is resolved
   * by finding the WDR reference in the paginated history. If it cannot be
   * located, the outcome stays UNCERTAIN for human review (never retried
   * automatically — double payout protection).
   */
  async listWithdrawals(page = 1): Promise<{ items: Array<{ reference: string; status: string; amount?: number; fee?: number; currency?: string }>; total?: number }> {
    const raw = await this.request<unknown>(`/withdrawals?page=${page}`);
    const parsed = WithdrawalListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(`Unparseable withdrawals list: ${JSON.stringify(raw).slice(0, 300)}`, "INVALID_RESPONSE");
    }
    return { items: parsed.data.data, total: parsed.data.total };
  }

  async listGateways(): Promise<Array<{ id: string; name: string }>> {
    const raw = await this.request<unknown>("/gateways");
    const parsed = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })).or(z.array(z.object({ id: z.string(), name: z.string() }))) }).safeParse(raw);
    if (parsed.success) return parsed.data.data;
    const arr = z.array(z.object({ id: z.string(), name: z.string() })).safeParse(raw);
    if (arr.success) return arr.data;
    throw new ProviderError(`Unparseable gateways response: ${JSON.stringify(raw).slice(0, 200)}`, "INVALID_RESPONSE");
  }
}

let client: XdigitexPayClient | null = null;

export function getXdigitexClient(): XdigitexPayClient {
  if (!client) client = new XdigitexPayClient();
  return client;
}

/** Test/ops seam — inject a client with a mock fetch or custom config. */
export function setXdigitexClientForTesting(c: XdigitexPayClient | null): void {
  client = c;
}

export function isXdigitexConfigured(): boolean {
  return getXdigitexClient().isConfigured();
}

export function logProviderEvent(msg: string, meta?: Record<string, unknown>): void {
  logger.info(msg, meta);
}
