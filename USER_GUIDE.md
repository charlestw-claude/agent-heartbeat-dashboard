# USER GUIDE — agent-heartbeat-dashboard

> 適用版本：v1.6.0
> 最後更新：2026-04-25

---

## 目錄

1. [簡介](#簡介)
2. [快速開始](#快速開始)
3. [介面總覽](#介面總覽)
4. [Agent Status 區塊](#agent-status-區塊)
5. [VM Realtime 區塊](#vm-realtime-區塊)
6. [Claude Subscription 區塊](#claude-subscription-區塊)
7. [響應式行為](#響應式行為)
8. [常見問題（FAQ）](#常見問題faq)
9. [疑難排解](#疑難排解)

---

## 簡介

**agent-heartbeat-dashboard** 是 VM agent 環境的監控儀表板，集中呈現：

- **各 Claude Code agent 的存活狀態**：heartbeat 時間、MCP server 健康、當前模型
- **VM 即時資源**：CPU、RAM、磁碟、網路（透過 WebSocket 即時推送）
- **Claude 訂閱用量**：5 小時 session、週配額、串流燒率、ETA、每日活動熱力圖

部署於 Hyper-V VM 的本機 Node.js 服務，預設聽 port `3900`。

---

## 快速開始

### 啟動方式

正式環境由 Windows Scheduled Task + VBS 啟動，無需手動處理：

```
profiles/vm-agent/config/agents/heartbeat-dashboard-silent.vbs
```

開發或除錯時可直接啟動：

```bash
cd C:\ClaudeProjects\agent-heartbeat-dashboard
npm install        # 首次或依賴變更時
node server.js
```

開啟瀏覽器：`http://localhost:3900`

### 重啟服務

```powershell
# 找出執行中的 process
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*heartbeat-dashboard*' }

# 停止後 scheduled task 會自動拉起
Stop-Process -Id <PID> -Force
```

---

## 介面總覽

儀表板由三大區塊組成（由上而下）：

1. **Agent Status**：每個 agent 的卡片（heartbeat、MCP、模型版本）
2. **VM Realtime**：CPU / RAM / 磁碟 / 網路即時圖表
3. **Claude Subscription**：訂閱用量與統計

頁首附「重新整理」按鈕，會觸發即時健康檢查（不只重新載入畫面）。

---

## Agent Status 區塊

### 卡片內容

每個 agent 顯示為一張卡片，欄位包括：

- **狀態膠囊**：`Online`（綠）/ `Stale`（橘）/ `Offline`（紅）
- **CPU / RAM 膠囊**：該 agent process 的即時佔用
- **Model 膠囊**：當前載入的 Claude 模型（如 `Opus 4.7`）
- **最後 heartbeat 時間**：相對時間（`2m ago`）
- **MCP 狀態**：Telegram MCP server 是否健康（綠勾 / 紅叉）

### 重新整理

點擊頁首按鈕會：

1. 觸發 `POST /api/check-now`，呼叫 `health-check.ps1`
2. 等待結果回傳後重新渲染畫面（約 2–5 秒）

> 透過按鈕觸發的健康檢查會被標記為 `source=manual`，不會列入 Daily Routine 統計。

---

## VM Realtime 區塊

透過 WebSocket（`/ws`）接收即時 metrics：

- **CPU 折線圖**：總體使用率（過去 60 秒）
- **RAM 折線圖**：總體使用率
- **Disk caches**：磁碟快取大小
- **網路吞吐**：上下行 KB/s

斷線時會自動重連，並在頁首顯示連線狀態。

---

## Claude Subscription 區塊

整合 **ClaudeMonitor**（同一台 VM 的 .NET WPF tray app）的本機 API：

- `GET /v1/usage`：當前 session 與週用量
- `GET /v1/analysis`：14 天活動聚合
- `GET /v1/stats`：30 天 rolling-window 統計

> ClaudeMonitor 使用獨立的 claude.ai 網頁 cookie，**不會**動到 `~/.claude/.credentials.json`，因此對運行中的 agent 完全無風險。

### Header

- **Plan 膠囊**：訂閱方案（如 `Pro`、`Team`）
- **狀態膠囊**：ClaudeMonitor 連線狀態
- **Updated Xm ago**：snapshot 接收時間（靠右）

### 主要圖表

#### 5h Session 進度

當前 5 小時 session 的累計 token / 配額百分比。

#### Weekly Quota

本週用量 / 配額。

#### Burn Rate（24h）

24 小時內的串流速率柱狀圖，疊加 `Peak` 與 `Avg` 兩條 markLine。

#### Daily Routine 7×24 熱力圖

過去 14 天的活動分布：

- Y 軸：星期一（最上）→ 星期日（最下）
- X 軸：00:00 → 23:00
- 顏色強度：當小時的活動量（正規化後）
- 底部說明：「Resets daily」

### 統計卡片（8 張）

| 卡片 | 內容 |
|------|------|
| **SESSION** | Peak / Avg 雙環圖（5h session 配額使用率） |
| **WEEK** | Peak / Avg 雙環圖（週配額使用率） |
| **STREAK** | 連續使用天數，附最近 7 天圓點（含週幾字母） |
| **LAST MAXED** | 上次達到 Maxed 的天數，附時間軸標記 |
| **RATE** | 平均 / 峰值串流速率（成對長條） |
| **ETA** | 預估配額耗盡時間（進度條） |
| **HOURS** | 平均 / 峰值單日活躍小時數（成對長條） |
| **WoW** | 本週 vs. 上週（3 列成對長條：Tokens / Sessions / Hours） |

### 額外區塊

- **Session reset hour 直方圖**：所有歷史 session 的開始時段分布
- **24 小時時段強度**：依每小時平均活動量分為 5 級色階（Quiet / Normal / Active / Peak / Maxed）

---

## 響應式行為

- **桌面寬度（≥ 540px）**：所有膠囊與標題同列顯示，依各區塊原始排版
- **手機寬度（< 540px）**：
  - Agent 卡片：標題與 `Online` 膠囊保留第一列；CPU / RAM / Model 膠囊下移至第二列靠左
  - Subscription 區塊：膠囊靠左貼齊標題，僅 `Updated` 靠右
  - Daily Routine X 軸：自動降低標籤密度避免截斷

> 設計原則：手機版優先確保關鍵狀態（Online / Updated）一眼可見，次要資訊用第二列承接。

---

## 常見問題（FAQ）

### Q. Claude Subscription 一直顯示 Stale？

ClaudeMonitor 服務未啟動，或 `127.0.0.1:6736` 不通。檢查：

```powershell
Get-Process | Where-Object { $_.ProcessName -like '*ClaudeMonitor*' }
Test-NetConnection -ComputerName 127.0.0.1 -Port 6736
```

### Q. 我手動重啟 agent 後，dashboard 沒有立刻反映？

按頁首「重新整理」按鈕觸發即時健康檢查；若仍未更新，檢查該 agent 的健康檢查腳本是否正確上報到 `POST /api/heartbeat`。

### Q. 模型版本顯示為 `--`？

該 agent 尚未上報 model 欄位。檢查該 agent 的健康檢查腳本是否包含 `model` 欄位。

### Q. Daily Routine 為何是禮拜一在最上面？

依使用者偏好設定，週一為一週的開始（與 ISO 8601 一致）。

---

## 疑難排解

### Dashboard 沒有自動拉起

檢查 Windows 工作排程器是否啟用 `heartbeat-dashboard` 任務：

```powershell
Get-ScheduledTask -TaskName 'heartbeat-dashboard*'
```

### Port 3900 已被佔用

```powershell
Get-NetTCPConnection -LocalPort 3900 |
  Select-Object OwningProcess, State
Get-Process -Id <OwningProcess>
```

### SQLite 資料庫鎖死

刪除 `db/heartbeat.db-wal` 與 `db/heartbeat.db-shm` 後重啟（**不要**刪 `.db` 本體）。

### WebSocket 一直斷線重連

檢查 `metrics/ws.js` log；通常是 `metrics/collector.js` 的 PowerShell 取樣失敗（permission 或工具不存在）。
