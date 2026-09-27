import * as vscode from 'vscode';
import * as path from 'node:path';
import { WikiHttpClient, sanitizeHeaderValue } from './httpClient';

export type PreviewMode = 'simpleBrowser' | 'webview' | 'external' | 'ask';
export type LoginMode = 'auto' | 'botPassword' | 'clientlogin';
/**
 * - `userNamespaceOnly`（默认）：只有当 PAGE_INFO.pageTitle 位于 User 命名空间时才写回它。
 *   这样「pull 用户页 → 改 → originalPreview」能正确往返，而 pull 主命名空间条目时不会误编辑条目。
 * - `always`：只要 PAGE_INFO 有 pageTitle 就写回它（完全等价于 Wikitext 的 writePage 语义，风险自负）。
 * - `never`：忽略 pageTitle，始终用 pageTemplate 生成目标页面。
 */
export type PageInfoTitleMode = 'userNamespaceOnly' | 'always' | 'never';

export interface ResolvedConfig {
	/** 绝对 URL，例如 https://www.huijiwiki.com/api.php */
	apiUrl: string;
	/** 绝对 URL 前缀，例如 https://www.huijiwiki.com/wiki/ */
	articleBase: string;
	host: string;
	scheme: string;
	username: string;
	usernameSource: string;
	password?: string;
	passwordSource: string;
	loginMode: LoginMode;
	/** PAGE_INFO 里的 pageTitle 在多大程度上决定目标页面 */
	targetFromPageInfo: PageInfoTitleMode;
	pageTemplate: string;
	subpage: string;
	summaryTemplate: string;
	previewMode: PreviewMode;
	enableScripts: boolean;
	getCss: boolean;
	watchlist: string;
	minorEdit: boolean;
	confirmBeforeSave: boolean;
	detectConflict: boolean;
	/** 写入后清一次服务端/边缘缓存，避免打开页面看到旧版本 */
	purgeAfterSave: boolean;
	/** 内置浏览器每次都开在代码区右侧（必要时先关掉旧的内置浏览器标签） */
	simpleBrowserBeside: boolean;
	openAfterSave: boolean;
	userAgent: string;
	requestTimeout: number;
	insecureTls: boolean;
}

export interface WikiContext {
	config: ResolvedConfig;
	client: WikiHttpClient;
}

const SECRET_PREFIX = 'wikiUserPreview.password';

export function secretKey(host: string): string {
	return `${SECRET_PREFIX}:${host.toLowerCase()}`;
}

function own(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('wikiUserPreview');
}

function wikitext(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('wikitext');
}

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function useWikitext(): boolean {
	return own().get<boolean>('useWikitextSettings', true);
}

/**
 * 从 `wikiparser.user`（WPLS 用来填 User-Agent 的用户页 URI 或邮箱）里尽力解析出用户名。
 * 这是 WPLS 唯一与"身份"相关的配置，它本身不保存也不校验任何凭据。
 */
