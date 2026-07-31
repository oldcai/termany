# 通用 Pane RPC + 内嵌浏览器调试/自动化 — 执行与验收

> 这份文档是**执行状态 + 验收标准**,不是设计文档。目标是任何人(包括冷启动的 agent)读完能接着干,
> 且不重新推导已经核实过的事实、不重新讨论已经定下的决策。
>
> 完整设计推导见 `~/.claude/plans/pane-delegated-cherny.md`(仓库外)。本文件在"已核实的事实"和
> "已定决策"两节里保留了所有**承重**结论,失去那份文档也不影响施工。

## 0. 要做什么

pane1 跑 `npm run dev`,pane2 开着页面,pane3 的 agent 能自己读 console、点按钮、验证改动 ——
不用人来回复制粘贴。同时人也能在 web pane 里看到**同一份** console/network 数据。

顺带把 pane 之间的引用/控制做成通用能力(现在只有 `cwdFrom`、`queueCommand`、`addPane`、
`webview_history` 四个点对点的硬编码)。

---

## 1. 当前状态

| Phase | 内容 | 状态 |
|---|---|---|
| Spike A | `eval_with_callback` 在子 webview 上可用? | ✅ **通过**,7 个问题全部实测有答案,见 §2.7 |
| Spike B | ACP adapter 支持 http MCP? | ✅ 通过 |
| 0 | 安全基线 | ✅ 完成并实测,已提交 `ccbcdf6` |
| 0b | 打包 webview 的真实 `Origin` | ✅ **已实测**:`tauri://localhost`,零条 blocked |
| 1 | Rust `web_pane` 层 | ✅ **完成并实测**,43 项真机验收全过,见 §2.8 |
| 1.5 | 原地导航 | ✅ **完成并实测**,见 §2.8 |
| 2 | 采集 + drain | ✅ **完成并实测**(页内采集 + drain + renderer 轮询 + 服务端持久 ring),见 §2.8 |
| 2.5 | 徽章 + Inspect | ✅ **完成并截图验证**,见 §2.8 |
| 3 | Store 重构 + 控制通道 | 🟡 **主体完成并实测**(20/20 真机 e2e),见 §2.9。**剩一项**:无窗口时的 SQLite 兜底 |
| 4 | 生命周期 + 终端 + policy | ⬜ |
| 5 | MCP 门面 + agent 接线 | ⬜ |
| 6 | 自动化(snapshot/click/type/wait) | ⬜ |
| 7 | 截图 | ⬜ |
| 8 | DevTools 抽屉 | ⬜ |
| 9 | ACP client capabilities(独立后续) | ⬜ |

**下一步:补完 Phase 3 的 SQLite 兜底(见 §2.9 末尾),然后 Phase 4。**
Phase 4 接手时注意:`policyMode` 目前硬编码 `"ask"`,`requestConsent` 直接返回 false(fail closed)
—— 这两个挂钩已经在 `paneControl/http.ts` 的 `DispatchDeps` 里,Phase 4 只需接上 Settings 和 consent UI。

**注意依赖是硬的**:MCP 是门面,底下没东西它就没得暴露 —— 这是它排在第 5 而不是第 1 的原因。
Phase 1 给 eval 能力,Phase 2 给数据,Phase 3 让 server 够得着 renderer 里的 pane,Phase 5 才有东西可包。

---

## 2. 已核实的事实(不要重新推导)

### 2.1 Tauri 2.11 API —— 整个方案的地基

全部在 crate 源码核实过(`~/.cargo/registry/src/index.crates.io-*/`)。锁的是 `tauri 2.11.3`,
核对的源码是 2.11.2/2.11.5(本地 registry 没有 .3);patch 级漂移极不可能,但 `navigate` 在
规划 Phase 1.5 前先确认能编译。

| 事实 | 坐标 | 为什么承重 |
|---|---|---|
| `Webview::eval_with_callback(js, cb)` 存在,结果 JSON 序列化后回传 | `tauri/src/webview/mod.rs:1929` | **页面完全不需要向外发网络请求** → 页面 CSP 完全无关 |
| `WebviewBuilder::initialization_script` | `:868` | document-start 注入,每次导航都跑,main frame only |
| JS 端 `WebviewOptions` **没有** `initializationScript`,JS `Webview` **没有** `eval` | `@tauri-apps/api/webview.d.ts:420-560, :106-369` | 所以 webview 创建**必须**搬到 Rust |
| `new Webview(win, label, { skip: true })` 在已有 label 上套 handle,**零 IPC** | `@tauri-apps/api/webview.js:144-155`;Tauri 自己的 `getAllWebviews()` 就用这招 `:38-46` | **`WebBrowserPane.tsx` 的 occlusion/reveal 舞蹈一行都不用改** —— 全方案风险最低的关键点 |
| `show/hide/setPosition/setSize/setFocus/close` 全是纯 label invoke | `webview.js:357-448` | 同上 |
| `Webview::navigate(url)` / `reload()` 存在 | `webview/mod.rs:1689, :1694` | 不用再销毁重建 webview |
| `on_navigation` / `on_page_load` / `on_document_title_changed` | `:528 / :688 / :594` | 地址栏能跟上页内跳转 |
| `open_devtools()` 需要 cargo `devtools` feature 才能进 release | `:2007`;Windows 的 `close_devtools`/`is_devtools_open` 不支持 `:2043, :2079` | Phase 2.5 要改 Cargo.toml |
| 打包 app 自身 origin:Windows/Android `http(s)://tauri.localhost`,其余 `tauri://localhost` | `tauri/src/manager/mod.rs:340-346`,crate 自带断言 `:785-791` | Origin 白名单内容 |

### 2.2 wry / WebKit 的五个坑(全部必须处理,否则崩溃、挂死或全站失效)

| 坑 | 坐标 | 处理 |
|---|---|---|
| **首次导航 commit 之前,eval callback 被静默丢弃**(push 进 `pending_scripts` 时 callback 被 move 进去然后 drop);`pending_scripts` 在第一次 `didCommitNavigation` 置 `None` 且**永不重新武装** | `wry/src/wkwebview/mod.rs:720-723`;`navigation.rs:34` | 自己维护 `PaneInfo.committed`,未 commit 直接快速失败,而不是等满超时 |
| **注入的 wrapper 必须永远返回 JS `String`** —— 否则 app **当场死**。**已实测**(§2.7 Q6):不是 Rust panic,是 **ObjC 未捕获异常**,`catch_unwind` **拦不住**,Rust 侧根本无法防御 | `mod.rs:731-756`;实测栈见 §2.7 | 崩溃防护,不是优雅性问题 |
| **异常被吞** —— wry 丢弃 `NSError`,抛异常时 callback 收到 `""`,和 `undefined`/`null` 无法区分 | 同上 | wrapper 自己 try/catch,返回 `{ok,value|error,name}` 信封 |
| **双层解码** —— wry 把返回的 JS 值 JSON 序列化,所以字符串到 Rust 是被引号包过一层的 | 同上 | `from_str::<String>()` 再 `from_str::<Envelope>()` |
| **页面 CSP 管得住 `eval()`** —— Phase 1 实测才发现,不在原设计里 | 见下 | wrapper **不许出现 `eval`**,把用户代码文本内联 |

