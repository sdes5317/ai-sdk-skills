import { experimental_createBashTool as createBashTool } from '@ai-sdk/tool-bash';
import { createJustBashNetworkSandboxSession } from '@ai-sdk/sandbox-just-bash';
import type { Experimental_SandboxSession } from 'ai';
import { collectSkillFiles, type Skill } from './skills.js';

export const sandboxLifetimeMs = 10 * 60_000;
export const sandboxOutputRoot = '/workspace/output';
export type ExecutionSandbox = { sandbox: Experimental_SandboxSession; stop: () => PromiseLike<void> };
export type SandboxFactory = (signal: AbortSignal) => Promise<ExecutionSandbox>;

export const createLocalExecutionSandbox: SandboxFactory = async signal => {
  signal.throwIfAborted();
  const session = await createJustBashNetworkSandboxSession({
    abortSignal: signal,
    cwd: '/workspace',
    env: {},
    timeoutMs: 15_000,
    maxCallDepth: 30,
    maxCommandCount: 2_000,
    maxLoopIterations: 2_000,
  });
  if (signal.aborted) {
    await session.destroy();
    signal.throwIfAborted();
  }
  return {
    sandbox: session.restricted(),
    stop: async () => { await session.destroy(); },
  };
};

export async function prepareSandbox(runtime: ExecutionSandbox, skills: readonly Skill[], signal: AbortSignal) {
  const files = await collectSkillFiles(skills);
  for (const file of files) {
    signal.throwIfAborted();
    await runtime.sandbox.writeBinaryFile({ ...file, abortSignal: signal });
  }
  const setup = await runtime.sandbox.run({ command: `mkdir -p ${sandboxOutputRoot}`, abortSignal: signal });
  if (setup.exitCode !== 0) throw new Error('無法建立 Sandbox 輸出目錄。');
  return createBashTool({
    sandbox: runtime.sandbox,
    workingDirectory: '/workspace',
    timeout: 15_000,
    maxOutputLength: 12_000,
  });
}
