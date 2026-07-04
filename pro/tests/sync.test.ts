import { strict as assert } from "assert";
import moment from "moment";
import type { MixedEntity, SyncDirectionType } from "../../src/baseTypes";
import type { RenameLedger } from "../../src/renameLedger";
import { checkIsSkipItemOrNotByName, getSyncPlanInplace } from "../src/sync";

// getSyncPlanInplace formats a timestamp via the Obsidian-injected window.moment
// global at the very end; outside the Obsidian runtime we shim it for tests.
// Re-applied in a beforeEach (not just once at module load) because other test
// files in this same mocha run (e.g. tests/misc.test.ts) replace global.window
// wholesale with a jsdom window that has no .moment, and that pollution leaks
// across files within one mocha process.
const ensureWindowMomentShim = () => {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.moment = moment;
};

const buildEntity = (
  keyRaw: string,
  mtime: number,
  sizeRaw: number
): {
  key: string;
  keyRaw: string;
  mtimeCli: number;
  mtimeSvr: number;
  size: number;
  sizeRaw: number;
  sizeEnc: number;
} => ({
  key: keyRaw,
  keyRaw,
  mtimeCli: mtime,
  mtimeSvr: mtime,
  size: sizeRaw,
  sizeRaw,
  sizeEnc: sizeRaw,
});

const runPlan = async (
  mixedEntityMappings: Record<string, MixedEntity>,
  lastSuccessSyncMillis?: number,
  treatAsFreshProfileSync?: boolean,
  renameLedger?: RenameLedger,
  syncDirection?: SyncDirectionType
) => {
  return await getSyncPlanInplace(
    mixedEntityMappings,
    /* skipSizeLargerThan */ -1,
    /* conflictAction */ "keep_newer",
    syncDirection ?? "bidirectional",
    /* profiler */ undefined,
    /* settings */ {} as any,
    /* triggerSource */ "manual",
    /* configDir */ ".obsidian",
    lastSuccessSyncMillis,
    treatAsFreshProfileSync ?? false,
    renameLedger
  );
};

describe("Sync: checkIsSkipItemOrNotByName", () => {
  it("should be ok everywhere for empty config", async () => {
    let isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(!isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [""],
      /* onlyAllowPaths */ ["", "\n"]
    ).finalIsIgnored;
    assert.ok(!isSkip);
  });

  it("should be ok for deny list", async () => {
    let isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "yyy.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(!isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx$"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(!isSkip);

    // if we deny a folder, we have to deny all the sub files
    // TODO: it's soooo hard to do the path resolution in this func with regex,
    //       so we defer the detection to later steps now.
    //       the test here doesn't work.
    // isSkip = checkIsSkipItemOrNotByName(
    //   'xxx/yyy.md',
    //   false,
    //   false,
    //   false,
    //   '.obsidian',
    //   /*    ignorePaths */ ['xxx/$'],
    //   /* onlyAllowPaths */ []
    // ).finalIsIgnored;
    // assert.ok(isSkip);
  });

  it("should be ok for allow list", async () => {
    let isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [],
      /* onlyAllowPaths */ ["xxx"]
    ).finalIsIgnored;
    assert.ok(!isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "yyy.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [""],
      /* onlyAllowPaths */ ["xxx"]
    ).finalIsIgnored;
    assert.ok(isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [],
      /* onlyAllowPaths */ ["xxx$"]
    ).finalIsIgnored;
    assert.ok(isSkip);

    // should NOT skip because we allow the sub file AND not deny the folder
    // TODO: it's soooo hard to do the path resolution in this func with regex,
    //       so we defer the detection to later steps now.
    //       the test here doesn't work.
    // isSkip = checkIsSkipItemOrNotByName(
    //   'xxx/',
    //   false,
    //   false,
    //   false,
    //   '.obsidian',
    //   /*    ignorePaths */ [],
    //   /* onlyAllowPaths */ ['xxx/yyy.md']
    // ).finalIsIgnored;
    // assert.ok(!isSkip);
  });

  it("should detect the name by two lists together", async () => {
    // should skip because we ignore the path
    let isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx"],
      /* onlyAllowPaths */ ["yyy"]
    ).finalIsIgnored;
    assert.ok(isSkip);

    // should skip because we disallow the whole folder
    isSkip = checkIsSkipItemOrNotByName(
      "xxx/yyy.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx"],
      /* onlyAllowPaths */ ["xxx/yyy.md"]
    ).finalIsIgnored;
    assert.ok(isSkip);
  });
});

