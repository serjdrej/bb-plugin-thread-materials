import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_ImageLightbox as ImageLightbox,
  experimental_useTabVisible,
  UrlLink,
  useBbNavigate,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import {
  attachmentImages, extension, imageFormats, messageCommands, messageLinks, storageImageUrl,
  storageOrigins, threadMessages, type AttachmentImage, type MessageOrigin, type ThreadCommand, type ThreadMessage,
} from "./materials.js";
import type { materialsRpc } from "./rpc.js";
import "./app.css";

declare const __BB_PLUGIN_ID__: string | undefined;

const tabs = [
  { id: "files", label: "Files", empty: "No files in thread storage yet" },
  { id: "images", label: "Images", empty: "No images yet" },
  { id: "links", label: "Links", empty: "No links in the loaded messages" },
  { id: "commands", label: "Commands", empty: "No commands in the loaded agent replies" },
] as const;
type View = typeof tabs[number]["id"];
type Sort = "name" | "newest" | "oldest" | "largest";
interface FileEntry {
  name: string;
  path: string;
}
interface Storage {
  files: FileEntry[];
  root: string;
  truncated: boolean;
}
interface FileMetadata {
  size: number;
  modified: number;
}
interface Cursor {
  anchorId: string;
  anchorSeq: number;
}
type Sdk = ReturnType<typeof useSdk>;
const names = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const dateLabel = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function readHistory(sdk: Sdk, threadId: string, signal: AbortSignal, cursor: Cursor | null = null) {
  const page = await sdk.threads.timeline({
    threadId, signal, segmentLimit: "20", includeNestedRows: "true", deferContent: "false",
    ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}),
  });
  return { messages: threadMessages(page.rows, threadId), cursor: page.timelinePage.olderCursor };
}
type History = Awaited<ReturnType<typeof readHistory>>;

function sizeLabel(bytes: number): string {
  const index = Math.min(Math.max(Math.floor(Math.log(bytes || 1) / Math.log(1024)), 0), 3);
  return new Intl.NumberFormat("en", { maximumFractionDigits: index === 0 ? 0 : 1 })
    .format(bytes / 1024 ** index) + " " + ["B", "KB", "MB", "GB"][index];
}

function messageHref(threadId: string, projectId: string | null, seq: number): string {
  const prefix = projectId ? "/projects/" + encodeURIComponent(projectId) : "";
  return prefix + "/threads/" + encodeURIComponent(threadId) + "#msg=" + seq;
}

function OriginLink({ threadId, projectId, origin }: { threadId: string; projectId: string | null; origin: MessageOrigin }) {
  return <UrlLink className="tm-origin" href={messageHref(threadId, projectId, origin.seq)} title={dateLabel.format(origin.date)}>
    Go to message
  </UrlLink>;
}

function FileMenu({ children, preview, goToMessage, searching }: {
  children: ReactElement;
  preview: () => void;
  goToMessage: () => void;
  searching: boolean;
}) {
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="tm-file-menu" collisionPadding={8}
        data-bb-portaled-overlay="" data-bb-plugin-root=""
        data-bb-plugin={typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined}>
        <ContextMenu.Item onSelect={preview}>Open preview</ContextMenu.Item>
        <ContextMenu.Item onSelect={goToMessage} disabled={searching}>Go to message</ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

function CommandCard({ command, threadId, projectId }: { command: ThreadCommand; threadId: string; projectId: string | null }) {
  const [feedback, setFeedback] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command.code);
      setFeedback("Copied");
    } catch {
      setFeedback("Couldn't copy");
    }
  }

  return <article className="tm-command">
    <div className="tm-byline">
      <span className="tm-subtle">{command.language} · {dateLabel.format(command.date)}</span>
      <OriginLink threadId={threadId} projectId={projectId} origin={command} />
      <button type="button" className="tm-action tm-copy" onClick={() => void copy()}>Copy</button>
    </div>
    <pre tabIndex={0}><code>{command.code}</code></pre>
    <span className="tm-subtle" role="status">{feedback}</span>
  </article>;
}

function Thumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="tm-thumbnail">
    {failed ? <Icon name="Image" /> : <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
  </div>;
}

