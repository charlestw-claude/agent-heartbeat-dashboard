# Cloudflare Tunnel + Zero Trust 設定指南

本文件說明如何透過 Cloudflare Tunnel 讓 `agent-heartbeat-dashboard` 從外網（含手機）安全訪問，並只允許指定的 Google 帳號登入。

---

## 1. Cloudflare 是什麼

Cloudflare 是網路的「中間人 + 門神」。原本瀏覽器直連你的伺服器，用 Cloudflare 之後變成：

```
瀏覽器 → Cloudflare 全球節點（離使用者最近）→ 你的伺服器
```

好處：

- **加速**：全球節點分布，比直連你的 VM 快
- **防護**：擋 DDoS、爬蟲、惡意流量
- **免費 HTTPS 憑證**：自動簽發與更新
- **免費額度**：個人用法幾乎用不完

---

## 2. 本專案用到的 3 個 Cloudflare 服務

### 2.1 DNS（網域名稱系統）

- 瀏覽器打 `agent.charlestw.com` → 問 DNS「這個名字對應哪裡？」
- Cloudflare DNS 回答：「走我這邊」
- 本專案做 **subdomain delegation**（子網域委派）：只把 `agent.charlestw.com` 交給 Cloudflare 管，主網域 `charlestw.com` 留在 name.com

### 2.2 Tunnel（隧道）

- 核心問題：VM 在防火牆內，外網進不來（也不該開 port）
- 解法：VM 安裝 `cloudflared`，**主動從 VM 連出去** Cloudflare，建立加密隧道
- 之後外網要連 VM，Cloudflare 從隧道「倒送」請求進來
- **關鍵**：VM 不用開任何對外 port，防火牆規則 0 變動

### 2.3 Access（Zero Trust 權限控管）

- Cloudflare 在 dashboard 前面擋一層登入頁
- 設定「只有 Google 帳號 `<你的 email>` 能進」
- 別人打網址會看到登入頁，通不過就擋在外面
- 驗證在 Cloudflare 節點做，連 dashboard 都不會被打擾到

---

## 3. 整體請求流程

```
[手機瀏覽器]
  ↓ (1) 查 agent.charlestw.com → Cloudflare DNS 回應
  ↓ (2) 連到最近的 Cloudflare 節點
[Cloudflare 節點]
  ↓ (3) Access 檢查：已登入的 Google 帳號在白名單？
  ↓     → 否 → 跳 Google 登入頁 → 驗證通過
  ↓ (4) 透過 Tunnel 送回 VM
[加密隧道]
  ↓
[VM 的 cloudflared 程式]
  ↓ (5) 轉給 localhost:3900
[dashboard server.js]
  ↓ 回應原路返回
[手機顯示 dashboard]
```

---

## 4. 安全性

- VM 防火牆 **完全不開對外 port**，攻擊面最小
- 所有流量走 HTTPS + Cloudflare 憑證
- Access 層要 Google OAuth 通過才能進
- 即使洩漏網址，沒白名單內的 Google 帳號也進不去
- Cloudflare 本身也會擋 DDoS / 惡意爬蟲

---

## 5. 設定步驟（初始部署）

### 5.1 前置準備