**第五个坑展开(它一度让所有带 CSP 的页面全挂):**

`evaluateJavaScript:` 注入本身**不受**页面 CSP 管(Spike A 已证实,`script-src 'none'` 下我们照跑)。
但 wrapper 内部若用 `eval(<用户JS字符串>)`,那次**运行时字符串→代码编译**是受 `script-src` 管的 ——
除非页面给了 `'unsafe-eval'`,否则整条 eval 以 `EvalError` 失败。原设计的 wrapper 正是
`eval(<USER_JS_JSON>)`,在 `script-src 'self' 'unsafe-inline'` 的页面上**全军覆没**。
Spike A 没暴露它,因为 spike 调的是 `ping()` 这种直接函数调用,不是 `eval`。

**修法:把用户代码文本内联进脚本源。** 因为不解析就无法判断传进来的是表达式还是语句,两种都要支持:
1. 先试 `function(){ return (<src>); }` —— 表达式(`1+1`、`document.title`)
2. 空响应 = 没编译过,退回 `function(){ <src> }` —— 语句(`let a=1; return a;`)
3. 两种都空,再探一次 `__TERMANY__` 在不在:在 → 报"语法错误";不在 → 报"instrumentation 没跑起来"

代价是语法错误会让整脚本编译失败(拿不到信封),所以第 3 步的探测是必要的,不然错误信息毫无指向。
`the_wrapper_never_uses_eval` 单测锁死这条防回退。**注意:语句形式必须自己写 `return`。**

另:WKWebView 的 `evaluateJavaScript` **不 await promise**。→ `run()` 返回 `{ok:true,pending:"<id>"}`,
Rust 以 5/10/20/40/80/100ms 退避轮询 `take(id)`,超时后 fire-and-forget `cancel(id)` 释放槽位。

Oneshot 用 `std::sync::mpsc::sync_channel(1)` + `recv_timeout`,**不用 tokio**:`tauri::async_runtime`
没 re-export `oneshot`,且 tauri 的 tokio feature 集不含 `time`。而且 `SyncSender::send` 取 `&self`,
直接适配 wry 的 `Fn`(非 `FnOnce`)callback;`RecvTimeoutError` 还能区分 `Timeout` 和 `Disconnected`
—— 后者正好是"callback 被 drop 了"的信号。

所有命令 `async fn` + `spawn_blocking`(sync 命令默认跑在事件循环线程上,阻塞 5 秒冻住整个 UI)。

### 2.3 Spike B 结果(2026-07-29 实测)

三个 ACP adapter 全部 advertise `mcpCapabilities.http: true`,`withMcpServer` 路线可用:

| adapter | version | mcpCapabilities |
|---|---|---|
| `@agentclientprotocol/claude-agent-acp` | 0.63.0 | `{http:true, sse:true}` |
| `@agentclientprotocol/codex-acp` | 1.1.7 | `{acp:false, http:true, sse:false}` |
| `opencode acp` | 1.17.11 | `{http:true, sse:true}` |

ACP `PROTOCOL_VERSION = 1`。codex 明确 `acp:false` → **不要建在 `McpServerAcp` 上**(它也被标 UNSTABLE)。
探测脚本保留在 scratchpad,需要时重写很便宜(裸 JSON-RPC over NDJSON stdio,约 100 行)。

### 2.4 Phase 0 实测发现

- **macOS 把 `localhost` 优先解析成 `::1`**(`dns.lookup('localhost')` → `::1` family 6)。所以只绑
  `127.0.0.1` 会打断所有用 `localhost` 的客户端。已改成双 loopback 监听。
- **app 自己的请求就是 cross-site** —— dev client 在 `localhost:15173`,API 在 `127.0.0.1`,浏览器
  正确标成 `Sec-Fetch-Site: cross-site`。所以该头**只能在没有 Origin 时**用来判断,否则 403 掉 app 自己。
- 修复前的存量漏洞是实锤的:运行中的 0.1.25 server 监听在 `TCP *:5174`(所有网卡)。

### 2.5 代码坐标(会用到的现成东西)

| 用途 | 坐标 |
|---|---|
| pane 树 / `PaneView` / leaf 字段 | `apps/web/src/state/store.ts:31, :55-113, :125-157` |
| pane id = `crypto.randomUUID()`,**同时是终端 session id** | `store.ts:312`;SSH 是 `${paneId}:ssh:${host}` `manager.ts:210` |
| 跨树查找 / 全局改 leaf / 跳转 | `store.ts:1717` / `:710` / `:216` |
| 活 terminal 注册表(React 之外) | `manager.ts:174-181` |
| 注入命令(未挂载时缓冲,挂载后 50ms 冲刷) | `manager.ts:1750`;冲刷 `:1567` |
| **bracketed paste**(多行文本投递,`queueCommand` 会追加 `\r` 在第一行就提交,别用错) | `manager.ts:1762` |
| 判断 pane 是否在跑交互式 TUI | `manager.ts:1767` |
| dev server 自动发现(打印过的 URL ∩ 进程树在监听的端口) | `apps/web/src/terminal/servedUrls.ts:223`;`apps/server/src/sessionPorts.ts` |
| scrollback 合并(live ring ∪ SQLite),**服务端直接可答** | `apps/server/src/index.ts:891-908` |
| ACP runtime,一个 pane 一个 Runtime | `apps/server/src/acpRuntime.ts:326`;session 创建 `:155-203` |
| ACP permission 往返(consent UI 的模板) | `acpRuntime.ts` → `index.ts:814` |
| action registry / handler map / 程序化入口 | `keybindings.ts:65` / `App.tsx:149-254` / `App.tsx:261` |
| native view 遮挡登记(**整块布尔,不能局部裁剪**) | `apps/web/src/nativeViewOcclusion.ts:44-56` |
| web pane 创建 + 那套 occlusion/reveal 舞蹈 | `WebBrowserPane.tsx:110-229`(五处 `canReveal()` 竞态防护) |
| ANSI 剥离器(**已经重复两份,别写第三份**) | `manager.ts:415` 和 `servedUrls.ts:33` → 提到 `packages/core` |
| 跑 dev app 用的是 `tauri.dev.conf.json`(只覆盖 productName/标题/图标,`devUrl` 和 `security.csp` 都继承 base) | `apps/desktop/package.json` 的 `dev` script |

### 2.6 各 agent CLI 的 MCP 注册能力(2026-07-29 实测,非记忆)

版本:`claude` 2.1.220、`codex-cli` 0.145.0、`gemini` 0.46.0、`opencode` 1.17.11。

| CLI | 项目级? | 落盘位置 | token 处理 | 启动时注入(不碰用户文件) |
|---|---|---|---|---|
| claude | ✅ `-s project` | 仓库根 `.mcp.json`(**设计上要提交**) | `${VAR}` **原样存下**,不在写入时展开 | ✅ `--mcp-config <files...>` |
| claude | ✅ `-s local`(**默认**) | `~/.claude.json` 按项目路径分键,**不进仓库** | 字面值 | 同上 |
| gemini | ✅ `-s project`(**默认就是它**) | `.gemini/settings.json` | `-H` 头 | 未查 |
| codex | ❌ `codex mcp add` 明确输出 "Added **global** MCP server" | `~/.codex/config.toml` 的 `[mcp_servers.<name>]` | **`bearer_token_env_var` = 变量名,不是值**(官方为此设计) | ✅ `-c mcp_servers.x.url=...`;另有 `--profile` 叠加 `$CODEX_HOME/<name>.config.toml` |

