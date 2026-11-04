/**
 * Payment provider adapter — M-Pesa (sandbox first).
 *
 * Isolation contract:
 *  - The rest of the system depends only on PaymentProviderAdapter.
 *  - This adapter NEVER moves ledger money itself; it reports outcomes
 *    and the finance service journals them.
 *  - Live credentials must never enter code or the repo.
 */

export interface ProviderInitiateResult {
  ok: boolean;
  externalRef?: string;
  error?: string;
}

export interface PaymentProviderAdapter {
  readonly id: string;
  readonly sandbox: boolean;
  initiateCollection(params: {
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
    /** payer identifier, e.g. phone number */
    payer: string;
  }): Promise<ProviderInitiateResult>;
  initiatePayout(params: {
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
    /** payee identifier */
    payee: string;
  }): Promise<ProviderInitiateResult>;
}

/**
 * Sandbox adapter — simulates a provider without network calls.
 * Deterministic: succeeds unless explicitly told to fail through the
 * reference prefix `FAIL-` (used by tests).
 */
export class MpesaSandboxAdapter implements PaymentProviderAdapter {
  readonly id = "MPESA_SANDBOX";
  readonly sandbox = true;

  async initiateCollection(params: {
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
    payer: string;
  }): Promise<ProviderInitiateResult> {
    if (params.amountMinor <= 0n) return { ok: false, error: "Amount must be positive" };
    if (params.reference.startsWith("FAIL-")) return { ok: false, error: "Sandbox forced failure" };
    return { ok: true, externalRef: `SBX-C-${sha1(params.idempotencyKey)}` };
  }

  async initiatePayout(params: {
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
    payee: string;
  }): Promise<ProviderInitiateResult> {
    if (params.amountMinor <= 0n) return { ok: false, error: "Amount must be positive" };
    if (params.reference.startsWith("FAIL-")) return { ok: false, error: "Sandbox forced failure" };
    return { ok: true, externalRef: `SBX-P-${sha1(params.idempotencyKey)}` };
  }
}

function sha1(input: string): string {
  // Deterministic pseudo-ref for the sandbox; not used for security.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + input.length.toString(16);
}

let active: PaymentProviderAdapter = new MpesaSandboxAdapter();

export function getPaymentAdapter(): PaymentProviderAdapter {
  return active;
}

/** Test/ops seam — swapping providers never touches finance logic. */
export function setPaymentAdapter(adapter: PaymentProviderAdapter): void {
  active = adapter;
}
