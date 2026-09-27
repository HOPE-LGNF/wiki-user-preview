# Wiki User Preview

一条命令把**当前打开的 wikitext 文件**写入你在某个 MediaWiki 站点上 **User 命名空间**下的页面，保存，然后立刻打开该页面的渲染结果。

命令名：`wikiUserPreview.originalPreview`。

---

## 0. 先说三个影响设计的前提（都已核实）

按你的设想，这里有三处需要纠正：

### ① WPLS 没有任何登录能力，**"直接使用 WPLS 的登录"不可行**

`bhsd.vscode-extension-wikiparser`（WikiParser Language Server）的 `package.json` 里，全部配置只有这些：

`wikiparser.linter.*`、`wikiparser.inlay`、`wikiparser.completion`、`wikiparser.color`、`wikiparser.hover`、`wikiparser.signature`、`wikiparser.articlePath`、`wikiparser.config`、`wikiparser.user`。

其中唯一和"身份"有关的是：

> `wikiparser.user` — *According to the Wikimedia Foundation's policy, a URI for a userpage or an email address of the user may be required when accessing WMF sites. This information is only used to identify the user in the User-Agent header.*

也就是说，它是**给 HTTP 请求填 User-Agent 用的联系方式**，不是账号、不是密码，WPLS 从不做任何认证。它只以匿名身份 GET 页面用于补全/hover。

所以本扩展**没有**去"借用"WPLS 的登录态，而是：
- 复用 `wikiparser.user`（如果填的是用户页 URL）**推断用户名**；
- 复用 `wikiparser.articlePath` 之类做站点探测；
- 自己完成登录与写入。

### ② 真正"用户名 + 密码"的配置在 **Wikitext** 扩展里

`RoweWilsonFrederiskHolme.wikitext` 才是带账号体系的那个。它的配置里有：

| 配置 | 说明 |
|---|---|
| `wikitext.host` | 例如 `en.wikipedia.org` |
| `wikitext.transferProtocol` | `https://` |
| `wikitext.apiPath` | 例如 `/w/api.php`；灰机wiki是 `/api.php` |
| `wikitext.articlePath` | 例如 `/wiki/` |
| `wikitext.userName` | 用户名 |
| `wikitext.password` | **明文存在 settings.json 里** |
| `wikitext.autoLogin` | `Always` / `Never` / `Ask me` |

它也提供 `wikitext.login` / `wikitext.writePage` / `wikitext.viewPage` 等命令，内部用 `mwbot`。

**但它不导出任何公开 API**（`bot` 是模块私有变量，`activate()` 不返回对象），所以无法调用它的登录会话。本扩展的做法是：**读取它的配置，然后用自己的一套 MediaWiki API 客户端独立登录**。两边的会话互不干扰，也不需要在你的 settings 里重复填一遍。

### ③ 灰机wiki（HuijiWiki）在 Cloudflare 后面，可能返回人机验证

灰机wiki 的 `api.php`（在某个灰机子站上实测）在数据中心 IP 上会被 Cloudflare 的 interactive challenge 拦截（返回 `403` + "请稍候…"），普通浏览器请求头能提高通过率但不保证。扩展已经：
- 默认使用浏览器风格 UA（并附带 `wikiparser.user` 里的联系方式，满足 WMF 的 UA 政策）；
- 把"返回 HTML 而不是 JSON"识别成明确错误，而不是丢一个 JSON 解析异常；
- 对 `429/503` 遵循 `Retry-After` 自动重试。

如果你在公司网络/代理下遇到验证，把 `wikiUserPreview.userAgent` 改成你浏览器的完整 UA 通常能解决。

---

## 1. 安装与本地调试

```bash
npm install
npm run compile          # esbuild 打包到 dist/extension.js
```

在 VS Code 里打开这个目录，按 **F5** 启动 Extension Development Host，然后在里面打开一个 `.wikitext` 文件执行命令。

打包成可离线安装的 vsix：

```bash
npm run package          # 产出 wiki-user-preview-0.1.0.vsix
code --install-extension wiki-user-preview-0.1.0.vsix
```

跑冒烟测试（纯函数 + 对真实 MediaWiki 的匿名只读调用 + 预览 HTML 转义/剥离）：