**⚠️ `--strict-mcp-config` 绝对不能用** —— 它的语义是"只用 `--mcp-config` 里的 server",会**静默禁掉用户自己所有的 MCP server**。Termany 只用 `--mcp-config`(叠加式)。

**关键性质**:`.mcp.json` 里的 `${TERMANY_MCP_TOKEN}` 是原样存的(已实测)。配合 Termany 往每个终端
pane 注入 `TERMANY_MCP_URL`/`TERMANY_MCP_TOKEN`,一个**提交进仓库的 `.mcp.json` 反而是安全的**:
在 Termany 的 pane 里变量有值 → 工作;队友 clone 下来变量没值 → 自动失效,不泄任何东西。
codex 的 `bearer_token_env_var` 是同一思路。
(尚未实测的是运行时**展开**行为 —— Claude Code 文档说支持 `${VAR}`,Phase 5 顺手验一下。)

---

### 2.7 Spike A 结果(2026-07-29 实测,`apps/desktop/src-tauri/src/spike_a.rs`)

用 `TERMANY_SPIKE_A=1 npm run dev:desktop` 跑,目标是三张只有 CSP 不同的页面。
**§2.2 那四个坑全部得到实证,没有一个是纸上推断。**

| 问题 | 实测结果 | 影响 |
|---|---|---|
| Q1 `eval_with_callback` 在**子** webview 上 | ✅ `1+1` → `"2"` | **Spike A 核心问题通过**,Phase 1 按原设计走,不用退到 postMessage 中转 |
| Q2 `initialization_script` 在子 webview + 远程 URL | ✅ `typeof` → `"object"`,`ping()` → `"pong"` | Rust 侧创建 webview 的方案成立 |
| Q3 **页面 CSP 对我们有影响吗** | ✅ **零影响**,见下表 | **D1 得到实证** |
| Q4 抛异常时 callback 收到什么 | `""` | 和 `undefined` **完全无法区分**(Q4b `void 0` 也是 `""`)→ **信封是强制的** |
| Q5 返回 JS 字符串的形状 | `'a string'` → `"\"a string\""` | **双层解码是必须的** |
| Q6 `NaN` | 💥 **app 当场死** | 见下 |
| Q7 首次 commit 前 eval | `DROPPED (callback destroyed)` | 和源码预测一致 → `PaneInfo.committed` 闸门是必须的。注意它表现为 **Disconnected 而非 Timeout**,所以能立刻报错而不是等满超时 |

**Q3 三页对照** —— 这是整个采集架构的地基:

| 页面 | 页面自己的脚本 | 页面 fetch | 我们的 init script | 我们的 eval | drain 拿到 |
|---|---|---|---|---|---|
| `/strict`(`script-src 'none'`) | ❌ 被封 | — | ✅ 跑了 | ✅ 工作 | 0 条(页面没输出可采,对照正确) |
| `/permissive`(无 CSP) | ✅ | ✅ `FETCH-SUCCEEDED` | ✅ | ✅ | **6 条** |
| `/egress-blocked`(`connect-src 'none'`) | ✅ | ❌ **`fetch-blocked`** | ✅ | ✅ | **6 条** |

最后一行就是结论:**页面的出口被彻底封死,我们照样把数据全部拉出来。**
任何"页面把日志 POST 给我们"的设计在这一行就死了。采到的 6 条覆盖 `console.log`(含对象/数组序列化)、
`console.warn`、`console.error`、`unhandledrejection`、`window.onerror` —— 三条采集链路全通。

**Q6 的精确机制(修正:不是 Rust panic)**
```
wry::wkwebview::InnerWebView::eval::{{closure}}
  → +[NSJSONSerialization dataWithJSONObject:options:error:]
    → objc_exception_throw
       NSInvalidArgumentException: "Invalid number value (NaN) in JSON write"
      → libc++abi: terminating due to uncaught exception of type NSException
```
是 **Objective-C 异常**,不是 Rust unwind。所以 `catch_unwind` 拦不住,`error:` 出参也来不及填 ——
**Rust 侧完全没有防御手段**。唯一的防线是注入的 JS 永远返回 String。
spike 里这一项现在挂在 `TERMANY_SPIKE_A_NAN=1` 后面,因为它会把整个 spike 运行带走。

> `spike_a.rs` 是一次性探针,默认 inert(要 `TERMANY_SPIKE_A=1` 才跑)。**Phase 1 落地后删掉**,
> `web_pane/` 取代它。在那之前它是这些行为唯一的实证工具,留着。

### 2.8 Phase 1 验收结果(2026-07-29)

验收装置 `apps/desktop/src-tauri/src/web_pane/selftest.rs`(`TERMANY_WEB_PANE_SELFTEST=1` 才跑,
默认 inert),走的是**真实的 `create_pane` + `eval::run`**,不是 mock —— 这里能坏的东西全是
WKWebView/wry 的运行时行为,单测碰不到。它取代了一次性的 `spike_a.rs`。

**结果:ALL PASS(43)。** 三种 CSP profile(`/permissive`、`/egress-blocked`、`/strict`)
**表现完全一致**,每种 14 项:算术、instrumentation 就位、抛异常可区分、undefined 不算错、
`NaN` 不崩、`[Infinity,-Infinity,NaN]` 不崩、循环引用不挂、await promise(371ms)、
rejected promise、慢 promise 超时(不挂死)、页面无法卸载我们的钩子、DOM 节点安全序列化、
语句形式回退、语法错误被正确命名。外加生命周期 50 轮建/销 → `webviews 1 → 1`,**无孤儿**。

**renderer 侧也已真机验证**:用隔离 `HOME` 起了一套独立 SQLite(不碰用户布局),种入一个 web pane,
真实 `WebBrowserPane` 通过新路径创建成功:
```
[termany] web pane web_068aa09f-…-7b2b50335ebe_ktwbtx_0 created at http://127.0.0.1:5197/permissive
```
label 格式正是 `web_${paneId}_${mountId}_${viewKey}`,无任何报错。

静态:21 个 Rust 单测、60 个 server 测试、38 个 web 测试、web typecheck 全过。

**Phase 1.5(原地导航)也已完成并实测**,总计 44 项全过:
- `nav: initial path` → `/permissive`;`nav: landed on new path` → `/strict`(**新文档里 eval 正常**,
  说明 `on_page_load` 把 `committed` 重新打开了)
- `nav: eval gate closes` → 导航 gap 期间 `committed = false`,eval 会拒绝而不是打到即将销毁的旧文档
- `nav: no rebuild` → **同一个 webview**,`nav_count 1 → 2`(这是这一阶段的全部意义)
- renderer 侧端到端验证:pane 种在 `/redirect`,跟随 302 到 `/permissive`,`web-pane://state`
  事件到达 renderer → 地址栏更新 → 持久化的 `webUrl` 变成 `/permissive`。
  **这同时证明了"点链接后地址栏不跟随"那个存量 bug 已修。**

