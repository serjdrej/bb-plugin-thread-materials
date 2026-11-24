# Thread Materials

Find the files, images, and links you shared in a BB thread. Open **+ → Материалы** in the thread's right panel.

| View | What you can do |
| --- | --- |
| **Файлы** (Files) | Search the thread's storage, filter by format, and open a file in BB's preview. Sort by name, modification date, or size. Toggle **Группировать по типу** to keep formats together while sorting inside each group. |
| **Изображения** (Images) | Browse thumbnails of images in thread storage and supported local attachments. Click a thumbnail to see the image at full size. |
| **Ссылки** (Links) | Search HTTP and HTTPS links by title or address. Click **К сообщению** for the source message and **Загрузить старые** to include older messages. |

## Requirements

- BB 0.50.1 or later and BB Plugin SDK 0.6.157 or later.
- The panel uses Russian labels.
- File dates and sizes depend on the thread's host. Sorting by date and size is unavailable when that host cannot supply file metadata.

## Data access

The plugin reads the active thread's storage listing, file sizes and modification times, and user and assistant messages through BB. Its host handler resolves file paths inside the thread's storage before reading metadata. The gallery uses BB's authenticated file routes. Links are collected from supported Markdown links and plain URLs. Images and links are opened when you select them.

## Install from a checkout

Run from the plugin directory on the machine running BB.

```sh
npm ci --ignore-scripts
bb plugin install path:.
```

## Validate a change

```sh
npm run typecheck
bb plugin build .
```
