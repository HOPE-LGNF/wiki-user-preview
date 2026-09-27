/**
 * 冒烟测试：
 *  1. 纯函数（标题拼装、模板、articlePath 处理、从 wikiparser.user 解析用户名）
 *  2. 对真实 MediaWiki（www.mediawiki.org）的匿名只读 API 调用：
 *     apiPath 探测、login token、userinfo、action=parse、错误映射
 *
 * 运行：node esbuild.mjs 之外的独立打包，见 package.json 的 smoke 脚本。
 */
import * as stub from './vscode-stub';
import * as https from 'node:https';
import { WikiHttpClient, sanitizeHeaderValue } from '../src/httpClient';
import { MediaWikiApi, MediaWikiError, ParseResult } from '../src/mediawiki';
import { buildWebviewHtml, openInSimpleBrowser } from '../src/preview';
import { applyTemplate, articleUrl, buildPageTitle, documentVars, sanitizeTitlePart, usernameFromWikiparserUser, withCacheBuster } from '../src/config';
import { extractPageInfo, isUserNamespaceTitle, pageInfoFieldRange } from '../src/pageInfo';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
	}
}

function eq(name: string, actual: unknown, expected: unknown): void {
	check(name, actual === expected, { actual, expected });
}

// ------------------------------------------------------------ 1. 纯函数

console.log('\n[1] 纯函数');

eq('sanitizeTitlePart 去掉非法字符', sanitizeTitlePart('a#b<c>d[e]f|g{h}i'), 'a-b-c-d-e-f-g-h-i');
eq('sanitizeTitlePart 下划线转空格', sanitizeTitlePart('foo_bar'), 'foo bar');
eq('sanitizeTitlePart 折叠空白', sanitizeTitlePart('  a   b  '), 'a b');
eq('sanitizeTitlePart 保留中文', sanitizeTitlePart('用户页测试'), '用户页测试');

eq('usernameFromWikiparserUser: wiki/User:Foo', usernameFromWikiparserUser('https://zh.wikipedia.org/wiki/User:Foo'), 'Foo');
eq(
	'usernameFromWikiparserUser: index.php?title=User:Foo',
	usernameFromWikiparserUser('https://zh.wikipedia.org/w/index.php?title=User:Foo&action=view'),
	'Foo',
);
eq('usernameFromWikiparserUser: 中文命名空间', usernameFromWikiparserUser('https://huijiwiki.com/wiki/用户:Unauthorized_HOPE'), 'Unauthorized HOPE');
eq('usernameFromWikiparserUser: 带子页面只取主名', usernameFromWikiparserUser('https://x.org/wiki/User:Foo/bar'), 'Foo');
eq('usernameFromWikiparserUser: 邮箱返回 undefined', usernameFromWikiparserUser('me@example.com'), undefined);

const doc = { fileName: '/tmp/我的测试页.wikitext', isUntitled: false } as unknown as Parameters<typeof documentVars>[0];
const vars = documentVars(doc, 'Unauthorized_HOPE', '');
eq('documentVars.filename 去扩展名', vars.filename, '我的测试页');
eq('documentVars.subpage 默认取文件名', vars.subpage, '我的测试页');
eq('documentVars.ext', vars.ext, 'wikitext');

eq(
	'buildPageTitle 默认模板',
	buildPageTitle({ pageTemplate: 'User:{username}/OriginalPreview/{filename}' }, vars),
	'User:Unauthorized_HOPE/OriginalPreview/我的测试页',
);
eq('buildPageTitle 固定单页', buildPageTitle({ pageTemplate: 'User:{username}/OriginalPreview' }, vars), 'User:Unauthorized_HOPE/OriginalPreview');
eq(
	'applyTemplate 摘要变量',
	applyTemplate('上传 {basename}（{filename}）', vars),
	'上传 我的测试页.wikitext（我的测试页）',
);

eq('articleUrl 直接追加', articleUrl('https://x.org/wiki/', 'User:Foo/Bar'), 'https://x.org/wiki/User:Foo/Bar');
eq('articleUrl 空格转下划线', articleUrl('https://x.org/wiki/', 'User:Foo bar'), 'https://x.org/wiki/User:Foo_bar');
eq('articleUrl $1 形式', articleUrl('https://x.org/index.php?title=$1', 'User:Foo/Bar'), 'https://x.org/index.php?title=User:Foo/Bar');
eq('articleUrl 保留冒号与斜杠', articleUrl('https://x.org/wiki/', 'User:无名氏/子页'), 'https://x.org/wiki/User:%E6%97%A0%E5%90%8D%E6%B0%8F/%E5%AD%90%E9%A1%B5');