**Phase 2 的页内采集半边也已完成并实测**(总计 50 项全过):

`instrument.js` 加了 console 六级 + `window.onerror` + `unhandledrejection` + `fetch`/`XHR` monkeypatch,
两个独立 ring(500 / 300)、每条 4KB、全局 1MiB 软上限、连续重复折叠成 `count`。
新增 `web_pane_drain` 命令(直接函数调用,不走 eval —— 因此既免疫 CSP 也免疫用户代码的语法错误)。

| profile | logs | net | 说明 |
|---|---|---|---|
| `/permissive`(无 CSP) | 10 | 1 | 对照组 |
| `/egress-blocked`(`connect-src 'none'`) | **10** | **1** | **和对照组完全一致** —— 页面的 fetch 被 CSP 封死,我们照样拿到它的 console **和那次失败请求的记录** |
| `/strict`(`script-src 'none'`) | 4 | 0 | 页面脚本被封,但 WebKit 把 **CSP 违规**报到 console,我们如实采到 —— 这是特性不是噪音:"这页为什么什么都不跑"正是这些消息回答的问题 |

两次 drain 之间正确清空(第二次为空)。

**一个反直觉的实测结论**:`/strict` 下**仍有** 4 条采集,别把"空"写进断言 —— 我第一版就是这么写的,挂了。

**Phase 2b(持久化)+ 2.5(徽章/Inspect)也已完成并实测。**

全链路跑通:`page → 页内 ring → web_pane_drain → renderer 1Hz 轮询 → POST /api/web/events →
服务端 ring → 游标读取`。实测采到 6 条 console/rejection/exception + 1 条
`GET /should-be-blocked → 404 ok=false 3ms`,全部带 `nav=1` 标记,`href` 正确。
游标 `since=cursor` 返回空;未知 pane 返回空而不报错;缺参数 400;
**新路由自动被 Phase 0 的守卫覆盖**(恶意 Origin → 403)。

服务端 ring(`apps/server/src/webInspect.ts`,13 个单测):500 console + 300 network,
console/network **共用一个单调游标**,`nav` 标记,drop-oldest 且 `dropped` 计数每次读取后重置
(读者能区分"断档"和"没动静"),`navOnly` 可只看当前这次加载,空闲 pane 定期清理
(pane id 是永不重复的 UUID,不清会随进程寿命无限增长)。**所有字段在入口重新校验和钳制** ——
payload 来自任意网页,页内的上限只是礼貌不是保证。

徽章截图验证:错误徽章 `3` + 失败请求徽章 `⇅1` + Inspect(bug)按钮,数字与服务端 ring 完全一致。
`Cargo.toml` 的 tauri 加了 `devtools` feature —— 不加的话 Inspect 按钮对所有正式用户都是静默失灵。

**一个单测抓到的真 bug**:`listWebInspectPanes` 原本按 `Date.now()` 排序,毫秒精度下同一 tick 内
更新的两个 pane 排序随机。改成单调 `touchSeq` 排序,墙钟只留给 prune。

**轮询固有的局限(已知并接受)**:最后一次 drain 到 reload 之间产生的条目会丢。1Hz 的节奏给它封顶。

**仍需人工确认的一项**:GUI 里连续 zen 切换(那条 `if (cancelled) → web_pane_close` 孤儿兜底)。
Rust 侧的按 label 关闭机制已由 50 轮生命周期覆盖,但 renderer 那个竞态分支只有真人快速切 zen 才触发。

### 2.9 Phase 3 结果(2026-07-30)

**静态**:server 210 测试、web 83 测试、web typecheck 干净、cargo 21 测试,全过。
新增测试 137 条:`selectors` 35、`identity` 37、`policy`+`rings` 21、`hub` 18、`http` 26。

**真机 e2e 20/20**(隔离 `HOME`,端口 5199,脚本在 scratchpad):
`/control` socket 接入 → PTY socket 在 WSS 拆分后仍工作 → PTY 里 `printf` 出 OSC claim →
`/api/control/claim` 换到 token → `session.whoami` / `panes.list` / `panes.resolve` 全部作答 →
审计环 6 条 → 关掉 control socket 后 `panes.list` 变 `E_NO_HOST`。
Phase 0 的五条安全回归 + 三条新路由(401 无 token、403 恶意 Origin、403 伪造 nonce)一并复测通过。

**Store 重构(先做的那半)**:纯布局模型抽到 `apps/web/src/state/paneTree.ts`(零运行时 import,
所以能直接跑 `node --test`;类型由 `store.ts` 原样 re-export,17 个调用点一行没改)。
新增 `findTabContaining` / `updateTabContaining` / `removeTab` / `buildPaneIndex` / `mapLeaf`。
六个 action 全部改成按 pane id 寻址;`splitFocused`、`addPane` 保留旧签名,内部委托给新增的
`splitPaneById`、`addPaneNear`(两者返回新 pane id,RPC 要用)。顺手把 `setPaneAgentSession`
一起修了 —— 它和 `setAgentMessages` 是同一类异步 bug。

**几个实测得到的结论**:

- **`unref()` 会让超时路径无法测试**。`hub` 的超时定时器最初 `unref` 了,结果 event loop 提前
  drain,promise 永远不 settle,node:test 报 "event loop has already resolved" 并且**带崩同一个
  describe 里后面所有用例**(6 个)。server 本来就有 listening socket 撐着,unref 一点好处都没有。
- **OSC claim 必须按 pane 记,不能按 session 记**。SSH 的 session id 是 `${paneId}:ssh:${host}`(R8),
  直接用 `id` 会把身份绑到 session 上,同一 pane 换个 SSH 目标就丢了。加了 `paneIdOfSession()`。
- **不能拿 `resolveSpawnCwd` 来做 scoping**。它兜底到 `$HOME`,于是所有解析不出目录的 pane 会被
  归进同一个"伪项目"。scoping 需要的是"解析不出就是 undefined",所以另写了 `controlCwdForPane`
  (同一条候选链,去掉兜底),并加了 3 秒 memo —— macOS 上每次解析 live cwd 都要起一个 `lsof`。
- **一个假阳性值得记下来**:验证"OSC claim 不会随 scrollback 重放"时,不能 grep `7717` ——
  用户敲的 `printf '\033]7717;...'` 命令行回显本身就含这串**纯文本数字**,那是无害的。
  要 grep 真正的 `ESC ] 7717;` 序列。第一版断言写错了,以为有漏洞。
- **`allow-all` 是 D11「无条件 consent」的唯一例外**。§4 的验收原文是"global 能看到 B 的 pane,
  但对它做写操作会触发 consent",所以**跨项目读不拦**(否则 `scope:"global"` 等于没用),
  只拦写;`allow-all` 是用户显式选的,尊重它。

**已验收(§4 Phase 3 的人工清单)**:后台 tab 的 pane 能被寻址 ✅;默认只看得到本项目 ✅;
`scope:"global"` 能看到项目外的 pane 且不需要 consent ✅;pane 按 `cwdFrom` 链归属、链断了只在
global 可见 ✅;`session.whoami` 的 `project.root` 走最近的 `.git` ✅(`identity.test.ts` 5 条覆盖
`.git` 上溯;e2e 里 shell 落在隔离 HOME,没有 `.git`,所以 root == cwd,这是设计好的退化)。

