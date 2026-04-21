# Tailscale Serve 設定指南

本文件說明如何用 Tailscale Serve 讓 `agent-heartbeat-dashboard` 從外網（手機 / 筆電）私密地存取，不對公網曝露、不需自訂網域。

---

## 1. Tailscale 是什麼

**一句話**：零設定的 VPN mesh，讓你的所有裝置組成一個私人網路。

- **組織**：Tailscale Inc.（加拿大 SaaS 公司）
- **技術基礎**：[WireGuard](https://www.wireguard.com/)（開源 VPN 協定，業界公認最佳）
- **Tailscale 的價值**：在 WireGuard 之上加了身分管理（SSO）、NAT 穿透、跨平台 app、coordination server

每個裝置裝 Tailscale app 後，自動拿到一個固定的 tailnet 內網 IP（`100.x.x.x`）和 DNS 名稱（`<device>.<tailnet>.ts.net`）。裝置間用 WireGuard **點對點加密**連線（流量不經 Tailscale 伺服器）。

---

## 2. 為什麼選 Tailscale Serve 而非 Funnel / Cloudflare Tunnel

| 方案 | URL | 公網曝光 | 看 dashboard 要裝 client | 費用 | 設定時間 |
|------|-----|---------|-------------------------|------|---------|
| **Tailscale Serve**（本專案） | `xxx.ts.net`（私有） | **否** | 要 | $0 | 10 分鐘 |
| Tailscale Funnel | `xxx.ts.net`（公開） | 是 | 不用 | $0 | 10 分鐘 |
| Cloudflare Tunnel + Access | 自訂網域 | 是（加 OAuth） | 不用 | $0（要根網域） | 30+ 分鐘 |

**選 Serve 的理由：**
- 單人監控 → 裝 Tailscale 只在自己的裝置（手機 + 筆電），1-2 台負擔很小
- **0 公網曝光** = 網際網路掃描不到、連網址都不存在於公網
- 設定最快、不用管網域 / 憑證 / OAuth
- 以後延伸到 RDP / SSH / 其他 dashboard 都走同一套機制

---

## 3. 安全性說明

### 優點
- WireGuard 點對點加密，Tailscale 伺服器**看不到你的流量內容**
- 每個裝置要用你的 SSO（Google / GitHub / Microsoft）身分授權才能加入 tailnet
- Client 原始碼公開（可審）
- 零公網 port forwarding、零對外服務

### 信任邊界
- Tailscale coordination server 掌握 metadata（哪些裝置屬於你、公鑰），但不是流量內容
- **強烈建議** Google 帳號開 2FA，防止 tailnet 被人加裝置
- 若要完全自主，可以跑開源的 [Headscale](https://github.com/juanfont/headscale) 自架 coordination server（本專案不需要）

### 相對比較
- ✅ Tailscale：零公網 port forward、業界最佳實踐
- ❌ 傳統「家裡 router 開 port forwarding」或「動態 DNS」：port 曝露在公網，天天被黑客掃

---

## 4. 整體流程

```
[手機 / 筆電]                              [VM]
   |                                         |
   | Tailscale client 連上 tailnet           | Tailscale client 連上 tailnet
   | (使用 Google SSO 登入)                  | (使用同一個 Google 帳號登入)
   |                                         |
   | 瀏覽器訪問                              | Tailscale serve 把 :3900 暴露
   | https://vm-agent.xxx.ts.net             | 給 tailnet 內部
   |                                         |
   +------ WireGuard 加密通道 -------------> |
                                             |
                                         [localhost:3900 dashboard]
```

全程不經公網、HTTPS 憑證由 Tailscale 自動簽發與更新。

---

## 5. 設定步驟（初始部署）

### 5.1 前置準備

- Google 帳號（用來登入 Tailscale）
- VM 管理員權限
- 一台手機或筆電（之後要看 dashboard 用）

### 5.2 註冊 Tailscale 帳號

1. 瀏覽器打開 https://login.tailscale.com/start
2. 選 **Sign in with Google**（建議；之後所有裝置都用這個身分）
3. 授權 → 帳號建立完成

這一步會建立一個 **tailnet**，名稱通常是 `<你的 google 帳號前綴>.ts.net` 或 Tailscale 自動產生的名稱（例如 `tail1234.ts.net`）。

### 5.3 VM 安裝 Tailscale

```powershell
# 用 winget 安裝
winget install --id Tailscale.Tailscale

# 或從官網下載 msi
# https://tailscale.com/download/windows
```

安裝完畢後：

1. 系統匣會出現 Tailscale 圖示
2. 點圖示 → 「Log in」
3. 瀏覽器跳出 Tailscale 登入頁 → 用你的 Google 帳號登入 → Authorize
4. 裝置加入 tailnet 成功

驗證：

```powershell
# 查看 tailnet 內裝置清單 + 本機 IP
tailscale status

# 查看本機 tailnet IP（應該是 100.x.x.x）
tailscale ip -4
```

### 5.4 VM 開啟 Tailscale Serve（分享 dashboard）

```powershell
# 把本機 localhost:3900 暴露到 tailnet，HTTPS 端口
tailscale serve --bg https / http://localhost:3900
```

參數說明：
- `--bg`：背景執行（常駐、開機自動啟動）
- `https`：自動申請 `*.ts.net` 的 HTTPS 憑證
- `/`：路徑根目錄
- `http://localhost:3900`：要轉發的本機服務

驗證：

```powershell
# 查看目前 serve 狀態
tailscale serve status

# 應該顯示類似：
# https://vm-agent.<tailnet>.ts.net (tailnet only)
#   → http://localhost:3900
```

記下那個 URL（`https://vm-agent.<tailnet>.ts.net`），之後手機 / 筆電要用。

### 5.5 手機 / 筆電安裝 Tailscale

**手機（iOS / Android）：**
- App Store / Play Store 搜尋 "Tailscale" 下載
- 打開 app → Sign in with Google（同一個 Google 帳號！）
- 允許 VPN 權限
- 首頁會看到 tailnet 內裝置（應該看到 VM）

**筆電：**
- 下載對應平台 app：https://tailscale.com/download
- 安裝 → Sign in with Google（同一個帳號）
- 系統匣圖示 → 確認 Connected

### 5.6 測試訪問

**在手機 / 筆電上：**
1. 打開 Tailscale app，確認已連線（icon 亮著）
2. 瀏覽器打開 `https://vm-agent.<tailnet>.ts.net`（實際 URL 看 `tailscale serve status`）
3. 應該看到 dashboard ✓

**加到手機主畫面（PWA）：**
- iOS Safari：分享 → 加入主畫面
- Android Chrome：選單 → 安裝應用程式

---

## 6. 後續維運

### 6.1 查看狀態

```powershell
# Tailscale 連線狀態
tailscale status

# Serve 狀態
tailscale serve status

# Tailscale service 是否在跑
Get-Service Tailscale
```

### 6.2 更新 Tailscale

```powershell
winget upgrade --id Tailscale.Tailscale
```

或從系統匣圖示右鍵 → Check for updates。

### 6.3 新增裝置

- 新裝置上裝 Tailscale → Sign in with Google（同帳號）→ 自動加入 tailnet

### 6.4 移除裝置 / 調整權限

- 登入 Tailscale admin console：https://login.tailscale.com/admin/machines
- 看到所有 tailnet 內裝置，可以移除 / 重新命名 / 設過期

### 6.5 新增其他服務到同一個 tailnet

- 例如把家裡 Windows 加入 → RDP 連線走 Tailscale（詳見另一份指南）
- 或多個 dashboard → 每個都用 `tailscale serve` 指到不同 port

---

## 7. 疑難排解

### 7.1 `tailscale serve` 指令回報「Access denied」
- PowerShell 要以管理員身分啟動

### 7.2 瀏覽器打 URL 回 "ERR_CONNECTION_TIMED_OUT"
- 檢查手機 / 筆電的 Tailscale 是否連線（icon 是否亮）
- `tailscale status` 看 VM 和客戶端是否都在 tailnet 內
- 確認 VM 的 Tailscale service 在跑：`Get-Service Tailscale`

### 7.3 HTTPS 憑證錯誤
- `tailscale serve https` 指令第一次執行時需要幾秒申請憑證，等一下重試

### 7.4 裝置看不到彼此
- 確認**所有裝置**都用**同一個 Google 帳號**登入 Tailscale
- admin console（https://login.tailscale.com/admin/machines）確認裝置都在

### 7.5 忘記 tailnet URL
```powershell
tailscale serve status
```

---

## 8. 移除

如果以後要拆掉：

```powershell
# 停止 serve
tailscale serve reset

# 登出 / 移除裝置
tailscale logout

# 完整解除安裝
winget uninstall Tailscale.Tailscale
```

admin console 那邊也可以把對應裝置刪除。

---

## 9. 延伸應用

同一套 Tailscale 可以用在：
- **家裡 Windows RDP**：取代動態 DNS + port forwarding，0 公網曝露（待做）
- **SSH 到任何 tailnet 內裝置**：不用開 22 port
- **NAS / 檔案分享**：直接透過 tailnet IP 存取
- **其他內部 dashboard / 工具**：每個用 `tailscale serve` 指到不同 port 或 hostname

所有新服務都共享同一個身分驗證（你的 Google 帳號），一次裝好 Tailscale，後續都省事。
