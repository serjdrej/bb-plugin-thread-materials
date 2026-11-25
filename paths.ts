export const excludedMaterialNames = [
  "node_modules", ".pnpm-store", ".claude/worktrees", ".venv", "venv", ".turbo", ".next", ".cache", "__pycache__", ".DS_Store",
  "materials-npm-cache", "npm-cache", ".npm", "_cacache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
];

const excludedNames = new Set(excludedMaterialNames.map(name => name.toLowerCase()));

export function isServicePath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").toLowerCase().split("/");
  return parts.some((part, index) => excludedNames.has(part) || excludedNames.has(part + "/" + parts[index + 1]));
}

export function relativeFilePath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some(part => !part || part === "." || part === ".." || /[:\u0000]/u.test(part))) {
    return null;
  }
  return normalized;
}
