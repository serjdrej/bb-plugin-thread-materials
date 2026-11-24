export function relativeFilePath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some(part => !part || part === "." || part === ".." || /[:\u0000]/u.test(part))) {
    return null;
  }
  return normalized;
}