```bash
npm run smoke            # 40 项断言，需要联网
```

离线自检（类型检查 + 清单一致性 + 打包）：

```bash
npm run verify
```

`npm run check:manifest` 会校验 `package.json` 与源码不漂移：声明的命令是否都注册了、配置项是否都真的被读取、`#xxx#` 内链是否指向存在的配置项、`main` 是否指向 esbuild 产物。这类错在编译期不会报，但用户在 UI 里能直接看出来。

---

## 2. 首次配置

最省事的方式：**先在你已有的 Wikitext 扩展里配好站点和账号**，本扩展会自动继承。

如果不用 Wikitext，扩展会在第一次运行时逐个弹窗问你站点、用户名、密码，密码可以存进**系统钥匙串**（`context.secrets`，不会落到 settings.json）。

灰机wiki 站点示例配置（`www.huijiwiki.com` 是灰机主站，实际写你自己那个 wiki 的域名）：

```jsonc
{
  "wikiUserPreview.site": "www.huijiwiki.com",
  "wikiUserPreview.apiPath": "/api.php",
  "wikiUserPreview.articlePath": "/wiki/",
  "wikiUserPreview.username": "Unauthorized_HOPE@VSCodePreview",  // 机器人密码写法：用户名@机器人名
  "wikiUserPreview.pageTemplate": "User:{username}/OriginalPreview/{filename}"
}
```

密码用命令 **Wiki User Preview: 设置密码（存入系统钥匙串）** 录入，或设置 `wikitext.password`。

> **强烈建议用机器人密码**：在站点上访问 `Special:BotPasswords` 创建一个，授予 *Edit existing pages* + *Create, edit, and move pages* 权限，你会得到形如 `Unauthorized_HOPE@VSCodePreview` 的用户名和一段一次性密码。
> MediaWiki 官方的说法是：`action=login` 只为机器人密码设计；主账号密码必须走 `action=clientlogin`，而且开启了两步验证时要额外交互。本扩展两种都实现了，`loginMode: "auto"` 会按用户名里有没有 `@` 自动选择并互相回退。

---

## 3. 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `wikiUserPreview.site` | `""` | 完整 URL 或裸域名。留空回退到 `wikitext.host` |
| `wikiUserPreview.apiPath` | `""` | 留空时自动探测 `/api.php` 与 `/w/api.php` |
| `wikiUserPreview.articlePath` | `""` | 留空回退到 `wikitext.articlePath`，再不行用 `/wiki/` |
| `wikiUserPreview.username` | `""` | 留空依次回退 `wikitext.userName` → 从 `wikiparser.user` 解析 |
| `wikiUserPreview.useWikitextSettings` | `true` | 是否允许继承 Wikitext 扩展的站点/账号配置 |
| `wikiUserPreview.loginMode` | `auto` | `auto` / `botPassword` / `clientlogin` |
| `wikiUserPreview.pageTemplate` | `User:{username}/OriginalPreview/{filename}` | 目标页面标题模板 |
| `wikiUserPreview.subpage` | `""` | `{subpage}` 的值，留空取当前文件名 |
| `wikiUserPreview.summaryTemplate` | `由 VS Code 扩展 Wiki User Preview 上传，源文件：{basename}` | 编辑摘要 |
| `wikiUserPreview.previewMode` | `simpleBrowser` | `simpleBrowser` / `webview` / `external` / `ask` |
| `wikiUserPreview.enableScripts` | `false` | webview 模式下注入链接跳转脚本（站点 JS 一律剥离） |
| `wikiUserPreview.getCss` | `true` | webview 模式额外拉站点 CSS（`prop=headhtml`） |
| `wikiUserPreview.watchlist` | `nochange` | 监视列表处理 |
| `wikiUserPreview.minorEdit` | `false` | 标记小编辑 |
| `wikiUserPreview.confirmBeforeSave` | `true` | 写入前弹窗确认 |
| `wikiUserPreview.detectConflict` | `true` | 带 `baserevid` 做冲突检测，冲突时询问是否强制覆盖 |
| `wikiUserPreview.purgeAfterSave` | `true` | 写入后调 `action=purge` 刷新页面缓存（清 Cloudflare 之类的边缘缓存） |
| `wikiUserPreview.simpleBrowserBeside` | `true` | 内置浏览器每次开在代码区右侧；必要时先关掉位置不对的旧标签 |
| `wikiUserPreview.openAfterSave` | `true` | 保存后自动打开预览 |
| `wikiUserPreview.userAgent` | `""` | 自定义 UA；被 Cloudflare 拦时可填浏览器 UA |
| `wikiUserPreview.requestTimeout` | `30000` | 单请求超时（毫秒） |
| `wikiUserPreview.insecureTls` | `false` | 跳过证书校验（仅自建站点自签证书时用） |

