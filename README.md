# Wiki User Preview

[![CI](https://github.com/HOPE-LGNF/wiki-user-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/HOPE-LGNF/wiki-user-preview/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue.svg)

把当前打开的 **wikitext 文件**写入 MediaWiki 站点上 **User 命名空间**下的一个页面、保存，然后立刻打开该页面的渲染结果。

适合「本地写稿 → 上传到自己的用户子页 → 看看实际渲染成什么样」这个循环。

---

## 功能

- **一条命令完成上传与预览**，不用切浏览器、不用手动复制粘贴；也可以用「仅写入」命令只上传、由你自己在多屏环境里刷新。
- **目标页面可模板化**，默认每个源文件对应一个独立页面，不会互相覆盖。
- **运行时零第三方依赖**：自带 HTTP 客户端（cookie 会话、重定向、gzip/br 解压、限流重试），不依赖 `node-fetch` / `mwbot`。
- **登录双通道**：机器人密码走 `action=login`，主账号密码走 `action=clientlogin`（含两步验证，按 MediaWiki 的 `logincontinue` 协议续登），`auto` 模式自动选择并互相回退。
- **写入位置按服务端确认的账号名**：机器人密码的登录名是 `Alice@机器人名`，但目标页面用的是登录后由站点确认的账号名（`Alice`），所以写入的是你自己的用户子页。
- **凭据边界明确**：密码只发送给保存它时绑定的站点，拼接后的 API/条目地址必须与配置的站点同源，HTTP 客户端只与一个主机通信、拒绝跨主机跳转。详见[凭据边界](#凭据边界)。
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
| [WikiParser Language Server](https://marketplace.visualstudio.com/items?itemName=Bhsd.vscode-extension-wikiparser)（`Bhsd.vscode-extension-wikiparser`） | 读取 `wikiparser.articlePath` 作为条目地址前缀的回退（排在 `wikitext.articlePath` 之后）；若 `wikiparser.user` 填的是用户页 URL，会从中解析出用户名。 |

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
> MediaWiki 官方说明：`action=login` 只为机器人密码设计；主账号密码必须走 `action=clientlogin`。本扩展两条路都实现了，`loginMode` 为 `auto`（默认）时会按用户名里有没有 `@` 自动选择并互相回退。
>
> 用机器人密码时，`特殊:机器人密码` 里那串 `用户名@机器人名` 是**登录名**，账号本身仍是 `用户名`。本扩展在登录成功后向站点确认真实账号名，并用它生成目标页面，所以写入的是 `User:用户名/...`，而不是 `User:用户名@机器人名/...`。

---

## 命令

| 命令 | 作用 |
|---|---|
| `wikiUserPreview.originalPreview` | **写入并预览**：写入用户页 → 保存 → 打开预览。快捷键 `Ctrl+Alt+P` |
| `wikiUserPreview.writeOnly` | **仅写入**：写入用户页 → 保存，**不打开预览**。快捷键 `Ctrl+Alt+U` |
| `wikiUserPreview.login` | 登录并显示当前账号、UID、cookie 数 |
| `wikiUserPreview.logout` | 请求 `action=logout` 并清空本地 cookie 与缓存会话 |
| `wikiUserPreview.setPassword` | 把密码写入系统钥匙串（按站点分别保存） |
| `wikiUserPreview.clearPassword` | 清除钥匙串里的密码 |
| `wikiUserPreview.showResolvedConfig` | 以 JSON 显示**实际生效**的配置（密码打码），排查"到底读了哪个配置" |

两个写入命令共用同一套流程，只有最后一步不同：

| | `originalPreview` | `writeOnly` |
|---|---|---|
| 目标页面、冲突检测、`purge`、日志 | 相同 | 相同 |
| 打开预览 | 取决于 `openAfterSave`（默认开） | **始终不打开** |

`writeOnly` 适合另一块屏幕上已经开着该页面、改完直接刷新就行的场景。它同样会执行 `action=purge`（受 `purgeAfterSave` 控制），所以刷新时不会因为边缘缓存看到旧版。完成后会弹一条带 **「在浏览器中打开」**（用的是带版本参数、绕开缓存的地址）和 **「查看页面地址」** 的提示，不点就什么都不做。

在编辑器的标题栏上，`writeOnly` 是云上传图标，`originalPreview` 是预览图标，两者都在 `editorLangId == wikitext` 时出现。

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
| `wikiUserPreview.articlePath` | `""` | 条目地址前缀。留空依次回退 `wikitext.articlePath` → `wikiparser.articlePath` → 探测结果 → `/wiki/` |
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
| `wikiUserPreview.openAfterSave` | `true` | `originalPreview` 保存后是否自动打开预览；`writeOnly` 始终不打开，与本项无关 |
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

## 凭据边界

预览之前会**真正把文件写到站点上**，所以「密码发给了谁」「内容写到了哪一页」比预览窗口本身更重要。扩展在这两点上做了明确限制，宁可报错也不静默继续。

### 密码只发给配置的站点

密码按站点域名存在系统钥匙串里（`wikiUserPreview.password.<host>`）。而请求发往的地址是由 `site` 与 `apiPath` / `articlePath` 拼出来的，所以拼接结果会被逐一校验：

- 最终地址的**主机**必须与配置的站点主机一致，协议也必须一致；
- 地址里不允许出现 userinfo（`@` 之前的部分）。少了这条，`apiPath` 填成 `@evil.example/api.php` 就会让 URL 的实际主机变成 `evil.example`——界面显示的是 A 站，密码却发给了 B 站；
- `apiPath` 只接受路径，不接受夹带协议或主机。

任一条不满足都会**在发出任何请求之前**抛错，错误信息里会写明两个主机名。

### 一个客户端只与一个主机通信

HTTP 客户端持有唯一被授权的主机，每次请求（包括每一次重定向）在建立连接之前都会核对：

- **跨主机跳转一律拒绝**。站点回一个 307 就想把会话 cookie 和登录表单（或待上传正文）转交给别的主机——这条路是封死的；
- 同主机跳转照常跟随（MediaWiki 的 `/api.php` → `/w/api.php`、http → https 都很常见），但禁止 https → http 降级；
- 换站点时 cookie jar 会被清空，不会把上一个站点的会话带过去。

### 会话

- 编辑与预览**复用同一个已登录客户端**。私有 wiki 上如果预览另起一个匿名客户端，就会出现「保存成功、预览失败」；
- **退出登录**用当前会话的客户端发 `action=logout`，请求带着会话 cookie，服务端会话会被真正注销，之后才清除本地 cookie；
- User-Agent / 超时 / `insecureTls` 变更会**立即**丢弃已有客户端与会话——否则「先跳过 TLS 校验、之后关掉」不会对已建立的连接生效。

### 明文密码

系统钥匙串是首选。若你改用 `wikitext.password` 或 `wikiUserPreview` 侧的自定义配置，密码会以**明文**存在 `settings.json` 里——工作区级的 `settings.json` 会随仓库一起被提交，共享项目时要特别注意这一点。

---

## 批量导出页面（附带脚本）

Wikitext 只有单页的「Pull page to edit」。要一次拿回几十上百页，用仓库里的
`scripts/batch-grab.mjs`：零依赖、单文件，可直接拷到别处运行。

```bash
# 先看要抓哪些（不发内容请求）
node scripts/batch-grab.mjs --site <你的站点> --prefix "模块:建筑/" --dry-run

# 真正导出
node scripts/batch-grab.mjs --site <你的站点> --prefix "模块:建筑/" --out ./wiki-export

# 也可以混合多个来源
node scripts/batch-grab.mjs --site <你的站点> --category "分类:角色" --file 额外标题.txt --out ./wiki-export
```

**它必须跑在能访问该站点的网络里**——它是个普通的 Node 脚本，不在 VS Code 里运行，
也不走扩展宿主。站点在 Cloudflare 后面时，数据中心 IP 或非常规客户端可能被质询，
此时在你自己机器上跑才有意义。

| 参数 | 作用 |
|---|---|
| `--site <host>` | 必填，例如 `www.huijiwiki.com` |
| `--api-path <p>` | 默认 `/api.php`；注意维基百科是 `/w/api.php` |
| `--ua <string>` | User-Agent。被 Cloudflare 质询时可以填浏览器的 UA |
| `--pages` / `--file` / `--prefix` / `--category` / `--all` | 页面来源，可叠加，取并集 |
| `--out <dir>` | 输出目录，默认 `./wiki-export` |
| `--name-style` | `dash`（默认）把 `:` 与 `/` 换成 `_`，平铺；`raw` 保留 `/`，按子页面分目录 |
| `--no-page-info` | 不写 `PAGE_INFO` 头，只要纯源码 |
| `--overwrite` | 覆盖已存在的文件；默认跳过，便于中断后续跑 |
| `--batch` / `--delay` | 每次请求合并的标题数（默认 20，上限 50）与请求间隔（默认 300ms） |
| `--dry-run` | 只列出将要导出的页面，不请求内容、不写文件 |

导出的文件默认带 `PAGE_INFO` 头，格式与 Wikitext 写入的完全一致，因此**改完可以直接用
Wikitext 的「Post your edit to the website」推回去**——它从头部读取目标页面与冲突基准，
并在推送前把整块剥掉。冒烟测试里有一条断言专门守着这个契约（导出 → 本扩展的解析器必须
能剥掉并还原出标题、版本与正文）。

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
| `npm run typecheck` | 类型检查（`src/` 与 `scripts/` 都在内，测试脚本不过类型检查很容易掩盖错误） | 无 |
| `npm run check:manifest` | `package.json` 与源码的一致性：声明的命令是否都注册了、配置项是否都真的被读取、`#xxx#` 内链是否指向存在的配置项、自述文件的配置表是否与 `package.json` 一致、`main` 是否指向构建产物 | 无 |
| `scripts/verify-bundle.cjs` | 把 `vscode` 替换成替身后**真正 require 打包产物并调用 `activate()`**，断言命令注册、订阅是否都可回收 | 无 |
| `npm run test:batch` | 11 项断言：批量导出工具的文件名映射、`PAGE_INFO` 头格式、分批请求、整批失败后逐条重试、续跑跳过、`--dry-run` 不发内容请求、API/HTTP 错误处理 | 无 |
| `npm run smoke` | 129 项断言。纯函数（标题模板、`PAGE_INFO` 定位、URL 拼装、头部净化、预览 HTML 与 CSP）+ **本地假 MediaWiki** 上的凭据边界、跳转限制、两步验证续登、会话与登出、主机白名单 + 对真实 MediaWiki 的匿名只读调用（含 429 退避） | 部分联网 |
| `npm run test:integration` | 7 项断言：在真实 VS Code 的扩展宿主里验证编辑器分组与标签落位、revid 校验，以及**完整的写入流程**（用本地假 wiki 跑通登录 → 编辑 → 撤缓存 → 预览） | 图形界面 + 首次会下载 VS Code |

CI（`.github/workflows/ci.yml`）只跑 `npm run verify` 与打包上传产物——`smoke` 里有一小段依赖外部站点、`test:integration` 需要 GUI，都留在本地按需运行。

`npm run smoke` 里对真实站点的部分只有**匿名只读**调用（`action=query`）。登录失败、编辑报错这类写路径的覆盖全部打在本地假站点上，不会向第三方站点发出登录尝试。

那一段联网检查会先确认目标站点可达；不可达时整段**跳过并说明原因**（计入「跳过」而不是「通过」），这样网络问题不会伪装成代码失败。需要强制要求联网时，设 `WIKI_USER_PREVIEW_REQUIRE_NETWORK=1`，跳过会按失败处理。

`npm run test:integration` 会先重新构建扩展产物再启动 VS Code——否则扩展宿主加载的还是上一次的 `dist/extension.js`，测试就会在不知不觉中验证过期代码。它同时用 `--user-data-dir` 把测试实例的用户目录指到 `.vscode-test/user-data`，不会碰你日常使用的 VS Code 配置。

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
- **两步验证**：`clientlogin` 返回 `UI` 时，扩展会把站点要求的字段（如 `OATHToken`）弹窗询问，然后按 MediaWiki 协议带 `logincontinue` 续登。受限之处：纯图形验证码与第三方 OAuth 跳转（`REDIRECT`）都无法在扩展内完成，这两种情况会明确报错并建议改用机器人密码；`RESTART`（认证通过但没有本地账号）同样会明确报错。
- **默认只写 User 命名空间**：模板可以改成任意页面，但请自行确认有编辑权限。
- **不做后台或自动上传**：命令只在你手动触发时执行。
- **`wikitext.password` 是明文**：这是 Wikitext 扩展的设计。本扩展优先使用系统钥匙串，只在你自己填了该项时才回退读取。
- **`PAGE_INFO` 只在文件开头识别**：正文中间出现的同形块会被当成正文原样上传（并在日志里提示）——这样文档里贴的格式示例不会被静默删掉，其中的 `pageTitle` 也无法劫持目标页面。反过来说，如果你把块挪离了文件开头，它就不会再被剥离。
- **配置里的“路径”必须是路径**：`apiPath` / `articlePath` 若被填成指向别的主机的地址，扩展会**直接报错**而不是照发请求。这是有意的取舍。

---

## 目录结构

```
wiki-user-preview/
├── src/
│   ├── extension.ts              # 命令注册、主流程、会话与客户端缓存、错误处理
│   ├── config.ts                 # 配置解析与回退链、站点探测、同源校验、标题模板、URL 拼装
│   ├── mediawiki.ts              # tokens / login / clientlogin / edit / parse / purge / 限流重试
│   ├── httpClient.ts             # 零依赖 HTTP 客户端：单向主机白名单、cookie jar、重定向、gzip/br
│   ├── pageInfo.ts               # PAGE_INFO 块的解析与剥离（只认文件开头）
│   ├── preview.ts                # 三种预览方式 + HTML 净化 + CSP + 浏览器落位
│   └── test/integration/         # 真机集成测试（@vscode/test-electron），含端到端写入流程
├── scripts/
│   ├── batch-grab.mjs            # 批量导出页面源码的独立工具（零依赖，可直接拷走）
│   ├── batch-grab.d.mts          # 上面那个纯 JS 工具的类型声明（供仓库内调用方使用）
│   ├── batch-grab.test.mjs       # 它的离线测试（node:test，假 API + 真实 HTTP 服务器）
│   ├── smoke.ts                  # 冒烟测试
│   ├── fakeWiki.ts               # 本地假 MediaWiki（登录 / 编辑 / 解析 / 私有读取）与凭据收集端
│   ├── vscode-stub.ts            # 让纯函数与决策逻辑能在 Node 里被测试的 vscode 替身
│   ├── verify-bundle.cjs         # 打包产物校验（自带一份内联替身，改 API 时要同步）
│   ├── check-manifest.mjs        # package.json 与源码、自述文件的一致性校验
│   ├── runIntegration.mjs        # 集成测试装置：预写设置、隔离用户目录、注入端口
│   └── run-integration.sh        # 无图形界面 Linux / WSL 下的环境包装
├── .github/workflows/ci.yml
├── esbuild.mjs
└── package.json
```

依赖策略：**运行时零第三方依赖**。cookie 会话必须自己管，而少一个依赖就少一个在远程 / Web 扩展宿主里出问题的地方。

---

## 许可

[MIT](LICENSE)
