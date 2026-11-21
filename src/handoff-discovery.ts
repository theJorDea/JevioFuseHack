import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude SDK project key: realpath + NFC, then one hyphen per non-ASCII-alphanumeric.
// Never guess a bucket by prefix: CLI builds using a different long-path hash fail closed.
function projectKey(worktree: string): string {
  const canonical = worktree.normalize("NFC");
  const encoded = canonical.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) hash = (31 * hash + canonical.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Names only, never transcript contents. Bucket keys are lossy; the reader must
 * recheck containment, file type and transcript identity at the time of use. */
export async function discoverHandoffSessions(workspace: string, configDir?: string): Promise<{ id: string; path: string }[]> {
  const worktree = await realpath(workspace);
  if (!(await lstat(worktree)).isDirectory()) throw new Error("Handoff workspace must be a directory.");
  const config = path.resolve(configDir ?? (process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude")));
  const projects = path.join(config, "projects");
  const bucket = path.join(projects, projectKey(worktree));
  try {
    for (const dir of [config, projects, bucket]) {
      if (!(await lstat(dir)).isDirectory()) return []; // includes links and Windows junctions
    }
    // realpath also detects a redirect higher up the configured path. On Windows
    // relative() ignores spelling-only drive/case differences.
    if (path.relative(bucket, await realpath(bucket)) !== "") return [];
    const entries = await readdir(bucket, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.length === 42 &&
      entry.name.endsWith(".jsonl") && uuid.test(entry.name.slice(0, -6)))
      .map(entry => ({ id: entry.name.slice(0, -6), path: path.join(bucket, entry.name) }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}
