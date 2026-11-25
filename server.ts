import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { excludedMaterialNames, isServicePath, relativeFilePath } from "./paths.js";
import { fileLimit, materialsHostRpc, materialsRpc } from "./rpc.js";

export default function plugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: materialsHostRpc });
  bb.rpc.register(materialsRpc, {
    async listFiles({ threadId }) {
      const { hostId, storageRootPath: root } = await bb.sdk.threads.storageLocation({ threadId });
      try {
        const result = await bb.sdk.files.list({
          hostId, path: root, limit: fileLimit, includeHidden: false, excludeNames: excludedMaterialNames,
        });
        const files = result.files.flatMap(file => {
          const path = relativeFilePath(file.path);
          return path && !isServicePath(path) ? [{ path, name: file.name }] : [];
        });
        return { files, root, truncated: result.truncated };
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        return { files: [], root, truncated: false };
      }
    },
    async fileMetadata({ threadId, paths }) {
      const location = await bb.sdk.threads.storageLocation({ threadId });
      return host.call("statFiles", {
        root: location.storageRootPath,
        paths,
      }, { hostId: location.hostId, timeoutMs: 10_000 });
    },
  });
}