describe("Sync: getSyncPlanInplace mtime tolerance for offline-device delete/rename", () => {
  beforeEach(() => {
    ensureWindowMomentShim();
  });

  it("should still delete locally when remote is gone and local mtime drifted a little bit (bug repro)", async () => {
    // scenario: another device deleted the file on remote while this device was offline.
    // this device's own local mtime for the untouched file drifts by a few hundred ms
    // from what was recorded as prevSync (e.g. mobile fs stat precision quirks).
    const prevSync = buildEntity("foo.md", 1_700_000_000_000, 100);
    const local = buildEntity("foo.md", 1_700_000_000_400, 100); // 400ms drift, same size
    const mapping: Record<string, MixedEntity> = {
      "foo.md": { key: "foo.md", local, prevSync },
    };
    const result = await runPlan(mapping);
    assert.equal(
      result["foo.md"].decision,
      "remote_is_deleted_thus_also_delete_local"
    );
  });

  it("should still push to remote when local is gone and remote mtime drifted a little bit (symmetric case)", async () => {
    const prevSync = buildEntity("bar.md", 1_700_000_000_000, 100);
    const remote = buildEntity("bar.md", 1_700_000_000_400, 100);
    const mapping: Record<string, MixedEntity> = {
      "bar.md": { key: "bar.md", remote, prevSync },
    };
    const result = await runPlan(mapping);
    assert.equal(
      result["bar.md"].decision,
      "local_is_deleted_thus_also_delete_remote"
    );
  });

  it("should still treat a genuinely resized local edit as modified, not swallow it, even with close mtime", async () => {
    const prevSync = buildEntity("foo.md", 1_700_000_000_000, 100);
    const local = buildEntity("foo.md", 1_700_000_000_400, 250); // content actually changed (size differs)
    const mapping: Record<string, MixedEntity> = {
      "foo.md": { key: "foo.md", local, prevSync },
    };
    const result = await runPlan(mapping);
    assert.equal(result["foo.md"].decision, "local_is_modified_then_push");
  });

  it("should hold a same-size local-only file with drifted mtime instead of resurrecting a possibly renamed/deleted remote path", async () => {
    const prevSync = buildEntity("foo.md", 1_700_000_000_000, 100);
    const local = buildEntity("foo.md", 1_700_000_060_000, 100); // 60s later, same size
    const mapping: Record<string, MixedEntity> = {
      "foo.md": { key: "foo.md", local, prevSync },
    };
    const result = await runPlan(mapping);
    assert.equal(
      result["foo.md"].decision,
      "local_is_modified_but_remote_missing_then_hold"
    );
  });

  it("should still push a clearly resized local edit when remote is missing", async () => {
    const prevSync = buildEntity("foo.md", 1_700_000_000_000, 100);
    const local = buildEntity("foo.md", 1_700_000_060_000, 250);
    const mapping: Record<string, MixedEntity> = {
      "foo.md": { key: "foo.md", local, prevSync },
    };
    const result = await runPlan(mapping);
    assert.equal(result["foo.md"].decision, "local_is_modified_then_push");
  });

  it("should correctly resolve a rename (old key deleted, new key created) even with mtime drift on the old key", async () => {
    const oldPrevSync = buildEntity("old.md", 1_700_000_000_000, 100);
    const oldLocal = buildEntity("old.md", 1_700_000_000_400, 100); // untouched, just drifted
    const newRemote = buildEntity("new.md", 1_700_000_050_000, 100);
    const mapping: Record<string, MixedEntity> = {
      "old.md": { key: "old.md", local: oldLocal, prevSync: oldPrevSync },
      "new.md": { key: "new.md", remote: newRemote },
    };
    const result = await runPlan(mapping);
    assert.equal(
      result["old.md"].decision,
      "remote_is_deleted_thus_also_delete_local"
    );
    assert.equal(result["new.md"].decision, "remote_is_created_then_pull");
  });

  it("should leave the both-present exact-equal branch untouched (no tolerance applied there)", async () => {
    const local = buildEntity("baz.md", 1_700_000_000_000, 100);
    const remote = buildEntity("baz.md", 1_700_000_000_000, 100);
    const mapping: Record<string, MixedEntity> = {
      "baz.md": { key: "baz.md", local, remote },
    };
    const result = await runPlan(mapping);
    assert.equal(result["baz.md"].decision, "equal");
  });
});

