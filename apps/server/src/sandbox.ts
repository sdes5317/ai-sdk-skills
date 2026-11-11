import { experimental_createBashTool as createBashTool } from '@ai-sdk/tool-bash';
import { createVercelSandboxSessionFromNativeSandbox } from '@ai-sdk/sandbox-vercel';
import { Sandbox } from '@vercel/sandbox';
import type { Experimental_SandboxSession } from 'ai';
import { collectSkillFiles, type Skill } from './skills.js';

export const sandboxLifetimeMs = 10 * 60_000;
export const sandboxOutputRoot = '/workspace/output';
export type ExecutionSandbox = { sandbox: Experimental_SandboxSession; stop: () => PromiseLike<void> };
export type SandboxFactory = (signal: AbortSignal) => Promise<ExecutionSandbox>;

export const createVercelExecutionSandbox: SandboxFactory = async signal => {
  const credentials = process.env.VERCEL_TOKEN ? {
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID ?? '',
    projectId: process.env.VERCEL_PROJECT_ID ?? '',
  } : {};
  const native = await Sandbox.create({
    ...credentials,
    image: process.env.SANDBOX_IMAGE || 'vercel/sandbox/universal',
    persistent: false,
    timeout: sandboxLifetimeMs,
    resources: { vcpus: 2 },
    networkPolicy: 'deny-all',
    signal,
  });
  return {
    sandbox: createVercelSandboxSessionFromNativeSandbox(native),
    stop: async () => { await native.stop(); },
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
