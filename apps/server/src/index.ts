import { gateway } from 'ai';
import { z } from 'zod';
import { createChatAgent } from './agent.js';
import { createApp } from './app.js';
import { discoverSkills } from './skills.js';

const env = z.object({
  AI_GATEWAY_API_KEY: z.string().trim().min(1),
  AI_MODEL: z.string().trim().min(1).default('openai/gpt-5-mini'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
}).safeParse(process.env);

if (!env.success) {
  // Only report field names: configuration values may contain credentials.
  console.error('後端環境設定無效：', env.error.issues.map(issue => issue.path.join('.')).join(', '));
  process.exit(1);
}

const skills = await discoverSkills();
const agent = createChatAgent(gateway(env.data.AI_MODEL), skills);
const server = createApp(agent).listen(env.data.PORT, env.data.HOST, () => {
  console.log(`API: http://${env.data.HOST}:${env.data.PORT}`);
});
server.on('error', () => {
  console.error('API 啟動失敗，請檢查 HOST 與 PORT。');
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit());
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
