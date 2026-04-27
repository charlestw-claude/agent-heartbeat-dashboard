# CLAUDE.md — agent-heartbeat-dashboard

> 此檔案為本 repo 的專案專屬規範，全域規範見 `~/.claude/CLAUDE.md`。

<!-- snapshot: true -->
<!-- snapshot-path: C:/__CharlesProjects/_snapshots -->

---

## 專案簡介

**agent-heartbeat-dashboard** 是 VM agent 環境的監控儀表板，提供：

- 各 Claude Code agent 的存活狀態（heartbeat、MCP server、模型版本）
- VM 即時資源使用（CPU、RAM、磁碟、網路）
- Claude 訂閱用量整合（pull ClaudeMonitor 的 `/v1/usage`、`/v1/analysis`、`/v1/stats`）

部署於 Hyper-V VM，由 `system-deployment` repo 以 git submodule 形式引用，啟動方式見 `profiles/vm-agent/config/agents/heartbeat-dashboard-silent.vbs`。

---

## 技術棧

- **後端**：Node.js + Express 5（`server.js`），better-sqlite3 持久化（`db/heartbeat.db`）
- **前端**：原生 HTML/CSS/JS + ECharts CDN（`public/`）
- **資料來源**：
  - Heartbeat：各 agent 的 PowerShell 健檢腳本透過 `POST /api/heartbeat` 上報
  - VM metrics：`metrics/collector.js` 用 PowerShell 取樣
  - Claude 用量：`metrics/claude-usage.js` 主動 pull `127.0.0.1:6736`（ClaudeMonitor 本機 API）
- **WebSocket**：`metrics/ws.js` 廣播即時 VM metrics

---

## 啟動與重啟

正式環境由 Windows Scheduled Task + VBS 啟動：

```powershell
# 查看執行中的 dashboard process
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*heartbeat-dashboard*' }

# 重啟（停掉 PID，scheduled task 會自動拉起；或手動重新執行 .vbs）
Stop-Process -Id <PID> -Force
```

開發時直接 `node server.js`，預設聽 port 3900。

---

## 升版規則

依全域 CLAUDE.md §8 自動判斷：

- 含 `feat` → MINOR
- 僅 `fix`/`perf`/`refactor` → PATCH
- 含 `BREAKING CHANGE` → MAJOR

升版時同步更新：`VERSION`、`package.json`、`CHANGELOG.md/.html`、`USER_GUIDE.md/.html`，建立 tag 與 GitHub Release，並執行 snapshot 備份。

---

## 未追蹤檔案

見 `UNTRACKED_FILES.md`。