- 你要有的：
  - Cloudflare 免費帳號（[cloudflare.com](https://cloudflare.com) 註冊）
  - name.com 網域管理權限
  - VM 管理員權限
  - Google 帳號（要拿來當登入身分）

### 5.2 在 Cloudflare 加 subdomain zone

1. 登入 Cloudflare Dashboard
2. 右上「Add a Site」→ 輸入 `agent.charlestw.com`（**注意是子網域，不是根網域**）
3. 選 Free 方案
4. Cloudflare 會給你兩個 nameserver，例如：
   ```
   ada.ns.cloudflare.com
   walt.ns.cloudflare.com
   ```
   把這兩個記下來

### 5.3 在 name.com 新增 NS 紀錄

1. 登入 name.com → 進 `charlestw.com` 的 DNS 管理
2. **新增**兩筆 NS 紀錄（不要刪原本的）：
   ```
   Host: agent
   Type: NS
   Value: ada.ns.cloudflare.com
   
   Host: agent
   Type: NS
   Value: walt.ns.cloudflare.com
   ```
3. 等 DNS 傳遞（通常 5 分鐘 ~ 1 小時）
4. 用 `nslookup -type=NS agent.charlestw.com 8.8.8.8` 驗證是否指到 Cloudflare

### 5.4 建立 Tunnel

1. Cloudflare Dashboard → Zero Trust（左下角）→ Networks → Tunnels
2. Create a tunnel → Cloudflared → 命名例如 `vm-agent-dashboard`
3. Cloudflare 顯示安裝指令（Windows 選 64-bit）
4. 複製 token（下一步 VM 安裝時要用）

### 5.5 在 VM 安裝 cloudflared

```powershell
# 用 winget 安裝（簡單）
winget install --id Cloudflare.cloudflared

# 驗證
cloudflared --version
```

接著註冊為 Windows Service（開機自動啟動）：

```powershell
# 用 Cloudflare 給你的 token
cloudflared.exe service install <TOKEN>
```

服務會出現在 Windows Services，自動啟動、開機執行。

### 5.6 設定 Tunnel 路由

回到 Cloudflare Zero Trust Dashboard → 剛建的 tunnel → Public Hostname：

```
Subdomain: （空白）
Domain: agent.charlestw.com
Service Type: HTTP
URL: localhost:3900
```

儲存後 Cloudflare 自動在 DNS 加一筆 CNAME 指到 tunnel。

### 5.7 開 Cloudflare Access（Google OAuth）

1. Zero Trust Dashboard → Settings → Authentication → Login methods → Add new → **Google**
2. 按畫面指示到 Google Cloud Console 建 OAuth client，填回 Client ID / Secret
3. Zero Trust Dashboard → Access → Applications → Add Application → Self-hosted
4. Application name: `Agent Dashboard`
5. Application domain: `agent.charlestw.com`
6. Identity providers: 勾 Google
7. 下一步 → Policy：
   - Action: Allow
   - Include: Emails → 填你的 Google email
8. 儲存

### 5.8 測試

- 瀏覽器開 `https://agent.charlestw.com`
- 應該跳 Cloudflare 登入頁 → 用 Google 登入
- 登入成功 → 看到 dashboard
- 用別的裝置 / 手機驗證可連得到

### 5.9 加到手機主畫面（PWA）

- iOS Safari：分享 → 加入主畫面
- Android Chrome：選單 → 安裝應用程式

---

## 6. 後續維運

### 6.1 檢查 Tunnel 狀態

```powershell
# Service 狀態
Get-Service cloudflared

# 實時 log（最近 50 行）
Get-EventLog -LogName Application -Source cloudflared -Newest 50
```

### 6.2 更新 cloudflared

```powershell
winget upgrade --id Cloudflare.cloudflared
```

### 6.3 Access 政策調整

- 新增可登入 email：Zero Trust → Access → Applications → 編輯 policy
- 要加 session 逾時、國家限制也在同一個頁面

### 6.4 如果 Tunnel 斷線

- Cloudflare Dashboard → Zero Trust → Networks → Tunnels 看狀態
- VM 上 `services.msc` 確認 cloudflared service 正在跑
- 必要時重啟 service：`Restart-Service cloudflared`

---

## 7. 疑難排解

### 7.1 DNS 還沒生效

- `agent.charlestw.com` 打不開 → 用 `nslookup -type=NS agent.charlestw.com 8.8.8.8` 檢查 NS 紀錄是否指到 Cloudflare
- 如果還是指 name.com → 等更久，或檢查 NS 紀錄是否填對

### 7.2 Cloudflare 要求驗證網域擁有權

- 畫面會顯示「加一筆 TXT 紀錄到 `charlestw.com` 根網域」
- 回 name.com DNS 管理頁，新增那筆 TXT（不動原有紀錄）
- 等 5 分鐘，回 Cloudflare 按 verify

### 7.3 Access 登入失敗

- Google 帳號不在白名單 → 回 Access policy 確認 email
- 登入頁報「Invalid redirect URI」→ Google OAuth client 的 redirect URI 沒填對，照 Cloudflare 指示修

### 7.4 打 agent.charlestw.com 看不到 dashboard，只看 Cloudflare 預設頁

- Tunnel Public Hostname 的 service URL 填錯（應該是 `localhost:3900`，不是 `http://localhost:3900` 也不是 `127.0.0.1`）

---

## 8. 移除

如果以後要拆掉：

```powershell
# VM 上
cloudflared.exe service uninstall
winget uninstall Cloudflare.cloudflared
```

Cloudflare Dashboard 側：

- Zero Trust → Access → Applications → 刪 application
- Zero Trust → Networks → Tunnels → 刪 tunnel
- Cloudflare 主介面 → 刪 `agent.charlestw.com` zone

name.com 那邊刪掉那兩筆 NS 紀錄。
