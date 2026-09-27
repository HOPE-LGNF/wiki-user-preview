import * as vscode from 'vscode';
import { WikiContext, applyTemplate, articleUrl, buildPageTitle, documentVars, resetSharedClient, resolveConfig, secretKey, withCacheBuster } from './config';
import { WikiHttpClient } from './httpClient';
import { EditResult, MediaWikiApi, MediaWikiError, LoginResult, UiField } from './mediawiki';
import { PageInfo, extractPageInfo, isUserNamespaceTitle } from './pageInfo';
import * as preview from './preview';

let output: vscode.OutputChannel;

interface Session {
	key: string;
	api: MediaWikiApi;
	/** 登录时提交的名字（机器人密码会带 @机器人名） */
	username: string;
	/** 服务端确认的账号名，用于拼 `User:` 命名空间下的目标页面 */
	canonicalUsername: string;
	/** 会话所属的 HTTP 客户端。客户端一换（超时/TLS/UA 变更）会话就必须重建 */
	client: WikiHttpClient;
}

let session: Session | undefined;

interface EditBase {
	baserevid?: number;
	basetimestamp?: string;
}

interface PostedRevision {
	revid: number;
	timestamp?: string;
}

/** 本会话内已写回过的版本，用于避免同一个 buffer 连续推送被当成「自我冲突」。 */
const postedRevisions = new Map<string, PostedRevision>();