### 页面命名

`pageTemplate` 支持这些变量：

- `{username}` — 登录用户名（不含 `@机器人名` 后缀部分保留原样，请自行注意）
- `{filename}` — 当前文件名，**不含扩展名**，已做 MediaWiki 标题合法化
- `{basename}` — 含扩展名的文件名
- `{ext}` — 扩展名（不含点）
- `{subpage}` — `wikiUserPreview.subpage` 的值，留空则等于 `{filename}`

几种常见用法：

```jsonc
// 每个文件一个页面（默认）
"wikiUserPreview.pageTemplate": "User:{username}/OriginalPreview/{filename}"

// 固定单页，反复覆盖（最贴近你举例的 用户:Unauthorized_HOPE/xxx）
"wikiUserPreview.pageTemplate": "User:{username}/OriginalPreview"

// 按源文件所在目录分文件夹
"wikiUserPreview.pageTemplate": "User:{username}/OriginalPreview/{subpage}"
```

> 你给的例子里页面名是 `.../用户:Unauthorized_HOPE/xxx`，这里默认改成了 `User:{username}/OriginalPreview/{filename}`。
> 两点说明：`User:` 是 MediaWiki 的规范命名空间名，在中文站点（含灰机wiki）同样有效，不必写 `用户:`；写成模板后每个源文件对应独立页面，不会互相覆盖。想固定单页就把模板改成 `User:{username}/OriginalPreview`。

---

## 4. 三种预览方式，以及两个必须知道的坑

保存成功后按 `previewMode` 打开页面。**默认是 `webview`**（见下面的理由）：

| 模式 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| `webview`（默认） | 调 `action=parse` 拿渲染后的 HTML，在 Webview 里自己渲染 | 不受 iframe 限制，不执行站点脚本，最稳；固定在当前代码区**右侧**分栏打开 | 没有站点皮肤（只有 `prop=headhtml` 带来的部分样式） |
| `simpleBrowser` | `simpleBrowser.api.open(uri, { viewColumn: Beside })` | 真·原页面，有站点皮肤、按钮、目录 | 见下面两个坑 |
| `external` | `vscode.env.openExternal` | 最可靠，一定有皮肤 | 跳出 VS Code |
| `ask` | 每次弹窗选 | 灵活 | 每次都要选一次 |

不管用哪种方式，成功后的提示条上都会有**另外两种打开方式**的按钮，一键切换，不用改配置。

### 坑 ①：内置浏览器会显示「因通知而暂停」

这句中文是 **VS Code 自己**的消息，原文在 VS Code 的 nls 消息表里：

```
Paused due to Notification
Dismiss the notification to continue using the browser.
```

也就是说：内嵌页面触发了**通知**（浏览器通知/弹窗），VS Code 就把 Simple Browser 暂停了，需要你手动关掉那个通知才能继续看内容。这与本站的皮肤、脚本或扩展都无关，是 iframe 内运行的必然结果。

另外还有一个同源的、修不掉的问题：Simple Browser 是 `vscode-webview://` 里的 iframe，站点 cookie 属**第三方**，会被浏览器策略拦掉。站点若依赖 cookie 判断「公告已读过」，公告就会反复出现。

**结论：任何依赖 iframe 的方式都会受这类限制。** 所以默认改成了 `webview`——它压根不 iframe 站点，而是拿 `action=parse` 的渲染结果自己画。想保留完整站点外观就用 `external`（系统浏览器）。

### 坑 ②：打开位置（内置浏览器会「顶掉」你正在看的代码页）

`simpleBrowser.show` 不带 `viewColumn`，会在**当前编辑器组里**开成一个标签页——看起来就像「替换掉了正在看的代码页」。

