# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/) and this project adheres to [Semantic Versioning](https://semver.org/).

> CHANGELOG 自 v1.6.0 起算，舊版資訊請參考 git tag 與 commit 歷史。

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
