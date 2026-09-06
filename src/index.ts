export {
  parseEnv,
  toRecord,
  type EntryKind,
  type FindingCode,
  type ParsedEntry,
  type ParseFinding,
  type ParseResult,
  type Quote,
} from "./format/parse.js";

export {
  availableBackends,
  openDatabase,
  openDatabaseSync,
  PROVIDERS,
  resetBindingCache,
  scanPlaceholders,
  SqliteBindError,
  SqliteUnavailableError,
  type BindParams,
  type BindValue,
  type Database,
  type OpenOptions,
  type RunResult,
  type SqliteBackend,
  type SqliteProvider,
  type SqliteValue,
  type Statement,
} from "./sqlite/open.js";

export {
  EnvelopeAuthError,
  EnvelopeFormatError,
  FORMAT_AES_256_GCM,
  hashKeyName,
  open as openEnvelope,
  readHeader,
  seal,
  type EnvelopeHeader,
  type OpenInput,
  type SealInput,
} from "./crypto/envelope.js";

export {
  addWrap,
  createKeyring,
  DEK_BYTES,
  formatRecoveryCode,
  generateRecoveryCode,
  KeyringLockedError,
  normaliseRecoveryCode,
  RecoveryCodeError,
  sameKey,
  unlockDek,
  type CreateKeyringOptions,
  type DekWrap,
  type Keyring,
  type Unlock,
  type WrapMethod,
} from "./crypto/keyring.js";

export {
  CatalogVersionError,
  checkVersion,
  createSchema,
  migrate,
  MIGRATIONS,
  openCatalog,
  readMeta,
  SCHEMA_VERSION,
  type CatalogMeta,
  type Migration,
  type OpenCatalogOptions,
  type OpenedCatalog,
} from "./catalog/schema.js";

export {
  csvField,
  exportValues,
  type ExportFormat,
  type ExportOptions,
  type ExportResult,
} from "./catalog/export.js";

export {
  cacheDir,
  findProjectRoot,
  globalDir,
  locateCatalogs,
  type Located,
  type LocateOptions,
} from "./loader/locate.js";

export {
  currentRevision,
  itemContext,
  NoReleaseError,
  readEntries,
  readWraps,
  type CatalogEntry,
  type ReadOptions,
} from "./loader/read.js";

export {
  config,
  ConflictError,
  KekMissingError,
  type ConfigOptions,
  type ConfigResult,
  type Encoding,
  type Layer,
  type OnConflict,
  type Provenance,
} from "./loader/config.js";

export { Ui, type Stream, type UiOptions } from "./cli/ui.js";

export {
  COMMANDS,
  dispatch,
  PLANNED,
  type DispatchOptions,
} from "./commands/index.js";
