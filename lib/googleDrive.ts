import { google } from "googleapis";

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

/**
 * Accepts either a raw Google Drive folder ID or a full folder URL
 * (https://drive.google.com/drive/folders/XXXXXXXX) and returns the ID.
 */
export function extractFolderId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : trimmed;
}

export interface CreatedFolder {
  id: string;
  name: string;
  url: string;
}

/**
 * Creates one subfolder per name inside the given parent folder, in the
 * signed-in user's Drive. Requires the "parent" folder to already exist and
 * be visible to that user (their own folder, or one shared with them).
 */
export async function createDriveFolders(
  accessToken: string,
  parentFolderIdOrUrl: string,
  folderNames: string[]
): Promise<CreatedFolder[]> {
  const parentId = extractFolderId(parentFolderIdOrUrl);
  if (!parentId) {
    throw new Error("Please provide a parent folder link or ID.");
  }

  const cleanNames = folderNames.map((n) => n.trim()).filter((n) => n.length > 0);
  if (cleanNames.length === 0) {
    throw new Error("Please provide at least one folder name.");
  }

  const auth = buildAuthClient(accessToken);
  const drive = google.drive({ version: "v3", auth });

  // Confirm the parent is actually reachable before creating anything, so
  // the error message is clear instead of failing halfway through the list.
  try {
    await drive.files.get({ fileId: parentId, fields: "id, name, mimeType" });
  } catch {
    throw new Error(
      "Couldn't access that parent folder. Check that the link is correct and that your Google account has access to it."
    );
  }

  const created: CreatedFolder[] = [];
  for (const name of cleanNames) {
    const response = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id, name",
    });

    const id = response.data.id;
    if (!id) continue;

    created.push({
      id,
      name: response.data.name ?? name,
      url: `https://drive.google.com/drive/folders/${id}`,
    });
  }

  return created;
}

/**
 * Shares an existing Drive file (e.g. a generated tracker Sheet) with a
 * given email address, so that person's own Google login can open it
 * without the owner having to share it by hand. Non-fatal by design —
 * callers should treat a failure here as a warning, not a reason to fail
 * the whole job, since the file itself was already created successfully.
 */
export async function shareFileWithEmail(
  accessToken: string,
  fileId: string,
  email: string,
  role: "reader" | "writer" | "commenter" = "reader"
): Promise<void> {
  const auth = buildAuthClient(accessToken);
  const drive = google.drive({ version: "v3", auth });

  await drive.permissions.create({
    fileId,
    sendNotificationEmail: true,
    requestBody: {
      type: "user",
      role,
      emailAddress: email,
    },
  });
}
