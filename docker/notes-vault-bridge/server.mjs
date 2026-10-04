#!/usr/bin/env node
// Paperclip notes vault bridge: the only process with write access to a notes vault
// (for example an Obsidian vault). It runs in its own container so agent
// processes in the Paperclip container never see the vault on their
// filesystem; the Paperclip server calls it after checking who is asking
// and enforcing the vault rules. See doc/NOTES-VAULT.md.
//
// Dependency-free on purpose. Environment:
//   VAULT_ROOT              absolute path of the vault inside this container
//   VAULT_BRIDGE_TOKEN      bearer token the Paperclip server sends
//   VAULT_CHANGELOG_PATH    vault-relative changelog file (default vault-changelog.md)
//   VAULT_BRIDGE_PORT       listen port (default 8787)
//   VAULT_MAX_FILE_BYTES    largest file read or written (default 524288)
//   VAULT_UMASK             octal umask for new files and folders (default 002, group-writable)

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 2000;

export class VaultBridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Resolves a vault-relative path to an absolute one under the root, refusing
 * absolute paths, parent segments, hidden segments (".obsidian", ".trash",
 * ".git") and NUL bytes. Symlinks are checked separately with realpath.
 */
export function resolveVaultPath(root, relativePath, { allowRoot = false } = {}) {
  if (typeof relativePath !== "string") throw new VaultBridgeError(400, "vault_path_invalid", "Path must be a string.");
  const trimmed = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") {
    if (allowRoot) return root;
    throw new VaultBridgeError(400, "vault_path_invalid", "Path is required.");
  }
  if (trimmed.includes("\0") || trimmed.startsWith("/")) {
    throw new VaultBridgeError(400, "vault_path_invalid", "Path must be relative to the vault.");
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new VaultBridgeError(400, "vault_path_invalid", "Path may not contain empty, '.' or '..' segments.");
    }
    if (segment.startsWith(".")) {
      throw new VaultBridgeError(403, "vault_path_hidden", "Hidden files and folders are not accessible.");
    }
  }
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new VaultBridgeError(400, "vault_path_invalid", "Path escapes the vault.");
  }
  return resolved;
}

/** Confirms the nearest existing ancestor of a path is still inside the root after following symlinks. */
async function assertRealPathInside(root, absolutePath) {
  const realRoot = await fs.realpath(root);
  let probe = absolutePath;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
        throw new VaultBridgeError(403, "vault_path_escape", "Path resolves outside the vault.");
      }
      return;
    } catch (error) {
      if (error instanceof VaultBridgeError) throw error;
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw new VaultBridgeError(404, "vault_not_found", "Path not found.");
      probe = parent;
    }
  }
}

async function readTextFile(absolutePath, maxBytes) {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new VaultBridgeError(404, "vault_not_found", "File not found.");
    throw error;
  }
  if (!stat.isFile()) throw new VaultBridgeError(400, "vault_not_a_file", "Path is not a file.");
  if (stat.size > maxBytes) throw new VaultBridgeError(413, "vault_file_too_large", "File is larger than the bridge limit.");
  return fs.readFile(absolutePath, "utf8");
}