**⬜ 还差一项**:「关掉所有窗口后 `panes.list` / `term.scrollback` 仍能从 SQLite 作答」。
现在没窗口就是 `E_NO_HOST`。hub 只认活着的 renderer,离线目录得从 `saveState` 存的布局里读,
是独立一块。**这是 Phase 3 唯一未闭环的验收项。**

## 3. 已定决策(不要重新讨论)

| # | 决策 | 理由 |
|---|---|---|
| D1 | 采集用**页内 ring + 外部拉取**,页面零 egress | `eval_with_callback` 能取回值 → 页面 CSP 完全无关。任何"页面 POST 回 localhost"的方案在第一个 CSP 严格的站点上就废,还要给子 webview 开 `remote.urls` IPC 权限 |
| D2 | **双层 buffer**:页内 ring(CSP 免疫的采集点)→ renderer ~1Hz 轮询 → **服务端持久 ring** | 页内 ring 在导航/reload 时清空;服务端 ring 带游标,agent 用 `since_seq` 读增量,renderer 重载时也能读。UI 面板走 SSE 读**同一份**,这就是"人看到的和 agent 看到的一模一样"的结构性保证 |
| D3 | webview 创建搬到 Rust,但 **renderer 用 `skip:true` 保留 JS handle** | bounds/occlusion 逻辑一行不改 |
| D4 | Agent 走 HTTP,renderer 走 WebSocket | agent 是 shell 进程,`curl` 一行,没有生命周期;renderer 需要服务端主动发起请求 + 断连即失效的所有权信号 + 高频反向推送 |
| D5 | MCP 和 `/api/control/rpc` 是**同一个 dispatcher 的两层皮** | 不是两套实现 |
| D6 | MCP **手写 JSON-RPC,不引 SDK** | `@modelcontextprotocol/sdk` v1.30 有 17 个直接依赖(含 express@5 + hono@4 + cors + jose + ajv),4.3MB;`apps/server` 现在 5 个依赖、零框架。我们只需要 6 个方法。本代码库已经手写过三次同类东西(SSE / NDJSON 流 / 路由)。dispatch 藏在 `handleMcpRequest()` 后面,将来换 SDK 是传输层改动 |
| D7 | **Termany 绝不写用户自己的配置文件** | 不碰 `~/.claude.json`、`~/.codex/config.toml`、`~/.gemini/settings.json` —— 手改的、和别的工具共享的,合并出错是支持噩梦,且格式变得比 Termany 发版还快 |
| D8 | DevTools 抽屉**压缩** native view,不做遮挡物 | `isRectOccluded` 是整块布尔,抽屉和 viewport 相交会隐藏**整个页面**。抽屉做成 `.web-viewport` 的 flex 兄弟 → 现有 ResizeObserver 自动触发 `syncBounds` → `nativeViewOcclusion.ts` 零改动 |
| D9 | 授权分四层,默认 `ask`,**不能为赶进度砍掉** | token 证明的是"我是 pane X 里跑的进程",不能默默等于"我可以往任意 pane 打任意命令"。提示词注入是传输层解决不了的残余风险,consent + 审计 + kill switch 就是它的缓解 |
| D10 | 走完整路线 1→2→3→4→5,不走薄纵切 | 用户已确认长期运行。薄纵切能早三分之一时间可用,但通用层接入时路由要重接 |
| D11 | **默认 scope 是"项目",不是"全局"** —— selector 的默认作用域收到 caller 所在项目;跨项目要显式 `scope:"global"` 且走 Tier 2 consent | 见 §3.1 |

### 3.1 D11 展开:两种"项目级",别混为一谈

**(a) 安装位置的项目级** —— 已解决,见 §2.6。而且对 Termany 自己启动的 agent **根本不存在"安装"**:
ACP pane 是 `session/new` 时传 `withMcpServer`(运行时、per-session per-pane、不落盘,比项目级还窄);
终端 agent 是启动时加 flag。"项目级 vs 全局"只对**用户手动起的 agent** 才是问题。

**(b) 暴露范围的项目级** —— 这才是需要现在定的。原设计里 `panes.list` 是**全局**的:项目 A 的 agent
能看到、并且(过了 consent 后)驱动项目 B 的 pane。D9 的分层只限制了**写**,**发现是全局的**。

决定:**默认按项目收窄**。
- `Scope` 枚举加 `"project"`,并把它设为**默认**(原设计默认是 `"tab"`,`"global"` 要显式给)
- 判定依据:pane 的解析 cwd 是否落在 caller 的项目根之下。cwd 已经能拿到 —— `sessionCwd()`
  (`index.ts:1462`)和 `cwdCandidates`(`store.ts:1743`)都是现成的
- 项目根:从 caller pane 的 cwd 往上找最近的 `.git`(和 worktree 逻辑一致);找不到就退化成 cwd 本身
- 跨项目访问不是禁止,是**降级**:必须显式 `scope:"global"`,且无条件走 Tier 2 consent(即使是
  caller 自己创建的 pane)
- `session.whoami` 要回 `project: { root, paneCount }`,让 agent 知道自己被限定在哪

**为什么现在定**:它影响 selector 语法、`session.whoami` 的返回、以及 Tier 判定 —— 三样都在 Phase 3。
事后改是破坏性变更。

**注意**:web pane 没有 cwd(它有 `webUrl`)。归属按它的 `cwdFrom` 链解析(`cwdCandidates`
`store.ts:1743` 已经会走链);链断了就归到"无项目",只在 `scope:"global"` 时可见。

---

## 4. 分阶段:范围 · 改动 · 验收

> 每个阶段的验收分**自动化**(可执行的命令)和**人工**(需要眼睛看)。
> 阶段做完 → 跑该阶段验收 + §5 的回归基线 → 打勾 → 提交。

### Spike A —— `eval_with_callback` 在子 webview 上可用?(阻塞 Phase 1)

源码说可以(dispatcher 发 `Message::Webview(window_id, webview_id, EvaluateScriptWithCallback)`,
`tauri-runtime-wry/src/lib.rs:1890-1903`,子 webview 有自己的 `webview_id`),但没实跑过。
**整个方案的下游全压在这上面。**

做法:加一个最小 Tauri 命令,对现有的 `web_*` 子 webview 调 `eval_with_callback("1+1")`,看 callback 是否触发、拿到什么。

**验收**:callback 触发且拿到 `"2"`。
**失败的话**:fallback 是页面 `postMessage` 到主 webview 再中转 —— 明显更差,需要重新评估整个 Phase 1。

---

### Phase 1 —— Rust `web_pane` 层

**新建** `apps/desktop/src-tauri/src/web_pane/`:`mod.rs`(命令 + `resolve_pane` 守卫)、
`eval.rs`(信封 + job table)、`state.rs`(`PaneInfo.committed`)、`instrument.js`(本阶段只放一个
定义 `__TERMANY__ = {v:1}` 的桩)。

**命令**:`web_pane_create` / `eval` / `status` / `close` / `history`(`webview_history` 从
`lib.rs:533-547` 迁入,旧名保留一个 release 作为别名)。

