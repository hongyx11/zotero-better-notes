import {
  getLinkedNotesRecursively,
  getNoteLink,
  getNoteLinkParams,
} from "../../utils/link";
import { getString } from "../../utils/locale";
import { getLinesInNote } from "../../utils/note";
import { formatPath } from "../../utils/str";

export { exportNotes };

async function exportNotes(
  noteItems: Zotero.Item[],
  options: {
    embedLink?: boolean;
    standaloneLink?: boolean;
    exportNote?: boolean;
    exportMD?: boolean;
    setAutoSync?: boolean;
    syncDir?: string;
    withYAMLHeader?: boolean;
    exportDocx?: boolean;
    exportPDF?: boolean;
    exportFreeMind?: boolean;
  }
) {
  let inputNoteItems = noteItems;
  // If embedLink or exportNote, create a new note item
  if ((options.embedLink || options.exportNote) && !options.setAutoSync) {
    inputNoteItems = [];
    for (const noteItem of noteItems) {
      const noteID = await ZoteroPane.newNote();
      const newNote = Zotero.Items.get(noteID);
      newNote.setNote(noteItem.getNote());
      await newNote.saveTx({
        skipSelect: true,
        skipNotifier: true,
        skipSyncedUpdate: true,
      });
      await Zotero.DB.executeTransaction(async () => {
        await Zotero.Notes.copyEmbeddedImages(noteItem, newNote);
      });
      if (options.embedLink) {
        newNote.setNote(await embedLinkedNotes(newNote));
      }
      await newNote.saveTx();
      inputNoteItems.push(newNote);
    }
  }
  let linkedNoteItems = [] as Zotero.Item[];
  if (options.standaloneLink) {
    const linkedNoteIds = [] as number[];
    for (const noteItem of inputNoteItems) {
      let linkedIds: number[] = getLinkedNotesRecursively(
        getNoteLink(noteItem) || "",
        linkedNoteIds
      );
      linkedNoteIds.push(...linkedIds);
    }
    const targetNoteItemIds = inputNoteItems.map((item) => item.id);
    linkedNoteItems = Zotero.Items.get(
      linkedNoteIds.filter((id) => !targetNoteItemIds.includes(id))
    );
  }

  const allNoteItems = Array.from(
    new Set(inputNoteItems.concat(linkedNoteItems))
  );
  if (options.exportMD) {
    if (options.setAutoSync) {
      const raw = await new ztoolkit.FilePicker(
        `${getString("fileInterface.sync")} MarkDown File`,
        "folder"
      ).open();
      if (raw) {
        const syncDir = formatPath(raw);
        // Hard reset sync status for input notes
        for (const noteItem of inputNoteItems) {
          await toSync(noteItem, syncDir, true);
        }

        // Find linked notes that are not synced and include them in sync
        for (const noteItem of linkedNoteItems) {
          await toSync(noteItem, syncDir, false);
        }

        await addon.hooks.onSyncing(allNoteItems, {
          quiet: true,
          skipActive: false,
          reason: "export",
        });
      }
    } else {
      for (const noteItem of allNoteItems) {
        await toMD(noteItem, {
          withYAMLHeader: options.withYAMLHeader,
          keepNoteLink: true,
        });
      }
    }
  }
  if (options.exportDocx) {
    for (const noteItem of allNoteItems) {
      await toDocx(noteItem);
    }
  }
  if (options.exportFreeMind) {
    for (const noteItem of allNoteItems) {
      await toFreeMind(noteItem);
    }
  }
  if (options.exportPDF) {
    for (const noteItem of allNoteItems) {
      await addon.api.$export.savePDF(noteItem.id);
    }
  }
  if (options.embedLink && !options.exportNote) {
    // If not exportNote, delete temp notes
    for (const noteItem of allNoteItems) {
      const _w: Window = ZoteroPane.findNoteWindow(noteItem.id);
      if (_w) {
        _w.close();
      }
      await Zotero.Items.erase(noteItem.id);
    }
  } else if (options.exportNote) {
    for (const noteItem of allNoteItems) {
      ZoteroPane.openNoteWindow(noteItem.id);
    }
  }
}

async function toMD(
  noteItem: Zotero.Item,
  options: {
    filename?: string;
    keepNoteLink?: boolean;
    withYAMLHeader?: boolean;
  } = {}
) {
  let filename = options.filename;
  if (!filename) {
    const raw = await new ztoolkit.FilePicker(
      `${Zotero.getString("fileInterface.export")} MarkDown File`,
      "save",
      [["MarkDown File(*.md)", "*.md"]],
      `${noteItem.getNoteTitle()}.md`
    ).open();
    if (!raw) return;
    filename = formatPath(raw, ".md");
  }
  await addon.api.$export.saveMD(filename, noteItem.id, options);
}

async function toSync(
  noteItem: Zotero.Item,
  syncDir: string,
  overwrite: boolean = false
) {
  if (!overwrite && addon.api.sync.isSyncNote(noteItem.id)) {
    return;
  }
  addon.api.sync.updateSyncStatus(noteItem.id, {
    path: syncDir,
    filename: await addon.api.sync.getMDFileName(noteItem.id, syncDir),
    md5: "",
    noteMd5: Zotero.Utilities.Internal.md5(noteItem.getNote(), false),
    lastsync: 0,
    itemID: noteItem.id,
  });
}

async function toDocx(noteItem: Zotero.Item) {
  const raw = await new ztoolkit.FilePicker(
    `${Zotero.getString("fileInterface.export")} MS Word Docx`,
    "save",
    [["MS Word Docx File(*.docx)", "*.docx"]],
    `${noteItem.getNoteTitle()}.docx`
  ).open();
  if (!raw) return;
  const filename = formatPath(raw, ".docx");
  await addon.api.$export.saveDocx(filename, noteItem.id);
}

async function toFreeMind(noteItem: Zotero.Item) {
  const raw = await new ztoolkit.FilePicker(
    `${Zotero.getString("fileInterface.export")} FreeMind XML`,
    "save",
    [["FreeMind XML File(*.mm)", "*.mm"]],
    `${noteItem.getNoteTitle()}.mm`
  ).open();
  if (!raw) return;
  const filename = formatPath(raw, ".mm");
  await addon.api.$export.saveFreeMind(filename, noteItem.id);
}

async function embedLinkedNotes(noteItem: Zotero.Item): Promise<string> {
  const parser = ztoolkit.getDOMParser();

  let newLines: string[] = [];
  const noteLines = getLinesInNote(noteItem);
  for (let i in noteLines) {
    newLines.push(noteLines[i]);
    const doc = parser.parseFromString(noteLines[i], "text/html");
    const linkParams = Array.from(doc.querySelectorAll("a"))
      .filter((a) => a.href.startsWith("zotero://note/"))
      .map((a) => getNoteLinkParams(a.href))
      .filter((p) => p.noteItem && !p.ignore);
    for (const linkParam of linkParams) {
      const html = await addon.api.template.runTemplate(
        "[QuickImportV2]",
        "link, noteItem",
        [linkParam.link, noteItem]
      );
      newLines.push(html);
    }
  }
  return newLines.join("\n");
}
