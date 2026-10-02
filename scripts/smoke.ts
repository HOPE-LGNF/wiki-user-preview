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
import { shouldOpenPreview, writeConfirm } from '../src/extension';
import { applyTemplate, articleUrl, buildPageTitle, documentVars, getSharedClient, resetSharedClient, resolveConfig, sanitizeTitlePart, usernameFromWikiparserUser, withCacheBuster } from '../src/config';
import { startCollector, startFakeWiki } from './fakeWiki';
import { extractPageInfo, isUserNamespaceTitle, pageInfoFieldRange } from '../src/pageInfo';

let passed = 0;
let failed = 0;
let skipped = 0;

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

// ------- 仅写入 vs 写入并预览：这个真值表很容易写错，固定下来 -------
eq('writeOnly 命令始终不打开预览（openAfterSave 为 true 时也是）', shouldOpenPreview({ openPreview: false }, true), false);
eq('writeOnly 命令 + openAfterSave 关闭 → 不打开', shouldOpenPreview({ openPreview: false }, false), false);
eq('originalPreview + openAfterSave 开启 → 打开预览', shouldOpenPreview({}, true), true);
eq('originalPreview + openAfterSave 关闭 → 不打开预览', shouldOpenPreview({}, false), false);

// ------- 写入确认框的文案：按钮必须与模式一致 -------
// v0.2.5 把按钮写死成「写入并预览」，于是「仅写入」命令弹出的确认框文案自相矛盾：
// 用户特意选了不预览，按钮却写着「写入并预览」。
const baseConfirm = {
	pageTitle: 'User:Alice/OriginalPreview/Test',
	charCount: 12,
	host: 'w.example',
	username: 'Alice',
	titleSource: 'wikiUserPreview.pageTemplate',
	summary: '摘要',
	strippedChars: 0,
};
const previewDialog = writeConfirm({ ...baseConfirm, openAfterwards: true });
eq('确认框：写入并预览模式的按钮是「写入并预览」', previewDialog.button, '写入并预览');
check('确认框：该模式不应出现「不打开预览」的说明', !previewDialog.detail.includes('不打开预览'), previewDialog.detail);
check('确认框：消息里带上页面名与字符数', previewDialog.message.includes(baseConfirm.pageTitle) && previewDialog.message.includes('12 字符'), previewDialog.message);

const writeOnlyDialog = writeConfirm({ ...baseConfirm, openAfterwards: false });
eq('确认框：仅写入模式的按钮是「仅写入」', writeOnlyDialog.button, '仅写入');
check('确认框：仅写入模式的按钮不能写成「写入并预览」', writeOnlyDialog.button !== '写入并预览', writeOnlyDialog.button);
check('确认框：仅写入模式在明细里说明这次不开预览', writeOnlyDialog.detail.includes('本次只写入，不打开预览'), writeOnlyDialog.detail);
check('确认框：两种模式的按钮不同', writeOnlyDialog.button !== previewDialog.button);

const strippedDialog = writeConfirm({ ...baseConfirm, openAfterwards: true, strippedChars: 42 });
check('确认框：剥离了 PAGE_INFO 时在明细里说明', strippedDialog.detail.includes('42 字符不会上传'), strippedDialog.detail);
check('确认框：没有剥离时不出现该说明', !previewDialog.detail.includes('PAGE_INFO'), previewDialog.detail);


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

// ------- 真实站点样本（casualtiesunknown.huijiwiki.com，从磁盘上已 pull 的文件里摘取）-------
// 上面的用例是按 Wikitext 源码构造的；这几条是站点真实产出的原文，用来确认「只认文件开头」
// 这条改动不会误伤真实文件，也确认两种包裹形态都还在。
const realWikitextPull =
	'<%-- [PAGE_INFO]\n' +
	'    comment = #Please do not remove this struct.#\n' +
	'    pageTitle = #建筑#\n' +
	'    pageID = ##\n' +
	'    revisionID = ##\n' +
	'    contentModel = ##\n' +
	'    contentFormat = ##\n' +
	'[END_PAGE_INFO] --%>\n' +
	'\n' +
	"{{正在施工|user=Unauthorized HOPE}}\n'''建筑'''是[[角色]]在地图中遇到的可交互实体。\n";
