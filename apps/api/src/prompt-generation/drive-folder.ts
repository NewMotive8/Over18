import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { promptDriveFolders } from '../db/schema.js';
import { DriveError, type GoogleDriveClient } from './google-drive-client.js';

/**
 * Where generated images go, decided once and then remembered forever.
 *
 * THE PROBLEM THIS SOLVES, STATED PLAINLY. The OAuth scope is `drive.file`:
 * access to files "that you open with an app or that the user shares with an
 * app while using the Google Picker API or the app's file picker". This
 * application has no picker and creates no character content, so the ONLY
 * folder it can address is one it created itself. A folder the operator makes
 * by hand in the Drive web UI is invisible to it, and Google reports invisible
 * resources as 404 `notFound` — which is precisely how production failed, with
 * a correct folder id, a valid token and a folder that plainly existed.
 *
 * The alternative was widening the scope to full `drive`, which would hand this
 * server's stored refresh token read/write access to the operator's entire
 * Google Drive in order to write into one folder. Creating our own folder keeps
 * the blast radius at exactly the images we put there.
 *
 * WHY THE ID IS PERSISTED RATHER THAN CONFIGURED. It does not exist until we
 * make it, so no operator can put it in an environment variable ahead of time.
 * It goes in the database, which survives restarts and redeploys, and whose
 * unique `slot` index is what makes "create once" a guarantee rather than a
 * hope.
 */

/** The default destination's slot. One row, one folder, one name. */
export const DEFAULT_SLOT = 'default';
export const DEFAULT_FOLDER_NAME = 'Over18 Generated Images';

export type DriveFolderSource =
  /** A folder this application created and recorded. The normal case. */
  | 'app_created'
  /** An explicit GOOGLE_DRIVE_FOLDER_ID override. Legacy escape hatch. */
  | 'configured'
  /** Nothing resolved yet, and nothing created — Drive is not configured. */
  | 'none';

export interface DriveFolderView {
  folderId: string | null;
  source: DriveFolderSource;
  folderName: string | null;
}

export interface DriveFolderResolver {
  /**
   * The destination, creating it on first use. Call this before spending money.
   */
  ensure(): Promise<DriveFolderView>;
  /**
   * What is already known, WITHOUT creating anything.
   *
   * Separate from `ensure` so that merely opening the Generation page — a GET,
   * polled every two seconds — cannot make a folder in someone's Drive. Read
   * paths stay free of side effects.
   */
  peek(): Promise<DriveFolderView>;
}

export interface DriveFolderResolverOptions {
  db: Db;
  drive: GoogleDriveClient;
  /** GOOGLE_DRIVE_FOLDER_ID, already trimmed. Null when unset. */
  configuredFolderId: string | null;
  folderName?: string;
  slot?: string;
}

