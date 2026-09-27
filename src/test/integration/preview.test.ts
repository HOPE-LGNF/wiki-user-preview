import * as assert from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { WikiHttpClient } from '../../httpClient';
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
		const api = new MediaWikiApi(new WikiHttpClient('integration-test', 10000, false), `${base}/api.php`);
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
		const api = new MediaWikiApi(new WikiHttpClient('integration-test', 10000, false), `${base}/api.php`);
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
