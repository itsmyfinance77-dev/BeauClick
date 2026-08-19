/**
 * ADR-015 / V3_SECURITY_MODEL.md §4: the shared harness for the adversarial-
 * ownership test shape, now mandatory for every tenant-scoped endpoint, not
 * confined to the two V2 domains that happened to have it. Usage: seed a
 * second party with a distinguishable real value, call the endpoint as the
 * first party, assert the second party's value never appears anywhere in
 * the response (not merely "the request failed").
 */
export function assertNoLeak(responseBody: unknown, forbiddenValue: string): void {
  const serialized = JSON.stringify(responseBody);
  if (serialized.includes(forbiddenValue)) {
    throw new Error(
      `Adversarial ownership check FAILED: forbidden value "${forbiddenValue}" leaked into response: ${serialized}`,
    );
  }
}