// cache-buster：绕过浏览器缓存 / bfcache / VS Code 复用 webview / 边缘缓存
eq('withCacheBuster 追加参数', withCacheBuster('https://x.org/wiki/Foo', 123), 'https://x.org/wiki/Foo?wikiUserPreviewRev=123');
eq(
	'withCacheBuster 已有 query 时用 &',
	withCacheBuster('https://x.org/index.php?title=Foo', 123),
	'https://x.org/index.php?title=Foo&wikiUserPreviewRev=123',
);
check(
	'withCacheBuster 不同版本产生不同 URL（否则缓存照样命中）',
	withCacheBuster('https://x.org/wiki/Foo', 1) !== withCacheBuster('https://x.org/wiki/Foo', 2),
);

// 回归：wikiparser.user 允许是任意字符串，用户实际填过中文；HTTP 头值必须 ASCII。
eq('sanitizeHeaderValue 纯 ASCII 原样返回', sanitizeHeaderValue('Mozilla/5.0 (compatible; x/1.0)'), 'Mozilla/5.0 (compatible; x/1.0)');
eq('sanitizeHeaderValue 制表符保留', sanitizeHeaderValue('a\tb'), 'a\tb');
eq(
	'sanitizeHeaderValue 中文按 UTF-8 百分号编码',
	sanitizeHeaderValue('HOPE的机器人'),
	'HOPE%E7%9A%84%E6%9C%BA%E5%99%A8%E4%BA%BA',
);
eq(
	'sanitizeHeaderValue 处理代理对（emoji）',
	sanitizeHeaderValue('a😀b'),
	'a%F0%9F%98%80b',
);
eq('sanitizeHeaderValue 剔除控制字符', sanitizeHeaderValue('a\u0000b\u007fc'), 'a%00b%7Fc');
check(
	'sanitizeHeaderValue 输出必定是 ASCII（Node 头校验通过）',
	// Node 的 checkInvalidHeaderChar 等价于这个判定
	!/[^\t\x20-\x7e]/.test(sanitizeHeaderValue('Mozilla/5.0 (contact: HOPE的机器人) \u00e9\u4e2d')),
	sanitizeHeaderValue('Mozilla/5.0 (contact: HOPE的机器人)'),
);

// -------- PAGE_INFO：wikitext 的「Pull page to edit」必然在文件开头插入这个块 --------
// 下面的字符串按 wikitext 的 getPageCode/getInfoHead 真实格式构造：字段之间用 \r 分隔，
// 且 wikitext 内容模型用的注释符是空串，所以这个块本身并不是注释。
const realPull =
	[
		'<%-- [PAGE_INFO]',
		"    comment = #Please do not remove this struct. It's record contains some important information of edit.#",
		'    pageTitle = #User:Unauthorized HOPE/OriginalPreview/1#',
		'    pageID = #12345#',
		'    revisionID = #67890#',
		'    contentModel = #wikitext#',
		'    contentFormat = #text/x-wiki#',
		'[END_PAGE_INFO] --%>',
	].join('\n') +
	'\r\r' +
	'== 正文 ==\r\n这里是内容。\r\n';

const extracted = extractPageInfo(realPull);
check('PAGE_INFO：上传正文里不再含 PAGE_INFO', !extracted.content.includes('PAGE_INFO'), extracted.content.slice(0, 40));
check('PAGE_INFO：正文以真实内容开头', extracted.content.startsWith('== 正文 =='), JSON.stringify(extracted.content.slice(0, 16)));
check('PAGE_INFO：正文没有前导空行', !/^\s/.test(extracted.content), JSON.stringify(extracted.content.slice(0, 6)));
check('PAGE_INFO：剥离后确实变短', extracted.content.length < realPull.length, { raw: realPull.length, stripped: extracted.content.length });
eq('PAGE_INFO.pageTitle', extracted.info?.pageTitle, 'User:Unauthorized HOPE/OriginalPreview/1');
eq('PAGE_INFO.pageID', extracted.info?.pageID, '12345');
eq('PAGE_INFO.revisionID', extracted.info?.revisionID, '67890');
eq('PAGE_INFO.contentModel', extracted.info?.contentModel, 'wikitext');
eq('PAGE_INFO.contentFormat', extracted.info?.contentFormat, 'text/x-wiki');
check('PAGE_INFO：定位到块的绝对范围', extracted.block?.start === 0 && (extracted.block?.end ?? 0) > 0, extracted.block);

