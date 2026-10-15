# dsh-opencode-session-header

給 DeepSeek Harness（DSH）的 Host bundle：替送往 **OpenCode Go** 的請求補上缺失的 `x-opencode-session` 標頭 —— 而且只在標頭真的缺了的時候才補。

## 解決的問題

OpenCode Go（`opencode.ai/zen/go`）自 2026-09-05 前後開始**強制要求**每個推理請求攜帶 `x-opencode-session`，缺了會直接拒絕路由：

```
INVALID_REQUEST 400: {"type":"MissingSessionID",
  "message":"Request is missing x-opencode-session and cannot be routed efficiently."}
```

在 DSH 裡這個標頭平常是帶得上的：agent loop 每次對話都會填一個 session id，`llm-pi-ai` 走 pi-ai 目錄 provider 時由其 `withOpenCodeSessionHeader` 從 `options.sessionId` 生成。**所以一般對話不會出問題。**

問題出在**沒有 session id 的手動組裝請求**。最典型的是內建的 `@deepseek-ai/dsh-experimental-auto-review`：它的 reviewer 呼叫（`classifyRisk()`）只帶 `provider` / `model` / `system` / `messages` / `temperature` / `signal`，沒有 `sessionId`。結果就是 —— **把權限切成 Auto review 之後，每次工具執行前的審查請求都 400，工具本身也跟著失敗。**

## 這個外掛怎麼修

包裝 host 進程的 `globalThis.fetch`，規則只有一條：

| 情況 | 行為 |
|---|---|
| host 是 `opencode.ai`（含子網域）且缺 `x-opencode-session` | 補上一個穩定的合法 token |
| 已經帶了該標頭（不分大小寫） | **原封不動** |
| 其他 provider（DeepSeek 官方、Anthropic、OpenAI…） | 完全不碰 |
| URL 無法解析或任何例外 | 回退原始呼叫，不製造新的失敗模式 |

**「只在缺失時補」是這個外掛存在的理由。** 換成在 provider profile 直接寫死一個標頭（`cordis.patch.yml` 的 `headers:`）也能讓 reviewer 通關，但那會把主對話原本正確的 per-session 值一起蓋掉 —— 等於拿對話路由／快取親和性去換。這裡不碰已存在的值，主對話維持原狀。

閘道只檢查標頭**存在且格式合法**，不驗證 session 是否真的註冊過，所以一個 process 穩定的 token 就足夠；同一個 session 的多次審查請求也會共用同一個路由鍵。

## 為什麼是包裝 fetch，不是攔截 llm/stream

`llm` service 有 `llm/stream` waterfall，看起來是理想的攔截點，但它改不動最終送出去的請求：

```js
// @deepseek-ai/dsh-llm —— stream()
return this.ctx.waterfall(this, "llm/stream", options,
  () => this.adapterStream(options, prepared));
```

final callback 用閉包捕獲了 `options` 與 `prepared`，而且不吃參數，所以 listener 即使呼叫 `next(newOptions)` 也到不了 adapter。要在請求層補東西，只能往更下層、也就是 fetch 這一層走。

## 安裝

用 DSH 的外掛管理器（`plugin_manager` → `install_bundle`，target 指向這個目錄），或 CLI：

```sh
dsh plugin --profile <profile> add <本目錄絕對路徑>

# 也可以直接從 GitHub 安裝：
dsh plugin --profile <profile> add github:NotKeKe/dsh-opencode-session-header
```

安裝成功會回報 `application: applied`，代表變更已生效（通常不需要重啟）。用 `Config.listConfigs`（不需批准）或 `dsh --profile <profile> --dump-config` 應該能看到 `opencode-session-header` 這一列。

## 驗證

**目前狀態（2026-10-15）**

| 層級 | 狀態 |
|---|---|
| 離線行為檢查（`node verify.mjs`） | ✅ 8/8 通過 |
| DSH 載入（`application: applied`、`warnings: []`） | ✅ 已確認 |
| 端到端：真實 OpenCode Go 閘道接受補上的標頭 | ⚠️ **尚未確認** |

也就是說：**規則層面已驗證，但「閘道因此放行」這件事還沒在作者機器上實測過。** 若你照著裝了卻仍然 400，那不是預期外的結果 —— 請開 issue 並附上完整錯誤訊息。

離線行為檢查（8 項：注入、不覆蓋既有值、忽略其他 host、子網域、`Request` 參數、無法解析的 URL、重複啟用不疊加、卸載還原）：

```sh
node verify.mjs
```

端到端：把權限選擇器切成 **Auto review**，然後觸發一次工具呼叫。工具正常執行就代表 reviewer 請求帶上標頭了；若仍出現 `Auto review of tool "..." failed: ... MissingSessionID ...`，先確認提供介面的 dsh 進程有沒有載入到新的 bundle。

## 移除

```sh
dsh plugin --profile <profile> remove @local/dsh-opencode-session-header
```

卸載時會還原原本的 `fetch`，不修改任何檔案、憑證或設定。

## 注意

- 以 `link:` 方式安裝時，**這個目錄不能移動或刪除**，否則外掛會失效。要清理請先移除 bundle。
- 目前沒有 Config schema。要調整目標 host 或 token 前綴，請改 `index.js` 的 `TARGET_HOSTS` / `TOKEN_PREFIX` 常數。
- 把 `VERBOSE` 設成 `true` 可以讓每次注入都印一行到 host console，方便排查；平常請保持 `false`。

## 檔案

| 檔案 | 作用 |
|---|---|
| `index.js` | 全部邏輯（fetch 包裝） |
| `package.json` | Host-only bundle manifest，零依賴、無需 build |
| `cordis.patch.yml` | 插入 `opencode-session-header` 這一列 |
| `verify.mjs` | 離線行為檢查 |

## 背景連結

- pi-ai issue：`@earendil-works/pi-ai` never sends the `x-opencode-session` header —— https://github.com/earendil-works/pi/issues/9326
- opencode issue：Go provider 400 MissingSessionID —— https://github.com/anomalyco/opencode/issues/47763
- OpenCode 官方公告（2026-09-03）：自 09/06 起，缺少此標頭的請求可能開始報錯。

## 授權

MIT License —— 見 [LICENSE](LICENSE)。
