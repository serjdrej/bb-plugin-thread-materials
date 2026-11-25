import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { isServicePath, relativeFilePath } from "./paths.js";

export const imageFormats = new Set(["apng", "avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
export const extension = (name: string) => name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
export const storageImageUrl = (threadId: string, path: string) =>
  "/api/v1/threads/" + encodeURIComponent(threadId) + "/thread-storage/files/" + path.split("/").map(encodeURIComponent).join("/");

export interface MessageOrigin {
  seq: number;
  date: number;
  role: "user" | "assistant";
}

export interface ThreadLink extends MessageOrigin {
  url: string;
  title: string;
}

interface ConversationAttachments {
  localImagePaths: string[];
  localFilePaths: string[];
}

interface HistoryRow {
  kind: string;
  threadId: string;
  role?: "user" | "assistant";
  initiator?: string;
  messageSeq?: number;
  text?: string;
  createdAt: number;
  attachments?: ConversationAttachments | null;
  children?: HistoryRow[] | null;
}

export interface ThreadMessage extends MessageOrigin {
  content: MarkdownNode;
  attachments: ConversationAttachments | null;
}

export function threadMessages(rows: HistoryRow[], threadId: string): ThreadMessage[] {
  return rows.flatMap(row => {
    if (row.threadId !== threadId) return [];
    if (row.kind === "turn") return threadMessages(row.children ?? [], threadId);
    if (row.kind !== "conversation" || row.messageSeq === undefined || row.text === undefined) return [];
    if (row.role !== "assistant" && !(row.role === "user" && row.initiator === "user")) return [];
    return [{ seq: row.messageSeq, date: row.createdAt, role: row.role, content: markdown.parse(row.text), attachments: row.attachments ?? null }];
  });
}

const markdown = unified().use(remarkParse).use(remarkGfm);

interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  identifier?: string;
  lang?: string | null;
  children?: MarkdownNode[];
}

function visit(node: MarkdownNode, callback: (node: MarkdownNode) => boolean | void): void {
  if (callback(node) === false) return;
  for (const child of node.children ?? []) visit(child, callback);
}

function nodeText(node: MarkdownNode): string {
  return node.value ?? (node.children ?? []).map(nodeText).join("");
}

function httpUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function messageLinks(message: ThreadMessage): ThreadLink[] {
  const definitions = linkDefinitions(message.content);
  const links = new Map<string, ThreadLink>();
  visit(message.content, node => {
    const candidate = node.type === "link" ? node.url
      : node.type === "linkReference" && node.identifier ? definitions.get(node.identifier) : undefined;
    const url = candidate && httpUrl(candidate);
    if (url && !links.has(url)) {
      links.set(url, { seq: message.seq, date: message.date, role: message.role, url, title: nodeText(node).trim() || url });
    }
  });
  return [...links.values()];
}

function linkDefinitions(tree: MarkdownNode): Map<string, string> {
  const definitions = new Map<string, string>();
  visit(tree, node => {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  return definitions;
}

const shellLanguages = new Set([
  "bash", "sh", "shell", "zsh", "fish", "shellscript", "terminal",
  "powershell", "pwsh", "ps1", "cmd", "bat", "batch",
]);
const transcriptLanguages = new Set(["console", "shell-session"]);
const shellPrompt = /^[ \t]*(?:[$%][ \t]+|PS(?: [^>]+)?>[ \t]*|[a-z]:[\\/][^>]*>[ \t]*)/iu;

export interface ThreadCommand extends MessageOrigin {
  code: string;
  language: string;
  index: number;
}

export function messageCommands(message: ThreadMessage): ThreadCommand[] {
  if (message.role !== "assistant") return [];
  const commands: ThreadCommand[] = [];
  visit(message.content, node => {
    if (node.type === "blockquote") return false;
    if (node.type !== "code" || !node.lang || !node.value) return;
    const language = node.lang.toLowerCase();
    const transcript = transcriptLanguages.has(language);
    if (!transcript && !shellLanguages.has(language)) return;
    const lines = node.value.split("\n");
    const firstLine = lines.find(line => line.trim()) ?? "";
    const code = transcript || shellPrompt.test(firstLine)
      ? lines.filter(line => shellPrompt.test(line)).map(line => line.replace(shellPrompt, "")).join("\n")
      : node.value;
    if (code.trim()) commands.push({ seq: message.seq, date: message.date, role: message.role, code, language, index: commands.length });
  });
  return commands;
}

export function storageOrigins(
  messages: ThreadMessage[], files: Set<string>, storageRoot: string, threadId: string,
): Map<string, MessageOrigin> {
  const origins = new Map<string, MessageOrigin>();
  if (!files.size) return origins;
  const root = storagePrefix(storageRoot);
  const caseInsensitive = /^[a-z]:\/|^\/\//iu.test(root);
  const key = (path: string) => caseInsensitive ? path.toLowerCase() : path;
  const knownPaths = new Map<string, string>();
  const byName = new Map<string, string | null>();
  for (const path of files) {
    knownPaths.set(key(path), path);
    const name = key(path.split("/").at(-1)!);
    byName.set(name, byName.has(name) ? null : path);
  }
  const fileRoute = storageImageUrl(threadId, "");
  const storageVariable = /^(?:\$(?:env:)?BB_THREAD_STORAGE|\$\{(?:env:)?BB_THREAD_STORAGE\}|%BB_THREAD_STORAGE%)\//iu;

  function resolveMention(source: string, kind: "attachment" | "link" | "code" | "text"): string | undefined {
    let candidate = source;
    if (kind === "link") {
      try {
        candidate = decodeURIComponent(candidate).replace(/^file:\/\/(?=\/)/iu, "")
          .replace(/^\/(?=[a-z]:[\\/])/iu, "");
      } catch {
        return undefined;
      }
    }
    candidate = candidate.replaceAll("\\", "/");
    const rootRelative = candidate.startsWith(fileRoute) ? candidate.slice(fileRoute.length)
      : root && key(candidate).startsWith(key(root)) ? candidate.slice(root.length) : undefined;
    const explicitPath = rootRelative ?? (storageVariable.test(candidate) ? candidate.replace(storageVariable, "") : undefined);
    const relative = explicitPath ?? candidate.replace(/^\.\//u, "");
    const found = lookup(relative);
    if (found) return found;
    if (kind === "attachment") return undefined;
    return lookup(relative.replace(/(?:#L\d+(?:C\d+)?(?:(?:-L?)\d+)?|:\d+(?::\d+)?)$/u, "")) ??
      (kind === "text" ? lookup(relative.replace(/[.!?:]+$/u, "")) : undefined);

    function lookup(value: string): string | undefined {
      const path = relativeFilePath(value);
      if (!path) return undefined;
      if (explicitPath !== undefined || candidate.startsWith("./") || path.includes("/") || kind === "attachment") {
        return knownPaths.get(key(path));
      }
      if (kind === "text" && !extension(path)) return undefined;
      return byName.get(key(path)) ?? undefined;
    }
  }

  for (const message of messages) {
    const { attachments } = message;
    const { seq, date, role } = message;
    const record = (path: string | undefined) => {
      if (path && (origins.get(path)?.seq ?? -1) < seq) origins.set(path, { seq, date, role });
    };
    for (const source of [...(attachments?.localFilePaths ?? []), ...(attachments?.localImagePaths ?? [])]) {
      record(resolveMention(source, "attachment"));
    }
    const definitions = linkDefinitions(message.content);
    visit(message.content, node => {
      if (node.type === "blockquote") return false;
      if (["link", "image", "linkReference", "imageReference"].includes(node.type)) {
        const url = node.url ?? definitions.get(node.identifier ?? "");
        if (url) record(resolveMention(url, "link"));
        return false;
      }
      if (node.type === "inlineCode" && node.value) {
        record(resolveMention(node.value, "code"));
      }
      if (node.type === "text" && node.value) {
        for (const match of node.value.matchAll(/"([^"\n]+)"|«([^»\n]+)»|[^\s()[\]{}<>"«»`|,;]+/gu)) {
          record(resolveMention(match[1] ?? match[2] ?? match[0], match[1] || match[2] ? "code" : "text"));
        }
      }
    });
  }
  return origins;
}

function storagePrefix(root: string): string {
  return root ? root.replaceAll("\\", "/").replace(/\/$/u, "") + "/" : "";
}

function relativeToRoot(path: string, root: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}

export interface AttachmentImage extends MessageOrigin {
  name: string;
  url: string;
}

export function attachmentImages(
  messages: ThreadMessage[], projectId: string | null, threadId: string, storagePaths: Set<string>, storageRoot: string,
): AttachmentImage[] {
  const images = new Map<string, AttachmentImage>();
  const projectPrefix = projectId && "/api/v1/projects/" + encodeURIComponent(projectId) + "/attachments/content?path=";
  const hostPrefix = "/api/v1/threads/" + encodeURIComponent(threadId) + "/host-files/";
  const root = storagePrefix(storageRoot);
  for (const message of messages) {
    const { attachments } = message;
    const paths = [...(attachments?.localImagePaths ?? []),
      ...(attachments?.localFilePaths ?? []).filter(path => imageFormats.has(extension(path)))];
    for (const source of paths) {
      if (isServicePath(source)) continue;
      const normalized = source.replaceAll("\\", "/");
      const storagePath = relativeFilePath(relativeToRoot(source, root));
      if (storagePath && storagePaths.has(storagePath)) continue;
      const path = relativeFilePath(normalized);
      const hostPath = normalized.replace(/^\/+/u, "");
      const isAbsolute = /^[a-z]:\/|^\/(?!\/)/iu.test(normalized) &&
        !hostPath.split("/").some(part => !part || part === "." || part === ".." || part.includes("\u0000"));
      const url = path && projectPrefix ? projectPrefix + encodeURIComponent(path)
        : isAbsolute ? hostPrefix + hostPath.split("/").map(encodeURIComponent).join("/") : null;
      if (!url) continue;
      const old = images.get(url);
      if (!old || message.seq > old.seq) {
        const { seq, date, role } = message;
        images.set(url, { seq, date, role, url, name: normalized.split("/").at(-1)! });
      }
    }
  }
  return [...images.values()];
}
