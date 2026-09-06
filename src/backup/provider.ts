/**
 * One provider per backup destination, in the shape the sqlite backends use:
 * everything they disagree about is data, eligibility is declared rather than
 * discovered by failing, and resolution picks among what can actually run.
 */

export interface StoredSnapshot {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt?: string;
}

export interface BackupProvider {
  readonly name: string;
  /** Human text for why this destination is or is not usable right now. */
  describe(env: Env): string;
  /** Checked before use: a destination that cannot work must not be tried. */
  eligible(env: Env): boolean;
  put(env: Env, name: string, bytes: Uint8Array): Promise<void>;
  get(env: Env, name: string): Promise<Uint8Array>;
  list(env: Env): Promise<StoredSnapshot[]>;
}

export type Env = Readonly<Record<string, string | undefined>>;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

const registry = new Map<string, BackupProvider>();

export function register(provider: BackupProvider): void {
  registry.set(provider.name, provider);
}

export function providers(): readonly BackupProvider[] {
  return [...registry.values()];
}

/**
 * ENVS_BACKUP_PROVIDER names one. Without it the first eligible provider wins,
 * and "file" is always eligible, so there is always a destination.
 */
export function resolveProvider(env: Env, pinned?: string): BackupProvider {
  const name = pinned ?? env["ENVS_BACKUP_PROVIDER"];
  if (name !== undefined && name !== "") {
    const chosen = registry.get(name);
    if (chosen === undefined) {
      throw new BackupError(
        `"${name}" is not one of ${[...registry.keys()].join(", ")}`,
      );
    }
    if (!chosen.eligible(env)) {
      throw new BackupError(
        `${name} is not configured: ${chosen.describe(env)}`,
      );
    }
    return chosen;
  }
  for (const provider of registry.values()) {
    if (provider.eligible(env)) return provider;
  }
  throw new BackupError("no backup destination is configured");
}
