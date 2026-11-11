import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createChatAgent } from '../src/agent.js';
import { createApp } from '../src/app.js';
import { mockStream, serve, textStream, userMessage } from './helpers.js';

test('聊天端點會執行工具，並將結果交回模型後串流文字', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    mockStream([{ type: 'tool-call', toolCallId: 'clock-1', toolName: 'getCurrentTime', input: '{"timeZone":"Asia/Taipei"}' }], 'tool-calls'),
    textStream('這是台北的目前時間。'),
  ] });
  const url = await serve(t, createApp(createChatAgent(model)));
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [userMessage] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const stream = await response.text();
  assert.match(stream, /tool-output-available/);
  assert.match(stream, /這是台北的目前時間/);
  assert.match(stream, /\[DONE\]/);
  assert.equal(model.doStreamCalls.length, 2);
  assert.match(JSON.stringify(model.doStreamCalls[1]?.prompt), /tool-result.*Asia\/Taipei/);
});

test('拒絕格式錯誤、system 注入、檔案與空白輸入，不呼叫模型', async t => {
  const model = new MockLanguageModelV4();
  const url = await serve(t, createApp(createChatAgent(model)));
  for (const body of [
    {},
    { messages: [] },
    { messages: [{ ...userMessage, role: 'system' }] },
    { messages: [{ ...userMessage, parts: [{ type: 'file', url: 'http://localhost/private', mediaType: 'text/plain' }] }] },
    { messages: [{ ...userMessage, parts: [{ type: 'text', text: '  ' }] }] },
    { messages: [{ ...userMessage, role: 'assistant' }] },
  ]) {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }
  assert.equal(model.doStreamCalls.length, 0);
});

test('拒絕損壞或過大的 JSON', async t => {
  const url = await serve(t, createApp(createChatAgent(new MockLanguageModelV4())));
  for (const [body, status] of [['{', 400], [JSON.stringify({ text: 'a'.repeat(270_000) }), 413]] as const) {
    const response = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, status);
    assert.ok((await response.json() as { error: string }).error);
  }
});

test('模型錯誤只回傳通用訊息', async t => {
  const logger = t.mock.method(console, 'error', () => {});
  const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('private-provider-detail'); } });
  const url = await serve(t, createApp(createChatAgent(model)));
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [userMessage] }),
  });
  const body = await response.text();
  assert.match(body, /回覆失敗或逾時/);
  assert.doesNotMatch(body, /private-provider-detail/);
  assert.doesNotMatch(JSON.stringify(logger.mock.calls.map(call => call.arguments)), /private-provider-detail/);
});

test('工具循環最多執行六步', async t => {
  const model = new MockLanguageModelV4({ doStream: async () => mockStream([
    { type: 'tool-call', toolCallId: crypto.randomUUID(), toolName: 'getCurrentTime', input: '{"timeZone":"UTC"}' },
  ], 'tool-calls') });
  const url = await serve(t, createApp(createChatAgent(model)));
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [userMessage] }),
  });
  assert.match(await response.text(), /\[DONE\]/);
  assert.equal(model.doStreamCalls.length, 6);
});

test('瀏覽器取消連線會中止模型請求', { timeout: 5_000 }, async t => {
  let observeAbort = () => {};
  const aborted = new Promise<void>(resolve => { observeAbort = resolve; });
  const model = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => {
    abortSignal?.addEventListener('abort', observeAbort, { once: true });
    return {
      stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'pending' });
        controller.enqueue({ type: 'text-delta', id: 'pending', delta: '回覆中' });
      } }),
    };
  } });
  const url = await serve(t, createApp(createChatAgent(model)));
  const controller = new AbortController();
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [userMessage] }),
  });
  await response.body?.getReader().read();
  controller.abort();
  await aborted;
});