describe("Sync: getSyncPlanInplace holding back stale orphan files with no prevSync", () => {
  beforeEach(() => {
    ensureWindowMomentShim();
  });

  const lastSuccessSyncMillis = 1_700_000_000_000;

  it("should hold back a local-only file with no prevSync whose mtime predates the last successful sync (bug repro)", async () => {
    // mimics: Mac renamed/deleted the file while this device was offline for
    // days, and this device's own prevSync record for that key was lost.
    const local = buildEntity(
      "orphan.md",
      lastSuccessSyncMillis - 60 * 60 * 1000, // 1 hour before last sync, well past the grace window
      100
    );
    const mapping: Record<string, MixedEntity> = {
      "orphan.md": { key: "orphan.md", local },
    };
    const result = await runPlan(mapping, lastSuccessSyncMillis, false);
    assert.equal(
      result["orphan.md"].decision,
      "local_is_created_but_looks_stale_then_hold"
    );
    assert.equal(result["orphan.md"].change, true);
  });

  it("should still push a genuinely new file created after the last successful sync", async () => {
    const local = buildEntity(
      "new.md",
      lastSuccessSyncMillis + 60 * 1000, // created after the last sync completed
      100
    );
    const mapping: Record<string, MixedEntity> = {
      "new.md": { key: "new.md", local },
    };
    const result = await runPlan(mapping, lastSuccessSyncMillis, false);
    assert.equal(result["new.md"].decision, "local_is_created_then_push");
  });

  it("should not hold anything when this profile has no prevSync history at all (post reset-button / freshly switched profile)", async () => {
    // same old mtime as the repro case, but treatAsFreshProfileSync=true
    // (prevSyncEntityList.length === 0 for this sync round) must short-circuit
    // the suspicion check entirely.
    const local = buildEntity(
      "orphan.md",
      lastSuccessSyncMillis - 60 * 60 * 1000,
      100
    );
    const mapping: Record<string, MixedEntity> = {
      "orphan.md": { key: "orphan.md", local },
    };
    const result = await runPlan(mapping, lastSuccessSyncMillis, true);
    assert.equal(result["orphan.md"].decision, "local_is_created_then_push");
  });

  it("should not hold files inside the Obsidian config folder", async () => {
    const local = buildEntity(
      ".obsidian/main.js",
      lastSuccessSyncMillis - 60 * 60 * 1000,
      100
    );
    const folderLocal = buildEntity(".obsidian/", 0, 0);
    const mapping: Record<string, MixedEntity> = {
      ".obsidian/main.js": { key: ".obsidian/main.js", local },
      // the file's parent folder must also be present, matching how a real
      // fsLocal.walk() result always includes the full directory tree.
      ".obsidian/": { key: ".obsidian/", local: folderLocal },
    };
    const result = await runPlan(mapping, lastSuccessSyncMillis, false);
    assert.equal(
      result[".obsidian/main.js"].decision,
      "local_is_created_then_push"
    );
  });

  it("should not hold a file whose mtime is only slightly before the last sync (within the grace window)", async () => {
    const local = buildEntity(
      "recent.md",
      lastSuccessSyncMillis - 60 * 1000, // 1 minute before, well within the 5-minute grace
      100
    );
    const mapping: Record<string, MixedEntity> = {
      "recent.md": { key: "recent.md", local },
    };
    const result = await runPlan(mapping, lastSuccessSyncMillis, false);
    assert.equal(result["recent.md"].decision, "local_is_created_then_push");
  });

  it("should not hold anything when lastSuccessSyncMillis is unknown (e.g. never recorded before)", async () => {
    const local = buildEntity(
      "orphan.md",
      lastSuccessSyncMillis - 60 * 60 * 1000,
      100
    );
    const mapping: Record<string, MixedEntity> = {
      "orphan.md": { key: "orphan.md", local },
    };
    const result = await runPlan(mapping, undefined, false);
    assert.equal(result["orphan.md"].decision, "local_is_created_then_push");
  });
});

