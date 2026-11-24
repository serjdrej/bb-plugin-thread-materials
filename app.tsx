import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
  attachmentImages, extension, imageFormats, messageLinks, storageImageUrl,
  storageOrigins, threadMessages, type AttachmentImage, type MessageOrigin, type ThreadMessage,
} from "./materials.js";
import { relativeFilePath } from "./paths.js";
import type { materialsRpc } from "./rpc.js";
import "./app.css";

const tabs = [
  { id: "files", label: "Файлы", empty: "В хранилище треда пока нет файлов" },
  { id: "images", label: "Изображения", empty: "Пока нет изображений" },
  { id: "links", label: "Ссылки", empty: "В загруженных сообщениях пока нет ссылок" },
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
const names = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const dateLabel = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

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
  return new Intl.NumberFormat("ru", { maximumFractionDigits: index === 0 ? 0 : 1 })
    .format(bytes / 1024 ** index) + " " + ["Б", "КБ", "МБ", "ГБ"][index];
}

function OriginLink({ threadId, projectId, origin }: { threadId: string; projectId: string | null; origin: MessageOrigin }) {
  const prefix = projectId ? "/projects/" + encodeURIComponent(projectId) : "";
  const href = prefix + "/threads/" + encodeURIComponent(threadId) + "#msg=" + origin.seq;
  return <UrlLink className="tm-origin" href={href} title={dateLabel.format(origin.date)}>К сообщению</UrlLink>;
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
  const [queries, setQueries] = useState<Record<View, string>>({ files: "", images: "", links: "" });
  const [sorts, setSorts] = useState<Record<View, Sort>>({ files: "name", images: "newest", links: "newest" });
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

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoadingFiles(true);
    setLoadingHistory(true);
    setLoadingOlder(false);
    setFileError(false);
    setHistoryError(false);
    setOlderError(false);

    void sdk.threads.get({ threadId, signal }).then(result => {
      if (!signal.aborted) setProjectId(result.projectId);
    }).catch(() => {});

    void (async () => {
      try {
        const list = await sdk.threads.storageFiles({ threadId, signal, limit: "1000" });
        if (signal.aborted) return;
        const files = list.files.flatMap(file => {
          const path = relativeFilePath(file.path);
          return path ? [{ path, name: file.name }] : [];
        });
        setStorage({ files, root: list.storageRootPath, truncated: list.truncated });
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

  async function loadOlder() {
    if (!history?.cursor || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await readHistory(sdk, threadId, controller.signal, history.cursor);
      if (controller.signal.aborted) return;
      const merged = new Map<number, ThreadMessage>();
      for (const message of [...page.messages, ...history.messages]) merged.set(message.seq, message);
      const cursor = page.cursor?.anchorId === history.cursor.anchorId && page.cursor?.anchorSeq === history.cursor.anchorSeq
        ? null : page.cursor;
      setHistory({ messages: [...merged.values()], cursor });
    } catch {
      if (!controller.signal.aborted) setOlderError(true);
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = null;
        setLoadingOlder(false);
      }
    }
  }

  const stored = useMemo(() => {
    const files = storage?.files ?? [];
    const paths = new Set(files.map(file => file.path));
    const origins = storageOrigins(history?.messages ?? [], paths, storage?.root ?? "");
    const attachments = attachmentImages(history?.messages ?? [], projectId, threadId, paths, storage?.root ?? "");
    return { files, origins, attachments, formats: [...new Set(files.map(file => extension(file.name)))].sort(names.compare) };
  }, [storage, history, projectId, threadId]);
  const links = useMemo(() => history?.messages.flatMap(messageLinks) ?? [], [history]);
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
    setView(tabs[target].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[target]?.focus();
  }

  const sort = sorts[view];
  const query = queries[view].trim().toLocaleLowerCase("ru");
  const matches = (...values: string[]) => values.some(value => value.toLocaleLowerCase("ru").includes(query));
  const openFile = (path: string) => navigate.experimental_openFilePreview({ target: { kind: "thread-storage", threadId, path }, location: null });
  const filteredFiles = stored.files.filter(file => matches(file.path, file.name) && (!format || extension(file.name) === (format === "-" ? "" : format)));
  const filteredImages = images.filter(image => matches(image.name));
  const filteredLinks = links.filter(link => matches(link.title, link.url));
  const activeCount = view === "files" ? filteredFiles.length : view === "images" ? filteredImages.length : filteredLinks.length;
  const counts = { files: stored.files.length, images: images.length, links: links.length };
  const noData = view === "links" ? !history : !storage;
  const error = view === "links" ? historyError : fileError;
  const loading = view === "links" ? loadingHistory : loadingFiles;

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
  const refresh = () => {
    olderRequest.current?.abort();
    olderRequest.current = null;
    setLoadingOlder(false);
    setRevision(value => value + 1);
  };

  return <div className="tm">
    <div className="tm-controls">
      <div className="tm-tabs" role="tablist" aria-label="Материалы треда" onKeyDown={handleTabs}>
        {tabs.map(tab => <button key={tab.id} type="button" role="tab" id={id + tab.id}
          aria-selected={view === tab.id} aria-controls={id + "panel"} tabIndex={view === tab.id ? 0 : -1}
          onClick={() => setView(tab.id)}>
          {tab.label} <span className="tm-count">{counts[tab.id]}</span>
        </button>)}
      </div>
      <label className="tm-search">
        <Icon name="Search" />
        <input type="search" aria-label="Поиск по материалам" value={queries[view]}
          placeholder={view === "links" ? "Поиск по названию или адресу" : "Поиск по имени"}
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
        {view === "files" && <select aria-label="Формат файла" value={format} onChange={event => setFormat(event.target.value)}>
          <option value="">Все форматы</option>
          {stored.formats.map(item => <option value={item || "-"} key={item}>{item.toUpperCase() || "Без расширения"}</option>)}
        </select>}
        <select aria-label="Сортировка" value={sort} onChange={event => setSorts({ ...sorts, [view]: event.target.value as Sort })}>
          <option value="name">По названию</option>
          <option value="newest" disabled={view === "files" && !metadata.size}>Сначала новые</option>
          {view === "files" && <option value="oldest" disabled={!metadata.size}>Сначала старые</option>}
          {view !== "links" && <option value="largest" disabled={!metadata.size}>Сначала крупные</option>}
        </select>
        {view === "files" && <label className="tm-group-toggle">
          <input type="checkbox" checked={groupByFormat} onChange={event => setGroupByFormat(event.target.checked)} />
          Группировать по типу
        </label>}
        <button className="tm-refresh" type="button" title="Обновить" aria-label="Обновить"
          disabled={loadingFiles || loadingHistory} onClick={refresh}><Icon name="RefreshCw" /></button>
      </div>
    </div>
    <div className="tm-content" id={id + "panel"} role="tabpanel" aria-labelledby={id + view} tabIndex={0}>
      {noData && loading ? <div className="tm-skeleton" role="status" aria-label="Загрузка">
        {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
      </div> : error && noData && !activeCount ? <div className="tm-empty" role="alert">
        <p>Не удалось загрузить материалы</p><button className="tm-action" type="button" onClick={refresh}>Повторить</button>
      </div> : activeCount === 0 ? <div className="tm-empty">
        <Icon name={view === "files" ? "FolderOpen" : view === "images" ? "Image" : "Link2"} />
        <p>{query || (view === "files" && format) ? "Ничего не найдено" : tabs.find(tab => tab.id === view)?.empty}</p>
        {(query || (view === "files" && format)) && <button className="tm-action" type="button" onClick={() => {
          setQueries({ ...queries, [view]: "" });
          if (view === "files") setFormat("");
        }}>Сбросить фильтры</button>}
      </div> : null}

      {view === "files" && filteredFiles.map((file, index) => {
        const kind = extension(file.name);
        const info = metadata.get(file.path);
        const origin = stored.origins.get(file.path);
        return <section key={file.path}>
          {groupByFormat && (index === 0 || extension(filteredFiles[index - 1].name) !== kind) &&
            <h3 className="tm-group">{kind.toUpperCase() || "Без расширения"}</h3>}
          <div className="tm-row">
            <button className="tm-file" type="button" onClick={() => openFile(file.path)} title={file.path}>
              <Icon name={imageFormats.has(kind) ? "Image" : "FileText"} />
              <span className="tm-file-name"><span className="tm-truncate">{file.name}</span>
                {file.name !== file.path && <span className="tm-subtle tm-truncate">{file.path.slice(0, file.path.lastIndexOf("/"))}</span>}
              </span>
              {info && <span className="tm-subtle tm-details">{sizeLabel(info.size)}<br />{dateLabel.format(info.modified)}</span>}
            </button>
            {origin && <OriginLink threadId={threadId} projectId={projectId} origin={origin} />}
          </div>
        </section>;
      })}

      {view === "images" && <div className="tm-gallery">{filteredImages.map(image => <article className="tm-card" key={image.path}>
        <button type="button" title={image.name} onClick={() => image.attachment ? setLightbox(image.attachment) : openFile(image.path)}>
          <Thumbnail key={image.src} src={image.src} />
          <span className="tm-truncate tm-image-name">{image.name}</span>
        </button>
        {image.origin && <OriginLink threadId={threadId} projectId={projectId} origin={image.origin} />}
      </article>)}</div>}

      {view === "links" && filteredLinks.map(link => <article className="tm-link" key={link.seq + ":" + link.url}>
        <Icon name="Link2" />
        <div>
          <UrlLink className="tm-url tm-truncate" href={link.url} title={link.title}>{link.title}</UrlLink>
          <span className="tm-subtle tm-truncate" title={link.url}>{link.url}</span>
          <div className="tm-byline">
            <span className="tm-subtle">{link.role === "user" ? "Вы" : "Агент"} · {dateLabel.format(link.date)}</span>
            <OriginLink threadId={threadId} projectId={projectId} origin={link} />
          </div>
        </div>
      </article>)}
    </div>

    {((view !== "files" && history?.cursor) || (view !== "links" && storage?.truncated) || (error && !noData)) &&
      <div className="tm-footer">
        {view !== "links" && storage?.truncated && <span>Показаны первые {stored.files.length} файлов</span>}
        {error && !noData && <span>Не удалось обновить список</span>}
        {view !== "files" && history?.cursor && <>
          <span>{olderError ? "Не удалось загрузить ранние сообщения" : "Загружено сообщений: " + history.messages.length}</span>
          <button type="button" className="tm-action" disabled={loadingOlder || loadingHistory} onClick={() => void loadOlder()}>
            {loadingOlder ? "Загрузка…" : "Загрузить старые"}
          </button>
        </>}
      </div>}
    {lightbox && <ImageLightbox imageAlt={lightbox.name} imageSrc={lightbox.url} title={lightbox.name} isOpen onClose={() => setLightbox(null)} />}
  </div>;
}

export default definePluginApp(app => {
  app.slots.experimental_tab({
    id: "materials",
    title: "Материалы",
    tooltip: "Материалы треда",
    icon: "FolderOpen",
    layout: "flush",
    context: { kind: "thread" },
    availability: "action",
    component: ({ threadId }) => <Materials key={threadId} threadId={threadId} />,
  });
});
