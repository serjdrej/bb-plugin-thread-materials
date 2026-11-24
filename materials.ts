import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { relativeFilePath } from "./paths.js";

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
  text: string;
  attachments: ConversationAttachments | null;
}

export function threadMessages(rows: HistoryRow[], threadId: string): ThreadMessage[] {
  return rows.flatMap(row => {
    if (row.threadId !== threadId) return [];
    if (row.kind === "turn") return threadMessages(row.children ?? [], threadId);
    if (row.kind !== "conversation" || row.messageSeq === undefined || row.text === undefined) return [];
    if (row.role !== "assistant" && !(row.role === "user" && row.initiator === "user")) return [];
    return [{ seq: row.messageSeq, date: row.createdAt, role: row.role, text: row.text, attachments: row.attachments ?? null }];
  });
}

const markdown = unified().use(remarkParse).use(remarkGfm);

interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

function visit(node: MarkdownNode, callback: (node: MarkdownNode) => void): void {
  callback(node);
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
  const tree = markdown.parse(message.text);
  const definitions = new Map<string, string>();
  const links = new Map<string, ThreadLink>();
  visit(tree, node => {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  visit(tree, node => {
    const candidate = node.type === "link" ? node.url
      : node.type === "linkReference" && node.identifier ? definitions.get(node.identifier) : undefined;
    const url = candidate && httpUrl(candidate);
    if (url && !links.has(url)) {
      links.set(url, { seq: message.seq, date: message.date, role: message.role, url, title: nodeText(node).trim() || url });
    }
  });
  return [...links.values()];
}

export function storageOrigins(messages: ThreadMessage[], files: Set<string>, storageRoot: string): Map<string, MessageOrigin> {
  const root = storageRoot.replaceAll("\\", "/").replace(/\/$/u, "") + "/";
  const origins = new Map<string, MessageOrigin>();
  for (const message of messages) {
    const { attachments } = message;
    const sources = [...(attachments?.localFilePaths ?? []), ...(attachments?.localImagePaths ?? [])];
    if (message.text.includes(storageRoot) || message.text.includes("BB_THREAD_STORAGE") || message.text.includes("file:")) {
      visit(markdown.parse(message.text), node => {
        if (node.type !== "link" || !node.url) return;
        try {
          const uri = node.url.startsWith("file:///") ? node.url.slice(7).replace(/^\/(?=[a-z]:)/iu, "") : node.url;
          const path = decodeURIComponent(uri).replaceAll("\\", "/");
          if (path.startsWith(root)) sources.push(path);
          else if (path.startsWith("$BB_THREAD_STORAGE/")) sources.push(path.slice("$BB_THREAD_STORAGE/".length));
        } catch {
          // Malformed encoded path.
        }
      });
    }
    for (const source of sources) {
      const path = relativeFilePath(relativeToRoot(source, root));
      if (!path || !files.has(path)) continue;
      const previous = origins.get(path);
      if (!previous || previous.seq < message.seq) origins.set(path, message);
    }
  }
  return origins;
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
  const root = storageRoot.replaceAll("\\", "/").replace(/\/$/u, "") + "/";
  for (const message of messages) {
    const { attachments } = message;
    const paths = [...(attachments?.localImagePaths ?? []),
      ...(attachments?.localFilePaths ?? []).filter(path => imageFormats.has(extension(path)))];
    for (const source of paths) {
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
