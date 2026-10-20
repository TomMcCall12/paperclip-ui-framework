/** Opt-in Line adoption. This script never discovers roots from titles or task content. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { lineService } from "../server/src/services/lines.js";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
function requireFlag(name: string) {
  const value = flag(name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
function digest(ids: string[]) {
  return createHash("sha256").update(ids.slice().sort().join("\n")).digest("hex");
}

type ManifestEntry = { rootIssueId: string; memberIssueIds: string[]; fingerprint: string; conflict: string | null; existingLineId: string | null };
type Manifest = { version: 1; companyId: string; generatedAt: string; roots: ManifestEntry[] };

async function main() {
  const config = loadConfig();
  const db = createDb(process.env.DATABASE_URL?.trim() || config.databaseUrl || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`);
  const companyId = requireFlag("--company");
  const outputPath = requireFlag("--output");
  const mode = process.argv.includes("--apply") ? "apply" : "dry-run";
  const rootsFile = mode === "dry-run" ? requireFlag("--roots-file") : null;
  const manifestFile = mode === "apply" ? requireFlag("--manifest") : null;
  const approvedReference = mode === "apply" ? requireFlag("--approval-reference") : null;
  const approvedSha256 = mode === "apply" ? requireFlag("--approved-sha256") : null;
  const inputRoots: string[] = rootsFile ? JSON.parse(await readFile(rootsFile, "utf8")) : [];
  if (rootsFile && (!Array.isArray(inputRoots) || inputRoots.length === 0 || inputRoots.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/iu.test(id))))
    throw new Error("Root file must be a non-empty JSON array of explicit UUIDs");
  const manifestText = manifestFile ? await readFile(manifestFile, "utf8") : null;
  if (manifestText && createHash("sha256").update(manifestText).digest("hex") !== approvedSha256)
    throw new Error("Approved manifest SHA-256 does not match the supplied file");
  const sourceManifest = manifestText ? JSON.parse(manifestText) as Manifest : null;
  if (sourceManifest && (sourceManifest.version !== 1 || sourceManifest.companyId !== companyId || !Array.isArray(sourceManifest.roots)))
    throw new Error("Manifest company or version does not match");
  const rootIds = sourceManifest ? sourceManifest.roots.map((row) => row.rootIssueId) : inputRoots;
  if (new Set(rootIds).size !== rootIds.length) throw new Error("Duplicate root IDs require review");

  const inspect = async (rootIssueId: string): Promise<ManifestEntry> => {
    const inspected = await lineService(db).inspect(companyId, rootIssueId);
    return { rootIssueId, ...inspected, fingerprint: digest(inspected.memberIssueIds) };
  };
  const roots = await Promise.all(rootIds.map(inspect));
  const owners = new Map<string, string>();
  const byRoot = new Map(roots.map((root) => [root.rootIssueId, root]));
  for (const root of roots) for (const member of root.memberIssueIds) {
    const first = owners.get(member);
    if (first && first !== root.rootIssueId) {
      root.conflict = "overlapping_roots";
      byRoot.get(first)!.conflict = "overlapping_roots";
    }
    else owners.set(member, root.rootIssueId);
  }
  if (mode === "dry-run") {
    const manifest: Manifest = { version: 1, companyId, generatedAt: new Date().toISOString(), roots };
    await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(JSON.stringify({ mode, roots: roots.length, conflicts: roots.filter((row) => row.conflict).length, outputPath }));
    return;
  }

  const report = { version: 1, companyId, approvalId: approvedReference, manifestSha256: approvedSha256, manifestFile, startedAt: new Date().toISOString(), results: [] as Array<{ rootIssueId: string; outcome: string; lineId?: string }> };
  for (const [index, root] of roots.entries()) {
    const approved = sourceManifest!.roots[index]!;
    if (approved.fingerprint !== root.fingerprint || JSON.stringify(approved.memberIssueIds) !== JSON.stringify(root.memberIssueIds)) {
      report.results.push({ rootIssueId: root.rootIssueId, outcome: "membership_changed_since_approval" });
    } else if (root.conflict || approved.conflict) {
      report.results.push({ rootIssueId: root.rootIssueId, outcome: root.conflict ?? approved.conflict! });
    } else {
      try {
        const result = await lineService(db).ensure(companyId, root.rootIssueId, { type: "system" }, {
          memberIssueIds: approved.memberIssueIds, manifestSha256: approvedSha256!, approvalId: approvedReference!,
        });
        report.results.push({ rootIssueId: root.rootIssueId, outcome: result.created ? "created" : "already_grouped", lineId: result.line.id });
      } catch (error) {
        report.results.push({ rootIssueId: root.rootIssueId, outcome: error instanceof Error ? error.message : "unknown_error" });
      }
    }
    // Each root is one transaction. Flush after every ten roots and at the end.
    if ((index + 1) % 10 === 0 || index + 1 === roots.length)
      await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify({ mode, results: report.results.length, outputPath }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