**改动**:`lib.rs` 加 `mod web_pane;` + 注册命令;`WebBrowserPane.tsx` **只改 `create()`**
(`:110-179`),换成 `invoke("web_pane_create")` + `skip:true` handle。
`bringForward` / `syncBounds` / `canReveal` / 监听器接线**一律不动**。

**⚠️ 本阶段最高风险 —— 孤儿 native view,必须进第一个 commit 并配测试**
现在 `new Webview(...)` 是**同步**赋值,effect 中途卸载时 cleanup(`:238-239`)拿得到 handle。
改成 Rust 创建后,handle 只能在 await 之后才有;若此时 cleanup 已跑,`webview` 还是 `null`,
cleanup 什么都不做 → 那个子 webview **永远不会被关闭**。而 label 带 `mountId`+`viewKey`,下次不撞名,
所以连报错都没有,只是静默堆积在 app 上层。触发条件:zen 切换(注释 `:43-45` 说这个 pane 本来就会
remount)、快速关 pane。
**mitigation**:`if (cancelled) { void invoke("web_pane_close", { label }).catch(() => {}) }`

**其他必须做对的**
- 每个命令接 `caller: tauri::Webview` 并要求 `caller.label() == "main"` —— `capabilities/default.json`
  的 `"windows": ["main"]` 会覆盖该窗口**所有** webview(`tauri-utils/src/acl/capability.rs:150-157`),
  而 `is_local_url` 把配置的 `devUrl`(`http://localhost:15173`)算作 local
- label 校验比现在的 `starts_with("web_")` 更严:长度 ≤128 + 字符集白名单
- label 不存在统一返回 `Err("web pane not found: <label>")` —— 不要 `Ok` 带哨兵值,不要 panic
- 顺手补 `WebBrowserPane.tsx:202-203` 缺失的 `.catch(() => {})`(现在已经在产生 unhandled rejection)

**自动化验收**
```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # is_web_pane_label 边界、eval 双层解码、"" 歧义空值、超时钳位
npm -w @termany/web run test && npm -w @termany/web exec tsc --noEmit
```
**人工验收**(跑起来的 app)
- [ ] `1+1` → `2`
- [ ] `throw new TypeError('x')` → `{ok:false, name:"TypeError"}`
- [ ] `NaN` → `{ok:true, value:null}` 且**不 panic**(这条是崩溃防护,必须显式测)
- [ ] `new Promise(r=>setTimeout(()=>r(42),300))` → `42`
- [ ] `(async()=>{await new Promise(r=>setTimeout(r,9e3))})()` → 超时错误,**不挂死**
- [ ] 未 commit 的 pane 上 eval → 立即报 "has not loaded a page yet",**不是等满 5 秒**
- [ ] **zen 切换 50 次 → 无孤儿 webview**(`app.webviews().len()` 回到基线)
- [ ] 页面里 `Object.defineProperty(window,'__TERMANY__',{value:null})` → 我们的 `configurable:false` 赢

---

### Phase 1.5 —— 原地导航

`web_pane_navigate` / `web_pane_reload` 接管;`useEffect` 依赖从 `[label, url]` 降到 `[label]`;
`on_navigation` 回填地址栏。

**这是对 `WebBrowserPane` 生命周期最大的一次改动,单独一个阶段**,这样 reveal 舞蹈的回归可归因。

导航时立刻 `mark_navigating` 把 `committed` 置回 false —— wry 的 `pending_scripts` 在首次 commit
后**永不重新武装**,所以这是我们自己唯一的闸门。

**人工验收**
- [ ] 改 URL / reload **不再销毁重建 webview**(session、cookie、滚动位置、历史都在)
- [ ] 点站内链接后**地址栏跟上**(现在永远是旧的)
- [ ] eval 发出后立刻 navigate → 拿到 `Dropped` 错误,**不挂死**

---

### Phase 2 —— 采集 + drain

完整 `instrument.js`;renderer ~1Hz 轮询 `drain()`;服务端 ring `apps/server/src/webInspect.ts` + `/api/web/events`。

**ring 规格**:console 500 条(每参数上限 4KB)/ network 300 条,**两个独立 buffer**(防止 log
洪水冲掉解释问题的那条网络记录);全局 1MiB 软上限,超了只累加 `dropped` 计数器;连续相同的
`(level, text, source)` 累加 `count` 而不是追加(React 渲染循环才不会淹掉一切)。
network **默认不记 body/header**。

每个 monkeypatch 自己 try/catch,**绝不能往页面代码里抛异常** —— 弄坏用户站点的 `fetch`
比没有 instrumentation 糟糕得多。

**人工验收**
- [ ] **带 `Content-Security-Policy: default-src 'self'; connect-src 'none'` 的页面,`drain()` 仍返回 console 条目**
      ← 整个采集架构的核心主张。**Spike A 已在 §2.7 用 `/egress-blocked` 证实**;这里要用**真实的
      `instrument.js`**(不是 spike 的简化版)复测一遍,因为完整版多了 fetch/XHR monkeypatch、
      ring 上限、`safeStringify` 循环检测
- [ ] `console.log` 的对象/数组参数被正确序列化(spike 已验:`{nested:{a:1}}` 和 `[1,2,3]` 都对)
- [ ] `unhandledrejection` 和 `window.onerror` 都进 ring(spike 已验)
- [ ] reload 后服务端 ring 里的历史不丢
- [ ] `nav` 分隔符正确:reload 前后的条目能区分
- [ ] **monkeypatch 不会把异常抛进页面代码** —— 故意让 `safeStringify` 遇到 getter 抛异常的对象

---

### Phase 2.5 —— 徽章 + Inspect(便宜,可插队)

`.web-toolbar` 加错误数 / 失败请求数徽章;`web_pane_devtools` + `Cargo.toml` 的 tauri 加 `devtools` feature。

App Store 影响是 moot 的(已经 `macOSPrivateApi: true` 且走自己的 CDN updater 发 app+dmg)。
Windows 的 `close_devtools`/`is_devtools_open` 不支持 → 返回 `{requested, reportedOpen, reliable}` 三个字段,
让 renderer 不用编码平台怪癖。

**人工验收**
- [ ] **release 构建**里 Inspect 能打开 Web Inspector
- [ ] 有错误时徽章出数字,点击有反应

---

### Phase 3 —— Store 重构 + 控制通道

**先做 store 重构,它是前提也是存量 bug 修复。** 六个改 pane 的 action 现在只作用于**活动 tab**
(`splitFocused` `:1113`、`closeLeaf` `:731`、`renamePane` `:1210`、`togglePaneView` `:1296`、
`setPaneView` `:1331`、`addPane` `:1399` 都走 `inActiveWs` + `if (h.id !== n.activeHTab) return h`)。
RPC 打到后台 pane 会**静默 no-op**。加 `updateTabContaining` 并重写它们,旧签名保留成薄包装。
**回归测试先于 RPC 层写。**

然后:`noServer` upgrade 路由拆两个 WSS;`apps/server/src/paneControl/{hub,selectors,identity,policy,http,rings}.ts`;
`apps/web/src/control/{client,paneIndex}.ts`;`session.whoami` + `panes.*`;
`packages/core/src/paneControl.ts`(server/web 共享类型)。

