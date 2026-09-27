import { HttpResponse, WikiHttpClient } from './httpClient';

export interface UiField {
	id: string;
	type: string;
	label?: string;
	help?: string;
	name?: string;
	value?: unknown;
	options?: { value: string; label?: string }[];
	required?: boolean;
}

export type UiPrompt = (message: string, fields: UiField[]) => Promise<Record<string, string> | undefined>;

export class MediaWikiError extends Error {
	constructor(
		readonly code: string,
		readonly info: string,
		readonly payload?: unknown,
	) {
		super(`${code}: ${info}`);
		this.name = 'MediaWikiError';
	}
}

export interface LoginResult {
	username: string;
	userId?: number;
	via: 'login' | 'clientlogin';
}

export interface PageRevision {
	revid: number;
	timestamp?: string;
}

export interface EditResult {
	title: string;
	pageid?: number;
	oldrevid?: number;
	newrevid?: number;
	newtimestamp?: string;
}

export interface ParseResult {
	title: string;
	displaytitle?: string;
	text: string;
	categoriesHtml?: string;
	headHtml?: string;
	/** 本次实际解析的版本号，用于校验"看到的确实是刚写入的那一版"。 */
	revid?: number;
}

export interface EditParams {
	title: string;
	text: string;
	summary?: string;
	token: string;
	watchlist?: string;
	minor?: boolean;
	baserevid?: number;
	/**
	 * 基准版本的 ISO 时间戳。和 baserevid 一起发是必要的：按 action=help&modules=edit 的说明，
	 * 只发 baserevid 会让「自己编辑自己」被判成冲突，而 basetimestamp 会让自我冲突被忽略。
	 */
	basetimestamp?: string;
}

