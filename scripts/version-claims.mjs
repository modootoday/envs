/**
 * Versions a page claims about this package.
 *
 * Its own module, and free of side effects, because the publish guard runs its
 * checks at import and exits: a test that wanted this function got the whole
 * release gate instead, and failed the moment the gate correctly refused.
 *
 * Only versions attached to this package are read, so a measured third-party
 * version stays a measurement rather than becoming a false refusal.
 */
export function versionClaims(text) {
  // Deduplicated by value: the scoped name also matches the bare one, and a
  // page reporting the same stale version twice is one thing to fix, not two.
  const claims = new Set();
  const patterns = [
    /@modootoday\/envs@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g,
    /\benvs@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g,
    /\benvs\s+v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gi,
  ];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) claims.add(m[1]);
  }
  return [...claims];
}
