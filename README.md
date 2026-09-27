# Wiki User Preview

[![CI](https://github.com/HOPE-LGNF/wiki-user-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/HOPE-LGNF/wiki-user-preview/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue.svg)

把当前打开的 **wikitext 文件**写入 MediaWiki 站点上 **User 命名空间**下的一个页面、保存，然后立刻打开该页面的渲染结果。

适合「本地写稿 → 上传到自己的用户子页 → 看看实际渲染成什么样」这个循环。

---

## 功能

- **一条命令完成上传与预览**，不用切浏览器、不用手动复制粘贴。
- **目标页面可模板化**，默认每个源文件对应一个独立页面，不会互相覆盖。
- **运行时零第三方依赖**：自带 HTTP 客户端（cookie 会话、重定向、gzip/br 解压、限流重试），不依赖 `node-fetch` / `mwbot`。
- **登录双通道**：机器人密码走 `action=login`，主账号密码走 `action=clientlogin`（含两步验证字段交互），`auto` 模式自动选择并互相回退。
- **自动处理 Wikitext 扩展的 `PAGE_INFO` 块**：上传前剥离，并用其中的 `pageTitle` / `revisionID` 决定目标页面与编辑冲突基准。
- **三种预览方式**：Webview 自绘、VS Code 内置浏览器、系统浏览器，一键切换。
- **密码存系统钥匙串**（`context.secrets`），不写入 `settings.json`。
- **中文界面**，对灰机wiki（HuijiWiki）等中文站点开箱可用。

---

## 安装

### 从 Release 安装（推荐）

到 [Releases](https://github.com/HOPE-LGNF/wiki-user-preview/releases) 下载最新的 `.vsix`，然后：

```bash
code --install-extension wiki-user-preview-<版本>.vsix
```

装完重载窗口：`Ctrl+Shift+P` → **Developer: Reload Window**。

> 注意用**哪一侧**的 `code` 命令：如果 VS Code 是从 Windows 连到 WSL / 容器 / 远程的，扩展要装在你实际编辑文件的那一侧。从 WSL 终端执行 `code --install-extension` 会装到 WSL 侧，用 Windows 的 `code.cmd` 则装到 Windows 侧。

### 从源码构建

```bash
git clone https://github.com/HOPE-LGNF/wiki-user-preview.git
cd wiki-user-preview
npm install
npm run compile        # esbuild 打包到 dist/extension.js
npm run package        # 产出 .vsix
```

在 VS Code 里打开这个目录，按 **F5** 启动 Extension Development Host，在宿主窗口里打开一个 `.wikitext` 文件即可调试。

---

## 快速开始

### 与其它扩展的关系

本扩展可以完全独立使用；如果装了下面两个扩展，会自动复用它们的配置，省掉重复填写：

| 扩展 | 本扩展如何使用它 |
|---|---|
| [Wikitext](https://marketplace.visualstudio.com/items?itemName=RoweWilsonFrederiskHolme.wikitext)（`RoweWilsonFrederiskHolme.wikitext`） | 读取 `wikitext.host` / `apiPath` / `articlePath` / `userName` / `password` 作为回退配置。它自身带 `wikitext.password`（**明文存 settings.json**），本扩展只在你自己填了该项时才读取。 |
| [WikiParser Language Server](https://marketplace.visualstudio.com/items?itemName=Bhsd.vscode-extension-wikiparser)（`Bhsd.vscode-extension-wikiparser`） | 读取 `wikiparser.articlePath` 辅助站点探测；若 `wikiparser.user` 填的是用户页 URL，会从中解析出用户名。 |

两点说明：

- WPLS 的 `wikiparser.user` 是**给 User-Agent 用的联系方式**（WMF 的 UA 政策要求），不是账号，也不涉及任何认证。本扩展不会去借用别的扩展的登录会话——它自己完成登录与写入。
- Wikitext 扩展不导出公开 API，所以两边的会话是各自独立的，互不干扰。

`wikitext.wikiparser.enable` 打开时，Wikitext 会激活 WPLS；这与本扩展无关。

### 配置

最省事的方式是先在 Wikitext 扩展里配好站点和账号，本扩展会自动继承。也可以自己配：

```jsonc
{
  "wikiUserPreview.site": "www.huijiwiki.com",   // 灰机wiki 主站；实际填你自己那个 wiki 的域名
  "wikiUserPreview.apiPath": "/api.php",
  "wikiUserPreview.articlePath": "/wiki/",
  "wikiUserPreview.username": "你的用户名@机器人名",  // 机器人密码写法：用户名@机器人名
  "wikiUserPreview.pageTemplate": "User:{username}/OriginalPreview/{filename}"
}
```

密码用命令 **Wiki User Preview: 设置密码（存入系统钥匙串）** 录入。

两者都不配也可以——第一次执行主命令时，扩展会依次弹窗询问站点、用户名、密码，并可以顺手把密码存进系统钥匙串。

> **建议使用机器人密码。** 在站点上访问 `Special:BotPasswords` 创建一个，授予 *Edit existing pages* 与 *Create, edit, and move pages* 权限，会得到形如 `用户名@机器人名` 的用户名和一段一次性密码。
> MediaWiki 官方说明：`action=login` 只为机器人密码设计；主账号密码必须走 `action=clientlogin`，账号开启两步验证时还需额外交互。本扩展两条路都实现了，`loginMode` 为 `auto`（默认）时会按用户名里有没有 `@` 自动选择并互相回退。

---

## 命令

| 命令 | 作用 |
|---|---|
| `wikiUserPreview.originalPreview` | **主命令**：写入用户页 → 保存 → 打开预览。快捷键 `Ctrl+Alt+P`，只在 wikitext 语言的文件里出现 |
| `wikiUserPreview.login` | 登录并显示当前账号、UID、cookie 数 |
| `wikiUserPreview.logout` | 请求 `action=logout` 并清空本地 cookie 与缓存会话 |
| `wikiUserPreview.setPassword` | 把密码写入系统钥匙串（按站点分别保存） |
| `wikiUserPreview.clearPassword` | 清除钥匙串里的密码 |
| `wikiUserPreview.showResolvedConfig` | 以 JSON 显示**实际生效**的配置（密码打码），排查"到底读了哪个配置" |

主命令的执行流程：

1. 取当前编辑器内容；
2. 若是 Wikitext 扩展拉取下来的文件，剥离开头的 `PAGE_INFO` 块；
3. 解析配置（站点 → `apiPath` 自动探测 → 用户名 → 密码）；
4. 弹窗确认目标页面与字符数；
5. 登录（复用会话，必要时重新登录）；
6. 取 CSRF token；决定冲突检测的基准版本；
7. `action=edit` 写入并保存（带 `assert=user`）；
8. 令牌 / 登录态失效时自动重登重试；`editconflict` 时询问是否强制覆盖；
9. 写入成功后按需 `action=purge`，然后打开预览。

全过程写入 **Output → Wiki User Preview** 通道，出错时提示条上会给出「查看日志」。

---

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `wikiUserPreview.site` | `""` | 完整 URL 或裸域名。留空回退到 `wikitext.host` |
| `wikiUserPreview.apiPath` | `""` | 留空时依次尝试 `wikitext.apiPath`、`/api.php`、`/w/api.php` 自动探测 |
| `wikiUserPreview.articlePath` | `""` | 留空回退到 `wikitext.articlePath`，再不行用 `/wiki/` |
| `wikiUserPreview.username` | `""` | 留空依次回退 `wikitext.userName` → 从 `wikiparser.user` 解析 |
| `wikiUserPreview.useWikitextSettings` | `true` | 是否允许继承 Wikitext 扩展的站点/账号配置 |
| `wikiUserPreview.loginMode` | `auto` | `auto` / `botPassword` / `clientlogin` |
| `wikiUserPreview.targetFromPageInfo` | `userNamespaceOnly` | `PAGE_INFO.pageTitle` 在多大程度上决定目标页面：`userNamespaceOnly` / `always` / `never` |
| `wikiUserPreview.pageTemplate` | `User:{username}/OriginalPreview/{filename}` | 目标页面标题模板 |
| `wikiUserPreview.subpage` | `""` | `{subpage}` 的值，留空取当前文件名 |
| `wikiUserPreview.summaryTemplate` | `由 VS Code 扩展 Wiki User Preview 上传，源文件：{basename}` | 编辑摘要模板 |
| `wikiUserPreview.previewMode` | `webview` | `webview` / `simpleBrowser` / `external` / `ask` |
| `wikiUserPreview.enableScripts` | `false` | webview 模式下注入链接跳转脚本（站点 JS 一律剥离） |
| `wikiUserPreview.getCss` | `true` | webview 模式额外拉站点 CSS（`prop=headhtml`） |
| `wikiUserPreview.watchlist` | `nochange` | 监视列表处理：`nochange` / `preferences` / `unwatch` / `watch` |
| `wikiUserPreview.minorEdit` | `false` | 标记小编辑 |
| `wikiUserPreview.confirmBeforeSave` | `true` | 写入前弹窗确认 |
| `wikiUserPreview.detectConflict` | `true` | 用 PAGE_INFO 里的版本做冲突检测，冲突时询问是否强制覆盖 |
| `wikiUserPreview.purgeAfterSave` | `true` | 写入后调 `action=purge` 刷新页面缓存 |
| `wikiUserPreview.simpleBrowserBeside` | `true` | 让内置浏览器不与代码挤在同一编辑器组，而是出现在代码区右侧 |
| `wikiUserPreview.openAfterSave` | `true` | 保存后自动打开预览 |
| `wikiUserPreview.userAgent` | `""` | 自定义 User-Agent；被 Cloudflare 拦时可填浏览器 UA |
| `wikiUserPreview.requestTimeout` | `30000` | 单请求超时（毫秒） |
| `wikiUserPreview.insecureTls` | `false` | 跳过证书校验（仅自建站点自签证书时用） |

### 页面命名

`pageTemplate` 支持的变量：

- `{username}` — 登录用户名
- `{filename}` — 当前文件名，**不含扩展名**，已做 MediaWiki 标题合法化
- `{basename}` — 含扩展名的文件名
- `{ext}` — 扩展名（不含点）
- `{subpage}` — `wikiUserPreview.subpage` 的值，留空则等于 `{filename}`

常见用法：

```jsonc
// 每个源文件一个页面（默认）
"wikiUserPreview.pageTemplate": "User:{username}/OriginalPreview/{filename}"

// 固定单页，反复覆盖
"wikiUserPreview.pageTemplate": "User:{username}/OriginalPreview"

// 用 subpage 配置项手动指定子页面名
"wikiUserPreview.pageTemplate": "User:{username}/OriginalPreview/{subpage}"
```

`User:` 是 MediaWiki 的规范命名空间名，在中文站点（含灰机wiki）同样有效，不必写成 `用户:`。

### 拉取来的文件：PAGE_INFO

Wikitext 扩展的 **Pull page to edit**（`wikitext.readPage`）会在文件开头插入一个元信息块：

```
<%-- [PAGE_INFO]
    pageTitle = #Foo#
    pageID = #12345#
    revisionID = #67890#
    ...
[END_PAGE_INFO] --%>
```

本扩展会：

1. **上传前剥离这个块**。它对 `wikitext` 内容模型并不是注释（Wikitext 为非 wikitext 模型准备的是 `/* */`、`--[=[ ]=]`），不剥离的话会明文出现在页面正文里。
2. **用 `pageTitle` 决定目标页面**。默认 `targetFromPageInfo: userNamespaceOnly`：只有当该标题位于 User 命名空间时才写回它，这样「拉取 → 编辑 → 预览」能形成往返；而拉取的是主命名空间条目时，仍然写到自己的用户子页，不会误编辑条目。设为 `always` 则完全等同 `wikitext.writePage` 的语义（自行确认权限），设为 `never` 则始终用 `pageTemplate`。
3. **用 `revisionID` 做冲突检测**。基准版本取自「拉取页面时」而不是「提交前刚查到的」——后者永远等于当前版本，检测不出任何东西。同时会带上 `basetimestamp`，因为按 API 说明，只发 `baserevid` 时「自己改自己」会被判成冲突。

---

## 预览方式

保存成功后按 `previewMode` 打开页面：

| 模式 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| `webview`（默认） | 调 `action=parse` 拿渲染后的 HTML，在 Webview 里自己渲染 | 不受 iframe 限制、不执行站点脚本、最稳；复用同一个面板 | 没有站点皮肤（只有 `prop=headhtml` 带来的部分样式） |
| `simpleBrowser` | VS Code 内置浏览器 | 真·原页面，有站点皮肤、按钮、目录 | 见下面的「已知行为」 |
| `external` | 系统默认浏览器 | 最可靠，一定有完整外观 | 跳出 VS Code |
| `ask` | 每次弹窗选 | 灵活 | 每次都要选一次 |

不管用哪种方式，成功后的提示条上都会给出**另外两种打开方式**的按钮，一键切换，不用改配置。

Webview 模式的安全处理：

- 站点自带的 `<script>` 和 inline 事件处理器（`onclick` 等）**一律剥离**；
- 注入 `<base href="站点条目前缀">`，让相对链接和图片能正确解析；
- CSP 默认 `script-src 'none'`；只有把 `enableScripts` 打开，才会注入一个带 nonce 的脚本，把点击链接改为交给系统浏览器打开。

### 已知行为：内置浏览器

**「因通知而暂停」。** 内嵌页面触发浏览器通知时，VS Code 会暂停内置浏览器并显示这句提示（原文是 VS Code 自己的 `Paused due to Notification`）。需要手动关掉通知才能继续看内容。这与站点本身无关，是 iframe 内运行的必然结果。

**第三方 cookie 被拦。** 内置浏览器是 `vscode-webview://` 里的 iframe，站点 cookie 属第三方，会被浏览器的 cookie 策略拦掉。站点若依赖 cookie 判断「公告已读过」，公告就会反复出现。

**落位。** 内置浏览器的工作方式随 VS Code 版本变化：从 1.9x 起，只要工作台里有集成浏览器（`workbench.action.browser.open`），内置 simple-browser 就会把请求转交过去，而那条路径收不到 `viewColumn`，总是开在**当前编辑器组**里，看起来就像替换掉了正在看的代码页。本扩展的做法是**先打开、再按需把浏览器标签移到右侧组**（`workbench.action.moveEditorToRightGroup`）：

- 判据是「这一组里有没有代码文件」，因此连续预览不会越切越多组；
- 只有确认活动标签不是文本编辑器时才移动，所以浏览器打开失败时绝不会把你的代码文件搬走；
- 关掉 `wikiUserPreview.simpleBrowserBeside` 即恢复 VS Code 的原生行为。

**标签不复用。** 集成浏览器每次预览都会新开一个标签（分组数不变）。想复用同一个面板请用 `webview` 模式。

### 已知行为：缓存

页面已经更新，内置浏览器却仍显示旧版、刷新也无效，通常是多层缓存叠加：浏览器 HTTP 缓存 / bfcache（URL 没变就不重新请求）、内置浏览器复用 webview、以及 Cloudflare 之类**按完整 URL 做键**的边缘缓存。扩展叠了三道处理：

1. **预览 URL 带版本参数** —— 打开用的地址是 `...?wikiUserPreviewRev=<版本>`，每次保存版本号都变，URL 变了就必然重新取。MediaWiki 会忽略页面视图上不认识的 query 参数。「查看页面地址」按钮复制的是**不带参数**的规范地址。
2. **Webview 模式把解析钉死在版本上** —— 用 `action=parse&oldid=<新版本>`，并请求 `prop=revid` 校验回来的版本号；对不上会**直接报错**，而不是静默展示旧内容。
3. **`purgeAfterSave`（默认开）** —— 写入成功后调 `action=purge`。编辑本身会刷新 MediaWiki 的解析缓存，但边缘缓存不一定跟着失效；purge 失败只记日志，不阻塞预览。

---

## 构建与测试

```bash
npm install

npm run compile          # 构建：esbuild 打包到 dist/extension.js
npm run watch            # 构建（watch 模式）
npm run package          # 打包成 .vsix

npm run typecheck        # tsc --noEmit
npm run check:manifest   # 校验 package.json 与源码不漂移
npm run verify           # 离线自检：typecheck + check:manifest + 构建 + 产物校验
npm run smoke            # 冒烟测试（需联网）
npm run test:integration # 真机集成测试（需图形界面）
```

### 各类检查分别管什么

| 命令 | 覆盖范围 | 需要什么 |
|---|---|---|
| `npm run typecheck` | 类型检查 | 无 |
| `npm run check:manifest` | `package.json` 与源码的一致性：声明的命令是否都注册了、配置项是否都真的被读取、`#xxx#` 内链是否指向存在的配置项、`main` 是否指向构建产物 | 无 |
| `scripts/verify-bundle.cjs` | 把 `vscode` 替换成替身后**真正 require 打包产物并调用 `activate()`**，断言命令注册等 | 无 |
| `npm run smoke` | 91 项断言：纯函数（标题模板、`PAGE_INFO` 剥离、URL 拼装、头部净化、预览 HTML 生成）+ 对真实 MediaWiki 的匿名只读调用（含 429 退避） | 联网 |
| `npm run test:integration` | 5 项断言：在真实 VS Code 的扩展宿主里验证编辑器分组与标签落位、revid 校验 | 图形界面 + 首次会下载 VS Code |

CI（`.github/workflows/ci.yml`）只跑 `npm run verify` 与打包上传产物——`smoke` 依赖外部站点、`test:integration` 需要 GUI，都留在本地按需运行。

### 集成测试在无图形界面的 Linux 上怎么跑

`npm run test:integration` 依赖 X 显示。在 WSL 下可以直接利用 WSLg；整条链路由 `scripts/run-integration.sh` 封装：

- 指向 WSLg 的 X socket（`/mnt/wslg/.X11-unix/X0`）；
- 把 `XDG_RUNTIME_DIR` 指到可写目录（VS Code 主进程要在那里建 IPC socket）；
- 若 Electron 缺运行库，先跑一次 `bash scripts/setup-electron-libs.sh`——它用 `apt-get download` + `dpkg -x` 把 `libnss3` / `libnspr4` / `libasound2` 解到 `~/.local/vscode-test-libs`，靠 `LD_LIBRARY_PATH` 生效，**不需要 root、不碰系统目录**。

测试用 `@vscode/test-electron` 拉起真实 VS Code，并在本地起一个假站点与假 MediaWiki API，除首次下载 VS Code 外全程离线。

---

## 已知限制

- **Cloudflare / WAF**：灰机wiki 等站点的 `api.php` 在数据中心 IP 上可能被 Cloudflare 的人机验证拦截（返回 `403` + "请稍候…"）。浏览器直连通常没问题；必要时把 `wikiUserPreview.userAgent` 改成你浏览器的完整 UA。
- **内置浏览器可能空白**：站点若禁止 iframe 嵌套（`X-Frame-Options` / `frame-ancestors`）就会如此，不是本扩展的问题。改用 `webview` 或 `external`。
- **Webview 模式没有站点皮肤**：只渲染 `action=parse` 的内容 HTML，不是完整页面快照。要完整外观请用 `external`。
- **两步验证**：`clientlogin` 走到 UI 步骤时，扩展会把站点要求的字段（如 `OATHToken`）逐个弹窗询问。图形验证码无法在扩展内完成。
- **默认只写 User 命名空间**：模板可以改成任意页面，但请自行确认有编辑权限。
- **不做后台或自动上传**：命令只在你手动触发时执行。
- **`wikitext.password` 是明文**：这是 Wikitext 扩展的设计。本扩展优先使用系统钥匙串，只在你自己填了该项时才回退读取。

---

## 目录结构

```
wiki-user-preview/
├── src/
│   ├── extension.ts              # 命令注册、主流程、会话缓存、错误处理
│   ├── config.ts                 # 配置解析与回退链、站点探测、标题模板、URL 拼装
│   ├── mediawiki.ts              # tokens / login / clientlogin / edit / parse / purge / 限流重试
│   ├── httpClient.ts             # 零依赖 HTTP 客户端：cookie jar、重定向、gzip/br 解压
│   ├── pageInfo.ts               # PAGE_INFO 块的解析与剥离
│   ├── preview.ts                # 三种预览方式 + HTML 净化 + 浏览器落位
│   └── test/integration/         # 真机集成测试（@vscode/test-electron）
├── scripts/
│   ├── smoke.ts                  # 冒烟测试
│   ├── vscode-stub.ts            # 让纯函数与决策逻辑能在 Node 里被测试的 vscode 替身
│   ├── verify-bundle.cjs         # 打包产物校验
│   ├── check-manifest.mjs        # package.json 与源码一致性校验
│   └── run-integration.sh        # 集成测试环境包装
├── .github/workflows/ci.yml
├── esbuild.mjs
└── package.json
```

依赖策略：**运行时零第三方依赖**。cookie 会话必须自己管，而少一个依赖就少一个在远程 / Web 扩展宿主里出问题的地方。

---

## 许可

[MIT](LICENSE)