function changelogCell(value) {
  return String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function formatChangelogRow({ date, path: filePath, summary, actor }) {
  return `| ${changelogCell(date)} | ${changelogCell(filePath)} | ${changelogCell(summary)} | ${changelogCell(actor)} |\n`;
}

export function createVaultBridge(options) {
  const root = path.resolve(options.root);
  const changelogPath = options.changelogPath ?? "vault-changelog.md";
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const now = options.now ?? (() => new Date());

  async function list(relativePath) {
    const absolute = resolveVaultPath(root, relativePath ?? "", { allowRoot: true });
    await assertRealPathInside(root, absolute);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") throw new VaultBridgeError(404, "vault_not_found", "Folder not found.");
      if (error?.code === "ENOTDIR") throw new VaultBridgeError(400, "vault_not_a_folder", "Path is not a folder.");
      throw error;
    }
    const visible = entries
      .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isFile()))
      .slice(0, MAX_LIST_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        path: path.relative(root, path.join(absolute, entry.name)).split(path.sep).join("/"),
        kind: entry.isDirectory() ? "folder" : "file",
      }));
    visible.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
    return { path: path.relative(root, absolute).split(path.sep).join("/"), entries: visible, truncated: entries.length > MAX_LIST_ENTRIES };
  }

  async function read(relativePath) {
    const absolute = resolveVaultPath(root, relativePath);
    await assertRealPathInside(root, absolute);
    const content = await readTextFile(absolute, maxBytes);
    return { path: relativePath, content, sha256: sha256(content), bytes: Buffer.byteLength(content, "utf8") };
  }

  async function appendChangelog(row) {
    const absolute = resolveVaultPath(root, changelogPath);
    await assertRealPathInside(root, absolute);
    let existing = "";
    try {
      existing = await fs.readFile(absolute, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await fs.appendFile(absolute, prefix + row, "utf8");
  }

  /**
   * create: the file must not exist. append: it must exist. replace: it must
   * exist and its current hash must equal baseSha256, so nothing is
   * overwritten that the caller has not read. Every write adds a changelog row.
   */
  async function write(input) {
    const { mode, content, baseSha256, summary, actor } = input;
    const relativePath = input.path;
    if (!["create", "append", "replace"].includes(mode)) {
      throw new VaultBridgeError(400, "vault_mode_invalid", "Mode must be create, append or replace.");
    }
    if (typeof content !== "string") throw new VaultBridgeError(400, "vault_content_invalid", "Content must be a string.");
    if (typeof summary !== "string" || !summary.trim()) throw new VaultBridgeError(400, "vault_summary_required", "A change summary is required.");
    if (typeof actor !== "string" || !actor.trim()) throw new VaultBridgeError(400, "vault_actor_required", "An actor is required.");
    const absolute = resolveVaultPath(root, relativePath);
    if (relativePath.replace(/\\/g, "/") === changelogPath) {
      throw new VaultBridgeError(403, "vault_changelog_reserved", "The changelog is written by the bridge only.");
    }
    await assertRealPathInside(root, absolute);

    let previousSha256 = null;
    if (mode === "create") {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await assertRealPathInside(root, path.dirname(absolute));
      if (Buffer.byteLength(content, "utf8") > maxBytes) throw new VaultBridgeError(413, "vault_file_too_large", "Content is larger than the bridge limit.");
      try {
        await fs.writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error?.code === "EEXIST") throw new VaultBridgeError(409, "vault_file_exists", "File already exists; use append or replace.");
        throw error;
      }
    } else {
      const current = await readTextFile(absolute, maxBytes);
      previousSha256 = sha256(current);
      if (mode === "replace") {
        if (typeof baseSha256 !== "string" || baseSha256 !== previousSha256) {
          throw new VaultBridgeError(409, "vault_base_mismatch", "The file changed since it was read (or baseSha256 is missing). Read it again and retry.");
        }
        if (Buffer.byteLength(content, "utf8") > maxBytes) throw new VaultBridgeError(413, "vault_file_too_large", "Content is larger than the bridge limit.");
        await fs.writeFile(absolute, content, "utf8");
      } else {
        const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
        if (Buffer.byteLength(current + separator + content, "utf8") > maxBytes) {
          throw new VaultBridgeError(413, "vault_file_too_large", "The file would exceed the bridge limit.");
        }
        await fs.appendFile(absolute, separator + content, "utf8");
      }
    }
    const written = await fs.readFile(absolute, "utf8");
    const date = now().toISOString().slice(0, 10);
    await appendChangelog(formatChangelogRow({ date, path: relativePath, summary, actor }));
    return { path: relativePath, mode, sha256: sha256(written), previousSha256, bytes: Buffer.byteLength(written, "utf8") };
  }

  return { root, list, read, write };
}

function tokenMatches(expected, header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new VaultBridgeError(413, "vault_body_too_large", "Request body too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new VaultBridgeError(400, "vault_body_invalid", "Request body must be JSON.");
  }
}

export function createVaultBridgeServer(options) {
  if (!options.token || options.token.length < 24) throw new Error("VAULT_BRIDGE_TOKEN must be at least 24 characters");
  const bridge = createVaultBridge(options);
  const bodyLimit = (options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) * 2 + 16 * 1024;
  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok" });
      if (!tokenMatches(options.token, req.headers.authorization)) return send(401, { error: "Unauthorized", code: "vault_bridge_unauthorized" });
      if (req.method !== "POST") return send(405, { error: "Method not allowed" });
      const body = await readJsonBody(req, bodyLimit);
      if (req.url === "/list") return send(200, await bridge.list(body.path ?? ""));
      if (req.url === "/read") return send(200, await bridge.read(body.path));
      if (req.url === "/write") return send(200, await bridge.write(body));
      return send(404, { error: "Not found" });
    } catch (error) {
      if (error instanceof VaultBridgeError) return send(error.status, { error: error.message, code: error.code });
      if (error?.code === "EACCES" || error?.code === "EPERM") {
        return send(403, { error: "The vault bridge is not allowed to write that file.", code: "vault_permission_denied" });
      }
      console.error("vault bridge error", error?.code ?? error?.name ?? "unknown");
      return send(500, { error: "Vault bridge error", code: "vault_bridge_error" });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.VAULT_ROOT;
  if (!root) throw new Error("VAULT_ROOT is required");
  process.umask(Number.parseInt(process.env.VAULT_UMASK ?? "002", 8));
  const port = Number.parseInt(process.env.VAULT_BRIDGE_PORT ?? "8787", 10);
  const server = createVaultBridgeServer({
    root,
    token: process.env.VAULT_BRIDGE_TOKEN ?? "",
    changelogPath: process.env.VAULT_CHANGELOG_PATH || "vault-changelog.md",
    maxFileBytes: process.env.VAULT_MAX_FILE_BYTES ? Number.parseInt(process.env.VAULT_MAX_FILE_BYTES, 10) : undefined,
  });
  server.listen(port, "0.0.0.0", () => console.log(`vault bridge listening on ${port}`));
}
