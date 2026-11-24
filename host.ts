import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { relativeFilePath } from "./paths.js";
import { materialsHostRpc } from "./rpc.js";

export default experimental_defineHostEntry({
  contract: materialsHostRpc,
  handlers: {
    async statFiles({ root, paths }) {
      const base = await realpath(root);
      const results: { path: string; size: number; modified: number }[] = [];
      for (let offset = 0; offset < paths.length; offset += 32) {
        const batch = await Promise.all(paths.slice(offset, offset + 32).map(async path => {
          const normalized = relativeFilePath(path);
          if (!normalized) return null;
          try {
            const absolute = await realpath(resolve(base, normalized));
            const within = relative(base, absolute);
            if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) return null;
            const file = await stat(absolute);
            return file.isFile() ? { path, size: file.size, modified: file.mtimeMs } : null;
          } catch {
            return null;
          }
        }));
        for (const item of batch) {
          if (item) results.push(item);
        }
      }
      return results;
    },
  },
});
