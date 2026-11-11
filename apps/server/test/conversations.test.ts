import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createChatAgent } from '../src/agent.js';
import { createApp } from '../src/app.js';
import { ConversationStore } from '../src/conversations.js';
import { createLocalExecutionSandbox, type ExecutionSandbox, type SandboxFactory } from '../src/sandbox.js';
import { mockStream, serve, textStream, userMessage } from './helpers.js';

test('HTTP 聊天可執行 Bash、下載產物，下一輪沿用檔案，清除後失效', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    mockStream([{ type: 'tool-call', toolCallId: 'bash-1', toolName: 'bash', input: JSON.stringify({ command: "printf 'report-ready' > output/report.txt" }) }], 'tool-calls'),
    mockStream([{ type: 'tool-call', toolCallId: 'publish-1', toolName: 'publishFile', input: '{"path":"/workspace/output/report.txt"}' }], 'tool-calls'),
    textStream('報告已完成。'),
    mockStream([{ type: 'tool-call', toolCallId: 'bash-2', toolName: 'bash', input: '{"command":"cat output/report.txt"}' }], 'tool-calls'),
    textStream('檔案仍然存在。'),
  ] });
  const store = new ConversationStore(model, []);
  t.after(() => store.closeAll());
  const url = await serve(t, createApp(createChatAgent(model), store));
  const id = crypto.randomUUID();
  async function chat() {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, messages: [userMessage] }),
    });
    assert.equal(response.status, 200);
    return response.text();
  }
  const stream = await chat();
  assert.match(stream, /報告已完成/);
  const downloadPath = /"url":"(\/api\/chats\/[^"\s]+)"/.exec(stream)?.[1];
  assert.ok(downloadPath);
  const file = await fetch(`${url}${downloadPath}`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await file.text(), 'report-ready');
  const otherId = crypto.randomUUID();
  assert.equal((await fetch(`${url}${downloadPath.replace(id, otherId)}`)).status, 404);
  assert.match(await chat(), /檔案仍然存在/);
  assert.match(JSON.stringify(model.doStreamCalls[4]?.prompt), /report-ready/);
  assert.equal((await fetch(`${url}/api/chats/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${url}${downloadPath}`)).status, 404);
  assert.equal((await fetch(`${url}/api/chats/${id}`, { method: 'DELETE' })).status, 204);
});

test('不同對話檔案隔離，拒絕同一對話的並行請求，最多四個環境', async t => {
  let created = 0;
  let stopped = 0;
  const runtimes: ExecutionSandbox[] = [];
  const factory: SandboxFactory = async signal => {
    created++;
    const runtime = await createLocalExecutionSandbox(signal);
    runtimes.push(runtime);
    return { ...runtime, stop: async () => { stopped++; await runtime.stop(); } };
  };
  const store = new ConversationStore(new MockLanguageModelV4(), [], factory);
  t.after(() => store.closeAll());
  const signal = new AbortController().signal;
  const firstId = crypto.randomUUID();
  const first = await store.acquire(firstId, signal);
  await assert.rejects(store.acquire(firstId, signal), { status: 409 });
  first.release();
  const again = await store.acquire(firstId, signal);
  assert.equal(created, 1);
  again.release();
  for (let index = 0; index < 3; index++) (await store.acquire(crypto.randomUUID(), signal)).release();
  await runtimes[0]?.sandbox.writeTextFile({ path: '/workspace/only-first.txt', content: 'private' });
  assert.equal(await runtimes[1]?.sandbox.readTextFile({ path: '/workspace/only-first.txt' }), null);
  await assert.rejects(store.acquire(crypto.randomUUID(), signal), { status: 429 });
  await store.closeAll();
  assert.equal(stopped, 4);
});

test('到期會清理環境，清除進行中的對話會傳遞取消訊號', async () => {
  let stopped = 0;
  let onStop = () => {};
  const wasStopped = new Promise<void>(resolve => { onStop = resolve; });
  const factory: SandboxFactory = async signal => {
    const runtime = await createLocalExecutionSandbox(signal);
    return { ...runtime, stop: async () => { stopped++; await runtime.stop(); onStop(); } };
  };
  const store = new ConversationStore(new MockLanguageModelV4(), [], factory, 40);
  const lease = await store.acquire(crypto.randomUUID(), new AbortController().signal);
  const keepAlive = setTimeout(() => {}, 500);
  try { await wasStopped; } finally { clearTimeout(keepAlive); await store.closeAll(); }
  assert.equal(stopped, 1);
  assert.equal(lease.signal.aborted, true);
  lease.release();
});

test('初始化失敗會釋放環境，並允許同一對話重試', async t => {
  let stopped = 0;
  const factory: SandboxFactory = async signal => {
    const runtime = await createLocalExecutionSandbox(signal);
    return { ...runtime, stop: async () => { stopped++; await runtime.stop(); } };
  };
  const store = new ConversationStore(new MockLanguageModelV4(), [{ name: 'missing', description: 'test', directory: '/path-that-does-not-exist' }], factory);
  t.after(() => store.closeAll());
  const id = crypto.randomUUID();
  await assert.rejects(store.acquire(id, new AbortController().signal));
  await assert.rejects(store.acquire(id, new AbortController().signal));
  assert.equal(stopped, 2);
});
