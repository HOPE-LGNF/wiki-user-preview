import * as vscode from 'vscode';
import { MediaWikiApi, ParseResult } from './mediawiki';

export interface WebviewOptions {
	enableScripts: boolean;
	getCss: boolean;
	articleBase: string;
	/** 刚写入的版本号：用它把 action=parse 钉死在该版本上，并校验回来的确实是这一版 */
	revid?: number;
}

let currentPanel: vscode.WebviewPanel | undefined;

export function disposePreviewPanel(): void {
	currentPanel?.dispose();
	currentPanel = undefined;
}

export async function openInSystemBrowser(url: string): Promise<void> {
	const ok = await vscode.env.openExternal(vscode.Uri.parse(url));
	if (!ok) {
		throw new Error(`无法在系统浏览器中打开：${url}`);
	}
}

/**
 * 与「在 VS Code 里打开网页」相关的命令 id。
 *
 * - `simpleBrowser.api.open`：内置 Simple Browser 扩展提供的命令。
 * - `workbench.action.browser.open`：VS Code 1.9x 起的「集成浏览器」。
 * - `workbench.action.moveEditorToRightGroup`：把当前活动的编辑器移到右侧组
 *   （没有右侧组时会新建一个），对任何编辑器标签都有效。
 */
const BROWSER_API_OPEN = 'simpleBrowser.api.open';
const BROWSER_INTEGRATED_OPEN = 'workbench.action.browser.open';
const BROWSER_FALLBACK_SHOW = 'simpleBrowser.show';
const MOVE_EDITOR_TO_RIGHT_GROUP = 'workbench.action.moveEditorToRightGroup';

function isTextEditorTab(tab: vscode.Tab): boolean {
	const input = tab.input;
	return input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff;
}

function groupOfTab(tab: vscode.Tab): vscode.TabGroup | undefined {
	return vscode.window.tabGroups.all.find(group => group.tabs.includes(tab));
}

/**
 * 等「刚被打开的浏览器标签」成为活动标签。
 *
 * 不能靠 viewType 判断：VS Code 1.9x 起，只要工作台里有 `workbench.action.browser.open`，
 * 内置 simple-browser 就会**整个转交给集成浏览器**，压根不会创建 `simpleBrowser.view`：
 *
 *   async function w(){ return (await commands.getCommands(true)).includes("workbench.action.browser.open") }
 *   registerCommand("simpleBrowser.api.open", async (e,t) => { await w() ? await u(e.toString(true)) : i.show(e,t) })
 *
 * 所以这里只判断「活动标签不是文本编辑器」，对两种实现都成立。
 */
async function waitForOpenedBrowserTab(timeoutMs = 1000): Promise<vscode.Tab | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab && !isTextEditorTab(tab)) {
			return tab;
		}
		if (Date.now() >= deadline) {
			return undefined;
		}
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

export interface BrowserOpenResult {
	/** 实际执行的命令 id */
	command: string;
	/** 是否检测到集成浏览器（存在时内置 Simple Browser 会把请求转交给它） */
	integratedBrowser: boolean;
	/** 是否执行了「移到右侧组」 */
	moved: boolean;
}

/**
 * 打开 VS Code 内置浏览器，并让它落在代码区右侧。
 *
 * 为什么不能只靠 `viewColumn`：
 *  - 集成浏览器路径根本收不到 viewColumn（`u()` 只传 URL），总是开在当前组；
 *  - 老式 Simple Browser 是单例，视图已存在时只调 `webviewPanel.reveal(viewColumn)`，
 *    而 `reveal` 不认 `ViewColumn.Beside` 这类负数列，面板会永远停在当初创建它的那一组。
 *
 * 因此统一策略：**先打开，再按需把刚打开的标签移到右侧组**。`viewColumn: Beside` 仍然传，
 * 对老式路径可以省掉一次移动。
 */
export async function openInSimpleBrowser(url: string, forceBeside = true): Promise<BrowserOpenResult> {
	const available = await vscode.commands.getCommands(true);
	const integratedBrowser = available.includes(BROWSER_INTEGRATED_OPEN);

	let command: string;
	if (available.includes(BROWSER_API_OPEN)) {
		command = BROWSER_API_OPEN;
		const viewColumn = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
		await vscode.commands.executeCommand(BROWSER_API_OPEN, vscode.Uri.parse(url), { viewColumn });
	} else {
		command = BROWSER_FALLBACK_SHOW;
		await vscode.commands.executeCommand(BROWSER_FALLBACK_SHOW, url);
	}

	if (!forceBeside) {
		return { command, integratedBrowser, moved: false };
	}

	// 打开是异步的；拿不到浏览器标签就什么都别动（绝不能让代码文件被移走）
	const tab = await waitForOpenedBrowserTab();
	if (!tab) {
		return { command, integratedBrowser, moved: false };
	}
	const group = groupOfTab(tab);
	if (!group) {
		return { command, integratedBrowser, moved: false };
	}
	// 判据是「这一组里有没有代码文件」而不是「在不在活动组右侧」：
	// 集成浏览器每次都在当前组新开标签，若按后者判断会被反复往右推、越切越多组。
	if (!group.tabs.some(isTextEditorTab)) {
		return { command, integratedBrowser, moved: false }; // 已经是独立的浏览器组了
	}
	await vscode.commands.executeCommand(MOVE_EDITOR_TO_RIGHT_GROUP);
	return { command, integratedBrowser, moved: true };
}