const realWikitest = extractPageInfo(realWikitextPull);
check('真实样本(wikitext)：开头的块被剥离', realWikitest.block !== undefined && realWikitest.block.start === 0, realWikitest.block);
eq('真实样本(wikitext)：pageTitle 解析正确', realWikitest.info?.pageTitle, '建筑');
check('真实样本(wikitext)：空 pageID/revisionID 不产生假值', realWikitest.info?.pageID === undefined && realWikitest.info?.revisionID === undefined, realWikitest.info);
check('真实样本(wikitext)：正文完整保留且不含 PAGE_INFO', realWikitest.content.includes("'''建筑'''") && !realWikitest.content.includes('PAGE_INFO'), realWikitest.content.slice(0, 30));
check('真实样本(wikitext)：剥离掉的块后紧跟的空白行也被去掉', realWikitest.content.startsWith('{{正在施工'), JSON.stringify(realWikitest.content.slice(0, 12)));

const realLuaPull =
	'--[=[<%-- [PAGE_INFO]\n' +
	'    comment = #Please do not remove this struct.#\n' +
	'    pageTitle = #模块:实体/信息框#\n' +
	'    pageID = #2085#\n' +
	'    revisionID = #12586#\n' +
	'    contentModel = #Scribunto#\n' +
	'    contentFormat = #text/plain#\n' +
	'[END_PAGE_INFO] --%>--]=]\n' +
	'\n' +
	'local p = {}\n';
const realLua = extractPageInfo(realLuaPull);
eq('真实样本(lua)：pageTitle 解析正确（含命名空间与斜杠）', realLua.info?.pageTitle, '模块:实体/信息框');
eq('真实样本(lua)：revisionID 解析正确', realLua.info?.revisionID, '12586');
eq('真实样本(lua)：contentModel 解析正确', realLua.info?.contentModel, 'Scribunto');
eq('真实样本(lua)：正文完整保留', realLua.content, 'local p = {}\n');

// 真实样本里有「块后面没有正文」的文件；剥完为空必须让调用方能够拒绝上传
const emptyAfterStrip = extractPageInfo('<%-- [PAGE_INFO]\n    pageTitle = #模块:建筑/Base/分类#\n    revisionID = #14441#\n[END_PAGE_INFO] --%>\n');
check('真实样本：纯元信息文件剥完为空', emptyAfterStrip.block !== undefined && emptyAfterStrip.content.trim() === '', JSON.stringify(emptyAfterStrip.content));

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
	// batch-grab.mjs 是 ESM，而本文件编译成 CJS，静态 import 会被 tsc 拒绝（TS1479）。
	// 动态 import 既能通过类型检查，esbuild 打包时也会把它内联进来。
	const { pageInfoHead } = await import('./batch-grab.mjs');

