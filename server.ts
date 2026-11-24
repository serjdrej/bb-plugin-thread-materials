import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { materialsHostRpc, materialsRpc } from "./rpc.js";

export default function plugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: materialsHostRpc });
  bb.rpc.register(materialsRpc, {
    async fileMetadata({ threadId, paths }) {
      const location = await bb.sdk.threads.storageLocation({ threadId });
      return host.call("statFiles", {
        root: location.storageRootPath,
        paths,
      }, { hostId: location.hostId, timeoutMs: 10_000 });
    },
  });
}