const revRange = extracted.block ? pageInfoFieldRange(realPull, extracted.block, 'revisionID') : undefined;
eq('pageInfoFieldRange 精确取到 revisionID 的值', revRange ? realPull.slice(revRange.start, revRange.end) : undefined, '67890');

// 没有块时不能改动任何内容
eq('没有 PAGE_INFO 时正文原样返回', extractPageInfo('== A ==\n正文').content, '== A ==\n正文');
check('没有 PAGE_INFO 时不产生 block', extractPageInfo('== A ==').block === undefined);

// 非 wikitext 内容模型会带真注释符，也要能剥掉
eq('jsonc 模型的 /* */ 包裹也能剥离', extractPageInfo('/*<%-- [PAGE_INFO]\n    pageTitle = #Foo#\n[END_PAGE_INFO] --%>*/\r\r{}').content, '{}');
eq('lua 模型的 --[=[ ]=] 包裹也能剥离', extractPageInfo('--[=[<%-- [PAGE_INFO]\n    pageTitle = #Foo#\n[END_PAGE_INFO] --%>--]=]\r\rreturn 1').content, 'return 1');

// 空字段（##）必须视为不存在，否则会把空串当成页面标题/版本号发出去
check('空字段 ## 视为不存在', extractPageInfo('<%-- [PAGE_INFO]\n    revisionID = ##\n[END_PAGE_INFO] --%>\r\rbody').info?.revisionID === undefined);

// 目标页面是否属于 User 命名空间（决定要不要写回 PAGE_INFO 的标题）
eq('isUserNamespaceTitle: User:', isUserNamespaceTitle('User:Foo'), true);
eq('isUserNamespaceTitle: 用户:', isUserNamespaceTitle('用户:Foo/bar'), true);
eq('isUserNamespaceTitle: 下划线等价于空格', isUserNamespaceTitle('User:Unauthorized_HOPE/1'), true);
eq('isUserNamespaceTitle: 主命名空间为 false', isUserNamespaceTitle('Main Page'), false);
eq('isUserNamespaceTitle: User talk 不是 User', isUserNamespaceTitle('User talk:Foo'), false);

// -------------------------------------------- 2. 真实 MediaWiki API 调用

const ORIGIN = 'https://www.mediawiki.org';
const ua = 'wiki-user-preview/0.1.0 (smoke test; +https://github.com/)';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Wikimedia 对匿名请求限流很严，这里自己按 Retry-After 退避，避免整个测试被 429 打断。 */
async function politeRequest(client: WikiHttpClient, url: string, options: Parameters<WikiHttpClient['request']>[1] = {}, label = '请求'): Promise<ReturnType<WikiHttpClient['request']>> {
	for (let attempt = 0; ; attempt++) {
		const response = await client.request(url, options);
		if (response.status !== 429 && response.status !== 503) {
			return response;
		}
		if (attempt >= 5) {
			return response;
		}
		const header = response.headers['retry-after'];
		const retryAfter = Number(Array.isArray(header) ? header[0] : header);
		const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20000) : Math.min(1500 * 2 ** attempt, 15000);
		console.log(`    … ${label} 被限流（HTTP ${response.status}），等待 ${Math.round(waitMs / 1000)}s 后重试`);
		await sleep(waitMs);
	}
}

async function probe(client: WikiHttpClient): Promise<string | undefined> {
	for (const candidate of ['/api.php', '/w/api.php']) {
		try {
			const response = await politeRequest(
				client,
				`${ORIGIN}${candidate}`,
				{ query: { action: 'query', meta: 'siteinfo', siprop: 'general', format: 'json' } },
				`探测 ${candidate}`,
			);
			if (response.status !== 200) {
				continue;
			}
			const data = JSON.parse(response.body) as { query?: { general?: { sitename?: string; articlepath?: string } } };
			if (data.query?.general) {
				return candidate;
			}
		} catch {
			/* 试下一个 */
		}
	}
	return undefined;
}

