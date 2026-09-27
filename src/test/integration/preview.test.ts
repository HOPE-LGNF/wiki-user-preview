import * as assert from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { WikiHttpClient } from '../../httpClient';
import { startFakeWiki } from '../../../scripts/fakeWiki';
import { MediaWikiApi } from '../../mediawiki';
import { disposePreviewPanel, openInSimpleBrowser, openInWebview } from '../../preview';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isTextEditorTab(tab: vscode.Tab): boolean {
	const input = tab.input;
	return input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff;
}

/** 假 MediaWiki：参数放在 POST body 里，必须读 body 而不是只用 query。 */
function createFakeServer(): http.Server {
	return http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => {
			body += chunk;
		});
		req.on('end', () => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === '/api.php') {
				const params = new URLSearchParams(body);
				const oldid = params.get('oldid') ?? params.get('page') ?? '1';
				// 故意制造一次 revid 不匹配，用于验证完整性校验
				const revid = oldid === '7777' ? 1 : Number(oldid);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ parse: { title: 'Test', text: '<p>hello</p>', revid } }));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end('<!DOCTYPE html><html><body><h1 id="ok">hello</h1></body></html>');
		});
	});
}

suite('预览落位（真实 VS Code 环境）', () => {
	let server: http.Server;
	let base = '';

	suiteSetup(async () => {
		server = createFakeServer();
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		// 测试实例的 user-data 会跨次保留，先清空所有编辑器再开始
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await sleep(500);
	});

	suiteTeardown(async () => {
		disposePreviewPanel();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	test('记录当前 VS Code 用的是哪种浏览器实现', async () => {
		const commands = await vscode.commands.getCommands(true);
		const integrated = commands.includes('workbench.action.browser.open');
		console.log(`    · workbench.action.browser.open（集成浏览器）: ${integrated}`);
		console.log(`    · simpleBrowser.api.open（老式 Simple Browser）: ${commands.includes('simpleBrowser.api.open')}`);
		console.log(`    · workbench.action.moveEditorToRightGroup: ${commands.includes('workbench.action.moveEditorToRightGroup')}`);
		assert.ok(commands.includes('workbench.action.moveEditorToRightGroup'), '移动命令必须存在，否则本策略失效');
	});

	test('浏览器不会和代码挤在同一组，而是出现在右侧新组', async () => {
		const doc = await vscode.workspace.openTextDocument({ content: 'code', language: 'plaintext' });
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
		const codeColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
		assert.ok(
			vscode.window.tabGroups.activeTabGroup.tabs.some(isTextEditorTab),
			'前置条件：活动组里应有代码文件',
		);

		await openInSimpleBrowser(`${base}/wiki/Test?wikiUserPreviewRev=1`, true);

		const group = vscode.window.tabGroups.activeTabGroup;
		const tab = group.activeTab;
		assert.ok(tab, '应当有活动标签');
		assert.ok(!isTextEditorTab(tab!), '活动标签应当是浏览器，而不是被移走的代码文件');
		assert.ok(
			group.viewColumn > codeColumn,
			`期望浏览器落在代码列(${codeColumn})右侧，实际列号 ${group.viewColumn}`,
		);
		// 代码文件必须还在原来的位置
		const codeGroup = vscode.window.tabGroups.all.find(g => g.tabs.some(t => t.input instanceof vscode.TabInputText));
		assert.strictEqual(codeGroup?.viewColumn, codeColumn, '代码文件不应被移动');
	});

	test('连续预览不会越切越多组', async () => {
		const groupCountBefore = vscode.window.tabGroups.all.length;
		await openInSimpleBrowser(`${base}/wiki/Test?wikiUserPreviewRev=2`, true);
		await sleep(600);
		await openInSimpleBrowser(`${base}/wiki/Test?wikiUserPreviewRev=3`, true);
		await sleep(600);
		assert.strictEqual(
			vscode.window.tabGroups.all.length,
			groupCountBefore,
			`连续两次预览后组数不应增加（之前 ${groupCountBefore}，现在 ${vscode.window.tabGroups.all.length}）`,
		);
	});

	test('webview 模式在与代码不同的组里打开', async () => {
		const client = new WikiHttpClient('integration-test', 10000, false);
		client.setHost(new URL(base).host, 'http://');
		const api = new MediaWikiApi(client, `${base}/api.php`);
		const codeGroup = vscode.window.tabGroups.all.find(group => group.tabs.some(isTextEditorTab));
		const codeColumn = codeGroup?.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;

		const allTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ tab, group })));
		const before = new Set(allTabs().map(entry => entry.tab));

		await openInWebview(api, 'Test', {
			enableScripts: false,
			getCss: false,
			articleBase: `${base}/wiki/`,
			revid: 4242,
		});

		// 面板创建到出现在 tabGroups 里是异步的；这里不假设 viewType，直接找新增的标签
		let added: { tab: vscode.Tab; group: vscode.TabGroup }[] = [];
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			added = allTabs().filter(entry => !before.has(entry.tab));
			if (added.length > 0) {
				break;
			}
			await sleep(100);
		}

		console.log(`    · 新增标签的 input 类型: ${added.map(e => e.tab.input?.constructor?.name).join(', ') || '（无）'}`);
		console.log(
			`    · 当前标签: ${allTabs()
				.map(e => `${e.tab.input?.constructor?.name}@${e.group.viewColumn}`)
				.join(' | ')}`,
		);

		assert.strictEqual(added.length, 1, `应新增 1 个标签，实际 ${added.length}`);
		assert.notStrictEqual(added[0]!.group.viewColumn, codeColumn, '预览面板不应与代码同组');
	});

	test('站点返回的 revid 与请求不符时明确报错，而不是静默展示旧版', async () => {
		const client = new WikiHttpClient('integration-test', 10000, false);
		client.setHost(new URL(base).host, 'http://');
		const api = new MediaWikiApi(client, `${base}/api.php`);
		await assert.rejects(
			() =>
				openInWebview(api, 'Test', {
					enableScripts: false,
					getCss: false,
					articleBase: `${base}/wiki/`,
					revid: 7777,
				}),
			/站点返回的是 rev 1/,
			'revid 不匹配时应当抛错',
		);
	});
});

