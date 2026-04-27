# UNTRACKED_FILES.md

本檔案記錄不進入 git 但對專案運作重要的檔案。

## SQLite 資料庫

- **路徑**：`db/heartbeat.db`（含 `.db-wal`、`.db-shm`）
- **用途**：儲存所有 heartbeat 記錄、VM metrics rollup、archive 索引
- **重建方式**：首次啟動 `node server.js` 時，`db/database.js` + `db/metrics-schema.js` 會自動建立 schema
- **歷史保留**：若需保留歷史資料，從舊機備份整個 `db/` 目錄到新機相同路徑

## Archive 目錄

- **路徑**：`db/archive/`
- **用途**：每日 rollup 後的 NDJSON 歸檔
- **重建方式**：可由 `metrics/archive.js` 重新產生；歷史檔請從舊機備份

## 執行 log

- **路徑**：`server.log`
- **用途**：node process 的 stdout/stderr 落地檔（VBS 啟動時導入）
- **重建方式**：自動產生，無需備份

## Node 依賴

- **路徑**：`node_modules/`
- **重建方式**：`npm install`