我一开始想用 `simpleBrowser.api.open(uri, { viewColumn: Beside })` 解决，**但真机测试证明这条路在 VS Code 1.139 上是死的**。实测：

```
· workbench.action.browser.open（集成浏览器）: true
· simpleBrowser.api.open（老式 Simple Browser）: false    ← 这个命令根本不存在
· workbench.action.moveEditorToRightGroup: true
```

原因是内置 simple-browser 的实现里有这么一个短路：

```js
async function w(){ return (await commands.getCommands(true)).includes("workbench.action.browser.open") }
registerCommand("simpleBrowser.api.open", async (e,t) => { await w() ? await u(e.toString(true)) : i.show(e,t) })
```

只要工作台里有 `workbench.action.browser.open`（VS Code 1.9x 起的**集成浏览器**），`show` 和 `api.open` 就**全都转交给它**，压根不会创建 `simpleBrowser.view` webview；而那条路径只传 URL，**收不到 viewColumn**。即使退回老式 Simple Browser，它也是单例：视图已存在时只调 `webviewPanel.reveal(viewColumn)`，而 `reveal` 不认负数列。

**最终方案：先打开，再按需把浏览器标签移到右侧组。**

- 用 `workbench.action.moveEditorToRightGroup`（对任何编辑器标签都有效，没有右侧组时会新建一个）；
- 判据是**「这一组里有没有代码文件」**，而不是「在不在活动组右侧」——集成浏览器每次都在当前组新开标签，若按后者判断会被反复往右推、越切越多组；
- 只有确认活动标签**不是文本编辑器**时才移动，所以万一浏览器没打开成功，绝不会把你的代码文件搬走。

`wikiUserPreview.simpleBrowserBeside`（默认开）控制这一行为；关掉就恢复 VS Code 原生行为（会和代码同组）。

一个已知的原生行为：集成浏览器**不复用标签**，所以每预览一次会在右侧组多开一个浏览器标签（组数不变）。想避免可以用 `webview` 模式，它复用同一个面板。

`webview` 模式不受这些问题影响：它自己 `createWebviewPanel(..., Beside)`，并且复用同一个面板。

### 这些结论是怎么验证的

不是靠读源码推断——本仓库带一套**真机集成测试**（`npm run test:integration`），在 WSL 里用 `@vscode/test-electron` 拉起真实 VS Code 运行扩展宿主的测试：

- 自动下载与作者本机完全一致的 VS Code（1.139.1）；
- 用 WSLg 的 X 显示，不需要 Xvfb；
- 缺的 Electron 运行库（libnss3 / libnspr4 / libasound2）用 `apt-get download` + `dpkg -x` 免 root 解到本地，靠 `LD_LIBRARY_PATH` 指过去；
- 本地起一个假站点 + 假 MediaWiki API，测试全程离线。

覆盖：浏览器落位、连续预览不增组、webview 面板落位、revid 不匹配时报错。

### 坑 ③：页面明明更新了，预览还是旧版，刷新也没用

这是**缓存**，而且是好几层叠在一起。同一时刻可能命中任意一层：

| 层 | 为什么会命中 |
|---|---|
| 浏览器 HTTP 缓存 / bfcache | URL 没变，Chromium 直接复用内存里的文档，连请求都不发 |
| VS Code 内置浏览器 | 复用同一个 webview，它的「刷新」不保证绕开上面那层 |
| Cloudflare 等边缘缓存 | 按**完整 URL**做键；匿名请求可能与你的登录态看到的是不同副本 |

扩展叠了两道处理：

1. **预览 URL 带版本参数。** 打开用的地址是 `...?wikiUserPreviewRev=<新 revid>`，每次保存版本号都变，所以 URL 变了 → 上面三层全都必然重新取。MediaWiki 会忽略页面视图上不认识的 query 参数，不影响页面本身。
   （`查看页面地址` 按钮复制的是**不带参数**的规范地址。）

2. **`webview` 模式把解析钉死在版本上。** 它用 `action=parse&oldid=<新 revid>`（API 文档：*oldid 覆盖 page 和 pageid*），并且请求 `prop=revid` 校验回来的版本号，**对不上就直接报错**而不是静默给你看旧内容——把一个难查的缓存问题变成一个明确的错误。