**寻址**:selector 语法而不是裸 UUID。`{sibling:{view:"web"}}` 就是"我这个 tab 里的那个 web pane"。
**歧义永远报错并列出候选,绝不静默猜测。**

```ts
// packages/core/src/paneControl.ts
type Scope = "tab" | "page" | "workspace" | "project" | "global";  // 默认 "project"(D11)

type PaneTarget =
  | string                                            // paneId,或字面量 "self"
  | { ref: "self"|"focused"|"next"|"prev"|"last-opened" }
  | { sibling: { view?: PaneView; index?: number; title?: string } }   // 同 tab 内
  | { view: PaneView; scope?: Scope }
  | { title: string; scope?: Scope; match?: "exact"|"contains" }       // 默认 contains,大小写不敏感
  | { index: number; tab?: string };                                   // 1-based
```

**作用域按 D11 默认收到项目**(见 §3.1):`Scope` 加 `"project"` 并设为默认;按 pane 解析 cwd 是否在
caller 项目根下判定(web pane 走 `cwdFrom` 链);`scope:"global"` 要显式给且无条件走 Tier 2 consent;
`session.whoami` 返回 `project: { root, paneCount }`。**这三样必须在本阶段一起做完** —— 事后改是破坏性变更。

每个响应都回 `resolved: { paneId, title, view, path }`,agent 不用先调 `panes.list`。
错误码统一:`E_NO_MATCH` / `E_AMBIGUOUS`(带 candidates)/ `E_NO_HOST` / `E_PANE_NOT_MOUNTED` /
`E_UNSUPPORTED` / `E_FORBIDDEN` / `E_CONSENT_DENIED` / `E_TIMEOUT`。

**身份**:PTY env 注入(`index.ts:1705`)+ ACP env 注入(`acpRuntime.ts:169`)+ 手动启动的 agent
走 OSC 挑战注册(恶意网页拿不到 token,因为它没法让那串字节出现在真实 PTY 的输出流上)。
记得把 `\x1b]7717;...` 加进 `sanitizeForReplay`(`index.ts:289`),防止 claim 从 scrollback 重放。

**自动化验收**:`selectors.test.ts`(纯函数,重点覆盖歧义分支)、`hub.test.ts`、`identity.test.ts`
**人工验收**
- [ ] 从 claude pane 里 `curl` 能列出 pane
- [ ] 后台 tab 里的 pane 也能被正确寻址(重构前会静默 no-op)
- [ ] 关掉所有窗口后,`panes.list` / `term.scrollback` 仍能从 SQLite 作答
- [ ] **默认只看得到本项目的 pane** —— 开两个不同项目的 workspace,A 里的 agent `panes.list` 看不到 B 的
- [ ] **`scope:"global"` 能看到 B 的 pane,但对它做写操作会触发 consent**(哪怕是 caller 自己建的)
- [ ] **web pane 按 `cwdFrom` 链正确归属到项目**;链断了的 pane 只在 `scope:"global"` 下可见
- [ ] `session.whoami` 返回的 `project.root` 是最近的 `.git` 目录

---

### Phase 4 —— 生命周期 + 终端 + policy

`pane.*` / `term.*` / `action.*`;consent UI;审计环;Settings 开关。

`term.send` **必须走 renderer** 的 `sendCommand`(`manager.ts:1735`),保住 agent-activity 注册、
per-session 串行化、SSH session 解析。不要在服务端直接 `pty.write()`。

**人工验收**
- [ ] agent 在自己旁边开一个 pane 并在里面跑命令,用户确认一次
- [ ] policy 设 `off` 时所有控制端点返回 `E_FORBIDDEN`
- [ ] 审计面板能看到刚才发生的调用

---

### Phase 5 —— MCP 门面 + agent 接线

`apps/server/src/mcp/{transport,tools,handlers,format,config}.ts`;
`acpRuntime.ts` 的 `.withMcpServer(...)`(**带 capability gate** —— adapter 不支持时 log 一次并在
pane 里显示一行提示,不要静默失败);PTY env 注入 `TERMANY_MCP_URL`/`TERMANY_MCP_TOKEN`;Settings 的 MCP 区块。

`POST /mcp` 只回 JSON;`GET`/`DELETE /mcp` → `405 + Allow: POST`;batch 数组 → `-32600`。
`/mcp` **不发任何 `Access-Control-*` 头**。

**agent 注册**(能力已实测,见 §2.6 —— 比最初估计的好,三个都能自动):

| agent | Termany 怎么做 | 碰用户文件? |
|---|---|---|
| ACP pane(任意 agent) | `session/new` 时传 `withMcpServer`,per-session per-pane | 否 |
| 终端 `claude` | 写 Termany 自己的 `~/.termany/mcp/claude.json`,启动时加 `--mcp-config <该文件>` | 否 |
| 终端 `codex` | 启动时加 `-c mcp_servers.termany.url=... -c mcp_servers.termany.bearer_token_env_var=TERMANY_MCP_TOKEN` | 否 |
| 终端 `gemini` | 同理走它的 CLI/settings;`-s project` 是它的默认 | 否(用 launch flag) |
| 其余 | Settings 里一键复制 + 用户手动粘一次 | 否 |

**⚠️ 不要传 `--strict-mcp-config`** —— 会静默禁掉用户自己所有的 MCP server。只用叠加式的 `--mcp-config`。

**用户手动起的 agent**:推荐 `claude mcp add -s local`(按项目隔离、不进仓库)。若确实想提交进仓库共享,
用 `-s project` 配 `${TERMANY_MCP_TOKEN}` 引用而不是字面 token —— 在 Termany 里有值能用,
队友 clone 下来变量为空自动失效,不泄密(§2.6)。**绝不把 token 字面量写进要提交的文件。**

**自动化验收**:`tests/mcp.test.ts` —— initialize → tools/list → tools/call;畸形输入;无 token → 401
**人工验收**
- [ ] `npx @modelcontextprotocol/inspector` 能完成 initialize → tools/list → tools/call
- [ ] **ACP pane 里的 claude 主动调 `browser_console`**
- [ ] 从 side rail 启动的终端 `claude` 能看到这些工具

---

### Phase 6 / 7 / 8 / 9

- **6 自动化**:`browser_snapshot`(ref 方案,`WeakRef` map,导航后失效并明确报 stale)/ `click` / `type` / `wait_for`。
  验收:agent 独立走完一个登录表单。
- **7 截图**:macOS `WKWebView.takeSnapshot`(objc2,依赖已在 `Cargo.lock` 里,只是 feature 合并);
  Windows/Linux 返回 `Err("unsupported")` 但**签名不变**;renderer 侧降采样。
  ⚠️ `afterScreenUpdates` 默认 `YES` 会等合成,而 Termany 一有遮挡就 `hide()` native view →
  **默认传 `false`** + 3 秒硬超时 + 返回 `stale: true`。
  验收:有 PopMenu 遮挡时截图 3 秒内返回且 `stale:true`,**不挂死**;长页面 base64 < 1.5MB。