describe("Sync: getSyncPlanInplace rename ledger overrides mtime-based guessing", () => {
  beforeEach(() => {
    ensureWindowMomentShim();
  });

  it("bug repro: trusts the ledger over the mtime heuristic when they disagree, and the renamed-to key resolves independently", async () => {
    // prevSync/local mtime differ by far more than the delete-tolerance
    // window, so the mtime heuristic alone would (wrongly) conclude "local
    // modified it, push it back up" - exactly the resurrection bug. The
    // ledger says otherwise and must win.
    const prevSync = buildEntity("old.md", 1_700_000_000_000, 100);
    const local = buildEntity("old.md", 1_700_000_100_000, 100); // 100s later
    const remoteNew = buildEntity("new.md", 1_700_000_050_000, 100);
    const renameLedger: RenameLedger = {
      version: "1",
      entries: [
        { fromKey: "old.md", toKey: "new.md", when: 1_700_000_010_000 },
      ],
    };
    const mapping: Record<string, MixedEntity> = {
      "old.md": { key: "old.md", local, prevSync },
      "new.md": { key: "new.md", remote: remoteNew },
    };
    const result = await runPlan(
      mapping,
      undefined,
      false,
      renameLedger,
      "bidirectional"
    );
    assert.equal(
      result["old.md"].decision,
      "remote_is_deleted_thus_also_delete_local"
    );
    assert.equal(result["new.md"].decision, "remote_is_created_then_pull");
  });

  it("bug repro: trusts a folder rename ledger entry for stale child files under the moved folder", async () => {
    // Obsidian reports a folder move as one rename event for the folder path,
    // while sync walks individual child files. The ledger must therefore
    // resolve old-folder/note.md through old-folder -> new-folder, otherwise
    // the offline device can resurrect the old child path.
    const prevSync = buildEntity("old-folder/note.md", 1_700_000_000_000, 100);
    const local = buildEntity("old-folder/note.md", 1_700_000_100_000, 100);
    const remoteNew = buildEntity("new-folder/note.md", 1_700_000_050_000, 100);
    const renameLedger: RenameLedger = {
      version: "1",
      entries: [
        {
          fromKey: "old-folder",
          toKey: "new-folder",
          when: 1_700_000_010_000,
        },
      ],
    };
    const mapping: Record<string, MixedEntity> = {
      "old-folder/": {
        key: "old-folder/",
        local: buildEntity("old-folder/", 0, 0),
        prevSync: buildEntity("old-folder/", 0, 0),
      },
      "old-folder/note.md": {
        key: "old-folder/note.md",
        local,
        prevSync,
      },
      "new-folder/": {
        key: "new-folder/",
        remote: buildEntity("new-folder/", 0, 0),
      },
      "new-folder/note.md": {
        key: "new-folder/note.md",
        remote: remoteNew,
      },
    };
    const result = await runPlan(
      mapping,
      undefined,
      false,
      renameLedger,
      "bidirectional"
    );
    assert.equal(
      result["old-folder/note.md"].decision,
      "remote_is_deleted_thus_also_delete_local"
    );
    assert.equal(
      result["new-folder/note.md"].decision,
      "remote_is_created_then_pull"
    );
  });

  it("holds instead of falling back to upload when the ledger has no entry and the same-size local file only has mtime drift", async () => {
    const prevSync = buildEntity("old.md", 1_700_000_000_000, 100);
    const local = buildEntity("old.md", 1_700_000_100_000, 100);
    const mapping: Record<string, MixedEntity> = {
      "old.md": { key: "old.md", local, prevSync },
    };
    const result = await runPlan(
      mapping,
      undefined,
      false,
      { version: "1", entries: [] },
      "bidirectional"
    );
    assert.equal(
      result["old.md"].decision,
      "local_is_modified_but_remote_missing_then_hold"
    );
  });

  it("holds when the ledger's target doesn't exist anywhere and the old same-size local file only has mtime drift", async () => {
    const prevSync = buildEntity("old.md", 1_700_000_000_000, 100);
    const local = buildEntity("old.md", 1_700_000_100_000, 100);
    const renameLedger: RenameLedger = {
      version: "1",
      entries: [
        { fromKey: "old.md", toKey: "gone.md", when: 1_700_000_010_000 },
      ],
    };
    const mapping: Record<string, MixedEntity> = {
      "old.md": { key: "old.md", local, prevSync },
      // note: "gone.md" has no entry at all in mixedEntityMappings - it
      // doesn't exist on remote or locally, matching "renamed then deleted"
    };
    const result = await runPlan(
      mapping,
      undefined,
      false,
      renameLedger,
      "bidirectional"
    );
    assert.equal(
      result["old.md"].decision,
      "local_is_modified_but_remote_missing_then_hold"
    );
  });

  it("respects incremental_pull_only direction: does nothing locally even when the ledger confirms a rename", async () => {
    const prevSync = buildEntity("old.md", 1_700_000_000_000, 100);
    const local = buildEntity("old.md", 1_700_000_100_000, 100);
    const remoteNew = buildEntity("new.md", 1_700_000_050_000, 100);
    const renameLedger: RenameLedger = {
      version: "1",
      entries: [
        { fromKey: "old.md", toKey: "new.md", when: 1_700_000_010_000 },
      ],
    };
    const mapping: Record<string, MixedEntity> = {
      "old.md": { key: "old.md", local, prevSync },
      "new.md": { key: "new.md", remote: remoteNew },
    };
    const result = await runPlan(
      mapping,
      undefined,
      false,
      renameLedger,
      "incremental_pull_only"
    );
    assert.equal(result["old.md"].decision, "conflict_created_then_do_nothing");
  });

  it("respects incremental_push_only direction: keeps local even when the ledger confirms a rename (push-only never deletes based on remote state)", async () => {
    const prevSync = buildEntity("old.md", 1_700_000_000_000, 100);
    const local = buildEntity("old.md", 1_700_000_100_000, 100);
    const remoteNew = buildEntity("new.md", 1_700_000_050_000, 100);
    const renameLedger: RenameLedger = {
      version: "1",
      entries: [
        { fromKey: "old.md", toKey: "new.md", when: 1_700_000_010_000 },
      ],
    };
    const mapping: Record<string, MixedEntity> = {
      "old.md": { key: "old.md", local, prevSync },
      "new.md": { key: "new.md", remote: remoteNew },
    };
    const result = await runPlan(
      mapping,
      undefined,
      false,
      renameLedger,
      "incremental_push_only"
    );
    assert.equal(result["old.md"].decision, "conflict_created_then_keep_local");
  });

  it("respects incremental_pull_and_delete_only direction: deletes local when the ledger confirms a rename", async () => {
    const prevSync = buildEntity("old.md", 1_700_000_000_000, 100);
    const local = buildEntity("old.md", 1_700_000_100_000, 100);
    const remoteNew = buildEntity("new.md", 1_700_000_050_000, 100);
    const renameLedger: RenameLedger = {
      version: "1",
      entries: [
        { fromKey: "old.md", toKey: "new.md", when: 1_700_000_010_000 },
      ],
    };
    const mapping: Record<string, MixedEntity> = {
      "old.md": { key: "old.md", local, prevSync },
      "new.md": { key: "new.md", remote: remoteNew },
    };
    const result = await runPlan(
      mapping,
      undefined,
      false,
      renameLedger,
      "incremental_pull_and_delete_only"
    );
    assert.equal(
      result["old.md"].decision,
      "remote_is_deleted_thus_also_delete_local"
    );
  });
});
