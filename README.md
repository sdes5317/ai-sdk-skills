# 最小 LLM Chat + Agent Skills

前後端分離的 TypeScript 範例：React 19 + Vite 8、Node.js + Express 5、AI SDK 7 `ToolLoopAgent`，套件使用 npm workspaces 管理。介面只有一個對話框，支援串流、停止、重試與清除；訊息存在 React 記憶體，重新整理就清除。

## 啟動

需要 **Node.js 24+、npm 11+**，以及一組 **Vercel AI Gateway API key**。這裡使用 AI Gateway，`.env` 內填的是 Gateway key；不是 OpenAI 的 API key。

在專案根目錄執行：

```powershell
npm ci
Copy-Item apps/server/.env.example apps/server/.env
```

編輯 `apps/server/.env`：

```dotenv
AI_GATEWAY_API_KEY=填入你的金鑰
AI_MODEL=openai/gpt-5-mini
HOST=127.0.0.1
PORT=3001
```

`AI_MODEL` 使用 Gateway 的 `供應商/模型` 識別碼，可改成你有權限使用、支援工具呼叫的模型。金鑰只由後端讀取；`.env` 已排除於 Git，不能放入 `VITE_*` 環境變數。

```powershell
npm run dev
```

打開 [聊天介面](http://127.0.0.1:5173)。[健康檢查](http://127.0.0.1:3001/api/health) 應回傳 `{"status":"ok"}`。

也可以在兩個終端機分別執行：

```powershell
npm run dev -w @chat/server
npm run dev -w @chat/web
```

若後端改了連接埠，將 `apps/web/.env.example` 複製成 `apps/web/.env`，調整 `API_PROXY_TARGET` 後重啟 Vite。此變數只供 Vite 伺服器使用。

## 程式分工

```text
apps/
  web/
    src/App.tsx                 單一聊天視窗、useChat 與工具狀態
    src/styles.css              響應式樣式
    vite.config.ts              開發與預覽時的 /api 代理
  server/
    src/index.ts                環境設定、技能探索、啟動與關閉
    src/app.ts                  HTTP 驗證、串流、取消與錯誤處理
    src/agent.ts                ToolLoopAgent 指示與工具組合
    src/skills.ts               技能 metadata、完整指示與參考檔讀取
    skills/clear-answer/        可直接試用的回答整理技能
    test/                       不需金鑰的假模型整合測試
```

前端使用 `useChat` 和 `DefaultChatTransport`，將目前的對話送至 `POST /api/chat`；後端以 `pipeAgentUIStreamToResponse` 回傳標準 UI message stream。工具完全由後端執行，前端只顯示進度。兩端共用 AI SDK 的訊息協定，不匯入彼此的執行程式。

後端明確限制每次最多 6 步、每步最多 2048 個輸出 token、整次請求 60 秒。中止連線會傳遞到模型；下一輪會移除未完成的工具呼叫。輸入限制為 256 KiB、80 則訊息，每則使用者文字最多 16,000 字元；超過後可清除對話重來。端點只接受文字提問，不接受客戶端 `system` 訊息、附件或任意工具種類。

## Agent Skills 的運作

依照 [AI SDK 官方 Agent Skills 指南](https://ai-sdk.dev/cookbook/guides/agent-skills) 採取漸進式載入：

1. 啟動時掃描後端 `skills/`，解析 YAML frontmatter，只保留名稱、用途與內部目錄。
2. System instructions 只加入技能的名稱與用途，不加入完整技能內容。
3. 模型判斷任務符合用途後，呼叫 `loadSkill({ name })`，才將完整 `SKILL.md` 放進該次對話。
4. 技能需要參考資料時，呼叫 `readSkillFile({ name, path })`；`path` 相對於技能目錄。

技能目錄在啟動時固定，沒有跨使用者共享的「已載入技能」狀態。完整內容只透過工具結果進入目前對話。新增或修改技能後重啟後端。

範例：

- 「台北現在幾點？」：觸發 `getCurrentTime`，驗證基本工具循環。
- 「請幫我整理 REST 與 RPC 的差異，使用 clear-answer 技能」：驗證 `loadSkill` → `readSkillFile` → 回答。

技能選擇由模型決定；要除錯時，可像第二個例子明確指定名稱。

新增技能只需建立：

```text
apps/server/skills/my-skill/
  SKILL.md
  references/optional.md
```

```markdown
---
name: my-skill
description: 清楚描述使用者提出什麼任務時應使用此技能。
---

# 任務指示

說明執行順序。需要時使用 readSkillFile 讀取 references/optional.md。
```

名稱必須與資料夾相同，使用小寫英數與連字號。YAML 或必要 metadata 錯誤會讓啟動失敗；沒有 `SKILL.md` 的資料夾會忽略。檔案工具會檢查真實路徑，拒絕 `..`、符號連結或 Windows junction 導向技能目錄外的檔案，且單檔限制 64 KiB。

此範例提供唯讀文字資源，不執行 skill 腳本。技能是伺服器端維護的可信資產，請勿放入金鑰或私人檔案；工具結果會傳至模型及瀏覽器。需要執行第三方技能腳本時，再導入獨立 sandbox 與明確權限。

## 驗證與建置

```powershell
npm run check
```

依序執行前後端 TypeScript 檢查、10 項後端整合測試及正式建置。測試使用 SDK 的 `MockLanguageModelV4`，不需要 key，也不呼叫真實模型；HTTP 測試需要允許本機 loopback 連線。

測試涵蓋工具循環、技能與參考檔載入、訊息驗證、錯誤遮蔽、取消連線、取消後繼續對話、步數上限、路徑跳脫及檔案大小限制。開發時另外以瀏覽器操作驗證送出、工具進度、停止、錯誤、重試與清除。

## 分開部署

```powershell
npm run build
npm run start -w @chat/server
```

前端產物位於 `apps/web/dist`，部署至靜態主機；後端執行 `apps/server/dist/index.js`，部署時也必須保留相鄰的 `apps/server/skills/`。後端工作目錄使用 `apps/server`，即可載入當地 `.env`；也可以由部署平台注入環境變數。

兩個服務可分別部署，在公開入口將 `/api/*` 代理至 Node.js，讓瀏覽器維持同源存取。Vite 的代理只用於開發與預覽；`vite preview` 不作為正式伺服器。

例如 Nginx 的 API 代理區塊（前端靜態檔另行設定）：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 75s;
}
```

此專案範圍是本機單人使用。對外提供服務時，入口需加入登入驗證、每使用者限流與費用配額，並使用 HTTPS。瀏覽器提交的對話與工具歷史都不具授權效力；日後新增寫入或其他敏感工具時，必須在後端檢查身分與權限。

## 官方參考

- [ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)
- [Node.js Agent 串流](https://ai-sdk.dev/docs/reference/ai-sdk-core/pipe-agent-ui-stream-to-response)
- [React useChat](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)
- [Agent Skills](https://ai-sdk.dev/cookbook/guides/agent-skills)