function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

function escapeHtml(input: string): string {
	return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 站点自带脚本一律剥离：预览只需要渲染结果，不需要执行站点 JS。 */
function stripScripts(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<script\b[^>]*\/>/gi, '')
		.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
}

const BASE_CSS = `
:root { color-scheme: light dark; }
body {
	margin: 0;
	padding: 1rem 1.5rem 4rem;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
	font-size: 15px;
	line-height: 1.75;
	word-wrap: break-word;
}
img, video, audio { max-width: 100%; height: auto; }
table { border-collapse: collapse; max-width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border, #a2a9b1); padding: 0.3em 0.6em; }
a { color: var(--vscode-textLink-foreground, #36c); }
a.new { color: var(--vscode-editorError-foreground, #d33); }
pre, code, tt { font-family: var(--vscode-editor-font-family, monospace); }
pre { padding: 0.6em 0.8em; overflow-x: auto; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); }
.mw-editsection, .mw-empty-elt, #toc, .toc { display: none; }
.wiki-preview-banner {
	position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
	padding: 4px 10px; font-size: 12px;
	background: var(--vscode-statusBar-background, #007acc);
	color: var(--vscode-statusBar-foreground, #fff);
	opacity: 0.92;
}
.wiki-preview-body { padding-top: 1.8rem; }
`;

export function buildWebviewHtml(parse: ParseResult, options: WebviewOptions): { html: string; scriptNonce: string } {
	const n = nonce();
	const scriptPolicy = options.enableScripts ? `'nonce-${n}'` : `'none'`;
	const csp = [
		`default-src 'none'`,
		`img-src https: http: data: blob:`,
		`style-src https: http: 'unsafe-inline'`,
		`font-src https: http: data:`,
		`media-src https: http: data: blob:`,
		`script-src ${scriptPolicy}`,
		`frame-src https: http:`,
		`base-uri 'none'`,
		`form-action 'none'`,
	].join('; ');

	const head = options.getCss && parse.headHtml ? stripScripts(parse.headHtml) : '';
	const body = stripScripts(parse.text);
	const categories = parse.categoriesHtml ? `<hr />${stripScripts(parse.categoriesHtml)}` : '';
	const title = parse.displaytitle ?? parse.title;

	const linkScript = options.enableScripts
		? `<script nonce="${n}">
(function () {
	const api = acquireVsCodeApi();
	document.addEventListener('click', function (event) {
		const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
		if (!anchor) { return; }
		const href = anchor.getAttribute('href');
		if (!href || href.startsWith('#')) { return; }
		event.preventDefault();
		event.stopPropagation();
		api.postMessage({ type: 'open', url: anchor.href });
	}, true);
})();
</script>`
		: '';

	const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<base href="${escapeHtml(options.articleBase)}" />
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
${head}
</head>
<body>
<div class="wiki-preview-banner">原样预览（action=parse 渲染结果）· ${escapeHtml(parse.title)}</div>
<div class="wiki-preview-body mw-parser-output">${body}${categories}</div>
${linkScript}
</body>
</html>`;
	return { html, scriptNonce: n };
}

export async function openInWebview(api: MediaWikiApi, pageTitle: string, options: WebviewOptions): Promise<ParseResult> {
	const parse = await api.parsePage(pageTitle, options.revid !== undefined ? { getCss: options.getCss, revid: options.revid } : { getCss: options.getCss });

	// 把"静默看到旧版本"变成明确报错：站点返回的版本必须就是我们刚写入的那一版。
	if (options.revid !== undefined && parse.revid !== undefined && parse.revid !== options.revid) {
		throw new Error(`站点返回的是 rev ${parse.revid}，但刚写入的是 rev ${options.revid}——请求被中间的缓存层改写了`);
	}

	const { html } = buildWebviewHtml(parse, options);

	if (!currentPanel) {
		currentPanel = vscode.window.createWebviewPanel('wikiUserPreview.originalPreview', 'Original Preview', vscode.ViewColumn.Beside, {
			// 始终开启 enableScripts，是否真正执行由 CSP 的 script-src 决定，
			// 这样切换 wikiUserPreview.enableScripts 不必重建面板。
			enableScripts: true,
			retainContextWhenHidden: false,
		});
		currentPanel.onDidDispose(
			() => {
				currentPanel = undefined;
			},
			null,
			[],
		);
		currentPanel.webview.onDidReceiveMessage(
			(message: { type?: string; url?: string }) => {
				if (message.type === 'open' && message.url) {
					void vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
			},
			null,
			[],
		);
	}
	currentPanel.title = `Original Preview: ${parse.displaytitle ?? parse.title}`;
	currentPanel.webview.html = html;
	// 用 reveal() 不带列：面板创建时已经在 Beside（右侧）了，再传 Beside 会把它当成
	// "相对当前活动列"而可能又切出一个新组。
	currentPanel.reveal(undefined, true);
	return parse;
}
