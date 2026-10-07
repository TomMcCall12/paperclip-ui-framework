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
//   VAULT_OWNER_UID/GID     owner given to new files and folders (optional; needs CAP_CHOWN)
//
// Optional two-way sync with a cloud copy of the vault (for example the Google
// Drive folder Obsidian opens on a computer), with `rclone bisync`:
//   VAULT_SYNC_REMOTE           rclone remote path, e.g. "gdrive:My Vault"; no sync when unset
//   VAULT_SYNC_RCLONE           rclone binary (default "rclone")
//   VAULT_SYNC_CONFIG           rclone config file; rclone rewrites it when its token refreshes
//   VAULT_SYNC_STATE_DIR        writable folder for bisync listings, cache and lock
//   VAULT_SYNC_INTERVAL_SEC     seconds between syncs (default 300)
//   VAULT_SYNC_AFTER_WRITE_SEC  sync this soon after a write through the bridge (default 30)

import { spawn } from "node:child_process";
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
  const owner = Number.isInteger(options.ownerUid) && Number.isInteger(options.ownerGid)
    ? { uid: options.ownerUid, gid: options.ownerGid }
    : null;

  /** Gives new files and folders the vault owner, so people can still edit them. */
  async function adopt(absolutePath) {
    if (owner) await fs.chown(absolutePath, owner.uid, owner.gid);
  }

  /** Creates missing parent folders and adopts each one it created. */
  async function makeParents(absoluteDir) {
    const missing = [];
    for (let probe = absoluteDir; probe !== root && probe.startsWith(`${root}${path.sep}`); probe = path.dirname(probe)) {
      try {
        await fs.stat(probe);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        missing.unshift(probe);
      }
    }
    for (const dir of missing) {
      await fs.mkdir(dir);
      await assertRealPathInside(root, dir);
      await adopt(dir);
    }
  }

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
      await makeParents(path.dirname(absolute));
      await assertRealPathInside(root, path.dirname(absolute));
      if (Buffer.byteLength(content, "utf8") > maxBytes) throw new VaultBridgeError(413, "vault_file_too_large", "Content is larger than the bridge limit.");
      try {
        await fs.writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
        await adopt(absolute);
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

const SYNC_EXCLUDES = [".DS_Store", "desktop.ini", "Thumbs.db", ".~lock.*", "~$*"];
const SYNC_OUTPUT_LIMIT = 64 * 1024;
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Arguments for one `rclone bisync` run. Both sides keep their changes: when
 * the same file changed on both, the newer one wins and the other is kept
 * beside it as "name.sync-conflict1.md". rclone's own --max-delete guard stops
 * a run that would delete half the vault (for example an empty mount).
 */
export function bisyncArgs({ root, remote, config, stateDir, resync = false }) {
  const args = [
    "bisync", root, remote,
    "--workdir", path.join(stateDir, "bisync"),
    "--cache-dir", path.join(stateDir, "cache"),
    "--create-empty-src-dirs",
    "--compare", "size,modtime",
    "--resilient", "--recover",
    "--max-lock", "5m",
    "--conflict-resolve", "newer",
    "--conflict-loser", "num",
    "--conflict-suffix", "sync-conflict",
    "--suffix-keep-extension",
    "--drive-skip-gdocs",
    "--log-level", "NOTICE",
  ];
  if (config) args.push("--config", config);
  for (const pattern of SYNC_EXCLUDES) args.push("--exclude", pattern);
  // The first run, or a recovery, merges both sides; nothing is deleted.
  if (resync) args.push("--resync", "--resync-mode", "newer");
  return args;
}

function runProcess(command, args, env) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-SYNC_OUTPUT_LIMIT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), SYNC_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Gives files rclone created (owned by root here) to the vault owner, so people can still edit them. */
async function adoptRootOwned(dir, owner) {
  if (!owner) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.uid === 0) await fs.chown(absolute, owner.uid, owner.gid);
    if (stat.isDirectory()) await adoptRootOwned(absolute, owner);
  }
}

