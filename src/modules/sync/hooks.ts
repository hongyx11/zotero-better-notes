import { showHint } from "../../utils/hint";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";

export { setSyncing, callSyncing };

function setSyncing() {
  const syncPeriod = getPref("syncPeriodSeconds") as number;
  if (syncPeriod > 0) {
    showHint(`${getString("sync.start.hint")} ${syncPeriod} s`);
    const timer = ztoolkit.getGlobal("setInterval")(() => {
      if (!addon.data.alive) {
        showHint(getString("sync.stop.hint"));
        ztoolkit.getGlobal("clearInterval")(timer);
      }
      // Only when Zotero is active and focused
      if (document.hasFocus() && (getPref("syncPeriodSeconds") as number) > 0) {
        callSyncing(undefined, {
          quiet: true,
          skipActive: true,
          reason: "auto",
        });
      }
    }, Number(syncPeriod) * 1000);
  }
}

async function callSyncing(
  items: Zotero.Item[] = [],
  { quiet, skipActive, reason } = {
    quiet: true,
    skipActive: true,
    reason: "unknown",
  }
) {
  // Always log in development mode
  if (addon.data.env === "development") {
    quiet = false;
  }
  if (addon.data.sync.lock) {
    // Only allow one task
    return;
  }
  let progress;
  // Wrap the code in try...catch so that the lock can be released anyway
  try {
    addon.data.sync.lock = true;
    let skippedCount = 0;
    if (!items || !items.length) {
      items = Zotero.Items.get(addon.api.sync.getSyncNoteIds());
    } else {
      items = items.filter((item) => addon.api.sync.isSyncNote(item.id));
    }
    if (items.length === 0) {
      addon.data.sync.lock = false;
      return;
    }
    if (skipActive) {
      // Skip active note editors' targets
      const activeNoteIds = Zotero.Notes._editorInstances
        .filter(
          (editor) =>
            !Components.utils.isDeadWrapper(editor._iframeWindow) &&
            editor._iframeWindow.document.hasFocus()
        )
        .map((editor) => editor._item.id);
      const filteredItems = items.filter(
        (item) => !activeNoteIds.includes(item.id)
      );
      skippedCount = items.length - filteredItems.length;
      items = filteredItems;
    }
    ztoolkit.log("sync start", reason, items, skippedCount);

    if (!quiet) {
      progress = new ztoolkit.ProgressWindow(
        `[${getString("sync.running.hint.title")}] ${
          addon.data.env === "development" ? reason : "Better Notes"
        }`
      )
        .createLine({
          text: `[${getString("sync.running.hint.check")}] 0/${
            items.length
          } ...`,
          type: "default",
          progress: 1,
        })
        .show(-1);
    }
    // Export items of same dir in batch
    const toExport = {} as Record<string, number[]>;
    const toImport: SyncStatus[] = [];
    const toDiff: SyncStatus[] = [];
    let i = 1;
    for (const item of items) {
      const syncStatus = addon.api.sync.getSyncStatus(item.id);
      const filepath = syncStatus.path;
      let compareResult = await doCompare(item);
      switch (compareResult) {
        case SyncCode.NoteAhead:
          if (Object.keys(toExport).includes(filepath)) {
            toExport[filepath].push(item.id);
          } else {
            toExport[filepath] = [item.id];
          }
          break;
        case SyncCode.MDAhead:
          toImport.push(syncStatus);
          break;
        case SyncCode.NeedDiff:
          toDiff.push(syncStatus);
          break;
        default:
          break;
      }
      progress?.changeLine({
        text: `[${getString("sync.running.hint.check")}] ${i}/${
          items.length
        } ...`,
        progress: ((i - 1) / items.length) * 100,
      });
      i += 1;
    }
    ztoolkit.log("will be synced:", toExport, toImport, toDiff);
    i = 1;
    let totalCount = Object.keys(toExport).length;
    for (const filepath of Object.keys(toExport)) {
      progress?.changeLine({
        text: `[${getString("sync.running.hint.updateMD")}] ${i}/${
          items.length
        } ...`,
        progress: ((i - 1) / items.length) * 100,
      });
      await addon.api.$export.syncMDBatch(filepath, toExport[filepath]);
      i += 1;
    }
    i = 1;
    totalCount = toImport.length;
    for (const syncStatus of toImport) {
      progress?.changeLine({
        text: `[${getString(
          "sync.running.hint.updateNote"
        )}] ${i}/${totalCount}, ${toDiff.length} queuing...`,
        progress: ((i - 1) / totalCount) * 100,
      });
      const item = Zotero.Items.get(syncStatus.itemID);
      const filepath = OS.Path.join(syncStatus.path, syncStatus.filename);
      await addon.api.$import.fromMD(filepath, { noteId: item.id });
      // Update md file to keep the metadata synced
      await addon.api.$export.syncMDBatch(syncStatus.path, [item.id]);
      i += 1;
    }
    i = 1;
    totalCount = toDiff.length;
    for (const syncStatus of toDiff) {
      progress?.changeLine({
        text: `[${getString("sync.running.hint.diff")}] ${i}/${totalCount}...`,
        progress: ((i - 1) / totalCount) * 100,
      });

      await addon.hooks.onShowSyncDiff(
        syncStatus.itemID,
        OS.Path.join(syncStatus.path, syncStatus.filename)
      );
      i += 1;
    }
    const syncCount =
      Object.keys(toExport).length + toImport.length + toDiff.length;
    progress?.changeLine({
      text:
        (syncCount
          ? `[${getString(
              "sync.running.hint.finish"
            )}] ${syncCount} ${getString("sync.running.hint.synced")}`
          : `[${getString("sync.running.hint.finish")}] ${getString(
              "sync.running.hint.upToDate"
            )}`) + (skippedCount ? `, ${skippedCount} skipped.` : ""),
      progress: 100,
    });
  } catch (e) {
    ztoolkit.log(e);
    // showHint(`Sync Error: ${String(e)}`);
  } finally {
    progress?.startCloseTimer(5000);
  }
  addon.data.sync.lock = false;
}

async function doCompare(noteItem: Zotero.Item): Promise<SyncCode> {
  const syncStatus = addon.api.sync.getSyncStatus(noteItem.id);
  const MDStatus = await addon.api.sync.getMDStatus(noteItem.id);
  // No file found
  if (!MDStatus.meta) {
    return SyncCode.NoteAhead;
  }
  // File meta is unavailable
  if (MDStatus.meta.version < 0) {
    return SyncCode.NeedDiff;
  }
  let MDAhead = false;
  let noteAhead = false;
  const md5 = Zotero.Utilities.Internal.md5(MDStatus.content, false);
  const noteMd5 = Zotero.Utilities.Internal.md5(noteItem.getNote(), false);
  // MD5 doesn't match (md side change)
  if (md5 !== syncStatus.md5) {
    MDAhead = true;
  }
  // MD5 doesn't match (note side change)
  if (noteMd5 !== syncStatus.noteMd5) {
    noteAhead = true;
  }
  // Note version doesn't match (note side change)
  // This might be unreliable when Zotero account is not login
  if (Number(MDStatus.meta.version) !== noteItem.version) {
    noteAhead = true;
  }
  if (noteAhead && MDAhead) {
    return SyncCode.NeedDiff;
  } else if (noteAhead) {
    return SyncCode.NoteAhead;
  } else if (MDAhead) {
    return SyncCode.MDAhead;
  } else {
    return SyncCode.UpToDate;
  }
}

enum SyncCode {
  UpToDate = 0,
  NoteAhead,
  MDAhead,
  NeedDiff,
}
