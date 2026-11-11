import type { LanguageModel } from 'ai';
import { createChatAgent } from './agent.js';
import { createArtifactTools, type ArtifactStore } from './artifacts.js';
import { createLocalExecutionSandbox, prepareSandbox, sandboxLifetimeMs, type SandboxFactory } from './sandbox.js';
import type { Skill } from './skills.js';

type Conversation = {
  agent: ReturnType<typeof createChatAgent>;
  files: ArtifactStore;
  stop: () => PromiseLike<void>;
};
type Entry = {
  ready: Promise<Conversation>;
  controller: AbortController;
  active: boolean;
  timer: ReturnType<typeof setTimeout>;
};

export class ConversationStore {
  private readonly entries = new Map<string, Entry>();
  readonly toolNames = ['bash', 'publishFile'];

  constructor(
    private readonly model: LanguageModel,
    private readonly skills: readonly Skill[],
    private readonly createSandbox: SandboxFactory = createLocalExecutionSandbox,
    private readonly lifetimeMs = sandboxLifetimeMs,
  ) {}

  private async create(id: string, signal: AbortSignal): Promise<Conversation> {
    const runtime = await this.createSandbox(signal);
    try {
      const bash = await prepareSandbox(runtime, this.skills, signal);
      const files: ArtifactStore = new Map();
      const agent = createChatAgent(this.model, this.skills, { bash, ...createArtifactTools(id, runtime.sandbox, files) });
      signal.throwIfAborted();
      return { agent, files, stop: runtime.stop };
    } catch (error) {
      await runtime.stop();
      throw error;
    }
  }

  async acquire(id: string, requestSignal: AbortSignal) {
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= 4) throw Object.assign(new Error('同時開啟的對話已達上限，請先清除其他對話。'), { status: 429 });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, requestSignal]);
      const ready = this.create(id, signal);
      const timer = setTimeout(() => { void this.close(id).catch(() => console.error('執行環境清理失敗。')); }, this.lifetimeMs);
      timer.unref();
      entry = { ready, controller, active: false, timer };
      this.entries.set(id, entry);
      const createdEntry = entry;
      void ready.catch(() => {
        if (this.entries.get(id) === createdEntry) {
          this.entries.delete(id);
          clearTimeout(timer);
        }
      });
    }
    if (entry.active) throw Object.assign(new Error('此對話仍在回覆中。'), { status: 409 });
    entry.active = true;
    try {
      const conversation = await entry.ready;
      const signal = AbortSignal.any([entry.controller.signal, requestSignal]);
      signal.throwIfAborted();
      return { agent: conversation.agent, signal, release: () => { entry.active = false; } };
    } catch (error) {
      entry.active = false;
      throw error;
    }
  }

  async getFile(id: string, fileId: string) {
    const entry = this.entries.get(id);
    return entry ? (await entry.ready).files.get(fileId) : undefined;
  }

  async close(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.controller.abort();
    // Failed initialization already disposes its partially created runtime.
    const conversation = await entry.ready.catch(() => undefined);
    if (conversation) {
      conversation.files.clear();
      await conversation.stop();
    }
  }

  async closeAll() {
    const results = await Promise.allSettled([...this.entries.keys()].map(id => this.close(id)));
    if (results.some(result => result.status === 'rejected')) console.error('部分執行環境未能正常清理。');
  }
}