export function createVaultSync(options) {
  const root = path.resolve(options.root);
  const remote = options.remote;
  const stateDir = path.resolve(options.stateDir);
  const intervalMs = options.intervalMs ?? 300_000;
  const afterWriteMs = options.afterWriteMs ?? 30_000;
  const run = options.run ?? runProcess;
  const now = options.now ?? (() => new Date());
  const owner = Number.isInteger(options.ownerUid) && Number.isInteger(options.ownerGid)
    ? { uid: options.ownerUid, gid: options.ownerGid }
    : null;
  const state = {
    enabled: true,
    remote,
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastOk: null,
    lastError: null,
    lastConflicts: 0,
    consecutiveFailures: 0,
    nextRunAt: null,
  };
  let timer = null;
  let rerun = false;
  let stopped = false;

  async function hasListings() {
    try {
      const names = await fs.readdir(path.join(stateDir, "bisync"));
      return names.some((name) => name.endsWith(".path1.lst"));
    } catch {
      return false;
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    const at = Date.now() + Math.max(0, delayMs);
    if (timer && state.nextRunAt && Date.parse(state.nextRunAt) <= at) return;
    if (timer) clearTimeout(timer);
    state.nextRunAt = new Date(at).toISOString();
    timer = setTimeout(() => {
      timer = null;
      state.nextRunAt = null;
      void runOnce();
    }, Math.max(0, delayMs));
    timer.unref?.();
  }

  async function runOnce() {
    if (state.running) {
      rerun = true;
      return status();
    }
    state.running = true;
    state.lastStartedAt = now().toISOString();
    try {
      await fs.mkdir(path.join(stateDir, "bisync"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "cache"), { recursive: true });
      const env = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: stateDir,
        XDG_CACHE_HOME: path.join(stateDir, "cache"),
      };
      const bisync = (resync) => run(options.rclone ?? "rclone", bisyncArgs({ root, remote, config: options.config, stateDir, resync }), env);
      const firstRun = !(await hasListings());
      let result = await bisync(firstRun);
      // bisync asks for a resync after a critical failure; merging both sides loses nothing.
      if (result.code !== 0 && !firstRun && /must run --resync/i.test(result.output)) {
        result = await bisync(true);
      }
      state.lastConflicts = (result.output.match(/sync-conflict\d/g) ?? []).length;
      if (result.code === 0) {
        await adoptRootOwned(root, owner);
        state.lastOk = true;
        state.lastError = null;
        state.lastSuccessAt = now().toISOString();
        state.consecutiveFailures = 0;
      } else {
        const lines = result.output.split("\n").map((line) => line.trim()).filter((line) => /ERROR|abort|critical/i.test(line));
        state.lastOk = false;
        state.lastError = (lines.slice(-3).join(" | ") || `rclone exited with ${result.code}`).slice(0, 600);
        state.consecutiveFailures += 1;
        console.error("vault sync failed", state.lastError);
      }
    } catch (error) {
      state.lastOk = false;
      state.lastError = String(error?.message ?? error).slice(0, 600);
      state.consecutiveFailures += 1;
      console.error("vault sync error", state.lastError);
    } finally {
      state.running = false;
      state.lastFinishedAt = now().toISOString();
    }
    if (rerun) {
      rerun = false;
      schedule(0);
    } else {
      schedule(intervalMs);
    }
    return status();
  }

  function status() {
    return { ...state };
  }

  return {
    start(initialDelayMs = 10_000) {
      schedule(initialDelayMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** Asks for a sync soon, for example after a write; repeated requests share one run. */
    requestSoon(delayMs = afterWriteMs) {
      if (state.running) {
        rerun = true;
        return;
      }
      schedule(delayMs);
    },
    runOnce,
    status,
  };
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
  const sync = options.sync ?? null;
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
      if (req.url === "/write") {
        const written = await bridge.write(body);
        sync?.requestSoon();
        return send(200, written);
      }
      if (req.url === "/sync/status") return send(200, sync ? sync.status() : { enabled: false });
      if (req.url === "/sync/run") {
        if (!sync) return send(409, { error: "Sync is not set up for this vault.", code: "vault_sync_disabled" });
        sync.requestSoon(0);
        return send(202, sync.status());
      }
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
  const ownerUid = process.env.VAULT_OWNER_UID ? Number.parseInt(process.env.VAULT_OWNER_UID, 10) : undefined;
  const ownerGid = process.env.VAULT_OWNER_GID ? Number.parseInt(process.env.VAULT_OWNER_GID, 10) : undefined;
  const syncRemote = process.env.VAULT_SYNC_REMOTE?.trim();
  let sync = null;
  if (syncRemote) {
    if (!process.env.VAULT_SYNC_STATE_DIR) throw new Error("VAULT_SYNC_STATE_DIR is required when VAULT_SYNC_REMOTE is set");
    sync = createVaultSync({
      root,
      remote: syncRemote,
      rclone: process.env.VAULT_SYNC_RCLONE || "rclone",
      config: process.env.VAULT_SYNC_CONFIG || undefined,
      stateDir: process.env.VAULT_SYNC_STATE_DIR,
      intervalMs: Number.parseInt(process.env.VAULT_SYNC_INTERVAL_SEC ?? "300", 10) * 1000,
      afterWriteMs: Number.parseInt(process.env.VAULT_SYNC_AFTER_WRITE_SEC ?? "30", 10) * 1000,
      ownerUid,
      ownerGid,
    });
    sync.start();
  }
  const server = createVaultBridgeServer({
    root,
    token: process.env.VAULT_BRIDGE_TOKEN ?? "",
    changelogPath: process.env.VAULT_CHANGELOG_PATH || "vault-changelog.md",
    ownerUid,
    ownerGid,
    maxFileBytes: process.env.VAULT_MAX_FILE_BYTES ? Number.parseInt(process.env.VAULT_MAX_FILE_BYTES, 10) : undefined,
    sync,
  });
  server.listen(port, "0.0.0.0", () => console.log(`vault bridge listening on ${port}${sync ? `, syncing with ${syncRemote}` : ""}`));
}