async function main(): Promise<void> {
	// ---- 预览打开位置：必须用 simpleBrowser.api.open 才能指定列（回归用户反馈）----
	// 这段放 main() 里是因为要用 await；smoke 打包成 CJS，不支持顶层 await。
	console.log('\n[1b] 预览打开位置（不需要联网）');
	// 让"刚打开的浏览器标签"立刻就是活动标签，避免等待窗口
	const browserTab = { input: new stub.TabInputWebview('browser') };
	stub.__setAvailableCommands(['workbench.action.browser.open', 'simpleBrowser.api.open', 'simpleBrowser.show', 'workbench.action.moveEditorToRightGroup']);
	stub.__setActiveEditor({ document: {} });
	stub.__setTabGroups([{ viewColumn: 2, tabs: [browserTab] }], 0);
	stub.__resetCalls();
	await openInSimpleBrowser('https://x.org/wiki/Foo');
	const browserCall = stub.__calls()[0];
	eq('有编辑器时走 simpleBrowser.api.open', browserCall?.command, 'simpleBrowser.api.open');
	eq('第一个参数是 Uri 对象而不是字符串', typeof browserCall?.args[0], 'object');
	eq(
		'第二个参数指定了 Beside 列（右侧分栏）',
		(browserCall?.args[1] as { viewColumn?: number } | undefined)?.viewColumn,
		-2,
	);

	// 没有打开的编辑器时应退化为当前列，避免凭空多切一栏
	stub.__setActiveEditor(undefined);
	stub.__resetCalls();
	await openInSimpleBrowser('https://x.org/wiki/Foo');
	eq('无编辑器时退化为 Active 列', (stub.__calls()[0]?.args[1] as { viewColumn?: number } | undefined)?.viewColumn, -1);

	// 老版本 VS Code 没有 api.open 时必须回退，而不是报错
	stub.__setAvailableCommands(['simpleBrowser.show', 'workbench.action.moveEditorToRightGroup']);
	stub.__setActiveEditor({ document: {} });
	stub.__resetCalls();
	await openInSimpleBrowser('https://x.org/wiki/Foo');
	eq('缺少 api.open 时回退到 simpleBrowser.show', stub.__calls()[0]?.command, 'simpleBrowser.show');
	stub.__setAvailableCommands(['workbench.action.browser.open', 'simpleBrowser.api.open', 'simpleBrowser.show', 'workbench.action.moveEditorToRightGroup']);

	// ---- 内置浏览器落位：决策逻辑（真实落位由 test:integration 在真机上验证）----
	// 背景：VS Code 1.9x 起只要存在 workbench.action.browser.open，内置 Simple Browser 就
	// 整个转交给"集成浏览器"，且它总是开在当前组；老式 Simple Browser 又是单例、reveal 不认
	// ViewColumn.Beside。所以统一改成"先打开，再按需把浏览器标签移到右侧组"。
	// 注意：标签对象必须复用同一份引用，否则 activeTab 不在 tabs 里，groupOfTab 会找不到组。
	const textTab = { input: new stub.TabInputText({}) };
	const webTab = { input: new stub.TabInputWebview('browser') };
	const MOVED = 'workbench.action.moveEditorToRightGroup';
	const ALL_BROWSER_COMMANDS = ['workbench.action.browser.open', 'simpleBrowser.api.open', 'simpleBrowser.show', MOVED];
	const mixedGroup = () => [{ viewColumn: 1, tabs: [textTab, webTab], activeTab: webTab }];

	// 场景 A：浏览器和代码挤在同一组 → 必须移动
	stub.__setAvailableCommands(ALL_BROWSER_COMMANDS);
	stub.__setActiveEditor({ document: {} });
	stub.__setTabGroups(mixedGroup());
	stub.__resetCalls();
	const rA = await openInSimpleBrowser('https://x.org/wiki/Foo', true);
	eq('A: 与代码同组时执行移到右侧', stub.__commandsCalled(MOVED).length, 1);
	eq('A: 返回值标记为已移动', rA.moved, true);
	eq('A: 检测到集成浏览器', rA.integratedBrowser, true);

	// 场景 B：浏览器已经独占一组 → 不能移动（否则每次预览都多切一组）
	stub.__setTabGroups([{ viewColumn: 1, tabs: [textTab] }, { viewColumn: 2, tabs: [webTab] }], 1);
	stub.__resetCalls();
	const rB = await openInSimpleBrowser('https://x.org/wiki/Foo', true);
	eq('B: 已独占一组时不移动', stub.__commandsCalled(MOVED).length, 0);
	eq('B: 返回值标记为未移动', rB.moved, false);

	// 场景 C：关掉该选项 → 不移动（同组布局下若开启是会移动的，所以这条有意义）
	stub.__setTabGroups(mixedGroup());
	stub.__resetCalls();
	await openInSimpleBrowser('https://x.org/wiki/Foo', false);
	eq('C: 关闭选项时不移动', stub.__commandsCalled(MOVED).length, 0);

	// 场景 D：活动标签仍是文本编辑器（说明浏览器没打开成功）→ 绝不能移动用户的代码
	stub.__setTabGroups([{ viewColumn: 1, tabs: [textTab] }]);
	stub.__resetCalls();
	await openInSimpleBrowser('https://x.org/wiki/Foo', true);
	eq('D: 拿不到浏览器标签时绝不移动代码', stub.__commandsCalled(MOVED).length, 0);

	// 场景 E：没有 api.open 时回退到 show，并且照样能移动
	stub.__setAvailableCommands(['simpleBrowser.show', MOVED]);
	stub.__setTabGroups(mixedGroup());
	stub.__resetCalls();
	const rE = await openInSimpleBrowser('https://x.org/wiki/Foo', true);
	eq('E: 回退到 simpleBrowser.show', rE.command, 'simpleBrowser.show');
	eq('E: 回退路径也会移动', stub.__commandsCalled(MOVED).length, 1);

	// 场景 F：老式 Simple Browser（没有集成浏览器）→ 仍传 Beside，尽量一次到位
	stub.__setAvailableCommands(['simpleBrowser.api.open', MOVED]);
	stub.__setTabGroups([{ viewColumn: 1, tabs: [textTab] }]);
	stub.__resetCalls();
	const rF = await openInSimpleBrowser('https://x.org/wiki/Foo', true);
	eq('F: 无集成浏览器时走 simpleBrowser.api.open', rF.command, 'simpleBrowser.api.open');
	eq('F: 无集成浏览器时标记为未检测到', rF.integratedBrowser, false);
	eq(
		'F: 仍请求 Beside 列',
		(stub.__commandsCalled('simpleBrowser.api.open')[0]?.args[1] as { viewColumn?: number } | undefined)?.viewColumn,
		-2,
	);
	stub.__setAvailableCommands(ALL_BROWSER_COMMANDS);
	stub.__setTabGroups([{ viewColumn: 1, tabs: [] }]);
	stub.__resetCalls();

	console.log('\n[2] 对 www.mediawiki.org 的真实调用');

	const client = new WikiHttpClient(ua, 30000, false);

	const apiPath = await probe(client);
	check('apiPath 探测命中', apiPath !== undefined, apiPath);
	// mediawiki.org 的 api 在 /w/api.php
	eq('mediawiki.org 使用 /w/api.php', apiPath, '/w/api.php');

	// ---------------------------------------------------------------
	// 回归：真实用户报告 "Invalid character in header content [\"User-Agent\"]"。
	// 起因是 wikiparser.user 填了中文，被原样拼进 User-Agent。
	// ---------------------------------------------------------------
	const rawUa = 'Mozilla/5.0 (compatible; wiki-user-preview/0.1.0; +https://github.com/) (contact: HOPE的机器人)';

	let rawRejected = false;
	try {
		const probeRequest = https.request({ hostname: 'example.invalid', headers: { 'User-Agent': rawUa } });
		probeRequest.destroy();
	} catch {
		rawRejected = true;
	}
	check('复现原 bug：未经净化的中文 UA 会被 Node 直接拒绝', rawRejected);

	const tolerant = new WikiHttpClient(rawUa, 30000, false);
	const tolerantResponse = await politeRequest(
		tolerant,
		`${ORIGIN}${apiPath ?? '/w/api.php'}`,
		{ query: { action: 'query', meta: 'siteinfo', siprop: 'general', format: 'json' } },
		'中文 UA 请求',
	);
	check('修复后：WikiHttpClient 自动净化，同样的 UA 请求成功', tolerantResponse.status === 200, tolerantResponse.status);

	const api = new MediaWikiApi(client, `${ORIGIN}${apiPath ?? '/w/api.php'}`, message => console.log(`    … ${message}`));

	await sleep(600);
	const logintoken = await api.getToken('login');
	check('拿到 login token', typeof logintoken === 'string' && logintoken.length > 10, logintoken.slice(0, 12));
	check('cookie jar 已种下 token cookie', client.cookieCount > 0, client.cookieCount);

	await sleep(600);
	const csrf = await api.getToken('csrf');
	check('匿名也能拿到 csrf token（形如 +\\）', csrf.length > 0, csrf);

	await sleep(600);
	const info = await api.getUserInfo();
	check('匿名状态下 userinfo.anonymous === true', info.anonymous === true, info);

	await sleep(600);
	const revision = await api.getPageRevision('Project:Sandbox');
	check('查询到 Project:Sandbox 的 revid', typeof revision?.revid === 'number', revision);

	// oldid：把预览钉死在指定版本上——这是"页面更新了但预览还是旧版"的根治手段
	if (revision?.revid !== undefined) {
		await sleep(600);
		const pinned = await api.parsePage('Project:Sandbox', { getCss: false, revid: revision.revid });
		eq('parsePage(revid) 返回的 revid 等于请求的 oldid', pinned.revid, revision.revid);
		check('parsePage(revid) 也拿到了正文', pinned.text.length > 50, pinned.text.length);
	}

	await sleep(600);
	const parsed = await api.parsePage('Project:Sandbox', { getCss: false });
	check('action=parse 返回 HTML', parsed.text.length > 50, parsed.text.length);
	check('parse 返回标题', parsed.title === 'Project:Sandbox', parsed.title);

	await sleep(600);
	const withCss = await api.parsePage('Project:Sandbox', { getCss: true });
	check('getCss=true 时拿到 headhtml', typeof withCss.headHtml === 'string' && withCss.headHtml.length > 0, withCss.headHtml?.length);

	// ------------------------------------------------ 3. 预览 HTML 的产出
	console.log('\n[3] 预览 HTML 生成与脚本剥离');

	const hostile: ParseResult = {
		title: 'User:Foo/OriginalPreview',
		displaytitle: 'User:Foo/OriginalPreview',
		text: '<p onclick="alert(1)">正文</p><script>alert("xss")</script><a href="/wiki/Main_Page">链接</a>',
		categoriesHtml: '<div>分类</div>',
		headHtml: '<head><link rel="stylesheet" href="//x.org/a.css"><script src="//x.org/b.js"></script></head>',
	};

	const noScripts = buildWebviewHtml(hostile, { enableScripts: false, getCss: true, articleBase: 'https://x.org/wiki/' });
	check('剥离站点 <script> 标签', !/<script(?![^>]*nonce-)/i.test(noScripts.html), noScripts.html.match(/<script[^>]*>/gi));
	check('剥离内联事件处理器 onclick', !/onclick/i.test(noScripts.html));
	check('注入 <base href>', noScripts.html.includes('<base href="https://x.org/wiki/" />'));
	check('enableScripts=false 时 CSP 为 script-src \'none\'', noScripts.html.includes(`script-src 'none'`));
	check('保留正文内容', noScripts.html.includes('正文'));

	const withScripts = buildWebviewHtml(hostile, { enableScripts: true, getCss: true, articleBase: 'https://x.org/wiki/' });
	check('enableScripts=true 时注入带 nonce 的跳转脚本', new RegExp(`<script nonce="${withScripts.scriptNonce}">`).test(withScripts.html));
	check('enableScripts=true 时 CSP 绑定同一 nonce', withScripts.html.includes(`script-src 'nonce-${withScripts.scriptNonce}'`));
	check('站点脚本依然被剥离', (withScripts.html.match(/<script/gi) ?? []).length === 1, (withScripts.html.match(/<script/gi) ?? []).length);

	// 错误映射：不存在的页面在 parse 时应当抛 MediaWikiError
	let threw: unknown;
	try {
		await sleep(600);
		await api.parsePage('This page surely does not exist 8f3a9b2c1d', { getCss: false });
	} catch (error) {
		threw = error;
	}
	check('不存在的页面抛出 MediaWikiError', threw instanceof MediaWikiError, threw instanceof Error ? threw.message : threw);
	check('错误码为 missingtitle', threw instanceof MediaWikiError && threw.code === 'missingtitle', threw instanceof MediaWikiError ? threw.code : undefined);

	// 故意用错误的机器人密码登录，验证失败路径不会崩、且错误信息可读
	let loginError: unknown;
	try {
		await api.loginBotPassword('WikiUserPreviewSmokeTest@NoSuchBot', 'not-a-real-password');
	} catch (error) {
		loginError = error;
	}
	check('错误的机器人密码会抛出可读错误', loginError instanceof Error, loginError instanceof Error ? loginError.message : loginError);

	void stub;
}

main()
	.then(() => {
		console.log(`\n结果：${passed} 通过，${failed} 失败`);
		process.exit(failed === 0 ? 0 : 1);
	})
	.catch(error => {
		console.error('\n冒烟测试异常终止：', error);
		process.exit(1);
	});