export function usernameFromWikiparserUser(raw: string): string | undefined {
	if (!raw) {
		return undefined;
	}
	let candidate: string;
	const titleMatch = /[?&]title=([^&]+)/.exec(raw);
	if (titleMatch?.[1]) {
		// 形如 .../index.php?title=User:Foo/bar
		try {
			candidate = decodeURIComponent(titleMatch[1]);
		} catch {
			candidate = titleMatch[1];
		}
	} else if (/^https?:\/\//i.test(raw)) {
		const withoutQuery = raw.split(/[?#]/)[0] ?? raw;
		const segments = withoutQuery.split('/').filter(Boolean);
		// 从出现 "User:" / "用户:" 的那一段开始拼接，之后才是可能的子页面
		const start = segments.findIndex(segment => {
			try {
				return /^(?:User|用户|使用者|用戶)\s*:/i.test(decodeURIComponent(segment));
			} catch {
				return false;
			}
		});
		const tail = start >= 0 ? segments.slice(start).join('/') : (segments[segments.length - 1] ?? '');
		try {
			candidate = decodeURIComponent(tail);
		} catch {
			candidate = tail;
		}
	} else {
		candidate = raw;
	}
	const userMatch = /^(?:User|用户|使用者|用戶)\s*:\s*(.+)$/i.exec(candidate.replace(/_/g, ' ').trim());
	if (!userMatch?.[1]) {
		return undefined;
	}
	// User:Foo/bar → Foo
	return userMatch[1].split('/')[0]?.trim() || undefined;
}

export function defaultUserAgent(version: string): string {
	const base = `Mozilla/5.0 (compatible; wiki-user-preview/${version}; +https://github.com/)`;
	const contact = str(vscode.workspace.getConfiguration('wikiparser').get('user'));
	return contact ? `${base} (contact: ${contact})` : base;
}

interface SiteBase {
	scheme: string;
	host: string;
	apiPath: string;
	articlePath: string;
	source: string;
}

function parseSiteInput(input: string): { scheme: string; host: string } | undefined {
	const value = input.trim();
	if (!value) {
		return undefined;
	}
	if (/^https?:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			return { scheme: `${url.protocol}//`, host: url.host };
		} catch {
			return undefined;
		}
	}
	return { scheme: 'https://', host: value.replace(/^\/+|\/+$/g, '') };
}

function normaliseArticlePath(raw: string): string {
	const value = raw.trim();
	if (!value) {
		return '/wiki/';
	}
	return value;
}

/** 配置里只允许出现「路径」的部分，不允许夹带协议或主机。 */
function assertPathLike(label: string, value: string): void {
	if (!value) {
		return;
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
		throw new Error(`${label} 只能是路径（例如 /api.php），不能包含协议或主机，已拒绝：${value}`);
	}
}

/**
 * 拼接出的最终地址必须与配置的站点同源。
 *
 * 这是凭据的边界：`apiPath` 里塞一个 `@` 就能改变 URL 的实际主机
 * （`https://good.example` + `@evil.example/api.php` → 主机是 `evil.example`），
 * 于是界面和确认框显示 `good.example`，密码却发给了 `evil.example`。
 */
function assertTrustedUrl(label: string, url: string, site: SiteBase): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${label} 不是合法的绝对地址，已拒绝：${url}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(
			`${label} 含有 userinfo（"@" 之前的部分），这会把请求指向另一个主机，已拒绝：${url}。` +
				`请检查 wikiUserPreview.apiPath / articlePath 是否被人为加入 "@"。`,
		);
	}
	// 用同样的拼接方式算出「期望的基准」再比 host / protocol —— 手写 scheme 归一化很容易出错
	// （site.scheme 存的是 'https://' 这种带 '//' 的形式，`replace(/:+$/,'')` 对它无效）。
	let expected: URL;
	try {
		expected = new URL(`${site.scheme}${site.host}`);
	} catch {
		throw new Error(`配置的站点地址无法解析，已拒绝：${site.scheme}${site.host}`);
	}
	if (parsed.host.toLowerCase() !== expected.host.toLowerCase()) {
		throw new Error(
			`${label} 的主机是 ${parsed.host}，与配置的站点 ${expected.host} 不一致，已拒绝——密码只会发送给配置的站点。` +
				`请检查 wikiUserPreview.site 与 apiPath / articlePath（以及 wikitext.host / wikiparser.articlePath）。`,
		);
	}
	if (parsed.protocol !== expected.protocol) {
		throw new Error(`${label} 的协议是 ${parsed.protocol}，与配置的 ${expected.protocol} 不一致，已拒绝：${url}`);
	}
	return parsed;
}

async function probeApiPath(client: WikiHttpClient, scheme: string, host: string): Promise<{ apiPath: string; articlePath: string } | undefined> {
	for (const candidate of ['/api.php', '/w/api.php']) {
		try {
			const response = await client.request(`${scheme}${host}${candidate}`, {
				method: 'GET',
				query: { action: 'query', meta: 'siteinfo', siprop: 'general', format: 'json' },
			});
			if (response.status !== 200) {
				continue;
			}
			const data = JSON.parse(response.body) as { query?: { general?: { articlepath?: string; server?: string; scriptpath?: string } } };
			const general = data.query?.general;
			if (!general) {
				continue;
			}
			return {
				apiPath: candidate,
				articlePath: normaliseArticlePath(general.articlepath ?? `${general.scriptpath ?? ''}/index.php?title=$1`),
			};
		} catch {
			// 换下一个候选
		}
	}
	return undefined;
}

