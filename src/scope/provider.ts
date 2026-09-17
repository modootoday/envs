/**
 * Who can say which sources a project wants.
 *
 * This package holds values and knows nothing about declaration files; the
 * package that reads them depends on this one, so the dependency cannot run the
 * other way. The contract lives here and an implementation arrives at runtime,
 * the way a sqlite binding does (see ../sqlite/provider.ts).
 */

export interface ScopeResolution {
  /** Source aliases, in precedence order, as `envs run --alias` takes them. */
  readonly aliases: readonly string[];
  /** The file this came from, so a caller can say where the scope was decided. */
  readonly from: string;
}

/** Undefined means "no declaration here", which is a refusal, not an empty scope. */
export type ScopeResolver = (
  cwd: string,
) => Promise<ScopeResolution | undefined> | ScopeResolution | undefined;

export interface ScopeProvider {
  readonly name: string;
  /** Held as a string: a literal specifier would make bundlers hard-fail. */
  readonly specifier: string;
  readonly exportName: string;
}

/**
 * One entry today. A second declaration format adds one here and implements the
 * same contract; nothing in this package learns its shape.
 */
export const SCOPE_PROVIDERS: readonly ScopeProvider[] = [
  {
    name: "envs-config",
    specifier: "@modootoday/envs-config/scope",
    exportName: "resolveScope",
  },
];

export class ScopeProviderMissingError extends Error {
  readonly attempts: readonly (readonly [string, string])[];

  constructor(attempts: readonly (readonly [string, string])[]) {
    const tried = attempts.map(([s, why]) => `  ${s}: ${why}`).join("\n");
    super(`no scope provider could be loaded\n${tried}`);
    this.name = "ScopeProviderMissingError";
    this.attempts = attempts;
  }
}

async function importModule(
  specifier: string,
): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ specifier)) as Record<
    string,
    unknown
  >;
}

/**
 * The first provider that loads and exports the contract wins. Absence throws
 * with every attempt named: falling back to "load everything" would hand the
 * caller a scope nobody chose, and it would look like it worked.
 */
export async function loadScopeResolver(
  providers: readonly ScopeProvider[] = SCOPE_PROVIDERS,
  load: (specifier: string) => Promise<Record<string, unknown>> = importModule,
): Promise<ScopeResolver> {
  const attempts: (readonly [string, string])[] = [];
  for (const provider of providers) {
    let mod: Record<string, unknown>;
    try {
      mod = await load(provider.specifier);
    } catch (error) {
      attempts.push([provider.specifier, (error as Error).message]);
      continue;
    }
    const exported = mod[provider.exportName];
    if (typeof exported !== "function") {
      attempts.push([
        provider.specifier,
        `no ${provider.exportName} export`,
      ]);
      continue;
    }
    return exported as ScopeResolver;
  }
  throw new ScopeProviderMissingError(attempts);
}