3. **`purgeAfterSave`（默认开）** 在写入成功后调一次 `action=purge`。编辑本身会刷新 MediaWiki 的解析缓存，但边缘缓存不一定跟着失效；purge 失败只记日志，不阻塞预览。

Webview 模式的安全处理：
- 站点自带的 `<script>` 和 inline 事件处理器（`onclick` 等）**一律剥离**；
- 注入 `<base href="站点条目前缀">`，让相对链接和图片能正确解析；
- CSP 默认 `script-src 'none'`；只有把 `enableScripts` 打开才会注入一个带 nonce 的脚本，把点击链接改为交给系统浏览器打开。

---

## 5. 命令一览

| 命令 | 作用 |
|---|---|
| `wikiUserPreview.originalPreview` | **主命令**：写入用户页 → 保存 → 打开预览（快捷键 `Ctrl+Alt+P`，仅 wikitext 文件） |
| `wikiUserPreview.login` | 登录并显示当前账号、UID、cookie 数 |
| `wikiUserPreview.logout` | 请求 `action=logout` 并清空本地 cookie 与缓存会话 |
| `wikiUserPreview.setPassword` | 把密码写入系统钥匙串（按站点分别保存） |
| `wikiUserPreview.clearPassword` | 清除钥匙串里的密码 |
| `wikiUserPreview.showResolvedConfig` | 以 JSON 显示**实际生效**的配置（密码打码），排查"到底读了哪个配置"用 |

主命令的执行流程：

1. 取当前编辑器内容；
2. 解析配置（站点 → `apiPath` 自动探测 → 用户名 → 密码）；
3. 弹窗确认目标页面与字符数；
4. 登录（复用会话，必要时重新登录）；
5. 取 CSRF token；`detectConflict` 时先查当前 `revid` 作 `baserevid`；
6. `action=edit` 写入并保存，带 `assert=user`；
7. token/登录态失效自动重登重试；`editconflict` 询问是否强制覆盖；
8. 打开预览。

全过程写入 **Output → Wiki User Preview** 通道，出错时会给出「查看日志」。

---

## 6. 已知限制

- **Cloudflare/WAF**：数据中心 IP 上灰机wiki的 `api.php` 会被间歇性拦截。浏览器直连通常没问题。必要时自定义 `userAgent`。
- **Simple Browser 可能空白**：见上一节，属站点 iframe 策略所致，不是本扩展的 bug。用 `webview` 或 `external` 即可。
- **`wikitext.password` 是明文**：这是 Wikitext 扩展的设计。本扩展优先使用系统钥匙串，只在你自己填了 `wikitext.password` 时才回退读取。
- **webview 模式没有皮肤**：只渲染 `action=parse` 的内容 HTML，不是完整页面快照。要完整外观请用 `external` 或 `simpleBrowser`。
- **两步验证**：`clientlogin` 走到 UI 步骤时，本扩展会把站点要求的字段（如 `OATHToken`）逐个弹窗问你要。验证码等图形交互无法在扩展内完成。
- **不写入非 User 命名空间**：默认模板限定在 `User:` 下。你当然可以把模板改成任何页面，但请自行确认有编辑权限。
- **未做上传节流**：命令由你手动触发，扩展不做后台轮询或自动上传。

---

## 7. 目录结构

```
wiki-user-preview/
├── src/
│   ├── extension.ts     # 命令注册、主流程、会话缓存、错误处理
│   ├── config.ts        # 配置解析与回退链、站点探测、标题模板、URL 拼装
│   ├── mediawiki.ts     # tokens / action=login / action=clientlogin / edit / parse / 限流重试
│   ├── httpClient.ts    # 零依赖 HTTP 客户端：cookie jar、重定向、gzip/br 解压
│   └── preview.ts       # simpleBrowser / webview / external 三种预览 + HTML 净化
├── scripts/
│   ├── smoke.ts         # 40 项冒烟测试（含真实 MediaWiki 调用）
│   └── vscode-stub.ts   # 让纯函数能在 Node 里被测试的 vscode 替身
├── esbuild.mjs
└── package.json
```

依赖策略：**运行时零第三方依赖**。不用 `mwbot`、不用 `node-fetch`——cookie 会话必须自己管，而少一个依赖就少一个在远程/Web 扩展宿主里出问题的地方。
