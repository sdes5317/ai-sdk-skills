---
name: sales-report
description: 當使用者要求用內附的範例銷售 CSV 計算金額、測試 Bash 技能或產生可下載報表時使用。只支援此技能定義的簡單 CSV 格式。
---

# 範例銷售報表

1. 使用 `readSkillFile` 讀取本技能的 `references/format.md`。
2. 使用 `bash` 執行：

   ```sh
   bash /workspace/skills/sales-report/scripts/summarize.sh
   ```

3. 檢查命令成功，再讀取 `/workspace/output/sales-summary.md` 確認結果。
4. 使用 `publishFile` 發布 `/workspace/output/sales-summary.md`，讓使用者下載。
5. 說明這是根據技能內附的範例資料產生，不是使用者的真實營業資料。

此技能使用 just-bash 的 `bash`、`awk`、`mkdir` 與 `printf`，不需要 Python、Node.js 或網路。
