import type { Entity, MixedEntity } from "./baseTypes";
import type { FakeFsEncrypt } from "./fsEncrypt";

// Records rename/move events explicitly, so an offline device reconciling
// later can deterministically recognize "this local-only file was moved
// elsewhere" instead of guessing from mtime/size heuristics alone. Stored as
// a small shared file on the remote (like the legacy, currently-unused
// metadataOnRemote mechanism), separate from per-file content.
export const DEFAULT_FILE_NAME_FOR_RENAME_LEDGER =
  "_remotely-save-rename-ledger.json";

const RENAME_LEDGER_VERSION = "1";

// Entries older than this are pruned on every write. This is intentionally
// much longer than normal mobile-offline windows: if a device comes back after
// months, stale rename evidence is still safer than silently resurrecting old
// paths.
export const RENAME_LEDGER_MAX_AGE_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export interface RenameLedgerEntry {
  fromKey: string;
  toKey: string;
  when: number;
}

export interface RenameLedger {
  version: string;
  entries: RenameLedgerEntry[];
}

const normalizeLedgerKey = (key: string): string =>
  key.endsWith("/") ? key.slice(0, -1) : key;

const isValidRenameLedgerEntry = (e: unknown): e is RenameLedgerEntry => {
  if (e === null || typeof e !== "object") {
    return false;
  }
  const maybe = e as Partial<RenameLedgerEntry>;
  return (
    typeof maybe.fromKey === "string" &&
    typeof maybe.toKey === "string" &&
    typeof maybe.when === "number" &&
    Number.isFinite(maybe.when)
  );
};

export const emptyRenameLedger = (): RenameLedger => ({
  version: RENAME_LEDGER_VERSION,
  entries: [],
});

export const pruneRenameLedger = (
  ledger: RenameLedger,
  now: number
): RenameLedger => ({
  version: ledger.version,
  entries: ledger.entries.filter(
    (e) =>
      isValidRenameLedgerEntry(e) && now - e.when <= RENAME_LEDGER_MAX_AGE_MS
  ),
});

const entrySignature = (e: RenameLedgerEntry) =>
  `${normalizeLedgerKey(e.fromKey)}\t${normalizeLedgerKey(e.toKey)}\t${e.when}`;

export const mergeRenameLedgerEntries = (
  ledger: RenameLedger,
  newEntries: RenameLedgerEntry[]
): RenameLedger => {
  const seen = new Set(ledger.entries.map(entrySignature));
  const merged = [...ledger.entries];
  for (const e of newEntries) {
    if (!isValidRenameLedgerEntry(e)) {
      continue;
    }
    const sig = entrySignature(e);
    if (!seen.has(sig)) {
      seen.add(sig);
      merged.push(e);
    }
  }
  return { version: ledger.version, entries: merged };
};

export const serializeRenameLedger = (ledger: RenameLedger): string =>
  JSON.stringify(ledger, null, 2);

export const deserializeRenameLedger = (
  raw: string | ArrayBuffer
): RenameLedger => {
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    if (parsed !== null && Array.isArray(parsed.entries)) {
      return {
        version:
          typeof parsed.version === "string"
            ? parsed.version
            : RENAME_LEDGER_VERSION,
        entries: parsed.entries.filter(isValidRenameLedgerEntry),
      };
    }
  } catch (e) {
    console.warn(
      "remotely-save: failed to parse rename ledger, treating it as empty",
      e
    );
  }
  return emptyRenameLedger();
};

const resolveOneLedgerHop = (
  key: string,
  entries: RenameLedgerEntry[]
): string | undefined => {
  const normalizedKey = normalizeLedgerKey(key);
  const candidates = entries
    .map((e) => {
      const fromKey = normalizeLedgerKey(e.fromKey);
      const toKey = normalizeLedgerKey(e.toKey);
      if (normalizedKey === fromKey) {
        return { when: e.when, fromKey, toKey };
      }
      const folderPrefix = `${fromKey}/`;
      if (normalizedKey.startsWith(folderPrefix)) {
        return {
          when: e.when,
          fromKey,
          toKey: `${toKey}/${normalizedKey.slice(folderPrefix.length)}`,
        };
      }
      return undefined;
    })
    .filter(
      (e): e is { when: number; fromKey: string; toKey: string } =>
        e !== undefined
    );
  if (candidates.length === 0) {
    return undefined;
  }
  const latest = candidates.reduce((a, b) => (a.when >= b.when ? a : b));
  if (key.endsWith("/") && !latest.toKey.endsWith("/")) {
    return `${latest.toKey}/`;
  }
  return latest.toKey;
};

/**
 * Follows the fromKey -> toKey chain starting at `key`, using the most
 * recent entry whenever a fromKey has more than one recorded rename. Stops
 * (and returns that key) at the first hop that currently has a remote copy,
 * per `mixedEntityMappings` (already fetched this sync round, no extra
 * network call needed). Returns undefined - meaning "the ledger has no
 * actionable answer, fall back to the existing heuristics" - when: there is
 * no entry for the current key, the chain cycles back to an already-visited
 * key, or the chain runs out without ever landing on a key that currently
 * exists on remote.
 */
export const resolveRenameLedgerTarget = (
  key: string,
  ledger: RenameLedger,
  mixedEntityMappings: Record<string, MixedEntity>
): string | undefined => {
  const entries = ledger.entries.filter(isValidRenameLedgerEntry);
  const visited = new Set<string>([key]);
  let current = key;
  const maxHops = entries.length;
  for (let i = 0; i < maxHops; i++) {
    const next = resolveOneLedgerHop(current, entries);
    if (next === undefined) {
      return undefined;
    }
    if (visited.has(next)) {
      // cycle, e.g. A -> B -> A: not actionable evidence, bail out
      return undefined;
    }
    visited.add(next);
    if (mixedEntityMappings[next]?.remote !== undefined) {
      return next;
    }
    current = next;
  }
  return undefined;
};

export const readRenameLedgerFromRemote = async (
  fsEncrypt: FakeFsEncrypt,
  remoteEntityList: Entity[]
): Promise<RenameLedger> => {
  const existsOnRemote = remoteEntityList.some(
    (e) => e.key === DEFAULT_FILE_NAME_FOR_RENAME_LEDGER
  );
  if (!existsOnRemote) {
    return emptyRenameLedger();
  }
  try {
    const content = await fsEncrypt.readFile(
      DEFAULT_FILE_NAME_FOR_RENAME_LEDGER
    );
    return deserializeRenameLedger(content);
  } catch (e) {
    console.warn(
      "remotely-save: failed to read rename ledger, treating it as empty",
      e
    );
    return emptyRenameLedger();
  }
};

export const writeRenameLedgerToRemote = async (
  fsEncrypt: FakeFsEncrypt,
  ledger: RenameLedger
): Promise<void> => {
  const encoded = new TextEncoder().encode(serializeRenameLedger(ledger));
  const now = Date.now();
  await fsEncrypt.writeFile(
    DEFAULT_FILE_NAME_FOR_RENAME_LEDGER,
    encoded.buffer as ArrayBuffer,
    now,
    now
  );
};
