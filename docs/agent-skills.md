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
