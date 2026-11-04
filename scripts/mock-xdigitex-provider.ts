/**
 * Local mock Xdigitex Pay provider for browser E2E testing.
 *
 * Emulates ONLY the documented endpoints (POST /payments/initiate,
 * GET /payments/{reference}/status, POST /withdrawals, GET /withdrawals,
 * GET /balance) and behaves like the real provider: when a mobile-money
 * payment "completes", it POSTs a payment.completed webhook to the LipaHub
 * app with the shared secret header. Withdrawals start "processing" and are
 * completed via a test control endpoint, exercising the reconciliation path.
 *
 * This is a TEST double for local E2E only — never run in production.
 * Run: npx tsx scripts/mock-xdigitex-provider.ts
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.MOCK_PROVIDER_PORT ?? 4599);
const APP_WEBHOOK_URL = process.env.APP_PUBLIC_URL
  ? `${process.env.APP_PUBLIC_URL}/api/webhooks/xdigitex`
  : "http://localhost:4310/api/webhooks/xdigitex";
const WEBHOOK_SECRET = process.env.XDIGITEX_PAY_WEBHOOK_SECRET ?? "e2e-secret";

interface MockPayment {
  reference: string;
  status: "pending" | "processing" | "completed" | "failed";
  amount: number;
  fee: number;
  net_amount: number;
  currency: string;
  gateway: string;
}
interface MockWithdrawal {
  reference: string;
  status: "processing" | "completed" | "failed";
  amount: number;
  fee: number;
  currency: string;
}

const payments = new Map<string, MockPayment>();
const withdrawals = new Map<string, MockWithdrawal>();
const balance = { balance: 0, locked_balance: 0, available_balance: 0, currency: "KES" };

function ref(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function fireWebhook(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(APP_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": WEBHOOK_SECRET },
      body: JSON.stringify({ event, ...payload }),
    });
    console.log(`[mock] webhook ${event} for ${String(payload.reference)} → ${res.status}`);
  } catch (e) {
    console.error(`[mock] webhook delivery failed: ${String(e)}`);
  }
}

function completePayment(p: MockPayment): void {
  p.status = "completed";
  // Provider wallet receives the net amount (fee retained by provider).
  balance.balance = Math.round((balance.balance + p.net_amount) * 100) / 100;
  balance.available_balance = balance.balance;
  setImmediate(() => fireWebhook("payment.completed", {
    reference: p.reference, status: "completed", amount: p.amount,
    fee: p.fee, net_amount: p.net_amount, currency: p.currency,
  }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const bodyText = await readBody(req);
  const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return json(res, { error: "missing X-API-Key" }, 401);
  }

  if (path === "/api/payments/initiate") {
    const reference = ref("TX");
    const amount = Number(body.amount);
    const fee = Math.round(amount * 12) / 100; // 12% like the docs example
    const gateway = String(body.gateway);
    const p: MockPayment = {
      reference, status: "pending", amount, fee,
      net_amount: Math.round((amount - fee) * 100) / 100,
      currency: String(body.currency), gateway,
    };
    payments.set(reference, p);
    // Simulate the customer completing the STK prompt shortly after initiation.
    if (gateway === "safaricom" || gateway === "airtel" || gateway === "mobile") {
      setTimeout(() => completePayment(p), 3000);
    }
    const base = { success: true, reference, gateway, amount, fee, net_amount: p.net_amount, fee_percent: 12 };
    if (gateway === "card") return json(res, { ...base, redirect_url: `http://localhost:${PORT}/simulated-checkout/${reference}` });
    if (gateway === "crypto") return json(res, { ...base, checkout_url: `http://localhost:${PORT}/simulated-checkout/${reference}`, qrcode_link: "about:blank" });
    return json(res, { ...base, deposit_id: ref("DP"), pawa_status: "ACCEPTED", correspondent: gateway === "safaricom" ? "MPESA_KEN" : "AIRTEL_KEN", message: "Check your phone to complete the payment." });
  }

  const statusMatch = path.match(/^\/api\/payments\/([^/]+)\/status$/);
  if (statusMatch) {
    const p = payments.get(decodeURIComponent(statusMatch[1]));
    if (!p) return json(res, { error: "not found" }, 404);
    return json(res, { reference: p.reference, status: p.status, amount: p.amount, fee: p.fee, net_amount: p.net_amount, currency: p.currency, gateway: p.gateway, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }

  if (path === "/api/withdrawals") {
    if (req.method === "POST") {
      const reference = ref("WDR");
      const amount = Number(body.amount);
      const fee = Math.round(amount * 3) / 100; // 3% documented withdrawal fee
      const w: MockWithdrawal = { reference, status: "processing", amount, fee, currency: String(body.currency) };
      withdrawals.set(reference, w);
      console.log(`[mock] withdrawal ${reference} accepted (processing)`);
      return json(res, { success: true, reference, status: "processing", amount, fee, message: "Withdrawal is processing" });
    }
    return json(res, { data: Array.from(withdrawals.values()), total: withdrawals.size, per_page: 20, current_page: 1 });
  }

  if (path === "/api/balance") {
    return json(res, balance);
  }

  if (path === "/api/gateways") {
    return json(res, { data: [
      { id: "safaricom", name: "M-Pesa Kenya" }, { id: "airtel", name: "Airtel Money Kenya" },
      { id: "card", name: "Card" }, { id: "mobile", name: "Mobile Money" }, { id: "crypto", name: "Crypto" },
    ] });
  }

  // Test-only controls (never exist on the real provider)
  if (path.startsWith("/__test/complete-withdrawal/")) {
    const reference = path.split("/").pop()!;
    const w = withdrawals.get(reference);
    if (!w) return json(res, { error: "not found" }, 404);
    w.status = "completed";
    // The provider pays out net; fee retained. Wallet decreases by gross.
    balance.balance = Math.round((balance.balance - w.amount) * 100) / 100;
    balance.available_balance = balance.balance;
    return json(res, { ok: true });
  }
  if (path.startsWith("/__test/complete-payment/")) {
    const reference = path.split("/").pop()!;
    const p = payments.get(reference);
    if (!p) return json(res, { error: "not found" }, 404);
    completePayment(p);
    return json(res, { ok: true });
  }

  json(res, { error: "not found" }, 404);
});

server.listen(PORT, () => {
  console.log(`[mock] Xdigitex Pay mock provider on http://localhost:${PORT}/api`);
  console.log(`[mock] webhooks → ${APP_WEBHOOK_URL} (secret: ${WEBHOOK_SECRET ? "set" : "none"})`);
});
