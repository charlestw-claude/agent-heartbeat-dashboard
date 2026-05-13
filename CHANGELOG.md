# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/) and this project adheres to [Semantic Versioning](https://semver.org/).

> CHANGELOG 自 v1.6.0 起算，舊版資訊請參考 git tag 與 commit 歷史。

## [1.7.0] - 2026-05-13

### Added

- **agents.conf 為單一真相來源**：`agents-conf.js` 啟動時讀 `../../profiles/vm-agent/config/agents/agents.conf`（TSV：name / channel_dir / token_env / color），原本散在 `server.js`、`public/app.js`、`metrics/collector.js` 的三份硬編 agent 清單全部派生自 conf。新增 `GET /api/agents-meta` 給前端拿色票，`collector.js` 的 `AGENT_NAME_PATTERN` 動態組成（longest-first 排序，Claude-Quant-2 優先於 Claude-Quant）。
- **Per-agent activity timeline modal**：點任一 agent 狀態卡開啟 modal，顯示 events + Telegram 進出訊息（chronological，預設 24 h，可調 1 h–7 d）。三種 kind filter（event / inbound / outbound），最少保留一個。Heartbeat 排除避免洗版。新 endpoint `GET /api/agent/:name/timeline?hours=&kinds=&limit=`。
- **寫入端 X-Dashboard-Secret 驗證**：所有 POST/DELETE 端點（`/api/heartbeat`、`/api/event`、`/api/check-now`、`/api/tg-log`、`/api/agent/:name/fresh-start`）走 `requireWriteAuth`。Loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1) 免驗證；非 loopback 要 `X-Dashboard-Secret` header 對到 `DASHBOARD_SECRET` 環境變數。沒設環境變數時 fallback 為「僅接受 loopback」。
- **Centralised TG-message log**：新增 `tg_messages` 資料表 + `POST /api/tg-log`（plugin / hook 寫入）+ `GET /api/tg-log`（dashboard / 外部查詢）。
- **Restart-loop 偵測 + 紅 banner**：偵測連續重啟頻率超過閾值的 agent，dashboard 頂端顯示紅色 banner 告警。
- **Per-agent next-startup toggle**：狀態卡上新增按鈕，可切換下次啟動是否走 fresh-start（避開 last_session.txt resume）。`POST /api/agent/:name/fresh-start` 與 `DELETE` 對應端點。
- **Per-agent session-state endpoints**：`GET /api/agent/:name/session-state` 回傳 last_session / fresh_start 旗標。
- **Silent catch 補 log**：原本吞錯誤的 try/catch 全部加 `console.error`，方便事後追因。

### Changed

- **綁定 127.0.0.1（不再 0.0.0.0）**：dashboard server 改純 loopback 監聽，防止 LAN 內其他裝置直接打 API。
- **Agent-01 channel dir rename 收尾**：`server.js` 的 `AGENT_CHANNEL_DIRS` 同步改為 `telegram-agent-01`。

[1.7.0]: https://github.com/charlestw-claude/agent-heartbeat-dashboard/releases/tag/v1.7.0

## [1.6.0] - 2026-04-25

### Added

- **Claude Subscription panel**：整合 ClaudeMonitor 本機 API（`127.0.0.1:6736`），顯示訂閱用量、5 小時 session、週配額、串流燒率與 ETA。
- **ClaudeMonitor v2.5.0 `/v1/stats` 對接**：八張統計卡（SESSION / WEEK / STREAK / LAST MAXED / RATE / ETA / HOURS / WoW），加上 Session reset hour 直方圖與 24 小時時段強度分布。
- **Daily Routine 7×24 熱力圖**：依星期一為首列、星期日為末列排序，並顯示「Resets daily」說明。
- **Agent 模型版本膠囊**：每張 agent 卡片顯示當前 Claude 模型（如 `Opus 4.7`、`Sonnet 4.6`）。
- **Stats 輪詢層**：`metrics/claude-usage.js` 新增 `getStats()` 與對應 polling state，前端 `GET /api/claude/stats` 對應路由。
- **`renderRing()` ECharts 工具**：薄環雙軌（Peak / Avg）視覺，供 SESSION 與 WEEK 卡片使用。

### Changed

- **手機版狀態卡片排版**：第一列保留標題與 Online 膠囊靠右，其餘膠囊（CPU/RAM/Model）下移至第二列靠左，避免窄寬度溢出。
- **Daily Routine X 軸標籤**：依容器寬度自動調整顯示密度，避免文字截斷。
- **Subscription 區塊 header**：膠囊靠左貼齊標題，僅 `Updated Xm ago` 靠右。

### Fixed

- **24 小時柱狀圖 markLine 標籤**：`position: 'insideEndTop'` + 右側 padding，避免 Peak / Avg 文字超出 grid。
- **手機版膠囊溢位**：以 `@media (max-width: 540px)` viewport query 取代 container query，修正 Safari 上的相容性問題。

[1.6.0]: https://github.com/charlestw-claude/agent-heartbeat-dashboard/releases/tag/v1.6.0