/** 端到端跑一遍写入流程。设置由 scripts/runIntegration.mjs 预写进隔离的用户目录。 */
suite('写入流程（本地假 wiki，端到端）', () => {
	let wiki: Awaited<ReturnType<typeof startFakeWiki>>;

	suiteSetup(async () => {
		const port = Number(process.env.WIKI_USER_PREVIEW_TEST_PORT);
		assert.ok(
			Number.isInteger(port) && port > 0,
			'缺少 WIKI_USER_PREVIEW_TEST_PORT，应由 scripts/runIntegration.mjs 注入（它也要和预写的设置一致）',
		);
		wiki = await startFakeWiki('127.0.0.1', port);
		wiki.setCanonicalUsername('Alice');
		// 模拟私有 wiki：不带会话 cookie 读不到页面
		wiki.setRequireLoginForRead(true);
	});

	suiteTeardown(async () => {
		await wiki.close();
	});

	test('测试装置：预写的设置已生效（否则下面会弹模态框卡到超时）', async () => {
		const own = vscode.workspace.getConfiguration('wikiUserPreview');
		const wt = vscode.workspace.getConfiguration('wikitext');
		assert.strictEqual(own.get('confirmBeforeSave'), false, 'confirmBeforeSave 没读到，端到端测试会被模态确认框卡住');
		assert.strictEqual(own.get('pageTemplate'), 'User:{username}/OriginalPreview/Test', 'pageTemplate 没读到');
		assert.strictEqual(wt.get('host'), `127.0.0.1:${process.env.WIKI_USER_PREVIEW_TEST_PORT}`, 'wikitext.host 没读到');
		assert.ok(wt.get('password'), 'wikitext.password 没读到，会弹密码输入框');
	});

	test('机器人密码写入账号本人的用户子页，且预览复用同一登录态', async () => {
		const doc = await vscode.workspace.openTextDocument({ content: '== 测试 ==\n正文\n', language: 'wikitext' });
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });

		// 不直接 await：万一命令卡住，我们要能看到它到底打出了哪些请求、卡在哪一步
		const started = Date.now();
		let outcome = 'timeout';
		const running = vscode.commands.executeCommand('wikiUserPreview.originalPreview').then(
			() => 'resolved',
			(error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
		);
		for (let second = 1; second <= 60 && outcome === 'timeout'; second++) {
			outcome = await Promise.race([running, sleep(1000).then(() => 'timeout')]);
			if (second % 10 === 0 || outcome !== 'timeout') {
				console.log(`    · ${second}s：结果=${outcome}，已收到 ${wiki.requests.length} 个请求，标签数=${vscode.window.tabGroups.all.length}`);
			}
		}
		const trace = wiki.requests.map(entry => `${entry.method} ${entry.params.get('action')}`).join(', ');
		console.log(`    · 命令结果 = ${outcome}，耗时 ${Date.now() - started}ms`);
		console.log(`    · 假站点收到 = ${trace || '(什么都没收到)'}`);
		assert.notStrictEqual(outcome, 'timeout', `命令没有返回；假站点收到：${trace}`);

		const found = (action: string) => wiki.requests.filter(entry => entry.params.get('action') === action);
		const actions = trace;
		const login = found('login')[0];
		assert.ok(login, `应当先登录，实际发生：${actions}`);
		assert.strictEqual(login.params.get('lgname'), 'Alice@PreviewBot', '机器人密码的登录名应带 @机器人名');

		const edit = found('edit')[0];
		assert.ok(edit, `应当发生一次 action=edit，实际发生：${actions}`);
		assert.strictEqual(
			edit.params.get('title'),
			'User:Alice/OriginalPreview/Test',
			'目标页面必须用服务端确认的账号名（Alice），而不是登录名（Alice@PreviewBot）',
		);
		assert.strictEqual(edit.params.get('assert'), 'user', '编辑应带 assert=user');

		const parse = found('parse')[0];
		assert.ok(parse, '保存后应发生一次 action=parse 用于预览');
		assert.ok(parse.cookie, '预览必须复用已登录的客户端——私有 wiki 下没有 cookie 就读不到页面');
	});
});