function log(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}`;
	output.appendLine(line);
	// 排障用旁路：OutputChannel 在集成测试里看不到，设了这个环境变量就同时写到 stderr。
	if (process.env.WIKI_USER_PREVIEW_DEBUG) {
		console.error(`[wiki-user-preview] ${line}`);
	}
}

function describeError(error: unknown): string {
	if (error instanceof MediaWikiError) {
		return `${error.code}: ${error.info}`;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * 弹出带按钮的通知并处理用户的选择。
 *
 * **绝不 await**：带按钮的通知要等用户点掉（或超时）才 resolve，await 它会让命令一直不返回，
 * 命令是否「完成」就取决于用户有没有关掉通知。按钮回调稍后异步执行即可。
 */
function notify(message: string, actions: string[], onAction?: (action: string | undefined) => Promise<void> | void): void {
	void vscode.window.showInformationMessage(message, ...actions).then(
		async action => {
			try {
				await onAction?.(action);
			} catch (error) {
				log(`处理通知操作失败：${describeError(error)}`);
				void vscode.window.showErrorMessage(`处理通知操作失败：${describeError(error)}`);
			}
		},
		error => log(`通知处理失败：${describeError(error)}`),
	);
}

function makeApi(wiki: WikiContext): MediaWikiApi {
	return new MediaWikiApi(wiki.client, wiki.config.apiUrl, message => {
		log(message);
		void vscode.window.setStatusBarMessage(`$(sync~spin) Wiki: ${message}`, 6000);
	});
}

// ------------------------------------------------------------------ 登录

async function promptUi(message: string, fields: UiField[]): Promise<Record<string, string> | undefined> {
	const answers: Record<string, string> = {};
	if (fields.length > 1) {
		void vscode.window.showInformationMessage(`站点要求补充登录信息：${message}`);
	}
	for (const field of fields) {
		const label = field.label ?? field.id;
		const placeHolder = field.help ?? '';

		if (field.type === 'button') {
			// 按钮只需要把它的 name=value 原样提交回去
			answers[field.id] = String(field.value ?? '');
			continue;
		}
		if (field.type === 'checkbox') {
			const picked = await vscode.window.showQuickPick(['是', '否'], { title: label, placeHolder, ignoreFocusOut: true });
			if (picked === undefined) {
				return undefined;
			}
			answers[field.id] = picked === '是' ? 'true' : 'false';
			continue;
		}
		if ((field.type === 'select' || field.type === 'radio') && field.options?.length) {
			const items = field.options.map(option => ({ label: option.label ?? option.value, value: option.value }));
			const picked = await vscode.window.showQuickPick(items, { title: label, placeHolder, ignoreFocusOut: true });
			if (picked === undefined) {
				return undefined;
			}
			answers[field.id] = picked.value;
			continue;
		}
		const input = await vscode.window.showInputBox({
			title: label,
			prompt: field.help ?? message,
			password: field.type === 'password',
			ignoreFocusOut: true,
		});
		if (input === undefined) {
			return undefined;
		}
		answers[field.id] = input;
	}
	return answers;
}

async function performLogin(wiki: WikiContext): Promise<Session> {
	const { config, client } = wiki;
	const api = makeApi(wiki);

	if (!config.password) {
		throw new Error(
			`没有可用密码。请运行命令「Wiki User Preview: 设置密码」把密码存入系统钥匙串，` +
				`或设置 wikitext.password（明文），或把密码填到 wikiUserPreview 的自定义配置里。`,
		);
	}

	const tryBotPassword = async () => {
		log(`action=login（机器人密码）→ ${config.apiUrl}，用户 ${config.username}`);
		return api.loginBotPassword(config.username, config.password!);
	};
	const tryClientLogin = async () => {
		log(`action=clientlogin（主账号密码）→ ${config.apiUrl}，用户 ${config.username}`);
		return api.clientLogin(config.username, config.password!, promptUi);
	};

	const looksLikeBotPassword = config.username.includes('@');
	const primary: () => Promise<LoginResult> =
		config.loginMode === 'botPassword' ? tryBotPassword : config.loginMode === 'clientlogin' ? tryClientLogin : looksLikeBotPassword ? tryBotPassword : tryClientLogin;
	let secondary: (() => Promise<LoginResult>) | undefined = primary === tryBotPassword ? tryClientLogin : tryBotPassword;
	if (config.loginMode === 'botPassword' || config.loginMode === 'clientlogin') {
		secondary = undefined;
	}

	const finish = async (result: LoginResult): Promise<Session> => {
		log(`登录成功（${result.via}）：${result.username}`);
		void vscode.window.setStatusBarMessage(`$(account) Wiki: ${result.username}`, 5000);
		// 取服务端确认的账号名。机器人密码的登录名形如 `Alice@PreviewBot`，但账号其实叫
		// Alice——用它拼 `User:` 才能落在自己的用户子页下，而不是 `User:Alice@PreviewBot/...`
		// （那属于另一个并不存在的用户）。
		let canonical = result.username;
		try {
			const info = await api.getUserInfo();
			if (info.name) {
				canonical = info.name;
			}
		} catch (error) {
			log(`获取账号名失败，回退到登录名：${describeError(error)}`);
		}
		if (canonical !== result.username) {
			log(`账号名归一化：${result.username} → ${canonical}`);
		}
		return { key: `${config.apiUrl}|${config.username}`, api, username: result.username, canonicalUsername: canonical, client };
	};

	try {
		return await finish(await primary());
	} catch (error) {
		if (!secondary) {
			throw error;
		}
		log(`首选登录方式失败：${describeError(error)}；尝试备用方式`);
		try {
			return await finish(await secondary());
		} catch (secondError) {
			throw new Error(
				`两种登录方式都失败了。\n首选：${describeError(error)}\n备用：${describeError(secondError)}\n\n` +
					`提示：MediaWiki 官方建议使用机器人密码（Special:BotPasswords，格式 用户名@机器人名）配合 action=login；` +
					`主账号密码需要走 action=clientlogin，若账号开启了两步验证会额外要求输入验证码。`,
			);
		}
	}
}

async function getSession(wiki: WikiContext): Promise<Session> {
	const key = `${wiki.config.apiUrl}|${wiki.config.username}`;
	// 会话必须属于当前的 HTTP 客户端：客户端会因超时 / TLS 校验 / UA 变更而更换，
	// 而换客户端意味着 cookie jar 是空的，复用旧会话会导致「编辑成功、预览却未登录」。
	if (session && session.key === key && session.client === wiki.client) {
		try {
			const info = await session.api.getUserInfo();
			if (!info.anonymous) {
				return session;
			}
			log('复用会话时发现已变成匿名，重新登录');
		} catch (error) {
			log(`校验已有会话失败，重新登录：${describeError(error)}`);
		}
	} else if (session) {
		log('HTTP 客户端或站点配置已变更，重建会话');
	}
	session = await performLogin(wiki);
	return session;
}

function dropSession(): void {
	session = undefined;
}

// ------------------------------------------------------------- 主命令实现

/**
 * 冲突检测的基准版本必须来自「用户拉取页面时」，不能是「提交前刚查到的」——后者永远等于
 * 当前版本，等于什么都没检测。优先级：
 *   1. 本会话上一次成功写回产生的版本（避免同一个 buffer 连续推送被判成自我冲突）
 *   2. PAGE_INFO 里的 revisionID / revisionTime（wikitext 的 Pull page to edit 写入的）
 *   3. 当前版本（只能防住「查询到提交」这个窗口内的竞态）
 *
 * basetimestamp 是必须的：按 action=help&modules=edit 的说明，只发 baserevid 时
 * 「自己改自己」会被判成 editconflict，而 basetimestamp 会让自我冲突被忽略。
 */
async function resolveEditBase(
	api: MediaWikiApi,
	progress: vscode.Progress<{ message?: string }>,
	pageTitle: string,
	pageInfo: PageInfo | undefined,
	remembered: PostedRevision | undefined,
): Promise<EditBase | undefined> {
	const pulledRevid = remembered?.revid ?? (pageInfo?.revisionID ? Number.parseInt(pageInfo.revisionID, 10) : undefined);
	const origin = remembered ? '本会话上次写回的版本' : 'PAGE_INFO';

	progress.report({ message: '检查页面当前版本…' });
	const revision = await api.getPageRevision(pageTitle);

	if (pulledRevid !== undefined && Number.isFinite(pulledRevid)) {
		const base: EditBase = { baserevid: pulledRevid };
		const timestamp = remembered?.timestamp ?? pageInfo?.revisionTime;
		if (timestamp) {
			base.basetimestamp = timestamp;
		} else if (revision?.revid === pulledRevid && revision.timestamp) {
			// 当前版本正好等于基准版本，补上 basetimestamp 可避免自我冲突。
			base.basetimestamp = revision.timestamp;
		}
		log(
			`基准版本取自${origin}：revid=${pulledRevid}` +
				(base.basetimestamp ? `，basetimestamp=${base.basetimestamp}` : '（无 basetimestamp：与当前版本不符时会报 editconflict）'),
		);
		return base;
	}

	if (revision) {
		const base: EditBase = { baserevid: revision.revid };
		if (revision.timestamp) {
			base.basetimestamp = revision.timestamp;
		}
		log(`页面已存在，基准版本取当前 revid=${revision.revid}（只能防查询到提交之间的竞态）`);
		return base;
	}

	log('页面不存在，将新建');
	return undefined;
}

/**
 * 这次写入之后要不要打开预览。
 *
 * - `writeOnly` 命令传 `openPreview: false`，**始终不打开**；
 * - `originalPreview` 命令还要看 `openAfterSave` 配置。
 */
export function shouldOpenPreview(options: { openPreview?: boolean }, openAfterSave: boolean): boolean {
	return (options.openPreview ?? true) && openAfterSave;
}

export interface WriteConfirmParams {
	openAfterwards: boolean;
	pageTitle: string;
	charCount: number;
	host: string;
	username: string;
	titleSource: string;
	summary: string;
	/** 被剥掉的 PAGE_INFO 块字符数，0 表示没有 */
	strippedChars: number;
}

/**
 * 写入前确认框的内容。
 *
 * 按钮文案必须跟着模式走：`writeOnly` 命令下若仍写「写入并预览」，就与用户刚刚特意选的
 * 「不打开预览」自相矛盾——即使点下去的行为是对的，文案本身也是在误导。
 * 抽成纯函数是为了能直接对文案写断言（v0.2.5 就是把这里写死成了「写入并预览」）。
 */
export function writeConfirm(params: WriteConfirmParams): { message: string; detail: string; button: string } {
	const detail = [
		`站点：${params.host}`,
		`账号：${params.username}`,
		`页面：${params.pageTitle}（来源：${params.titleSource}）`,
		`摘要：${params.summary}`,
	];
	if (!params.openAfterwards) {
		detail.push('本次只写入，不打开预览');
	}
	if (params.strippedChars > 0) {
		detail.push(`已自动剥离文件开头的 PAGE_INFO 块（${params.strippedChars} 字符不会上传）`);
	}
	return {
		message: `即将把当前文件写入 ${params.pageTitle}（${params.charCount} 字符）并保存。`,
		detail: detail.join('\n'),
		button: params.openAfterwards ? '写入并预览' : '仅写入',
	};
}

async function writeAndPreview(context: vscode.ExtensionContext, options: { openPreview?: boolean } = {}): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		throw new Error('当前没有打开的编辑器。');
	}
	const doc = editor.document;
	const raw = doc.getText();
	if (!raw.trim()) {
		throw new Error('当前文件是空的，没有内容可以上传。');
	}

	// Wikitext 的「Pull page to edit」必然会在文件开头插入 PAGE_INFO 块。对 wikitext
	// 内容模型它不是注释，所以必须在上传前剥掉，否则会明文出现在页面正文里。
	const pulled = extractPageInfo(raw);
	const text = pulled.content;
	if (!text.trim()) {
		throw new Error('剥掉 PAGE_INFO 之后没有正文可上传。');
	}

	const wiki = await resolveConfig(context);
	const cfg = wiki.config;
	const openAfterwards = shouldOpenPreview(options, cfg.openAfterSave);

	log(`站点：${cfg.apiUrl}`);
	log(`配置来源：站点=${cfg.apiUrl}，用户名=${cfg.usernameSource}，密码=${cfg.passwordSource}`);
	if (pulled.block) {
		log(`已剥离开头的 PAGE_INFO 块（${pulled.block.end - pulled.block.start} 字符），该块不会被上传`);
		log(`PAGE_INFO：${JSON.stringify(pulled.info ?? {})}`);
	} else {
		log('文件开头没有 PAGE_INFO 块');
	}
	if (pulled.misplacedBlock) {
		log('注意：正文中间也出现了 PAGE_INFO 形状的块。按设计只在文件开头识别元信息，该块会原样上传');
	}
	log(`上传正文长度：${text.length} 字符（原文 ${raw.length}）`);

	// 先登录、再决定目标页面。机器人密码的登录名形如 `Alice@PreviewBot`，但账号其实叫
	// Alice；目标页面必须用服务端确认的账号名来拼，否则会写到 `User:Alice@PreviewBot/...`
	// ——那属于另一个并不存在的用户，而不是自己的用户子页。
	const outcome = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Wiki User Preview', cancellable: false },
		async progress => {
			progress.report({ message: '登录中…' });
			const current = await getSession(wiki);

			const vars = documentVars(doc, current.canonicalUsername, cfg.subpage);
			const templateTitle = buildPageTitle(cfg, vars);
			const pulledTitle = pulled.info?.pageTitle?.trim();
			let pageTitle = templateTitle;
			let titleSource = 'wikiUserPreview.pageTemplate';
			if (pulledTitle && cfg.targetFromPageInfo !== 'never' && (cfg.targetFromPageInfo === 'always' || isUserNamespaceTitle(pulledTitle))) {
				pageTitle = pulledTitle;
				titleSource = 'PAGE_INFO.pageTitle';
			}
			// 只有目标页面确实就是 pull 来的那一页时，PAGE_INFO 里的版本号才能当作基准。
			const pageInfoBase = pulledTitle && pulledTitle === pageTitle ? pulled.info : undefined;
			const cacheKey = `${doc.uri.toString()}\u0000${pageTitle}`;
			const summary = applyTemplate(cfg.summaryTemplate, vars);
			const url = articleUrl(cfg.articleBase, pageTitle);

			log(
				`账号：${current.username}` +
					(current.canonicalUsername === current.username ? '' : `（服务端确认名：${current.canonicalUsername}）`),
			);
			log(`目标页面：${pageTitle}（来源：${titleSource}）`);
			log(`条目 URL：${url}`);

			if (cfg.confirmBeforeSave) {
				const dialog = writeConfirm({
					openAfterwards,
					pageTitle,
					charCount: text.length,
					host: cfg.host,
					username: current.canonicalUsername,
					titleSource,
					summary,
					strippedChars: pulled.block ? raw.length - text.length : 0,
				});
				const confirm = await vscode.window.showWarningMessage(dialog.message, { modal: true, detail: dialog.detail }, dialog.button);
				if (confirm !== dialog.button) {
					return undefined;
				}
			}

			progress.report({ message: '获取编辑令牌…' });
			let csrfToken = await current.api.getToken('csrf');

			const base = cfg.detectConflict ? await resolveEditBase(current.api, progress, pageTitle, pageInfoBase, postedRevisions.get(cacheKey)) : undefined;

			const doEdit = async (useBase: EditBase | undefined) =>
				current.api.edit({
					title: pageTitle,
					text,
					summary,
					token: csrfToken,
					watchlist: cfg.watchlist,
					minor: cfg.minorEdit,
					...useBase,
				});

			progress.report({ message: '写入并保存中…' });
			let editResult: EditResult;
			try {
				editResult = await doEdit(base);
			} catch (error) {
				if (error instanceof MediaWikiError && (error.code === 'badtoken' || error.code === 'assertuserfailed' || error.code === 'notloggedin')) {
					log(`令牌或登录态失效（${error.code}），重新登录后重试`);
					dropSession();
					const refreshed = await getSession(wiki);
					csrfToken = await refreshed.api.getToken('csrf');
					editResult = await refreshed.api.edit({
						title: pageTitle,
						text,
						summary,
						token: csrfToken,
						watchlist: cfg.watchlist,
						minor: cfg.minorEdit,
						...base,
					});
				} else if (error instanceof MediaWikiError && error.code === 'editconflict') {
					const force = await vscode.window.showWarningMessage(
						`页面 ${pageTitle} 自拉取以来已被修改过（基准版本 revid ${base?.baserevid ?? '未知'}）。是否强制覆盖？`,
						{ modal: true },
						'强制覆盖',
					);
					if (force !== '强制覆盖') {
						throw new Error('检测到编辑冲突，已取消。');
					}
					progress.report({ message: '强制覆盖中…' });
					editResult = await doEdit(undefined);
				} else {
					throw error;
				}
			}

			// 编辑会刷新 MediaWiki 的解析缓存，但 Cloudflare 这类边缘缓存不一定跟着失效。
			// purge 失败不影响主流程（预览 URL 还带了 cache-buster）。
			if (cfg.purgeAfterSave) {
				progress.report({ message: '刷新站点缓存…' });
				try {
					await current.api.purgePage(pageTitle, csrfToken);
					log('已请求 action=purge 刷新页面缓存');
				} catch (error) {
					log(`action=purge 失败（忽略）：${describeError(error)}`);
				}
			}

			return { result: editResult, pageTitle, url, cacheKey };
		},
	);

	if (!outcome) {
		log('用户在确认步骤取消了写入');
		return;
	}
	const { result, pageTitle, url, cacheKey } = outcome;

	log(`写入成功：rev ${result.oldrevid ?? '(新建)'} → ${result.newrevid ?? '?'}`);
	if (result.newrevid !== undefined) {
		const entry: PostedRevision = { revid: result.newrevid };
		if (result.newtimestamp !== undefined) {
			entry.timestamp = result.newtimestamp;
		}
		postedRevisions.set(cacheKey, entry);
	}
	if (result.newrevid !== undefined && result.oldrevid !== undefined) {
		// 便于排查：给出两版差异链接
		log(`差异：${articleUrl(cfg.articleBase, pageTitle)}?diff=${result.newrevid}&oldid=${result.oldrevid}`);
	}

	// 打开预览时用的地址带一个随版本变化的参数，绕开浏览器缓存 / bfcache / 边缘缓存
	const previewUrl = withCacheBuster(url, result.newrevid ?? Date.now());

	// 仅写入模式（`writeOnly` 命令，或把 openAfterSave 关掉）：不打开预览，只给反馈和
	// 一次性的打开入口。适合另一块屏幕上已经开着页面、直接刷新就行的场景。
	if (!openAfterwards) {
		log(`仅写入，不打开预览。预览 URL：${previewUrl}`);
		notify(`已写入 ${result.title}（rev ${result.newrevid ?? '?'}），可直接刷新页面查看。`, ['在浏览器中打开', '查看页面地址'], async action => {
			if (action === '在浏览器中打开') {
				await preview.openInSystemBrowser(previewUrl);
			} else if (action === '查看页面地址') {
				await vscode.env.clipboard.writeText(url);
				void vscode.window.showInformationMessage('页面地址已复制到剪贴板。');
			}
		});
		return;
	}

	await openPreview(wiki, pageTitle, url, result.newrevid);
}
type OpenChoice = 'simpleBrowser' | 'webview' | 'external';

const PREVIEW_LABELS: Record<OpenChoice, string> = {
	webview: 'Webview 原样渲染',
	simpleBrowser: 'VS Code 内置浏览器',
	external: '系统浏览器',
};

const PREVIEW_BUTTONS: Record<OpenChoice, string> = {
	webview: '改用 Webview 渲染',
	simpleBrowser: '改用内置浏览器',
	external: '改用系统浏览器',
};

const PREVIEW_DESCRIPTIONS: Record<OpenChoice, string> = {
	webview: '用 action=parse 的渲染结果自绘，无 iframe、不执行站点脚本，最稳；没有站点皮肤',
	simpleBrowser: '真·原页面（含站点皮肤）。但内嵌页面触发通知时 VS Code 会暂停它（"因通知而暂停"），且第三方 cookie 会被拦',
	external: '系统默认浏览器，行为最完整',
};

const ALL_PREVIEW_MODES: OpenChoice[] = ['webview', 'simpleBrowser', 'external'];

async function renderPreview(wiki: WikiContext, pageTitle: string, url: string, mode: OpenChoice, revid?: number): Promise<void> {
	const cfg = wiki.config;
	if (mode === 'external') {
		await preview.openInSystemBrowser(url);
		return;
	}
	if (mode === 'webview') {
		await preview.openInWebview(makeApi(wiki), pageTitle, {
			enableScripts: cfg.enableScripts,
			getCss: cfg.getCss,
			articleBase: cfg.articleBase,
			...(revid !== undefined ? { revid } : {}),
		});
		return;
	}
	const browser = await preview.openInSimpleBrowser(url, cfg.simpleBrowserBeside);
	log(
		`内置浏览器：命令=${browser.command}，集成浏览器=${browser.integratedBrowser}，` +
			`${browser.moved ? '已移到代码区右侧' : '未移动（已在独立分组里或未开启该选项）'}`,
	);
}

async function openPreview(wiki: WikiContext, pageTitle: string, url: string, newrevid?: number): Promise<void> {
	const cfg = wiki.config;
	const revSuffix = newrevid !== undefined ? `（rev ${newrevid}）` : '';

	// 打开用的 URL 带一个随版本变化的参数：绕过浏览器缓存、bfcache、VS Code 复用 webview
	// 以及按完整 URL 做键的边缘缓存。"刷新无效"就是被这几层之一卡住的。
	const previewUrl = withCacheBuster(url, newrevid ?? Date.now());
	log(`预览 URL：${previewUrl}`);

	let mode: OpenChoice;
	if (cfg.previewMode === 'ask') {
		const picked = await vscode.window.showQuickPick(
			ALL_PREVIEW_MODES.map(value => ({ label: PREVIEW_LABELS[value], value, description: PREVIEW_DESCRIPTIONS[value] })),
			{ title: `已保存到 ${pageTitle}，选择预览方式`, ignoreFocusOut: true },
		);
		if (!picked) {
			void vscode.window.showInformationMessage(`已保存到 ${pageTitle}${revSuffix}。`);
			return;
		}
		mode = picked.value;
	} else {
		mode = cfg.previewMode;
	}

	try {
		await renderPreview(wiki, pageTitle, previewUrl, mode, newrevid);
	} catch (error) {
		log(`用「${PREVIEW_LABELS[mode]}」预览失败：${describeError(error)}`);
		const others = ALL_PREVIEW_MODES.filter(item => item !== mode);
		// 同样不 await：交给用户之后异步处理
		void vscode.window
			.showErrorMessage(
				`预览失败（${PREVIEW_LABELS[mode]}）：${describeError(error)}`,
				...others.map(item => PREVIEW_BUTTONS[item]),
				'查看日志',
			)
			.then(async fallback => {
				try {
					const switched = others.find(item => fallback === PREVIEW_BUTTONS[item]);
					if (switched) {
						await renderPreview(wiki, pageTitle, previewUrl, switched, newrevid);
					} else if (fallback === '查看日志') {
						output.show(true);
					}
				} catch (retryError) {
					log(`改用其它方式预览也失败了：${describeError(retryError)}`);
					void vscode.window.showErrorMessage(`改用其它方式预览也失败了：${describeError(retryError)}`);
				}
			});
		return;
	}

	// 成功之后也始终给一次一键切换的机会，省得为了换个打开方式去改配置
	const others = ALL_PREVIEW_MODES.filter(item => item !== mode);
	notify(`已保存到 ${pageTitle}${revSuffix}，已用「${PREVIEW_LABELS[mode]}」打开。`, [
		...others.map(item => PREVIEW_BUTTONS[item]),
		'查看页面地址',
	], async action => {
		const switched = others.find(item => action === PREVIEW_BUTTONS[item]);
		if (switched) {
			try {
				await renderPreview(wiki, pageTitle, previewUrl, switched, newrevid);
			} catch (error) {
				log(`改用「${PREVIEW_LABELS[switched]}」失败：${describeError(error)}`);
				void vscode.window.showErrorMessage(`改用「${PREVIEW_LABELS[switched]}」失败：${describeError(error)}`);
			}
		} else if (action === '查看页面地址') {
			// 复制不带 cache-buster 的规范地址
			await vscode.env.clipboard.writeText(url);
			void vscode.window.showInformationMessage('页面地址已复制到剪贴板。');
		}
	});
}

// ---------------------------------------------------------------- 诊断等

async function showResolvedConfig(context: vscode.ExtensionContext): Promise<void> {
	const wiki = await resolveConfig(context, { promptForSecrets: false });
	const cfg = wiki.config;
	const redacted = {
		...cfg,
		password: cfg.password ? `***（已获取，长度 ${cfg.password.length}，来源：${cfg.passwordSource}）` : '（无）',
		passwordSource: cfg.passwordSource,
		userAgent: cfg.userAgent,
	};
	const doc = await vscode.workspace.openTextDocument({
		language: 'json',
		content: JSON.stringify(
			{
				说明: '这是 Wiki User Preview 实际生效的配置。密码不会显示明文。',
				站点配置来源: '站点：wikiUserPreview.site → wikitext.host；apiPath：wikiUserPreview.apiPath → wikitext.apiPath；articlePath：wikiUserPreview.articlePath → wikitext.articlePath → wikiparser.articlePath；用户名：wikiUserPreview.username → wikitext.userName → wikiparser.user',
				...redacted,
			},
			null,
			2,
		),
	});
	await vscode.window.showTextDocument(doc, { preview: true });
}

async function loginCommand(context: vscode.ExtensionContext): Promise<void> {
	const wiki = await resolveConfig(context);
	dropSession();
	const current = await getSession(wiki);
	const info = await current.api.getUserInfo();
	void vscode.window.showInformationMessage(
		`已登录：${info.name ?? current.username}（ID ${info.id ?? '?'}）@ ${wiki.config.host}，cookie 数 ${wiki.client.cookieCount}`,
	);
	log(`userinfo: ${JSON.stringify(info)}`);
}

async function logoutCommand(_context: vscode.ExtensionContext): Promise<void> {
	const current = session;
	if (!current) {
		resetSharedClient();
		void vscode.window.showInformationMessage('本地没有登录态；已清除缓存的客户端与 cookie。');
		return;
	}
	try {
		// 必须用当前会话的客户端发请求：换成新客户端就没有会话 cookie 了，
		// 服务端识别不出会话，等于没有注销。
		await current.api.logout();
		void vscode.window.showInformationMessage(`已注销 ${current.canonicalUsername}，并清除本地登录态与 cookie。`);
	} catch (error) {
		log(`登出请求失败：${describeError(error)}`);
		void vscode.window.showWarningMessage(`服务端注销可能未成功（${describeError(error)}），但本地登录态与 cookie 已清除。`);
	} finally {
		dropSession();
		resetSharedClient();
	}
}

async function setPasswordCommand(context: vscode.ExtensionContext): Promise<void> {
	let host = '';
	try {
		const wiki = await resolveConfig(context, { promptForSecrets: false });
		host = wiki.config.host;
	} catch {
		const input = await vscode.window.showInputBox({
			title: 'Wiki User Preview：站点域名',
			prompt: '要把密码绑定到哪个站点？（例如 www.huijiwiki.com）',
			ignoreFocusOut: true,
		});
		host = input?.trim() ?? '';
	}
	if (!host) {
		throw new Error('未提供站点域名，已取消。');
	}
	const password = await vscode.window.showInputBox({
		title: `Wiki User Preview：${host} 的密码`,
		prompt: '如果使用机器人密码，请在这里填 用户名@机器人名 对应的密码',
		password: true,
		ignoreFocusOut: true,
	});
	if (!password) {
		return;
	}
	await context.secrets.store(secretKey(host), password);
	dropSession();
	void vscode.window.showInformationMessage(`已把 ${host} 的密码存入系统钥匙串（不会写入 settings.json）。`);
}

async function clearPasswordCommand(context: vscode.ExtensionContext): Promise<void> {
	let host = '';
	try {
		const wiki = await resolveConfig(context, { promptForSecrets: false });
		host = wiki.config.host;
	} catch {
		// 站点都没配好，那就只删全局密码
	}
	if (host) {
		await context.secrets.delete(secretKey(host));
	}
	await context.secrets.delete('wikiUserPreview.password');
	dropSession();
	void vscode.window.showInformationMessage(host ? `已删除 ${host} 的密码（以及全局密码）。` : '已删除全局密码。');
}

// ------------------------------------------------------------------ 激活

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('Wiki User Preview');
	context.subscriptions.push(output, { dispose: preview.disposePreviewPanel });

	const run = (label: string, task: (ctx: vscode.ExtensionContext) => Promise<void>) => {
		return async () => {
			try {
				await task(context);
			} catch (error) {
				log(`${label} 失败：${describeError(error)}`);
				const action = await vscode.window.showErrorMessage(`Wiki User Preview（${label}）失败：${describeError(error)}`, '查看日志');
				if (action === '查看日志') {
					output.show(true);
				}
			}
		};
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('wikiUserPreview.originalPreview', run('写入并预览', writeAndPreview)),
		vscode.commands.registerCommand(
			'wikiUserPreview.writeOnly',
			run('仅写入用户页', ctx => writeAndPreview(ctx, { openPreview: false })),
		),
		vscode.commands.registerCommand('wikiUserPreview.login', run('登录', loginCommand)),
		vscode.commands.registerCommand('wikiUserPreview.logout', run('退出登录', logoutCommand)),
		vscode.commands.registerCommand('wikiUserPreview.setPassword', run('设置密码', setPasswordCommand)),
		vscode.commands.registerCommand('wikiUserPreview.clearPassword', run('清除密码', clearPasswordCommand)),
		vscode.commands.registerCommand('wikiUserPreview.showResolvedConfig', run('显示配置', showResolvedConfig)),
	);

	// 连接相关设置一旦变更就立刻丢弃已有客户端与会话：否则「关掉跳过 TLS 校验」这类改动
	// 不会对已建立的会话生效，旧连接会继续沿用旧设置。
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			const affected = ['insecureTls', 'requestTimeout', 'userAgent'].filter(key =>
				event.affectsConfiguration(`wikiUserPreview.${key}`),
			);
			if (affected.length > 0) {
				log(`连接相关设置已变更（${affected.join('、')}），丢弃已有客户端与会话`);
				dropSession();
				resetSharedClient();
			}
		}),
	);

	log('Wiki User Preview 已激活');
}

export function deactivate(): void {
	dropSession();
}
