/**
 * What a caller can see: the verbs and the flags. A version is chosen by what
 * changes for a consumer, and this is the part of that which a machine can
 * hold -- so the snapshot beside it decides patch against minor instead of
 * whoever is doing the release that day.
 *
 * Deliberately not the findings a command can print. Advice arriving in a
 * report is not a surface change, and treating it as one is the mistake this
 * exists to stop.
 */
export function surfaceOf(commands) {
  return commands
    .map((command) => ({
      name: command.name,
      options: (command.options ?? []).map((option) => option.name).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function surfaceDiff(before, after) {
  const names = (list) => new Set(list.map((c) => c.name));
  const gone = [...names(before)].filter((n) => !names(after).has(n));
  const added = [...names(after)].filter((n) => !names(before).has(n));
  const changed = [];
  for (const now of after) {
    const then = before.find((c) => c.name === now.name);
    if (!then) continue;
    const lost = then.options.filter((o) => !now.options.includes(o));
    const got = now.options.filter((o) => !then.options.includes(o));
    if (lost.length || got.length) {
      changed.push(
        `${now.name}: ${[...lost.map((o) => `-${o}`), ...got.map((o) => `+${o}`)].join(" ")}`,
      );
    }
  }
  return { gone, added, changed };
}

export const surfaceMoved = (diff) =>
  diff.gone.length > 0 || diff.added.length > 0 || diff.changed.length > 0;