function wikiparser(section: string): string {
	return str(vscode.workspace.getConfiguration('wikiparser').get(section));
}

function resolveSiteBase(): SiteBase | undefined {
	const explicit = str(own().get('site'));
	if (explicit) {
		const parsed = parseSiteInput(explicit);
		if (parsed) {
			return {
				scheme: parsed.scheme,
				host: parsed.host,
				apiPath: str(own().get('apiPath')),
				articlePath: str(own().get('articlePath')) || wikiparser('articlePath'),
				source: 'wikiUserPreview.site',
			};
		}
	}
	if (useWikitext()) {
		const host = str(wikitext().get('host'));
		if (host) {
			return {
				scheme: str(wikitext().get('transferProtocol')) || 'https://',
				host,
				apiPath: str(own().get('apiPath')) || str(wikitext().get('apiPath')),
				articlePath: str(own().get('articlePath')) || str(wikitext().get('articlePath')) || wikiparser('articlePath'),
				source: 'wikitext.host',
			};
		}
	}
	return undefined;
}

async function resolveUsername(host: string, allowPrompt: boolean): Promise<{ username: string; source: string }> {
	const explicit = str(own().get('username'));
	if (explicit) {
		return { username: explicit, source: 'wikiUserPreview.username' };
	}
	if (useWikitext()) {
		const fromWikitext = str(wikitext().get('userName'));
		if (fromWikitext) {
			return { username: fromWikitext, source: 'wikitext.userName' };
		}
	}
	const fromWikiparser = usernameFromWikiparserUser(str(vscode.workspace.getConfiguration('wikiparser').get('user')));
	if (fromWikiparser) {
		return { username: fromWikiparser, source: 'wikiparser.user' };
	}
	if (!allowPrompt) {
		return { username: '', source: '未配置' };
	}
	const input = await vscode.window.showInputBox({
		title: 'Wiki User Preview：用户名',
		prompt: `${host} 的登录用户名（机器人密码请写成 用户名@机器人名）`,
		placeHolder: 'Unauthorized_HOPE',
		ignoreFocusOut: true,
	});
	if (!input?.trim()) {
		throw new Error('未提供用户名，已取消。');
	}
	return { username: input.trim(), source: '本次输入' };
}

const GLOBAL_SECRET = SECRET_PREFIX;

async function resolvePassword(
	context: vscode.ExtensionContext,
	host: string,
	username: string,
	allowPrompt: boolean,
): Promise<{ password?: string; source: string }> {
	const perHost = await context.secrets.get(secretKey(host));
	if (perHost) {
		return { password: perHost, source: `系统钥匙串（${host}）` };
	}
	const global = await context.secrets.get(GLOBAL_SECRET);
	if (global) {
		return { password: global, source: '系统钥匙串（全局）' };
	}
	if (useWikitext()) {
		const fromWikitext = str(wikitext().get('password'));
		if (fromWikitext) {
			return { password: fromWikitext, source: 'wikitext.password（明文设置）' };
		}
	}
	if (!allowPrompt) {
		return { source: '未配置' };
	}
	const input = await vscode.window.showInputBox({
		title: 'Wiki User Preview：密码',
		prompt: `${host} 账号 ${username} 的密码`,
		password: true,
		ignoreFocusOut: true,
	});
	if (!input) {
		return { source: '未提供' };
	}
	const save = await vscode.window.showQuickPick(['保存到系统钥匙串（推荐）', '仅本次使用'], {
		title: '是否保存密码？',
		ignoreFocusOut: true,
	});
	if (save === '保存到系统钥匙串（推荐）') {
		await context.secrets.store(secretKey(host), input);
		return { password: input, source: `系统钥匙串（${host}）` };
	}
	return { password: input, source: '本次输入' };
}

