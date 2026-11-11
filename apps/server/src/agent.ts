import { isStepCount, tool, ToolLoopAgent, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import { buildSkillsPrompt, createSkillTools, type Skill } from './skills.js';

export function createChatAgent(model: LanguageModel, skills: readonly Skill[] = [], executionTools: ToolSet = {}) {
  return new ToolLoopAgent({
    model,
    instructions: [
      '你是簡潔、可靠的助理，預設使用繁體中文。查詢現在時間時必須使用 getCurrentTime，不要猜測工具結果。',
      buildSkillsPrompt(skills),
      Object.keys(executionTools).length ? [
        'bash 使用本機 just-bash 記憶體檔案系統，技能位於 /workspace/skills/<name>。',
        '可用 bash、cat、grep、jq、awk 等內建命令及 shell 腳本；沒有 node、npm、python、pip 或網路。',
        '不支援的技能請直接說明限制，不要聲稱已執行。輸出寫入 /workspace/output，再用 publishFile 提供下載。',
        '工作檔案在此對話內保留，執行環境 10 分鐘到期；檔案不存在時須重建，不要宣稱仍可取得。',
      ].join('\n') : '',
    ].filter(Boolean).join('\n\n'),
    stopWhen: isStepCount(6),
    maxOutputTokens: 2048,
    maxRetries: 1,
    toolCallConcurrency: 1,
    onError: ({ error }) => {
      console.error('模型呼叫失敗：', error instanceof Error ? error.name : 'UnknownError');
    },
    tools: {
      ...executionTools,
      ...createSkillTools(skills),
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