function Materials({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const rpc = useRpc<typeof materialsRpc>();
  const navigate = useBbNavigate();
  const visible = experimental_useTabVisible();
  const id = useId();
  const [view, setView] = useState<View>("files");
  const [queries, setQueries] = useState<Record<View, string>>({ files: "", images: "", links: "", commands: "" });
  const [sorts, setSorts] = useState<Record<View, Sort>>({ files: "name", images: "newest", links: "newest", commands: "newest" });
  const [groupByFormat, setGroupByFormat] = useState(true);
  const [format, setFormat] = useState("");
  const [revision, setRevision] = useState(0);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [metadata, setMetadata] = useState<Map<string, FileMetadata>>(new Map());
  const [history, setHistory] = useState<History | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [fileError, setFileError] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [lightbox, setLightbox] = useState<AttachmentImage | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [findingOrigin, setFindingOrigin] = useState(false);
  const [originStatus, setOriginStatus] = useState("");
  const [messageTarget, setMessageTarget] = useState<number | null>(null);
  const messageNavigation = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (messageTarget === null) return;
    // Route the asynchronously resolved message through BB's link component.
    messageNavigation.current?.querySelector("a")?.click();
    setMessageTarget(null);
  }, [messageTarget]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoadingFiles(true);
    setLoadingHistory(true);
    setLoadingOlder(false);
    setFindingOrigin(false);
    setOriginStatus("");
    setFileError(false);
    setHistoryError(false);
    setOlderError(false);

    void sdk.threads.get({ threadId, signal }).then(result => {
      if (!signal.aborted) setProjectId(result.projectId);
    }).catch(() => {});

    void (async () => {
      try {
        const list = await rpc.call("listFiles", { threadId });
        if (signal.aborted) return;
        const { files } = list;
        setStorage(list);
        setMetadata(new Map());
        setLoadingFiles(false);
        if (files.length) {
          const stats = await rpc.call("fileMetadata", { threadId, paths: files.map(file => file.path) }).catch(() => []);
          if (!signal.aborted) setMetadata(new Map(stats.map(item => [item.path, item])));
        }
      } catch {
        if (!signal.aborted) setFileError(true);
      } finally {
        if (!signal.aborted) setLoadingFiles(false);
      }
    })();

    void readHistory(sdk, threadId, signal).then(page => {
      if (!signal.aborted) setHistory(page);
    }).catch(() => {
      if (!signal.aborted) setHistoryError(true);
    }).finally(() => {
      if (!signal.aborted) setLoadingHistory(false);
    });

    return () => {
      controller.abort();
      olderRequest.current?.abort();
      olderRequest.current = null;
    };
  }, [sdk, rpc, threadId, visible, revision]);

  async function loadOlder(search?: FileEntry) {
    if (!history?.cursor || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingOlder(true);
    setOlderError(false);
    let next = history;
    if (search) {
      setFindingOrigin(true);
      setOriginStatus("Finding the message for " + search.name + "…");
    }
    try {
      while (next.cursor) {
        const current = next.cursor;
        const page = await readHistory(sdk, threadId, controller.signal, current);
        if (controller.signal.aborted) return;
        const merged = new Map<number, ThreadMessage>();
        for (const message of [...page.messages, ...next.messages]) merged.set(message.seq, message);
        const cursor = page.cursor?.anchorId === current.anchorId && page.cursor?.anchorSeq === current.anchorSeq
          ? null : page.cursor;
        next = { messages: [...merged.values()], cursor };
        setHistory(next);
        if (!search) return;
        const origin = storageOrigins(page.messages, stored.paths, storage?.root ?? "", threadId).get(search.path);
        if (origin) {
          setOriginStatus("");
          setMessageTarget(origin.seq);
          return;
        }
      }
      if (search) setOriginStatus("No message found for " + search.name + ".");
    } catch {
      if (!controller.signal.aborted) {
        if (search) setOriginStatus("Couldn't search earlier messages. Try again.");
        else setOlderError(true);
      }
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = null;
        setLoadingOlder(false);
        setFindingOrigin(false);
      }
    }
  }

  function goToFileMessage(file: FileEntry, origin?: MessageOrigin) {
    setOriginStatus("");
    if (origin) {
      setMessageTarget(origin.seq);
    } else if (history?.cursor) {
      void loadOlder(file);
    } else {
      setOriginStatus(historyError ? "Couldn't load messages. Refresh and try again." : "No message found for " + file.name + ".");
    }
  }

  function cancelHistoryRead() {
    olderRequest.current?.abort();
    olderRequest.current = null;
    setLoadingOlder(false);
    setFindingOrigin(false);
    setOriginStatus("");
  }

  function selectView(next: View) {
    if (next === view) return;
    if (findingOrigin) cancelHistoryRead();
    setOriginStatus("");
    setView(next);
  }

  const stored = useMemo(() => {
    const files = storage?.files ?? [];
    const paths = new Set(files.map(file => file.path));
    const origins = storageOrigins(history?.messages ?? [], paths, storage?.root ?? "", threadId);
    const attachments = attachmentImages(history?.messages ?? [], projectId, threadId, paths, storage?.root ?? "");
    return { files, paths, origins, attachments, formats: [...new Set(files.map(file => extension(file.name)))].sort(names.compare) };
  }, [storage, history, projectId, threadId]);
  const links = useMemo(() => history?.messages.flatMap(messageLinks) ?? [], [history]);
  const commands = useMemo(() => history?.messages.flatMap(messageCommands) ?? [], [history]);
  const images = useMemo(() => [
    ...stored.files.filter(file => imageFormats.has(extension(file.name))).map(file => ({
      ...file, src: storageImageUrl(threadId, file.path), origin: stored.origins.get(file.path),
      info: metadata.get(file.path), attachment: undefined,
    })),
    ...stored.attachments.map(attachment => ({
      name: attachment.name, path: attachment.url, src: attachment.url, origin: attachment,
      info: undefined, attachment,
    })),
  ], [stored, metadata, threadId]);

  function handleTabs(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex(tab => tab.id === view);
    const target = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (target === -1) return;
    event.preventDefault();
    selectView(tabs[target].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[target]?.focus();
  }

  const sort = sorts[view];
  const query = queries[view].trim().toLocaleLowerCase("en");
  const matches = (...values: string[]) => values.some(value => value.toLocaleLowerCase("en").includes(query));
  const openFile = (path: string) => navigate.experimental_openFilePreview({ target: { kind: "thread-storage", threadId, path }, location: null });
  const filteredFiles = stored.files.filter(file => matches(file.path, file.name) && (!format || extension(file.name) === (format === "-" ? "" : format)));
  const filteredImages = images.filter(image => matches(image.name));
  const filteredLinks = links.filter(link => matches(link.title, link.url));
  const filteredCommands = commands.filter(command => matches(command.code, command.language));
  const activeCount = { files: filteredFiles.length, images: filteredImages.length, links: filteredLinks.length, commands: filteredCommands.length }[view];
  const counts = { files: stored.files.length, images: images.length, links: links.length, commands: commands.length };
  const fromHistory = view === "links" || view === "commands";
  const noData = fromHistory ? !history : !storage;
  const error = fromHistory ? historyError : fileError;
  const loading = fromHistory ? loadingHistory : loadingFiles;
  const storageTruncated = !fromHistory && storage?.truncated;

  filteredFiles.sort((a, b) => {
    if (groupByFormat) {
      const groupOrder = names.compare(extension(a.name), extension(b.name));
      if (groupOrder) return groupOrder;
    }
    const aInfo = metadata.get(a.path);
    const bInfo = metadata.get(b.path);
    const order = sort === "newest" ? (bInfo?.modified ?? -Infinity) - (aInfo?.modified ?? -Infinity)
      : sort === "oldest" ? (aInfo?.modified ?? Infinity) - (bInfo?.modified ?? Infinity)
      : sort === "largest" ? (bInfo?.size ?? -1) - (aInfo?.size ?? -1) : 0;
    return order || names.compare(a.name, b.name) || names.compare(a.path, b.path);
  });
  filteredImages.sort((a, b) => {
    const order = sort === "largest" ? (b.info?.size ?? -1) - (a.info?.size ?? -1)
      : sort === "newest" ? (b.info?.modified ?? b.origin?.date ?? -1) - (a.info?.modified ?? a.origin?.date ?? -1) : 0;
    return order || names.compare(a.name, b.name);
  });
  filteredLinks.sort((a, b) => sort === "name" ? names.compare(a.title, b.title) : b.seq - a.seq);
  filteredCommands.sort((a, b) => (sort === "oldest" ? a.seq - b.seq : b.seq - a.seq) || a.index - b.index);
  const refresh = () => {
    cancelHistoryRead();
    setRevision(value => value + 1);
  };

  return <div className="tm">
    <div className="tm-controls">
      <div className="tm-tabs" role="tablist" aria-label="Thread materials" onKeyDown={handleTabs}>
        {tabs.map(tab => <button key={tab.id} type="button" role="tab" id={id + tab.id}
          aria-selected={view === tab.id} aria-controls={id + "panel"} tabIndex={view === tab.id ? 0 : -1}
          onClick={() => selectView(tab.id)}>
          {tab.label} <span className="tm-count">{counts[tab.id]}</span>
        </button>)}
      </div>
      <label className="tm-search">
        <Icon name="Search" />
        <input type="search" aria-label="Search materials" value={queries[view]}
          placeholder={view === "links" ? "Search by title or URL" : view === "commands" ? "Search commands" : "Search by name"}
          onChange={event => setQueries({ ...queries, [view]: event.target.value })}
          onKeyDown={event => {
            if (event.key === "Escape" && queries[view]) {
              event.stopPropagation();
              event.preventDefault();
              setQueries({ ...queries, [view]: "" });
            }
          }} />
      </label>
      <div className="tm-options">
        {view === "files" && <select aria-label="File format" value={format} onChange={event => setFormat(event.target.value)}>
          <option value="">All formats</option>
          {stored.formats.map(item => <option value={item || "-"} key={item}>{item.toUpperCase() || "No extension"}</option>)}
        </select>}
        <select aria-label="Sort" value={sort} onChange={event => setSorts({ ...sorts, [view]: event.target.value as Sort })}>
          {view !== "commands" && <option value="name">By name</option>}
          <option value="newest" disabled={view === "files" && !metadata.size}>Newest first</option>
          {(view === "files" || view === "commands") && <option value="oldest" disabled={view === "files" && !metadata.size}>Oldest first</option>}
          {!fromHistory && <option value="largest" disabled={!metadata.size}>Largest first</option>}
        </select>
        {view === "files" && <label className="tm-group-toggle">
          <input type="checkbox" checked={groupByFormat} onChange={event => setGroupByFormat(event.target.checked)} />
          Group by type
        </label>}
        <button className="tm-refresh" type="button" title="Refresh" aria-label="Refresh"
          disabled={loadingFiles || loadingHistory} onClick={refresh}><Icon name="RefreshCw" /></button>
      </div>
    </div>
    <div className="tm-content" id={id + "panel"} role="tabpanel" aria-labelledby={id + view} tabIndex={0}>
      {noData && loading ? <div className="tm-skeleton" role="status" aria-label="Loading">
        {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
      </div> : error && noData && !activeCount ? <div className="tm-empty" role="alert">
        <p>Couldn't load materials</p><button className="tm-action" type="button" onClick={refresh}>Retry</button>
      </div> : activeCount === 0 ? <div className="tm-empty">
        <Icon name={view === "files" ? "FolderOpen" : view === "images" ? "Image" : view === "links" ? "Link2" : "Terminal"} />
        <p>{query || (view === "files" && format) ? "No matches" : tabs.find(tab => tab.id === view)?.empty}</p>
        {(query || (view === "files" && format)) && <button className="tm-action" type="button" onClick={() => {
          setQueries({ ...queries, [view]: "" });
          if (view === "files") setFormat("");
        }}>Clear filters</button>}
      </div> : null}

      {view === "files" && filteredFiles.map((file, index) => {
        const kind = extension(file.name);
        const info = metadata.get(file.path);
        const origin = stored.origins.get(file.path);
        const preview = () => openFile(file.path);
        return <section key={file.path}>
          {groupByFormat && (index === 0 || extension(filteredFiles[index - 1].name) !== kind) &&
            <h3 className="tm-group">{kind.toUpperCase() || "No extension"}</h3>}
          <FileMenu preview={preview} goToMessage={() => goToFileMessage(file, origin)}
            searching={findingOrigin || (!origin && (loadingOlder || loadingHistory))}>
            <button className="tm-file" type="button" onClick={preview} title={file.path}>
              <Icon name={imageFormats.has(kind) ? "Image" : "FileText"} />
              <span className="tm-file-name"><span className="tm-truncate">{file.name}</span>
                {file.name !== file.path && <span className="tm-subtle tm-truncate">{file.path.slice(0, file.path.lastIndexOf("/"))}</span>}
              </span>
              {info && <span className="tm-subtle tm-details">{sizeLabel(info.size)}<br />{dateLabel.format(info.modified)}</span>}
            </button>
          </FileMenu>
        </section>;
      })}

      {view === "images" && <div className="tm-gallery">{filteredImages.map(image => {
        const preview = () => image.attachment ? setLightbox(image.attachment) : openFile(image.path);
        return <article className="tm-card" key={image.path}>
          <FileMenu preview={preview} goToMessage={() => goToFileMessage(image, image.origin)}
            searching={findingOrigin || (!image.origin && (loadingOlder || loadingHistory))}>
            <button type="button" title={image.name} onClick={preview}>
              <Thumbnail key={image.src} src={image.src} />
              <span className="tm-truncate tm-image-name">{image.name}</span>
            </button>
          </FileMenu>
        </article>;
      })}</div>}

      {view === "links" && filteredLinks.map(link => <article className="tm-link" key={link.seq + ":" + link.url}>
        <Icon name="Link2" />
        <div>
          <UrlLink className="tm-url tm-truncate" href={link.url} title={link.title}>{link.title}</UrlLink>
          <span className="tm-subtle tm-truncate" title={link.url}>{link.url}</span>
          <div className="tm-byline">
            <span className="tm-subtle">{link.role === "user" ? "You" : "Agent"} · {dateLabel.format(link.date)}</span>
            <OriginLink threadId={threadId} projectId={projectId} origin={link} />
          </div>
        </div>
      </article>)}

      {view === "commands" && filteredCommands.map(command =>
        <CommandCard key={command.seq + ":" + command.index} command={command} threadId={threadId} projectId={projectId} />)}
    </div>

    {(originStatus || history?.cursor || storageTruncated || (!noData && (error || historyError))) &&
      <div className="tm-footer">
        {originStatus && <span role="status">{originStatus}</span>}
        {findingOrigin && <button type="button" className="tm-action" onClick={cancelHistoryRead}>Cancel</button>}
        {storageTruncated && <span>Showing the first {stored.files.length} files</span>}
        {error && !noData && <span>Couldn't refresh the list</span>}
        {!fromHistory && historyError && <span>Couldn't load messages</span>}
        {!findingOrigin && history?.cursor && <>
          <span>{olderError ? "Couldn't load earlier messages" : "Messages loaded: " + history.messages.length}</span>
          <button type="button" className="tm-action" disabled={loadingOlder || loadingHistory} onClick={() => void loadOlder()}>
            {loadingOlder ? "Loading…" : "Load earlier messages"}
          </button>
        </>}
      </div>}
    <span ref={messageNavigation} hidden>
      {messageTarget !== null && <UrlLink href={messageHref(threadId, projectId, messageTarget)} />}
    </span>
    {lightbox && <ImageLightbox imageAlt={lightbox.name} imageSrc={lightbox.url} title={lightbox.name} isOpen onClose={() => setLightbox(null)} />}
  </div>;
}

export default definePluginApp(app => {
  app.slots.experimental_tab({
    id: "materials",
    title: "Materials",
    tooltip: "Thread materials",
    icon: "FolderOpen",
    layout: "flush",
    context: { kind: "thread" },
    availability: "action",
    component: ({ threadId }) => <Materials key={threadId} threadId={threadId} />,
  });
});
