import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RepositoryFileDocument, RepositoryFileEntry } from "@phaseatlas/contracts";

const HIDDEN_DIRECTORIES = new Set([
  ".git",
  ".svelte-kit",
  ".turbo",
  ".next",
  "coverage",
  "dist",
  "build",
  "node_modules",
]);
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;

function resolveInside(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("File path must be repository-relative.");
  const absolutePath = path.resolve(root, relativePath || ".");
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("File path is outside the repository boundary.");
  }
  const firstSegment = relative.split(path.sep)[0];
  if (firstSegment === ".git") throw new Error("The Git metadata directory is not available in the editor.");
  return absolutePath;
}

export async function listRepositoryFiles(root: string, directory = ""): Promise<RepositoryFileEntry[]> {
  const absoluteDirectory = resolveInside(root, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  return Promise.all(entries
    .filter((entry) => !entry.name.startsWith(".") || entry.name === ".phaseatlas")
    .filter((entry) => !entry.isDirectory() || !HIDDEN_DIRECTORIES.has(entry.name))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map(async (entry): Promise<RepositoryFileEntry> => {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, "/");
      const metadata = entry.isFile() ? await stat(absolutePath) : null;
      return {
        name: entry.name,
        path: relativePath,
        type: entry.isDirectory() ? "directory" : "file",
        ...(metadata ? { size: metadata.size } : {}),
      };
    }));
}

export async function readRepositoryFile(root: string, filePath: string): Promise<RepositoryFileDocument> {
  const absolutePath = resolveInside(root, filePath);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new Error(`${filePath} is not a file.`);
  if (metadata.size > MAX_TEXT_FILE_BYTES) throw new Error("Files larger than 5 MB cannot be opened in the editor.");
  const content = await readFile(absolutePath, "utf8");
  if (content.includes("\0")) throw new Error("Binary files cannot be opened in the text editor.");
  return { path: filePath.replaceAll(path.sep, "/"), content };
}

export async function saveRepositoryFile(root: string, filePath: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
    throw new Error("Files larger than 5 MB cannot be saved in the editor.");
  }
  const absolutePath = resolveInside(root, filePath);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new Error(`${filePath} is not a file.`);
  await writeFile(absolutePath, content, "utf8");
}
