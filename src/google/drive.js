import { gjson } from "./auth.js";
import { normalizeLookupName, scoreNameSimilarity, splitDrivePath, toArray } from "../utils.js";

const DRIVE_V3 = "https://www.googleapis.com/drive/v3";

function escapeDriveQ(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function driveUrl(path, query) {
  const url = new URL(`${DRIVE_V3}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function driveGet(app, fileId, fields = "id,name,mimeType,parents,trashed,webViewLink") {
  return gjson(app, driveUrl(`/files/${encodeURIComponent(fileId)}`, { fields }), {
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

export async function getSandboxRoot(app) {
  return driveGet(app, app.config.google.folderId, "id,name,mimeType,parents,trashed");
}

export async function isIdInSandboxTree(app, fileId) {
  if (fileId === app.config.google.folderId) return true;
  const seen = new Set();
  const queue = [fileId];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (current === app.config.google.folderId) return true;
    let meta;
    try {
      meta = await driveGet(app, current, "id,parents");
    } catch {
      return false;
    }
    const parents = toArray(meta.parents).map((item) => String(item));
    if (parents.includes(app.config.google.folderId)) return true;
    for (const parent of parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return false;
}

export async function assertInSandbox(app, fileId, mimePrefix = "") {
  const meta = await driveGet(app, fileId, "id,name,mimeType,parents,trashed,webViewLink");
  const inside = await isIdInSandboxTree(app, fileId);
  if (!inside) {
    throw new Error(`sandbox_violation: file ${fileId} is outside sandbox folder ${app.config.google.folderId}`);
  }
  if (mimePrefix && !String(meta.mimeType || "").includes(mimePrefix)) {
    throw new Error(`mime_mismatch: expected ${mimePrefix}, got ${meta.mimeType || "unknown"}`);
  }
  return meta;
}

export async function assertParentInSandbox(app, parentId) {
  const targetParent = String(parentId || app.config.google.folderId).trim();
  if (!targetParent) return app.config.google.folderId;
  const ok = await isIdInSandboxTree(app, targetParent);
  if (!ok) {
    throw new Error(`sandbox_violation: parent ${targetParent} is outside sandbox tree`);
  }
  const meta = await driveGet(app, targetParent, "id,name,mimeType,parents,trashed");
  if (meta.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error(`invalid_parent: ${targetParent} is not a folder`);
  }
  return targetParent;
}

async function listResolveCandidates(app, parentId, mimePrefix = "", pageSize = 200) {
  const q = [`'${escapeDriveQ(parentId)}' in parents`, "trashed=false"];
  if (mimePrefix) q.push(`mimeType contains '${escapeDriveQ(mimePrefix)}'`);
  const res = await gjson(
    app,
    driveUrl("/files", {
      q: q.join(" and "),
      fields: "files(id,name,mimeType,parents,trashed,webViewLink)",
      pageSize: Math.max(1, Math.min(Number(pageSize || 200), 500)),
      orderBy: "modifiedTime desc",
    }),
    { scopes: ["https://www.googleapis.com/auth/drive"] },
  );
  return toArray(res.files);
}

async function listFolderChildren(app, parentId, pageSize = 500) {
  return listResolveCandidates(app, parentId, "", pageSize);
}

export async function getFilePathSegments(app, fileId) {
  const segments = [];
  let currentId = String(fileId || "").trim();
  const seen = new Set();
  while (currentId && currentId !== app.config.google.folderId && !seen.has(currentId)) {
    seen.add(currentId);
    const meta = await driveGet(app, currentId, "id,name,parents");
    segments.unshift(String(meta?.name || currentId));
    const parents = toArray(meta?.parents).map((item) => String(item || "").trim()).filter(Boolean);
    currentId = parents[0] || "";
  }
  return segments;
}

export async function formatPathFromRoot(app, fileId) {
  const segments = await getFilePathSegments(app, fileId);
  return segments.length ? segments.join(" > ") : "(root)";
}

export async function resolveFolderPath(app, folderPathText) {
  const rawSegments = splitDrivePath(folderPathText);
  if (!rawSegments.length) {
    return { folderId: app.config.google.folderId, segments: [] };
  }
  const root = await getSandboxRoot(app);
  const rootName = normalizeLookupName(root?.name || "");
  const segments = [...rawSegments];
  if (segments.length && normalizeLookupName(segments[0]) === rootName) segments.shift();

  let parentId = app.config.google.folderId;
  const resolvedSegments = [];
  for (const segment of segments) {
    const resolved = await resolveByName(app, {
      name: segment,
      mimePrefix: "application/vnd.google-apps.folder",
      parentId,
      exactOnly: false,
    });
    if (!resolved.file) {
      return {
        error: resolved.ambiguous ? "folder_path_ambiguous" : "folder_not_found",
        missingSegment: segment,
        parentId,
        details: resolved,
      };
    }
    parentId = resolved.file.id;
    resolvedSegments.push(resolved.file.name);
  }
  return { folderId: parentId, segments: resolvedSegments };
}

export async function resolveByNameInTree(app, { name, mimePrefix = "", startParentId, exactOnly = false, maxFolders = 300 }) {
  const target = String(name || "").trim();
  if (!target) return { error: "name_required" };
  const rootParent = await assertParentInSandbox(app, startParentId || app.config.google.folderId);
  const normalizedTarget = normalizeLookupName(target);
  const queue = [rootParent];
  const seen = new Set();
  const exactMatches = [];
  const normalizedMatches = [];
  const fuzzyCandidates = [];

  while (queue.length) {
    const parentId = queue.shift();
    if (!parentId || seen.has(parentId)) continue;
    seen.add(parentId);
    if (seen.size > maxFolders) return { error: "folder_scan_limit_exceeded" };

    const children = await listFolderChildren(app, parentId, 500);
    for (const child of children) {
      const childId = String(child?.id || "").trim();
      const childName = String(child?.name || "").trim();
      const childMime = String(child?.mimeType || "");

      if (childMime === "application/vnd.google-apps.folder" && childId) queue.push(childId);
      if (mimePrefix && !childMime.includes(mimePrefix)) continue;

      const normalizedChild = normalizeLookupName(childName);
      if (childName === target) {
        exactMatches.push(child);
      } else if (normalizedChild === normalizedTarget) {
        normalizedMatches.push(child);
      } else if (!exactOnly) {
        const score = scoreNameSimilarity(childName, target);
        if (score >= 70) fuzzyCandidates.push({ file: child, score });
      }
    }
  }

  if (exactMatches.length === 1) return { file: exactMatches[0] };
  if (exactMatches.length > 1) {
    return {
      ambiguous: true,
      message: "multiple_files_with_same_name_in_tree",
      options: await Promise.all(
        exactMatches.map(async (file) => ({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          path: await formatPathFromRoot(app, file.id),
        })),
      ),
    };
  }
  if (normalizedMatches.length === 1) return { file: normalizedMatches[0] };
  if (normalizedMatches.length > 1) {
    return {
      ambiguous: true,
      message: "multiple_files_with_normalized_name_in_tree",
      options: await Promise.all(
        normalizedMatches.map(async (file) => ({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          path: await formatPathFromRoot(app, file.id),
        })),
      ),
    };
  }
  if (exactOnly) return { error: "file_not_found" };

  const scored = fuzzyCandidates
    .sort((left, right) => right.score - left.score)
    .filter((item, index, all) => index < 8 && (!all[0] || all[0].score - item.score <= 5));
  if (scored.length === 1) return { file: scored[0].file };
  if (scored.length > 1) {
    return {
      ambiguous: true,
      message: "multiple_fuzzy_candidates_found_in_tree",
      options: await Promise.all(
        scored.map(async (item) => ({
          id: item.file.id,
          name: item.file.name,
          mimeType: item.file.mimeType,
          score: item.score,
          path: await formatPathFromRoot(app, item.file.id),
        })),
      ),
    };
  }
  return { error: "file_not_found" };
}

export async function resolveByName(app, { name, mimePrefix = "", exactOnly = false, parentId }) {
  const target = String(name || "").trim();
  if (!target) return { error: "name_required" };
  const parent = await assertParentInSandbox(app, parentId || app.config.google.folderId);

  const exactQ = [`'${escapeDriveQ(parent)}' in parents`, "trashed=false", `name='${escapeDriveQ(target)}'`];
  if (mimePrefix) exactQ.push(`mimeType contains '${escapeDriveQ(mimePrefix)}'`);
  const exact = await gjson(
    app,
    driveUrl("/files", {
      q: exactQ.join(" and "),
      fields: "files(id,name,mimeType,parents,trashed,webViewLink)",
      pageSize: 50,
    }),
    { scopes: ["https://www.googleapis.com/auth/drive"] },
  );
  const exactFiles = toArray(exact.files);
  if (exactFiles.length === 1) return { file: exactFiles[0] };
  if (exactFiles.length > 1) {
    return {
      ambiguous: true,
      message: "multiple_files_with_same_name",
      options: exactFiles.map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType })),
    };
  }

  const allCandidates = await listResolveCandidates(app, parent, mimePrefix, 300);
  const normalizedTarget = normalizeLookupName(target);
  const normalizedExact = allCandidates.filter((file) => normalizeLookupName(file?.name) === normalizedTarget);
  if (normalizedExact.length === 1) return { file: normalizedExact[0] };
  if (normalizedExact.length > 1) {
    return {
      ambiguous: true,
      message: "multiple_files_with_normalized_name",
      options: normalizedExact.map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType })),
    };
  }
  if (exactOnly) return { error: "file_not_found" };

  const fuzzyQ = [`'${escapeDriveQ(parent)}' in parents`, "trashed=false", `name contains '${escapeDriveQ(target)}'`];
  if (mimePrefix) fuzzyQ.push(`mimeType contains '${escapeDriveQ(mimePrefix)}'`);
  const fuzzy = await gjson(
    app,
    driveUrl("/files", {
      q: fuzzyQ.join(" and "),
      fields: "files(id,name,mimeType,parents,trashed,webViewLink)",
      pageSize: 50,
    }),
    { scopes: ["https://www.googleapis.com/auth/drive"] },
  );
  const fuzzyFiles = toArray(fuzzy.files);
  if (fuzzyFiles.length === 1) return { file: fuzzyFiles[0] };
  if (fuzzyFiles.length > 1) {
    return {
      ambiguous: true,
      message: "multiple_candidates_found",
      options: fuzzyFiles.map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType })),
    };
  }

  const scored = allCandidates
    .map((file) => ({ file, score: scoreNameSimilarity(file?.name, target) }))
    .filter((item) => item.score >= 55)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 1) return { file: scored[0].file };
  if (scored.length > 1) {
    const top = scored[0];
    const close = scored.filter((item) => top.score - item.score <= 5).slice(0, 8);
    if (close.length === 1) return { file: close[0].file };
    return {
      ambiguous: true,
      message: "multiple_fuzzy_candidates_found",
      options: close.map((item) => ({
        id: item.file.id,
        name: item.file.name,
        mimeType: item.file.mimeType,
        score: item.score,
      })),
    };
  }

  return { error: "file_not_found" };
}
