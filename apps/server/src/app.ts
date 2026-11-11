import { pipeAgentUIStreamToResponse, validateUIMessages } from 'ai';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { createChatAgent } from './agent.js';

const bodySchema = z.object({
  messages: z.array(z.object({
    id: z.string().min(1).max(128),
    role: z.enum(['user', 'assistant']),
    parts: z.array(z.object({ type: z.string() }).loose()).min(1).max(100),
  })).min(1).max(80),
});

const textSchema = z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(16_000) });

export function createApp(agent: ReturnType<typeof createChatAgent>) {
  const app = express();
  const allowedAssistantParts = new Set(['text', 'step-start', ...Object.keys(agent.tools).map(name => `tool-${name}`)]);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });

  app.post('/api/chat', async (req, res) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: '訊息格式錯誤，或超過對話長度上限。' });
      return;
    }

    const { messages } = body.data;
    const invalidParts = messages.some(message => message.parts.some(part =>
      message.role === 'user'
        ? !textSchema.safeParse(part).success
        : !allowedAssistantParts.has(part.type),
    ));
    if (invalidParts || messages.at(-1)?.role !== 'user') {
      res.status(400).json({ error: '僅接受文字提問與已支援的助理訊息。' });
      return;
    }

    try {
      await validateUIMessages({ messages, tools: agent.tools });
    } catch {
      res.status(400).json({ error: '對話內容無效，請清除對話後重試。' });
      return;
    }

    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    await pipeAgentUIStreamToResponse({
      response: res,
      agent,
      uiMessages: messages,
      abortSignal: controller.signal,
      timeout: 60_000,
      sendReasoning: false,
      headers: { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
      onError: () => '回覆失敗或逾時，請稍後重試。',
    });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    if (status === 413) {
      res.status(413).json({ error: '對話內容過長，請清除對話後重試。' });
    } else if (status === 400) {
      res.status(400).json({ error: '請提供有效的 JSON。' });
    } else {
      res.status(500).json({ error: '伺服器暫時無法回覆，請稍後重試。' });
    }
  };
  app.use(errorHandler);
  return app;
}
