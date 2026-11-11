/**
 * Test isolation guard — tests must NEVER reach a real AI provider.
 * The adapter registry is cleared before every test file; individual
 * tests opt into stubs explicitly via setAdaptersForTesting().
 */
import { beforeAll } from "vitest";
import { setAdaptersForTesting } from "@/modules/ai/adapter";

beforeAll(() => {
  setAdaptersForTesting(new Map());
});