export function sanitizeTitlePart(input: string): string {
	const cleaned = input
		// MediaWiki 不允许出现在标题里的字符
		.replace(/[#<>[\]|{}]/g, '-')
		.replace(/_/g, ' ')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.slice(0, 120);
}

export interface TemplateVars {
	username: string;
	basename: string;
	filename: string;
	ext: string;
	subpage: string;
}

export function applyTemplate(template: string, vars: TemplateVars): string {
	return template
		.replace(/\{username\}/g, vars.username)
		.replace(/\{basename\}/g, vars.basename)
		.replace(/\{filename\}/g, vars.filename)
		.replace(/\{ext\}/g, vars.ext)
		.replace(/\{subpage\}/g, vars.subpage)
		.replace(/\s+/g, ' ')
		.trim();
}

export function documentVars(doc: vscode.TextDocument, username: string, subpageOverride: string): TemplateVars {
	const basename = path.basename(doc.isUntitled ? `${doc.fileName}.wikitext` : doc.fileName);
	const ext = path.extname(basename);
	const filename = sanitizeTitlePart(ext ? basename.slice(0, -ext.length) : basename) || 'Untitled';
	const subpage = sanitizeTitlePart(subpageOverride) || filename;
	return {
		username,
		basename,
		filename,
		ext: ext.replace(/^\./, ''),
		subpage,
	};
}

export function buildPageTitle(cfg: Pick<ResolvedConfig, 'pageTemplate'>, vars: TemplateVars): string {
	return applyTemplate(cfg.pageTemplate, vars).replace(/^\/+|\/+$/g, '');
}

/** 把标题拼成可点击的条目 URL，`$1` 形式与直接追加两种 articlePath 都支持。 */
export function articleUrl(articleBase: string, title: string): string {
	const encoded = encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':');
	if (articleBase.includes('$1')) {
		return articleBase.replace(/\$1/g, encoded);
	}
	return `${articleBase.replace(/\/+$/, '')}/${encoded}`;
}

/**
 * 给预览 URL 追加一个随版本变化的参数，用来绕过：
 *   - 浏览器 HTTP 缓存与 bfcache
 *   - VS Code 内置浏览器复用 webview 时"刷新也不重新请求"的行为
 *   - Cloudflare 之类按完整 URL 做键的边缘缓存
 *
 * MediaWiki 会忽略页面视图上不认识的 query 参数，所以不影响页面本身。
 */
export function withCacheBuster(url: string, token: string | number): string {
	const separator = url.includes('?') ? '&' : '?';
	return `${url}${separator}wikiUserPreviewRev=${encodeURIComponent(String(token))}`;
}

export interface ResolveOptions {
	/** 为 false 时不会弹窗索要用户名/密码，只做静默解析。 */
	promptForSecrets?: boolean;
}

let sharedClient: { key: string; client: WikiHttpClient } | undefined;

/**
 * 连接相关的设置（User-Agent / 超时 / TLS 校验）决定客户端的身份：任何一项变了就换一个
 * 新客户端并清空 cookie。这样「关掉跳过 TLS 校验」这类变更会立刻对下一次连接生效，
 * 而不是让已建立的会话继续沿用旧设置。会话侧靠比对客户端实例来发现这一点并重新登录。
 */
export function getSharedClient(userAgent: string, requestTimeout: number, insecureTls: boolean): WikiHttpClient {
	const key = JSON.stringify({ userAgent, requestTimeout, insecureTls });
	if (!sharedClient || sharedClient.key !== key) {
		sharedClient = { key, client: new WikiHttpClient(userAgent, requestTimeout, insecureTls) };
	}
	return sharedClient.client;
}

/** 丢弃共享客户端（含其中的 cookie）。登出、以及连接设置变更时调用。 */
export function resetSharedClient(): void {
	sharedClient?.client.clearCookies();
	sharedClient = undefined;
}

export async function resolveConfig(context: vscode.ExtensionContext, options: ResolveOptions = {}): Promise<WikiContext> {
	const promptForSecrets = options.promptForSecrets !== false;
	const version = (context.extension.packageJSON as { version?: string }).version ?? '0.1.0';
	// 先归一化再落进 config，这样「显示生效的配置」输出的就是真正会被发出的值。
	const userAgent = sanitizeHeaderValue(str(own().get('userAgent')) || defaultUserAgent(version));
	const requestTimeout = own().get<number>('requestTimeout', 30000);
	const insecureTls = own().get<boolean>('insecureTls', false);
	const client = getSharedClient(userAgent, requestTimeout, insecureTls);

	let site = resolveSiteBase();
	if (!site) {
		const input = await vscode.window.showInputBox({
			title: 'Wiki User Preview：站点',
			prompt: '站点地址，例如 www.huijiwiki.com 或 https://zh.wikipedia.org',
			placeHolder: 'www.huijiwiki.com',
			ignoreFocusOut: true,
		});
		if (!input?.trim()) {
			throw new Error('未配置站点，已取消。请设置 wikiUserPreview.site。');
		}
		const parsed = parseSiteInput(input);
		if (!parsed) {
			throw new Error(`无法解析站点地址：${input}`);
		}
		site = { scheme: parsed.scheme, host: parsed.host, apiPath: '', articlePath: '', source: '本次输入' };
	}

	// 在探测之前就锁定唯一允许通信的主机：之后的探测、登录、编辑、预览全都受它约束。
	// 换主机会顺带清空 cookie jar，避免上一个站点的会话被带过去。
	client.setHost(site.host, site.scheme);

	let apiPath = site.apiPath;
	let articlePath = site.articlePath;
	assertPathLike('apiPath', apiPath);
	if (!apiPath) {
		const probed = await probeApiPath(client, site.scheme, site.host);
		if (!probed) {
			throw new Error(`无法在 ${site.scheme}${site.host} 上找到可用的 api.php，请手动设置 wikiUserPreview.apiPath。`);
		}
		apiPath = probed.apiPath;
		articlePath = articlePath || probed.articlePath;
	}
	articlePath = normaliseArticlePath(articlePath);

	const base = `${site.scheme}${site.host}`;
	const apiUrl = `${base}${apiPath}`;
	const articleBase = /^https?:\/\//i.test(articlePath) ? articlePath : `${base}${articlePath.startsWith('/') ? '' : '/'}${articlePath}`;

	// 安全边界：拼接结果的最终主机必须就是配置的站点主机。
	// 不校验的话，`apiPath: "@evil.example/api.php"` 会让 URL 解析出 evil.example——
	// 界面显示 good.example，密码却发给了 evil.example。
	assertTrustedUrl('API 地址', apiUrl, site);
	assertTrustedUrl('条目地址', articleBase, site);

	const { username, source: usernameSource } = await resolveUsername(site.host, promptForSecrets);
	const { password, source: passwordSource } = await resolvePassword(context, site.host, username, promptForSecrets);

	const config: ResolvedConfig = {
		apiUrl,
		articleBase,
		host: site.host,
		scheme: site.scheme,
		username,
		usernameSource,
		passwordSource,
		loginMode: own().get<LoginMode>('loginMode', 'auto'),
		targetFromPageInfo: own().get<PageInfoTitleMode>('targetFromPageInfo', 'userNamespaceOnly'),
		pageTemplate: str(own().get('pageTemplate')) || 'User:{username}/OriginalPreview/{filename}',
		subpage: str(own().get('subpage')),
		summaryTemplate: str(own().get('summaryTemplate')) || '由 VS Code 扩展 Wiki User Preview 上传，源文件：{basename}',
		previewMode: own().get<PreviewMode>('previewMode', 'webview'),
		enableScripts: own().get<boolean>('enableScripts', false),
		getCss: own().get<boolean>('getCss', true),
		watchlist: own().get<string>('watchlist', 'nochange'),
		minorEdit: own().get<boolean>('minorEdit', false),
		confirmBeforeSave: own().get<boolean>('confirmBeforeSave', true),
		detectConflict: own().get<boolean>('detectConflict', true),
		purgeAfterSave: own().get<boolean>('purgeAfterSave', true),
		simpleBrowserBeside: own().get<boolean>('simpleBrowserBeside', true),
		openAfterSave: own().get<boolean>('openAfterSave', true),
		userAgent,
		requestTimeout,
		insecureTls,
	};
	if (password !== undefined) {
		config.password = password;
	}
	return { config, client };
}
