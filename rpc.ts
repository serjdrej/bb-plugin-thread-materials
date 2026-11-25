import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const fileLimit = 1000;
const filePaths = z.array(z.string().min(1).max(4096)).max(fileLimit);
const metadata = z.array(z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  modified: z.number().finite(),
}));

export const materialsRpc = defineRpcContract({
  listFiles: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      files: z.array(z.object({ path: z.string(), name: z.string() })),
      root: z.string(),
      truncated: z.boolean(),
    }),
  },
  fileMetadata: {
    input: z.object({ threadId: z.string().min(1), paths: filePaths }),
    output: metadata,
  },
});

export const materialsHostRpc = defineRpcContract({
  statFiles: {
    input: z.object({ root: z.string().min(1), paths: filePaths }),
    output: metadata,
  },
});
