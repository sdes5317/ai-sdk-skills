import { isStepCount, tool, ToolLoopAgent, type LanguageModel } from 'ai';
import { z } from 'zod';

export function createChatAgent(model: LanguageModel) {
  return new ToolLoopAgent({
    model,
    instructions: '你是簡潔、可靠的助理，預設使用繁體中文。查詢現在時間時必須使用 getCurrentTime，不要猜測工具結果。',
    stopWhen: isStepCount(6),
    maxOutputTokens: 2048,
    maxRetries: 1,
    onError: ({ error }) => {
      console.error('模型呼叫失敗：', error instanceof Error ? error.name : 'UnknownError');
    },
    tools: {
      getCurrentTime: tool({
        description: '取得指定時區的目前日期與時間。',
        inputSchema: z.object({
          timeZone: z.enum(['Asia/Taipei', 'Asia/Tokyo', 'America/New_York', 'UTC']).default('Asia/Taipei'),
        }),
        execute: async ({ timeZone }) => ({
          timeZone,
          time: new Intl.DateTimeFormat('zh-TW', {
            timeZone,
            dateStyle: 'full',
            timeStyle: 'long',
          }).format(new Date()),
        }),
      }),
    },
  });
}