function isHtml(body: string): boolean {
	const head = body.slice(0, 400).toLowerCase();
	return head.includes('<!doctype html') || head.includes('<html');
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** 429/503 时最多重试这么多次（含首次尝试）。 */
const MAX_RATE_LIMIT_RETRIES = 4;

export type NoticeHandler = (message: string) => void;

export class MediaWikiApi {
	constructor(
		readonly http: WikiHttpClient,
		readonly apiUrl: string,
		private readonly notice?: NoticeHandler,
	) {}

	private async post(params: Record<string, string | undefined>): Promise<Record<string, unknown>> {
		return this.dispatch('POST', params);
	}

	private async get(params: Record<string, string | undefined>): Promise<Record<string, unknown>> {
		return this.dispatch('GET', params);
	}

	private async dispatch(method: 'GET' | 'POST', params: Record<string, string | undefined>): Promise<Record<string, unknown>> {
		const merged: Record<string, string | undefined> = {
			format: 'json',
			formatversion: '2',
			...params,
		};

		let response: HttpResponse | undefined;
		for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
			response =
				method === 'POST' ? await this.http.request(this.apiUrl, { method: 'POST', form: merged }) : await this.http.request(this.apiUrl, { method: 'GET', query: merged });

			if (response.status !== 429 && response.status !== 503) {
				break;
			}
			if (attempt === MAX_RATE_LIMIT_RETRIES - 1) {
				break;
			}
			// Wikimedia 等站点会返回 Retry-After；没有就指数退避
			const header = response.headers['retry-after'];
			const retryAfter = Number(Array.isArray(header) ? header[0] : header);
			const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20000) : Math.min(1000 * 2 ** attempt, 8000);
			this.notice?.(`站点限流（HTTP ${response.status}），${Math.round(waitMs / 1000)} 秒后重试（第 ${attempt + 1} 次）…`);
			await sleep(waitMs);
		}

		if (!response) {
			throw new Error('请求未产生任何响应');
		}

		if (response.status !== 200) {
			if (isHtml(response.body)) {
				throw new Error(
					`站点返回 HTTP ${response.status} 的 HTML 页面而不是 API 响应。\n` +
						'常见原因：被 Cloudflare / WAF 的人机验证拦截、api.php 路径不对、或站点要求登录后访问。\n' +
						`响应片段：${response.body.replace(/\s+/g, ' ').slice(0, 200)}`,
				);
			}
			throw new Error(`HTTP ${response.status}：${response.body.slice(0, 300)}`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(response.body);
		} catch {
			throw new Error(
				`API 返回的不是 JSON（可能是 Cloudflare 人机验证页或 api.php 路径错误）。\n` + `响应片段：${response.body.replace(/\s+/g, ' ').slice(0, 200)}`,
			);
		}
		const data = parsed as Record<string, unknown>;

		const error = data['error'] as { code?: string; info?: string } | undefined;
		if (error) {
			throw new MediaWikiError(error.code ?? 'unknown', error.info ?? '未知错误', data);
		}
		const errors = data['errors'] as { code?: string; text?: string; html?: string }[] | undefined;
		if (Array.isArray(errors) && errors.length > 0) {
			const first = errors[0]!;
			throw new MediaWikiError(first.code ?? 'unknown', first.text ?? first.html ?? '未知错误', data);
		}
		return data;
	}

	// ---------------------------------------------------------------- tokens

	async getToken(type: 'login' | 'csrf'): Promise<string> {
		const data = await this.get({ action: 'query', meta: 'tokens', type });
		const tokens = (data['query'] as { tokens?: Record<string, string> } | undefined)?.tokens;
		const token = tokens?.[`${type}token`];
		if (!token) {
			throw new Error(`未能获取 ${type} token，返回内容：${JSON.stringify(data).slice(0, 300)}`);
		}
		return token;
	}

	// ----------------------------------------------------------------- login

	/** action=login：只为机器人密码（Special:BotPasswords 生成的 `用户名@机器人名`）设计。 */
	async loginBotPassword(username: string, password: string): Promise<LoginResult> {
		const lgtoken = await this.getToken('login');
		const data = await this.post({
			action: 'login',
			lgname: username,
			lgpassword: password,
			lgtoken,
		});
		const login = data['login'] as { result?: string; lgusername?: string; lguserid?: number; reason?: string; message?: string } | undefined;
		const result = login?.result ?? 'Unknown';
		if (result !== 'Success') {
			const detail = login?.reason ?? login?.message ?? result;
			if (result === 'Aborted' || result === 'WrongPass' || result === 'Failed') {
				throw new MediaWikiError(result, `action=login 失败：${detail}`);
			}
			throw new MediaWikiError(result, `action=login 返回了未预期的结果：${detail}`);
		}
		const out: LoginResult = { username: login?.lgusername ?? username, via: 'login' };
		if (login?.lguserid !== undefined) {
			out.userId = login.lguserid;
		}
		return out;
	}

	/**
	 * action=clientlogin：主账号密码的唯一正规途径。
	 * 站点可能返回 status=UI 索要额外信息（两步验证、验证码等），此时交给 prompt 回调补全。
	 */
	async clientLogin(username: string, password: string, prompt?: UiPrompt, loginReturnUrl?: string): Promise<LoginResult> {
		const logintoken = await this.getToken('login');
		const base: Record<string, string | undefined> = {
			action: 'clientlogin',
			username,
			password,
			logintoken,
			loginreturnurl: loginReturnUrl ?? `${this.apiUrl}?action=query&meta=userinfo`,
		};

		for (let round = 0; round < 6; round++) {
			const data = await this.post(base);
			const clientlogin = data['clientlogin'] as
				| { status?: string; username?: string; message?: string; messagecode?: string; requests?: UiField[] }
				| undefined;
			const status = clientlogin?.status ?? 'Unknown';

			if (status === 'PASS') {
				const out: LoginResult = { username: clientlogin?.username ?? username, via: 'clientlogin' };
				return out;
			}
			if (status === 'FAIL') {
				throw new MediaWikiError(clientlogin?.messagecode ?? 'clientlogin-fail', `action=clientlogin 失败：${clientlogin?.message ?? '未知原因'}`);
			}
			if (status === 'REDIRECT') {
				throw new MediaWikiError('clientlogin-redirect', '站点要求跳转到 Special:UserLogin 完成登录，无法在扩展内完成。请改用机器人密码。');
			}
			if (status === 'UI') {
				const requests = (clientlogin?.requests ?? []).filter(field => field.type !== 'hidden');
				if (requests.length === 0) {
					throw new MediaWikiError('clientlogin-ui', `站点要求补充信息但没有给出可填写的字段：${clientlogin?.message ?? ''}`);
				}
				if (!prompt) {
					throw new MediaWikiError('clientlogin-ui-unsupported', `站点要求两步验证或验证码（${requests.map(r => r.label ?? r.id).join('、')}），但当前环境无法交互输入。`);
				}
				const answers = await prompt(clientlogin?.message ?? '需要补充登录信息', requests);
				if (!answers) {
					throw new Error('已取消登录。');
				}
				for (const field of requests) {
					const answer = answers[field.id];
					if (answer === undefined) {
						continue;
					}
					if (field.type === 'button') {
						base[field.name ?? field.id] = answer;
					} else if (field.type === 'checkbox') {
						if (answer === 'true') {
							base[field.id] = '';
						} else {
							delete base[field.id];
						}
					} else {
						base[field.id] = answer;
					}
				}
				continue;
			}
			throw new MediaWikiError(status, `action=clientlogin 返回了未预期的状态：${JSON.stringify(clientlogin).slice(0, 300)}`);
		}
		throw new Error('登录补充信息的次数过多，已放弃。');
	}

	// --------------------------------------------------------------- account

	async getUserInfo(): Promise<{ name?: string; id?: number; anonymous: boolean }> {
		const data = await this.get({ action: 'query', meta: 'userinfo', uiprop: 'groups|rights' });
		const userinfo = (data['query'] as { userinfo?: { name?: string; id?: number; anon?: boolean } } | undefined)?.userinfo;
		return { name: userinfo?.name, id: userinfo?.id, anonymous: userinfo?.anon === true };
	}

	async logout(): Promise<void> {
		try {
			const token = await this.getToken('csrf');
			await this.post({ action: 'logout', token });
		} finally {
			this.http.clearCookies();
		}
	}

	// ------------------------------------------------------------------ page

	async getPageRevision(title: string): Promise<PageRevision | undefined> {
		const data = await this.get({
			action: 'query',
			prop: 'revisions',
			rvprop: 'ids|timestamp',
			titles: title,
			redirects: '1',
		});
		const pages = (data['query'] as { pages?: { missing?: boolean; revisions?: { revid?: number; timestamp?: string }[] }[] } | undefined)?.pages;
		const page = pages?.[0];
		if (!page || page.missing) {
			return undefined;
		}
		const revision = page.revisions?.[0];
		if (!revision?.revid) {
			return undefined;
		}
		const out: PageRevision = { revid: revision.revid };
		if (revision.timestamp !== undefined) {
			out.timestamp = revision.timestamp;
		}
		return out;
	}

	async edit(params: EditParams): Promise<EditResult> {
		const data = await this.post({
			action: 'edit',
			title: params.title,
			text: params.text,
			summary: params.summary,
			token: params.token,
			watchlist: params.watchlist,
			minor: params.minor ? '1' : undefined,
			baserevid: params.baserevid !== undefined ? String(params.baserevid) : undefined,
			basetimestamp: params.basetimestamp,
			starttimestamp: new Date().toISOString(),
			assert: 'user',
			errorformat: 'plaintext',
			erroruselocal: '1',
		});
		const edit = data['edit'] as { result?: string; pageid?: number; title?: string; oldrevid?: number; newrevid?: number; newtimestamp?: string } | undefined;
		if (edit?.result !== 'Success') {
			throw new MediaWikiError('edit-unknown', `保存返回了未预期的结果：${JSON.stringify(edit).slice(0, 300)}`);
		}
		const out: EditResult = { title: edit.title ?? params.title };
		if (edit.pageid !== undefined) {
			out.pageid = edit.pageid;
		}
		if (edit.oldrevid !== undefined) {
			out.oldrevid = edit.oldrevid;
		}
		if (edit.newrevid !== undefined) {
			out.newrevid = edit.newrevid;
		}
		if (edit.newtimestamp !== undefined) {
			out.newtimestamp = edit.newtimestamp;
		}
		return out;
	}

	async parsePage(title: string, options: { getCss: boolean; revid?: number } = { getCss: true }): Promise<ParseResult> {
		const props = ['text', 'displaytitle', 'categorieshtml', 'revid'];
		if (options.getCss) {
			props.push('headhtml');
		}
		const attempt = async (list: string[]): Promise<ParseResult> => {
			const data = await this.post({
				action: 'parse',
				// oldid 会覆盖 page/pageid，把解析钉死在指定版本上——这是"预览总是旧版"的根治办法
				...(options.revid !== undefined ? { oldid: String(options.revid) } : { page: title }),
				prop: list.join('|'),
				redirects: '1',
				disableeditsection: '1',
				disablelimitreport: '1',
			});
			const parse = data['parse'] as
				| { title?: string; displaytitle?: string; text?: string; categorieshtml?: string; headhtml?: string; revid?: number }
				| undefined;
			if (!parse) {
				throw new Error(`解析页面失败：${JSON.stringify(data).slice(0, 300)}`);
			}
			const out: ParseResult = { title: parse.title ?? title, text: parse.text ?? '' };
			if (parse.displaytitle !== undefined) {
				out.displaytitle = parse.displaytitle;
			}
			if (parse.categorieshtml !== undefined) {
				out.categoriesHtml = parse.categorieshtml;
			}
			if (parse.headhtml !== undefined) {
				out.headHtml = parse.headhtml;
			}
			if (parse.revid !== undefined) {
				out.revid = parse.revid;
			}
			return out;
		};

		try {
			return await attempt(props);
		} catch (error) {
			// 老站点可能不认识 headhtml，降级重试
			if (error instanceof MediaWikiError && options.getCss) {
				return await attempt(['text', 'displaytitle', 'categorieshtml', 'revid']);
			}
			throw error;
		}
	}

	/**
	 * action=purge：清掉服务端解析缓存，并在站点配置了 CDN 时一并发出清除请求。
	 * 页面编辑本身会刷新解析缓存，但 Cloudflare 之类的边缘缓存不一定跟着失效。
	 */
	async purgePage(title: string, token: string): Promise<void> {
		await this.post({
			action: 'purge',
			titles: title,
			token,
		});
	}
}