// ------- 批量导出工具（scripts/batch-grab.mjs）产出的文件必须能被本扩展解析 -------
// 这是「导出 → 改 → 推回」这条链路的关键：如果导出的 PAGE_INFO 头解析不出来，
// 推回时就会把整块当正文上传，或者丢失冲突基准。
const grabbedLua = `${pageInfoHead({ title: '模块:实体/信息框', pageid: 2085, revid: 12586, contentModel: 'Scribunto', contentFormat: 'text/plain' })}\n\nlocal p = {}\n`;
const reparse = extractPageInfo(grabbedLua);
check('批量导出：PAGE_INFO 头可被剥离', reparse.block !== undefined, reparse.block);
eq('批量导出：目标页面可恢复', reparse.info?.pageTitle, '模块:实体/信息框');
eq('批量导出：冲突基准版本可恢复', reparse.info?.revisionID, '12586');
eq('批量导出：内容模型可恢复', reparse.info?.contentModel, 'Scribunto');
eq('批量导出：正文完整保留', reparse.content, 'local p = {}\n');

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
	// 客户端只与一个主机通信，使用前必须先声明是哪一个
	client.setHost('www.mediawiki.org', 'https://');

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

	// 先确认目标站点可达再跑联网检查。网络不可达时整段跳过并说明原因——
	// 否则环境问题会伪装成代码失败（本机就出现过 Node 访问 mediawiki.org 超时、curl 却是 200）。
	let reachable = true;
	try {
		await client.request(`${ORIGIN}/w/api.php`, { query: { action: 'query', meta: 'siteinfo', format: 'json' } });
	} catch (error) {
		reachable = false;
		skipped += 1;
		console.log(`  ⚠ 跳过联网检查：${error instanceof Error ? error.message : String(error)}`);
		console.log('    这一段的结论只反映网络可达性，不反映代码正确性。');
		if (process.env.WIKI_USER_PREVIEW_REQUIRE_NETWORK) {
			failed += 1;
			console.log('    （已设 WIKI_USER_PREVIEW_REQUIRE_NETWORK，按失败处理）');
		}
	}

	if (reachable) {
		const apiPath = await probe(client);
		check('apiPath 探测命中', apiPath !== undefined, apiPath);
		// mediawiki.org 的 api 在 /w/api.php
		eq('mediawiki.org 使用 /w/api.php', apiPath, '/w/api.php');


		const tolerant = new WikiHttpClient(rawUa, 30000, false);
		tolerant.setHost('www.mediawiki.org', 'https://');
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
		// ------------------------------------------------ 3. 预览 HTML 的产出
	}

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

	// 登录失败与编辑报错的映射改由本地假站点覆盖（见 [4]），
	// 这里不再向真实站点发起任何登录尝试——那是写操作，且会在对方日志里留下失败记录。

	// ============ [4] 离线安全与会话回归（本地假 MediaWiki，全程不联网）============
	console.log('\n[4] 离线安全与会话回归（本地假 MediaWiki）');

	const fakeContext = {
		extension: { packageJSON: { version: '0.0.0-test' } },
		secrets: { get: async () => 'fake-password', store: async () => undefined, delete: async () => undefined },
	} as unknown as Parameters<typeof resolveConfig>[0];

	async function tryResolve(site: string, apiPath: string, articlePath: string): Promise<unknown> {
		stub.__set('wikiUserPreview', 'site', site);
		stub.__set('wikiUserPreview', 'apiPath', apiPath);
		stub.__set('wikiUserPreview', 'articlePath', articlePath);
		stub.__set('wikiUserPreview', 'username', 'Alice');
		stub.__set('wikiUserPreview', 'useWikitextSettings', false);
		try {
			await resolveConfig(fakeContext, { promptForSecrets: false });
			return undefined;
		} catch (error) {
			return error;
		}
	}

	// F1：拼接后的最终地址必须与配置的站点同源
	const userinfoAttack = await tryResolve('good.example', '@evil.example/api.php', '/wiki/');
	check(
		'F1: apiPath 里的 @ 被拒绝（否则界面显示 good.example、密码却发给 evil.example）',
		userinfoAttack instanceof Error && /userinfo/.test(userinfoAttack.message),
		userinfoAttack instanceof Error ? userinfoAttack.message : userinfoAttack,
	);
	const crossOriginArticle = await tryResolve('good.example', '/api.php', 'https://evil.example/wiki/');
	check(
		'F1: articlePath 指向别的主机时被拒绝',
		crossOriginArticle instanceof Error && /不一致/.test(crossOriginArticle.message),
		crossOriginArticle instanceof Error ? crossOriginArticle.message : crossOriginArticle,
	);
	const healthyConfig = await tryResolve('good.example', '/api.php', '/wiki/');
	check('F1: 正常配置不被误伤', healthyConfig === undefined, healthyConfig instanceof Error ? healthyConfig.message : healthyConfig);

	// F2：跨主机跳转必须被拒绝，且凭据不得外流
	const attacker = await startCollector('localhost');
	const wiki = await startFakeWiki('127.0.0.1');
	const redirectClient = new WikiHttpClient('smoke', 5000, false);
	// 与生产代码一致：传的是含端口的 host（resolveConfig 传的就是 site.host）
	redirectClient.setHost(new URL(wiki.origin).host, 'http://');
	check('F2 前置：带端口的站点不会被自己的白名单挡掉', redirectClient.host === `127.0.0.1:${new URL(wiki.origin).port}`, redirectClient.host);
	await redirectClient.request(wiki.apiUrl, { query: { action: 'query', meta: 'tokens', type: 'login' } });
	check('F2 前置：客户端已持有会话 cookie', redirectClient.cookieCount > 0, redirectClient.cookieCount);

	wiki.setRedirectOnce(`${attacker.origin}/steal`);
	let redirectError: unknown;
	try {
		await redirectClient.request(wiki.apiUrl, { method: 'POST', form: { action: 'login', lgpassword: 'FAKE-PASSWORD-1234' } });
	} catch (error) {
		redirectError = error;
	}
	check(
		'F2: 跳转到另一个主机时被拒绝',
		redirectError instanceof Error && /已拒绝向/.test(redirectError.message),
		redirectError instanceof Error ? redirectError.message : redirectError,
	);
	check('F2: 另一个主机没有收到任何请求（cookie 与密码都没外流）', attacker.received.length === 0, attacker.received);
	eq('F2: 被拒绝后本机 cookie 仍在（没有误清）', redirectClient.cookieCount > 0, true);

	// F2b：同主机跳转仍然跟随（MediaWiki 的 /api.php → /w/api.php 很常见）
	wiki.setRedirectOnce(`${wiki.origin}/other`);
	const followed = await redirectClient.request(wiki.apiUrl, { query: { action: 'query', meta: 'userinfo' } });
	eq('F2b: 同主机跳转仍被跟随', followed.status, 200);

	// F4：clientlogin 的 UI 续登必须符合协议
	const wiki2 = await startFakeWiki('127.0.0.1');
	wiki2.setClientLoginScript([
		{
			status: 'UI',
			requests: [
				{ id: 'OATHToken', type: 'password', label: '两步验证码', required: true },
				{ id: 'loginpreservestate', type: 'hidden', value: '1' },
			],
		},
		{ status: 'PASS', username: 'Alice@PreviewBot' },
	]);
	const client2 = new WikiHttpClient('smoke', 5000, false);
	client2.setHost(new URL(wiki2.origin).host, 'http://');
	const asked: { message: string; ids: string[] }[] = [];
	const loginResult = await new MediaWikiApi(client2, wiki2.apiUrl).clientLogin('Alice@PreviewBot', 'PW', async (message, fields) => {
		asked.push({ message, ids: fields.map(field => field.id) });
		return { OATHToken: '987654' };
	});
	eq('F4: 两步验证后登录成功', loginResult.username, 'Alice@PreviewBot');
	eq('F4: 只询问可填写的字段（hidden 不询问）', JSON.stringify(asked), JSON.stringify([{ message: '需要两步验证', ids: ['OATHToken'] }]));
	const clientLoginCalls = wiki2.requests.filter(entry => entry.params.get('action') === 'clientlogin');
	eq('F4: 一共两次 clientlogin 请求', clientLoginCalls.length, 2);
	const continuation = clientLoginCalls[1]!;
	eq('F4: 续登带 logincontinue=1（缺了它就会反复索要验证码）', continuation.params.get('logincontinue'), '1');
	eq('F4: 续登带上验证码', continuation.params.get('OATHToken'), '987654');
	eq('F4: 续登回传 hidden 字段', continuation.params.get('loginpreservestate'), '1');
	check('F4: 续登不再重复发送密码', continuation.params.get('password') === null, continuation.params.get('password'));
	check('F4: 续登不再重复发送用户名', continuation.params.get('username') === null, continuation.params.get('username'));

	// F4b：RESTART 给出明确错误
	const wiki3 = await startFakeWiki('127.0.0.1');
	wiki3.setClientLoginScript([{ status: 'RESTART' }]);
	const client3 = new WikiHttpClient('smoke', 5000, false);
	client3.setHost(new URL(wiki3.origin).host, 'http://');
	let restartError: unknown;
	try {
		await new MediaWikiApi(client3, wiki3.apiUrl).clientLogin('Alice', 'PW', async () => ({}));
	} catch (error) {
		restartError = error;
	}
	check(
		'F4b: RESTART 映射为明确错误',
		restartError instanceof MediaWikiError && restartError.code === 'clientlogin-restart',
		restartError instanceof Error ? restartError.message : restartError,
	);

	// F11：登录失败与编辑报错的映射，全部打本地服务器
	const wiki4 = await startFakeWiki('127.0.0.1');
	wiki4.setLoginResult('WrongPass', 'Incorrect username or password entered');
	const client4 = new WikiHttpClient('smoke', 5000, false);
	client4.setHost(new URL(wiki4.origin).host, 'http://');
	let loginError: unknown;
	try {
		await new MediaWikiApi(client4, wiki4.apiUrl).loginBotPassword('Alice@Bot', 'not-a-real-password');
	} catch (error) {
		loginError = error;
	}
	check(
		'F11: 登录失败被映射为可读错误（不再打真实站点）',
		loginError instanceof MediaWikiError && loginError.code === 'WrongPass' && /Incorrect username/.test(loginError.info),
		loginError instanceof Error ? loginError.message : loginError,
	);

	// F6：登出必须带会话 cookie，并清空本地 cookie
	wiki4.setLoginResult('Success');
	await new MediaWikiApi(client4, wiki4.apiUrl).loginBotPassword('Alice@Bot', 'pw');
	check('F6 前置：登录后持有 cookie', client4.cookieCount > 0, client4.cookieCount);
	await new MediaWikiApi(client4, wiki4.apiUrl).logout();
	const logoutCall = wiki4.requests.find(entry => entry.params.get('action') === 'logout');
	check('F6: 登出请求带上了会话 cookie（否则服务端不会注销）', Boolean(logoutCall?.cookie), logoutCall);
	eq('F6: 登出后本地 cookie 被清空', client4.cookieCount, 0);

	// F8：CSP 必须放行自己注入的 <base>
	const rendered = buildWebviewHtml(
		{ title: 'T', text: '<p>x</p>' },
		{ enableScripts: false, getCss: false, articleBase: 'https://www.huijiwiki.com/wiki/' },
	);
	check('F8: CSP 放行站点 origin 作为 base-uri', rendered.html.includes('base-uri https://www.huijiwiki.com'), rendered.html.match(/base-uri [^;']*/)?.[0]);
	check('F8: base-uri 不再是 none', !rendered.html.includes(`base-uri 'none'`));
	check('F8: <base> 仍然被注入', rendered.html.includes('<base href="https://www.huijiwiki.com/wiki/" />'));

	// F9：只有文件开头的 PAGE_INFO 才算元信息
	const midFile = '正文第一行\n\n<%-- [PAGE_INFO]\n    pageTitle = #攻击者指定的页面#\n[END_PAGE_INFO] --%>\n\n更多正文\n';
	const midParsed = extractPageInfo(midFile);
	check('F9: 正文中间的 PAGE_INFO 不被剥离', midParsed.content === midFile, midParsed.content.slice(0, 20));
	check('F9: 也不会劫持目标页面', midParsed.info === undefined, midParsed.info);
	check('F9: 但会被标记出来以便提示用户', midParsed.misplacedBlock !== undefined, midParsed.misplacedBlock);
	const headParsed = extractPageInfo('<%-- [PAGE_INFO]\n    pageTitle = #正常页面#\n[END_PAGE_INFO] --%>\r\r正文');
	eq('F9: 文件开头的块照常识别', headParsed.info?.pageTitle, '正常页面');
	eq('F9: 文件开头的块照常剥离', headParsed.content, '正文');

	await wiki.close();
	await wiki2.close();
	await wiki3.close();
	await wiki4.close();
	await attacker.close();

	// F7：连接相关设置一变，就必须换一个新客户端（会话随之重建）。
	// 否则「先跳过 TLS 校验、后来关掉」不会对已建立的连接生效。
	const clientA = getSharedClient('smoke-ua-A', 1000, false);
	check('F7: 相同设置复用同一个客户端', getSharedClient('smoke-ua-A', 1000, false) === clientA);
	check('F7: 超时变更 → 换新客户端', getSharedClient('smoke-ua-A', 2000, false) !== clientA);
	const clientB = getSharedClient('smoke-ua-A', 1000, false);
	check('F7: 关掉「跳过 TLS 校验」→ 换新客户端', getSharedClient('smoke-ua-A', 1000, true) !== clientB);
	const clientC = getSharedClient('smoke-ua-A', 1000, true);
	check('F7: User-Agent 变更 → 换新客户端', getSharedClient('smoke-ua-B', 1000, true) !== clientC);
	resetSharedClient();
	check('F7: resetSharedClient 之后不再复用', getSharedClient('smoke-ua-B', 1000, true) !== clientC);

	void stub;
}

main()
	.then(() => {
		console.log(`\n结果：${passed} 通过，${failed} 失败${skipped > 0 ? `，${skipped} 段跳过（目标站点不可达）` : ''}`);
		process.exit(failed === 0 ? 0 : 1);
	})
	.catch(error => {
		console.error('\n冒烟测试异常终止：', error);
		process.exit(1);
	});