export function createDriveFolderResolver(options: DriveFolderResolverOptions): DriveFolderResolver {
  const slot = options.slot ?? DEFAULT_SLOT;
  const folderName = options.folderName ?? DEFAULT_FOLDER_NAME;
  const { db, drive } = options;
  const configured = options.configuredFolderId?.trim() || null;

  /**
   * The ensure currently running, if any.
   *
   * Two prompts starting at once must not each create a folder. The unique
   * index catches the cross-process case; this catches the far more common
   * in-process one before it ever reaches Google, exactly as the access-token
   * exchange does.
   */
  let inFlight: Promise<DriveFolderView> | null = null;
  /**
   * Whether this process has already confirmed the recorded folder with Drive.
   *
   * ONCE PER PROCESS, NOT ONCE PER UPLOAD. Verifying every upload would add a
   * Google round trip to every image; never verifying would leave a deployment
   * uploading into a folder the operator has since put in the bin, failing for
   * ever with no way back. Once at first use is the balance, and it is also why
   * a redeploy does NOT create a second folder: verification succeeds and the
   * recorded row is reused.
   */
  let verifiedThisProcess = false;

  async function readRow() {
    const [row] = await db
      .select()
      .from(promptDriveFolders)
      .where(eq(promptDriveFolders.slot, slot))
      .limit(1);
    return row ?? null;
  }

  async function record(driveFolderId: string): Promise<string> {
    const [inserted] = await db
      .insert(promptDriveFolders)
      .values({ slot, driveFolderId, folderName, verifiedAt: new Date() })
      .onConflictDoNothing({ target: promptDriveFolders.slot })
      .returning();
    if (inserted) return inserted.driveFolderId;
    /**
     * Another process won the race. ADOPT ITS FOLDER rather than ours: two
     * processes must agree on one destination, and the recorded row is the
     * single source of truth. The folder we just created is left as an empty,
     * private, unused folder — a cosmetic cost paid only in a genuine race,
     * and far cheaper than deleting things in someone's Drive on a guess.
     */
    const existing = await readRow();
    return existing?.driveFolderId ?? driveFolderId;
  }

  async function create(): Promise<DriveFolderView> {
    const folder = await drive.createFolder(folderName);
    const folderId = await record(folder.id);
    verifiedThisProcess = true;
    return { folderId, source: 'app_created', folderName };
  }

  async function resolve(): Promise<DriveFolderView> {
    const row = await readRow();
    if (!row) return create();

    if (verifiedThisProcess) {
      return { folderId: row.driveFolderId, source: 'app_created', folderName: row.folderName };
    }

    let folder;
    try {
      folder = await drive.getFolder(row.driveFolderId);
    } catch (error) {
      /**
       * A LOOKUP FAILURE IS NOT PERMISSION TO MAKE A NEW FOLDER. An expired
       * token or a network blip would otherwise mint a folder per outage and
       * scatter the operator's images across all of them. Keep using what is
       * recorded and let the upload report the real error.
       */
      if (error instanceof DriveError && error.kind === 'auth') throw error;
      return { folderId: row.driveFolderId, source: 'app_created', folderName: row.folderName };
    }

    if (folder && !folder.trashed) {
      verifiedThisProcess = true;
      await db
        .update(promptDriveFolders)
        .set({ verifiedAt: new Date() })
        .where(eq(promptDriveFolders.slot, slot));
      return { folderId: row.driveFolderId, source: 'app_created', folderName: row.folderName };
    }

    // Gone or in the bin. Make a replacement and point the row at it, so the
    // operator gets a working destination instead of a permanent failure.
    const replacement = await drive.createFolder(folderName);
    await db
      .update(promptDriveFolders)
      .set({ driveFolderId: replacement.id, folderName, verifiedAt: new Date() })
      .where(eq(promptDriveFolders.slot, slot));
    verifiedThisProcess = true;
    return { folderId: replacement.id, source: 'app_created', folderName };
  }

  return {
    async peek() {
      if (configured) return { folderId: configured, source: 'configured', folderName: null };
      const row = await readRow();
      if (!row) return { folderId: null, source: 'none', folderName: null };
      return { folderId: row.driveFolderId, source: 'app_created', folderName: row.folderName };
    },

    async ensure() {
      /**
       * AN EXPLICIT SETTING ALWAYS WINS, and nothing is created behind it.
       * Its only correct use now is pinning a folder this app made earlier —
       * after a database restore, say. Pointed at a hand-made folder it will
       * still 404, which is why the readiness payload names the source and the
       * operator is told to clear it.
       */
      if (configured) return { folderId: configured, source: 'configured', folderName: null };
      if (inFlight) return inFlight;
      inFlight = resolve().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/** Never resolves a destination. Used when Drive has no credentials at all. */
export function createNullDriveFolderResolver(
  configuredFolderId: string | null = null,
): DriveFolderResolver {
  const configured = configuredFolderId?.trim() || null;
  const view: DriveFolderView = configured
    ? { folderId: configured, source: 'configured', folderName: null }
    : { folderId: null, source: 'none', folderName: null };
  return {
    async ensure() {
      return view;
    },
    async peek() {
      return view;
    },
  };
}
