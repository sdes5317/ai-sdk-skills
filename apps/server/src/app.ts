import { pipeAgentUIStreamToResponse, validateUIMessages } from 'ai';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { createChatAgent } from './agent.js';
import type { ConversationStore } from './conversations.js';

const bodySchema = z.object({
  id: z.uuid().optional(),
  messages: z.array(z.object({
    id: z.string().min(1).max(128),
    role: z.enum(['user', 'assistant']),
    parts: z.array(z.object({ type: z.string() }).loose()).min(1).max(100),
  })).min(1).max(80),
});

const textSchema = z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(16_000) });

export function createApp(agent: ReturnType<typeof createChatAgent>, conversations?: ConversationStore) {
  const app = express();
  const toolNames = [...Object.keys(agent.tools), ...(conversations?.toolNames ?? [])];
  const allowedAssistantParts = new Set(['text', 'step-start', ...toolNames.map(name => `tool-${name}`)]);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });

  app.post('/api/chat', async (req, res) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success || (conversations && !body.data.id)) {
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

    // A stopped stream may leave tool inputs without results. Keep only completed calls.
    const completeMessages = messages.map(message => ({
      ...message,
      parts: message.parts.filter(part => !part.type.startsWith('tool-')
        || (part.state === 'output-available' && part.preliminary !== true)
        || part.state === 'output-error' || part.state === 'output-denied'),
    })).filter(message => message.parts.some(part => part.type !== 'step-start'));

    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const lease = conversations && body.data.id ? await conversations.acquire(body.data.id, requestSignal) : undefined;
    const activeAgent = lease?.agent ?? agent;
    try {
      try {
        await validateUIMessages({ messages, tools: activeAgent.tools });
      } catch {
        res.status(400).json({ error: '對話內容無效，請清除對話後重試。' });
        return;
      }
      await pipeAgentUIStreamToResponse({
        response: res,
        agent: activeAgent,
        uiMessages: completeMessages,
        abortSignal: lease?.signal ?? requestSignal,
        timeout: 60_000,
        sendReasoning: false,
        headers: { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
        onError: () => '回覆失敗或逾時，請稍後重試。',
      });
    } finally {
      lease?.release();
    }
  });

  app.delete('/api/chats/:id', async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) { res.sendStatus(400); return; }
    await conversations?.close(req.params.id);
    res.sendStatus(204);
  });

  app.get('/api/chats/:id/files/:fileId', async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success || !z.uuid().safeParse(req.params.fileId).success) { res.sendStatus(400); return; }
    const file = await conversations?.getFile(req.params.id, req.params.fileId);
    if (!file) { res.status(404).json({ error: '檔案不存在，或對話已清除／到期。' }); return; }
    const name = encodeURIComponent(file.name).replaceAll("'", '%27');
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.send(Buffer.from(file.content));
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
    } else if (status === 409 || status === 429) {
      res.status(status).json({ error: status === 409 ? '此對話仍在回覆中。' : '對話數量已達上限，請先清除其他對話。' });
    } else {
      res.status(500).json({ error: '伺服器暫時無法回覆，請稍後重試。' });
    }
  };
  app.use(errorHandler);
  return app;
}
