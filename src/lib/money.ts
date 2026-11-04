/**
 * Money helpers — all amounts are integer minor units (cents).
 * Floats are never used for money arithmetic.
 */

export const MINOR_UNITS_PER_UNIT = 100;

export function toMinor(amountUnits: number): bigint {
  if (!Number.isFinite(amountUnits)) throw new Error("Invalid money amount");
  const minor = Math.round(amountUnits * MINOR_UNITS_PER_UNIT);
  if (minor <= 0) throw new Error("Money amount must be positive");
  return BigInt(minor);
}

export function fromMinor(minor: bigint): number {
  return Number(minor) / MINOR_UNITS_PER_UNIT;
}

export function formatMoney(minor: bigint | number | null | undefined, currency = "KES"): string {
  if (minor === null || minor === undefined) return `0.00 ${currency}`;
  const units = Number(minor) / MINOR_UNITS_PER_UNIT;
  return `${units.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/** Commission in minor units: amount * bps / 10000, rounded down (platform-favourable, deterministic). */
export function commissionMinor(amountMinor: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10_000) throw new Error("Commission bps out of range");
  return (amountMinor * BigInt(bps)) / 10_000n;
}

export function addMinor(...parts: Array<bigint | number>): bigint {
  return parts.reduce<bigint>((acc, p) => acc + BigInt(p), 0n);
}
