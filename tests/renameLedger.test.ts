import { strict as assert } from "assert";
import type { MixedEntity } from "../src/baseTypes";
import {
  RENAME_LEDGER_MAX_AGE_MS,
  type RenameLedger,
  type RenameLedgerEntry,
  deserializeRenameLedger,
  emptyRenameLedger,
  mergeRenameLedgerEntries,
  pruneRenameLedger,
  readRenameLedgerFromRemote,
  resolveRenameLedgerTarget,
  serializeRenameLedger,
} from "../src/renameLedger";

const remoteExistsMapping = (keys: string[]): Record<string, MixedEntity> => {
  const mapping: Record<string, MixedEntity> = {};
  for (const key of keys) {
    mapping[key] = {
      key,
      remote: { key, keyRaw: key, sizeRaw: 1 },
    };
  }
  return mapping;
};

const entry = (
  fromKey: string,
  toKey: string,
  when: number
): RenameLedgerEntry => ({ fromKey, toKey, when });

describe("renameLedger: resolveRenameLedgerTarget", () => {
  it("returns undefined for an empty ledger", () => {
    const result = resolveRenameLedgerTarget("a.md", emptyRenameLedger(), {});
    assert.equal(result, undefined);
  });

  it("resolves a single-hop rename when the target exists on remote", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("a.md", "b.md", 1000)],
    };
    const result = resolveRenameLedgerTarget(
      "a.md",
      ledger,
      remoteExistsMapping(["b.md"])
    );
    assert.equal(result, "b.md");
  });

  it("follows a multi-hop chain to the first hop that exists on remote", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("a.md", "b.md", 1000), entry("b.md", "c.md", 2000)],
    };
    // only "c.md" exists on remote; "b.md" is just an intermediate hop
    const result = resolveRenameLedgerTarget(
      "a.md",
      ledger,
      remoteExistsMapping(["c.md"])
    );
    assert.equal(result, "c.md");
  });

  it("resolves files inside a renamed folder", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("old-folder", "new-folder", 1000)],
    };
    const result = resolveRenameLedgerTarget(
      "old-folder/note.md",
      ledger,
      remoteExistsMapping(["new-folder/note.md"])
    );
    assert.equal(result, "new-folder/note.md");
  });

  it("resolves folder entities even though sync keys have a trailing slash", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("old-folder", "new-folder", 1000)],
    };
    const result = resolveRenameLedgerTarget(
      "old-folder/",
      ledger,
      remoteExistsMapping(["new-folder/"])
    );
    assert.equal(result, "new-folder/");
  });

  it("follows chained folder renames for child files", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("a", "b", 1000), entry("b", "c", 2000)],
    };
    const result = resolveRenameLedgerTarget(
      "a/note.md",
      ledger,
      remoteExistsMapping(["c/note.md"])
    );
    assert.equal(result, "c/note.md");
  });

  it("stops at an intermediate hop if it already exists on remote", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("a.md", "b.md", 1000), entry("b.md", "c.md", 2000)],
    };
    // "b.md" itself exists on remote (e.g. the rename to "c.md" was reverted
    // and never pushed) - should stop there, not overshoot to "c.md".
    const result = resolveRenameLedgerTarget(
      "a.md",
      ledger,
      remoteExistsMapping(["b.md", "c.md"])
    );
    assert.equal(result, "b.md");
  });

  it("returns undefined on a cycle instead of looping forever", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("a.md", "b.md", 1000), entry("b.md", "a.md", 2000)],
    };
    // neither hop exists on remote, so the algorithm must keep following
    // the chain until it revisits "a.md" and detects the cycle
    const result = resolveRenameLedgerTarget("a.md", ledger, {});
    assert.equal(result, undefined);
  });

  it("uses the most recent entry when the same fromKey has multiple records", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [
        entry("a.md", "old-target.md", 1000),
        entry("a.md", "new-target.md", 5000),
      ],
    };
    const result = resolveRenameLedgerTarget(
      "a.md",
      ledger,
      remoteExistsMapping(["old-target.md", "new-target.md"])
    );
    assert.equal(result, "new-target.md");
  });

  it("returns undefined when the chain never lands on a key that exists on remote", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("a.md", "b.md", 1000)],
    };
    // "b.md" was renamed away again and neither the original nor final
    // target exists on remote (e.g. deleted after the rename)
    const result = resolveRenameLedgerTarget("a.md", ledger, {});
    assert.equal(result, undefined);
  });
});

describe("renameLedger: pruning and merging", () => {
  it("prunes entries older than the max age window", () => {
    const now = 1_700_000_000_000;
    const ledger: RenameLedger = {
      version: "1",
      entries: [
        entry("old.md", "old2.md", now - RENAME_LEDGER_MAX_AGE_MS - 1000),
        entry("recent.md", "recent2.md", now - 1000),
      ],
    };
    const pruned = pruneRenameLedger(ledger, now);
    assert.equal(pruned.entries.length, 1);
    assert.equal(pruned.entries[0].fromKey, "recent.md");
  });

  it("keeps rename evidence for devices offline longer than 60 days", () => {
    const now = 1_700_000_000_000;
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("old.md", "new.md", now - 90 * 24 * 60 * 60 * 1000)],
    };
    const pruned = pruneRenameLedger(ledger, now);
    assert.equal(pruned.entries.length, 1);
  });

  it("merges new entries without duplicating identical ones", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("a.md", "b.md", 1000)],
    };
    const merged = mergeRenameLedgerEntries(ledger, [
      entry("a.md", "b.md", 1000), // exact duplicate, should not double up
      entry("c.md", "d.md", 2000), // genuinely new
    ]);
    assert.equal(merged.entries.length, 2);
  });

  it("round-trips through serialize/deserialize", () => {
    const ledger: RenameLedger = {
      version: "1",
      entries: [entry("a.md", "b.md", 1000)],
    };
    const roundTripped = deserializeRenameLedger(serializeRenameLedger(ledger));
    assert.deepEqual(roundTripped, ledger);
  });

  it("treats unparseable content as an empty ledger instead of throwing", () => {
    const result = deserializeRenameLedger("not valid json");
    assert.deepEqual(result, emptyRenameLedger());
  });

  it("filters malformed entries instead of letting them crash resolution", () => {
    const result = deserializeRenameLedger(
      JSON.stringify({
        version: "1",
        entries: [null, { fromKey: "a.md", toKey: "b.md", when: 1000 }],
      })
    );
    assert.deepEqual(result.entries, [entry("a.md", "b.md", 1000)]);
  });

  it("treats a remote read failure as an empty ledger instead of throwing", async () => {
    const result = await readRenameLedgerFromRemote(
      {
        readFile: async () => {
          throw Error("temporary WebDAV read failure");
        },
      } as any,
      [{ key: "_remotely-save-rename-ledger.json", keyRaw: "", sizeRaw: 0 }]
    );
    assert.deepEqual(result, emptyRenameLedger());
  });
});
