# Agent Skills：定義與最小實作

Agent Skills 是一種開放格式，將特定任務的操作指示、參考資料與可選腳本封裝成資料夾，讓 Agent 按需載入使用。核心檔案 `SKILL.md` 包含 YAML metadata（至少有 `name`、`description`）與 Markdown 操作指示。[官方格式規範](https://agentskills.io/specification)

```text
sales-report/
├── SKILL.md             # 必要：名稱、用途與操作步驟
├── references/format.md # 選用：報表格式等參考文件
├── scripts/summarize.sh # 選用：資料處理腳本
└── assets/sales.csv     # 選用：範例資料或模板
```

例如，`SKILL.md` 可以寫成：

```markdown
---
name: sales-report
description: 當使用者需要使用內附銷售資料產生報表時使用。
---

1. 讀取 references/format.md，確認報表格式。
2. 以技能目錄為工作目錄，執行 bash scripts/summarize.sh。
3. 檢查產生的報表並回覆結果。
```

依照 [AI SDK 官方指南](https://ai-sdk.dev/cookbook/guides/agent-skills)，本專案將後端能力分成以下 5 項：

| 能力 | 本專案實作 | 用途 |
| --- | --- | --- |
| 探索技能 | `discoverSkills` | 掃描技能並解析 metadata |
| 提供技能清單 | `buildSkillsPrompt` | 將名稱與用途加入 prompt，供模型選擇 |
| 載入技能 | `loadSkill` | 將完整 `SKILL.md` 載入上下文 |
| 讀取參考文件 | `readSkillFile` | 讀取技能引用的文字文件；官方範例稱為 `readFile` |
| 執行腳本 | `bash` | 執行命令並回傳結果；使用腳本的 Skill 才需要 |

`ToolLoopAgent` 另負責串起「模型呼叫工具 → 取得結果 → 繼續執行」的循環。[官方 Agent 組合範例](https://ai-sdk.dev/cookbook/guides/agent-skills#step-5-create-the-agent)

載入順序採用**漸進式載入**：先提供名稱與用途，任務符合時才載入完整指示，再按需讀取參考資料或執行腳本，以減少上下文用量。[官方運作說明](https://ai-sdk.dev/cookbook/guides/agent-skills#how-skills-work)

Skill 描述流程，實際操作由後端工具完成；可執行的腳本語言取決於後端環境。[官方腳本規範](https://agentskills.io/specification#scripts)

## AI SDK：Skills、Sandbox 與 ToolLoopAgent 的串接

本專案自行實作技能探索與文字讀取，使用 AI SDK 官方套件建立本機執行環境與 Bash 工具，再交給 `ToolLoopAgent` 串起流程。以下節錄關鍵程式；`skills` 是 `discoverSkills()` 的結果，`signal` 是請求的取消訊號，`model` 是已設定的模型。

### 1. 套件依賴

依照 [後端 package.json](../apps/server/package.json)：

| 套件 | 專案宣告版本 | 負責內容 |
| --- | --- | --- |
| `ai` | `^7.0.169` | `ToolLoopAgent`、`tool`、`isStepCount` 與 sandbox 介面型別 |
| `@ai-sdk/sandbox-just-bash` | `1.0.180` | 將 just-bash 包成 AI SDK 的 sandbox session |
| `@ai-sdk/tool-bash` | `1.0.23` | 建立模型可呼叫的 Bash 工具 |
| `yaml` | `^2.9.1` | 解析 `SKILL.md` 的 YAML metadata |
| `zod` | `^4.6.7` | 定義工具輸入 schema 與驗證 metadata |

`just-bash` 由 adapter 間接安裝，目前 lockfile 鎖定 `2.14.5`。本專案要求 Node.js 24+、npm 11+，在根目錄執行 `npm ci` 安裝。Sandbox 與 Bash API 仍屬 experimental，程式片段以專案鎖定版本為準。[官方安裝與用法](https://ai-sdk.dev/docs/ai-sdk-core/tools#bash-tool)

### 2. 用官方 adapter 建立本機 sandbox

節錄自 [sandbox.ts](../apps/server/src/sandbox.ts)：

```ts
import { createJustBashNetworkSandboxSession } from '@ai-sdk/sandbox-just-bash';
import type { Experimental_SandboxSession } from 'ai';

const session = await createJustBashNetworkSandboxSession({
  abortSignal: signal,
  cwd: '/workspace',
  env: {},
  timeoutMs: 15_000,
  maxCallDepth: 30,
  maxCommandCount: 2_000,
  maxLoopIterations: 2_000,
});
const sandbox: Experimental_SandboxSession = session.restricted();
```

`session.restricted()` 提供讀寫檔案、執行命令等操作介面；`session` 保留生命週期管理，結束時呼叫 `session.destroy()`。`Experimental_SandboxSession` 是介面型別，實際執行能力由 just-bash adapter 提供。[官方使用範例](https://ai-sdk.dev/docs/ai-sdk-core/tools#usage)

just-bash 在同一個 Node.js 程序內模擬 Bash 與記憶體檔案系統，沒有容器層級隔離。本專案使用 `bash`、`cat`、`awk`、`jq` 等內建命令，沒有掛載主機目錄，也未啟用網路、Python 或 Node.js 執行能力；不需要 Docker 或雲端 sandbox 帳號。[just-bash 官方說明](https://justbash.dev/)

### 3. 複製技能資源，再建立 Bash 工具

```ts
import { experimental_createBashTool as createBashTool } from '@ai-sdk/tool-bash';
import { collectSkillFiles } from './skills.js';

for (const file of await collectSkillFiles(skills)) {
  signal.throwIfAborted();
  await sandbox.writeBinaryFile({ ...file, abortSignal: signal });
}
const setup = await sandbox.run({
  command: 'mkdir -p /workspace/output',
  abortSignal: signal,
});
if (setup.exitCode !== 0) throw new Error('無法建立輸出目錄。');

const bash = await createBashTool({
  sandbox,
  workingDirectory: '/workspace',
  timeout: 15_000,
  maxOutputLength: 12_000,
});
```

`collectSkillFiles` 是本專案的函式：收集技能資源，產生 `{ path, content }`，目的路徑為 `/workspace/skills/<name>/...`。使用 `writeBinaryFile` 保留文字與二進位資源。這一步只把檔案放進執行環境，模型上下文仍由文字工具按需載入。

`createBashTool` 已提供工具 schema、描述與 `execute`：模型傳入 `{ command }`，工具使用綁定的 `sandbox` 執行，回傳 `{ stdout, stderr, exitCode }`。此處每個命令限時 15 秒，stdout、stderr 各保留最多 12,000 字元，再附上截斷提示。[官方參數說明](https://ai-sdk.dev/docs/ai-sdk-core/tools#options)

例如模型可以呼叫：

```json
{ "command": "bash /workspace/skills/sales-report/scripts/summarize.sh" }
```

完整的 `prepareSandbox` 另包裝 `execute`，合併取消訊號與命令期限，執行後檢查 `signal.throwIfAborted()`，避免將取消誤判為成功。程式見 [sandbox.ts](../apps/server/src/sandbox.ts)。

### 4. 用自訂工具載入 Skill 與參考文字

以下節錄 [skills.ts](../apps/server/src/skills.ts) 的 `createSkillTools` 內部。`read(name, path)` 是本專案的讀檔函式，會檢查技能名稱、真實路徑與 64 KiB 大小限制；`sandboxSkillsRoot` 為 `/workspace/skills`。

```ts
import { posix } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';

const skillTools = {
  loadSkill: tool({
    description: '依名稱載入已登錄技能的完整 SKILL.md 指示。',
    inputSchema: z.object({ name: z.string().min(1).max(64) }),
    execute: async ({ name }) => ({
      name,
      skillDirectory: posix.join(sandboxSkillsRoot, name),
      content: await read(name, 'SKILL.md'),
    }),
  }),
  readSkillFile: tool({
    description: '讀取技能目錄內的文字參考檔。',
    inputSchema: z.object({
      name: z.string().min(1).max(64),
      path: z.string().min(1).max(256),
    }),
    execute: async ({ name, path }) => ({ name, path, content: await read(name, path) }),
  }),
};
```

`createSkillTools(skills)` 回傳這組工具。`loadSkill` 將完整指示回傳為工具結果，讓模型在下一步讀到新指示；`skillDirectory` 告訴模型如何定位 Bash 環境裡的資源。本專案的文字工具讀取主機上的技能原檔，Bash 則使用前一步建立的記憶體複本。[官方載入工具範例](https://ai-sdk.dev/cookbook/guides/agent-skills#step-4-create-the-load-skill-tool)

### 5. 把指示與工具接進 ToolLoopAgent

以下簡化 [agent.ts](../apps/server/src/agent.ts)，保留 Skills 與 Bash 的接點：

```ts
import { isStepCount, ToolLoopAgent } from 'ai';
import { buildSkillsPrompt, createSkillTools } from './skills.js';

const agent = new ToolLoopAgent({
  model,
  instructions: [
    buildSkillsPrompt(skills),
    'bash 的技能資源位於 /workspace/skills/<name>，輸出寫入 /workspace/output。',
    '可用 shell 腳本與內建命令；沒有 node、python 或網路。',
  ].join('\n'),
  tools: { ...createSkillTools(skills), bash },
  stopWhen: isStepCount(6),
  toolCallConcurrency: 1,
  maxOutputTokens: 2048,
});
```

`instructions` 提供技能清單與環境說明，`tools` 提供可呼叫操作。每一步模型提出工具呼叫後，`ToolLoopAgent` 執行 `execute`，將結果帶入下一次模型呼叫；例如 `loadSkill → readSkillFile → bash → 回答`。`isStepCount(6)` 限制最多 6 個模型步驟，`toolCallConcurrency: 1` 讓工具依序執行。[官方 ToolLoopAgent 說明](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)

HTTP 入口在 [app.ts](../apps/server/src/app.ts) 透過 `pipeAgentUIStreamToResponse` 啟動 Agent 的串流執行，將對話與取消訊號傳入。[官方串流 API](https://ai-sdk.dev/docs/reference/ai-sdk-core/pipe-agent-ui-stream-to-response)

```ts
import { pipeAgentUIStreamToResponse } from 'ai';

await pipeAgentUIStreamToResponse({
  response: res,
  agent: activeAgent,
  uiMessages: completeMessages,
  abortSignal: lease?.signal ?? requestSignal,
  timeout: 60_000,
});
```

實際專案由 [conversations.ts](../apps/server/src/conversations.ts) 為每個對話建立 sandbox，再將綁定該環境的 `bash` 與產物工具傳給 `createChatAgent`。同一對話沿用檔案，清除、到期或關閉時透過 `runtime.stop()` 呼叫 `session.destroy()`。
