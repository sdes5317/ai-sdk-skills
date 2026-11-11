import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createApp } from '../src/app.js';

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;

export function mockStream(parts: StreamPart[], reason: 'stop' | 'tool-calls' = 'stop') {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        parts.forEach(part => controller.enqueue(part));
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: reason, raw: reason },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}

export function textStream(text: string) {
  return mockStream([
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
  ]);
}

export async function serve(t: TestContext, app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  return `http://127.0.0.1:${address.port}`;
}

export const userMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '台北現在幾點？' }] };