- **8 DevTools 抽屉**:`WebInspector.tsx` + `webdev-*` CSS;拖 grip 时挂起 bounds 同步;"问 agent" 桥接。
  ⚠️ 抽屉里**不能有浮层弹出菜单**(向上弹会跑到 native view 后面)—— 用内联输入框做过滤。
  验收:拖动不中途 reflow;"问 agent" 在终端 pane(用 `pasteIntoSession`)和 ACP pane 两种都落地。
- **9 ACP client capabilities**:`fs/*` + `terminal/*`,让 ACP agent 的 shell 命令跑在**真实可见的
  Termany PTY** 里。和本方案正交,不该阻塞它。注意 `ClientCapabilities` 是承诺 —— advertise 了
  `terminal: true` 却没完整实现五个方法,会弄坏依赖它的 agent。

---

## 5. 回归基线(每个阶段做完都跑)

```bash
npm -w @termany/server run test          # 当前 60 通过
npm -w @termany/web run test             # 当前 38 通过
npm -w @termany/web exec tsc --noEmit    # 当前干净
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # Phase 1 起
```

**安全回归**(改了 server 就跑,任何一条挂掉都是阻塞):
```bash
# 起一个测试 server(别用 5174,会杀掉正在跑的 Termany 的 shell)
TERMANY_PORT=5199 npx tsx apps/server/src/index.ts &
lsof -nP -iTCP:5199 -sTCP:LISTEN     # 期望:127.0.0.1 和 [::1] 两条,没有 *
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5199/api/version                                  # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: tauri://localhost' http://127.0.0.1:5199/api/version   # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' http://127.0.0.1:5199/api/version # 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example:5199' http://127.0.0.1:5199/api/version      # 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Sec-Fetch-Site: cross-site' http://127.0.0.1:5199/api/version   # 403
```

**冒烟**:`npm run dev:web` → 浏览器开 `http://localhost:15173` → app 完整加载、布局恢复、
scrollback 恢复、shell 提示符是活的;server 日志里 `grep "blocked a request"` **零条**。

---

## 6. 未闭环风险登记

| # | 风险 | 影响 | 处理 |
|---|---|---|---|
| ~~R1~~ | ~~打包 WKWebView 实际发的 `Origin` 未实测~~ | — | ✅ **已关闭** 2026-07-30:实测就是 `tauri://localhost`,白名单里已有,整个 app 启动零条 blocked。<br>**做法(完全非侵入,没碰用户运行中的 Termany)**:`start_server` 被 `!cfg!(debug_assertions)` 挡着(`lib.rs:965`),所以 `tauri build --debug --no-bundle` 出来的二进制走 `frontendDist` + 自定义协议(拿到真实 `tauri://` origin),同时**不会 spawn 也不会 kill 任何 server**;前端用 `VITE_API_URL=…:5175` 构建,服务端跑在隔离 `HOME` 下。<br>顺带加了常驻诊断 `TERMANY_LOG_ORIGINS=1`(每个不同的 Origin 只打一次)。**允许 `null` 不是安全的修法** —— 沙箱化的跨站 iframe 也发它。Windows/Linux 的形式仍是源码推断,未实测 |
| ~~R2~~ | ~~Spike A 未做~~ | — | ✅ **已关闭** 2026-07-29:7 个问题全部实测通过,见 §2.7。Phase 1 按原设计走 |
| **R3** | `skip: true` 是私有 API(`webview.js:143` 带 `@ts-expect-error`) | Tauri 升级可能失效 | 包一层 `attachWebviewHandle(label)`,只留一个改动点。公开 fallback 是 `Webview.getByLabel()`,但每 pane 多一次 IPC,**且可能需要给 capabilities 加 `core:webview:allow-get-all-webviews`** —— 首次构建时确认 |
| **R4** | 孤儿 native view | 静默堆积,无报错 | 见 Phase 1,mitigation 必须进第一个 commit |
| ~~R5~~ | ~~`claude --mcp-config` flag 名未核实~~ | — | ✅ **已关闭** 2026-07-29:`--mcp-config <configs...>` 实测存在(claude 2.1.220);codex 的 `-c` + `--bearer-token-env-var`、gemini 的 `-s project` 也都实测确认。见 §2.6。剩下的小未知项只有 `.mcp.json` 的**运行时** `${VAR}` 展开(写入时保留已实测),Phase 5 顺手验 |
| **R6** | 提示词注入 | 传输层解决不了 | D9 的 consent + 审计 + kill switch,默认 `ask` |
| **R7** | `capabilities/default.json` 的 `"windows": ["main"]` 覆盖该窗口所有 webview | dev 构建里指向 `localhost:15173` 的 web pane 会被当本地页 | 每个命令查 `caller.label() == "main"`;`"windows"` → `"webviews"` 作为**独立加固 ticket**,不要搭车 |
| **R8** | pane id 同时是终端 session id,SSH 是 `${paneId}:ssh:${host}` | agent 文档混淆会让 SSH pane 的 `term.scrollback` 读错 ring | RPC 里 `paneId` 和 `terminalSessionId` 分开暴露 |
| **R9** | 15 个 MCP 工具在上限附近(每个 schema 都进每次请求) | token 压力 | 吃紧时先砍 `pane_focus` 和 `browser_devtools` |
| **R10** | 给现存 `/api/fs/*`、`/api/scroll`、`/api/state` 加 token | 只剩"同机器另一个本地用户"这个威胁面 | 独立后续 PR |
| **R11** | `{ref:"last-opened"}` 的顺序是 renderer **观察**到的,不是真实创建顺序 | 刚重启后这个 selector 的答案等于首次遍历顺序,不等于用户心里的"最后开的那个" | 布局树里没有创建时间,补不出来。`paneIndex.ts` 里已注明;真要准就得给 leaf 加一个持久化的 `createdAt`,那是破坏性的 schema 变更,不搭车 |
| **R12** | `policyMode` 硬编码 `"ask"`、`requestConsent` 恒 false | Phase 3 的三个方法都是读,碰不到;但 Phase 4 一加写方法,不接 consent UI 就会**全部失败**(fail closed,不是 fail open) | 挂钩已在 `DispatchDeps`,Phase 4 必须同时接 Settings 开关和 consent UI |
| **R13** | 无窗口连接时控制面完全不可用(`E_NO_HOST`) | §4 的一条验收项未闭环 | 见 §2.9 末尾。离线要从 `saveState` 的布局 + SQLite scrollback 作答 |

---

## 7. 怎么接手

1. 读 §1 看进度,读 §2/§3 拿到承重事实和已定决策(**不要重新推导**)
2. 从第一个 ⬜ 的阶段开始,按 §4 的"范围 · 改动 · 验收"做
3. 做完跑该阶段验收 + §5 回归基线
4. 更新 §1 的状态表和 §6 的风险登记,提交

**安全底线**:任何时候都不要为了方便退回 `Access-Control-Allow-Origin: *`、不要绑非 loopback、
不要在没有 D9 那层授权的情况下暴露 `term.send` 或 `web.eval`。这三条里任何一条破掉,
这个功能就从"agent 能调试浏览器"变成"任何网页能在你机器上执行命令"。

**测试纪律**:别抢 5174 端口 —— 用户的 Termany 可能正跑着 live shell,杀掉 server 会丢会话。
测试统一用 5199 或 dev 的 5175。
