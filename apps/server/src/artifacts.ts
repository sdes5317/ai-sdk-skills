import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { tool, type Experimental_SandboxSession } from 'ai';
import { z } from 'zod';
import { sandboxOutputRoot } from './sandbox.js';

export type Artifact = { name: string; content: Uint8Array };
export type ArtifactStore = Map<string, Artifact>;

export function createArtifactTools(chatId: string, sandbox: Experimental_SandboxSession, files: ArtifactStore) {
  return {
    publishFile: tool({
      description: '將 /workspace/output 內的產出檔案提供給使用者下載。先用 bash 完成檔案，再呼叫此工具。',
      inputSchema: z.object({ path: z.string().min(1).max(512).regex(/^[^\0\r\n]+$/) }),
      execute: async ({ path }, { abortSignal }) => {
        const normalized = posix.normalize(path);
        if (!posix.isAbsolute(path) || !normalized.startsWith(`${sandboxOutputRoot}/`)) {
          throw new Error('只能發布 /workspace/output 內的檔案。');
        }
        const quotedPath = `'${normalized.replaceAll("'", "'\\''")}'`;
        const resolved = await sandbox.run({ command: `realpath ${quotedPath}`, abortSignal });
        const realPath = resolved.stdout.trim();
        if (resolved.exitCode !== 0 || !realPath.startsWith(`${sandboxOutputRoot}/`)) {
          throw new Error('檔案不存在，或連結指向輸出目錄外。');
        }
        const info = await sandbox.stat({ path: realPath, abortSignal });
        if (info?.type !== 'file' || info.size > 10 * 1024 * 1024) throw new Error('產出必須是 10 MiB 以內的檔案。');
        const content = await sandbox.readBinaryFile({ path: realPath, abortSignal });
        if (!content || content.byteLength > 10 * 1024 * 1024) throw new Error('無法讀取產出檔案。');
        const total = [...files.values()].reduce((size, file) => size + file.content.byteLength, 0);
        if (files.size >= 10 || total + content.byteLength > 20 * 1024 * 1024) throw new Error('此對話已達 10 個產出或 20 MiB 上限。');
        const id = randomUUID();
        const name = posix.basename(realPath);
        files.set(id, { name, content });
        return { name, size: content.byteLength, url: `/api/chats/${chatId}/files/${id}` };
      },
    }),
  };
}
