# Thread Materials

Find files, images, links, and suggested terminal commands in a BB thread. Open **+ → Materials** in the thread's right panel.

| View | What you can do |
| --- | --- |
| **Files** | Search thread storage, filter by format, and open files in BB's preview. Sort by name, modification date, or size. Toggle **Group by type** to keep formats together while sorting inside each group. |
| **Images** | Browse thumbnails of images in thread storage and supported local attachments. Click a thumbnail to see the image at full size. |
| **Links** | Search HTTP and HTTPS links by title or address. Click **Go to message** for the source message. |
| **Commands** | Search and copy shell commands from labeled code blocks in assistant replies, including Bash, PowerShell, and cmd. Use **Go to message** to see the surrounding instructions. |

Right-click a file or image and choose **Go to message** to jump to its latest matching attachment, local link, or filename mention. Materials searches earlier messages when needed. A bare filename is matched only when it identifies one file in the listing. Use **Load earlier messages** to include older links and commands.

## Requirements

- BB 0.50.1 or later and BB Plugin SDK 0.6.157 or later.
- File dates and sizes depend on the thread's host. Sorting by date and size is unavailable when that host cannot supply file metadata.

## Data access

The plugin reads the active thread's storage listing, file sizes and modification times, and user and assistant messages through BB. Known service directories such as npm caches, `node_modules`, and Python caches are excluded from the listing before the file limit is applied. Its host handler resolves file paths inside the thread's storage before reading metadata. The gallery uses BB's authenticated file routes. Terminal commands are shown as text for manual use.

## Install in BB

```sh
bb plugin install 'git:https://github.com/serjdrej/bb-plugin-thread-materials.git@semver:thread-materials-panel/:^0.1.3'
```


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

## License

[MIT](LICENSE)
