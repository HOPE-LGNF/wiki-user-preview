import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import { URL } from 'node:url';

export interface HttpResponse {
	status: number;
	location?: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

export interface RequestOptions {
	method?: 'GET' | 'POST';
	query?: Record<string, string | undefined>;
	form?: Record<string, string | undefined>;
	accept?: string;
}

export class HttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
		this.name = 'HttpError';
	}
}

function encode(params: Record<string, string | undefined>): string {
	const usp = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			usp.append(key, value);
		}
	}
	return usp.toString();
}

function decompress(buffer: Buffer, encoding: string | undefined): Buffer {
	switch ((encoding ?? '').toLowerCase()) {
		case 'gzip':
		case 'x-gzip':
			return zlib.gunzipSync(buffer);
		case 'deflate':
			try {
				return zlib.inflateSync(buffer);
			} catch {
				return zlib.inflateRawSync(buffer);
			}
		case 'br':
			return zlib.brotliDecompressSync(buffer);
		default:
			return buffer;
	}
}

const REDIRECT_CODES = [301, 302, 303, 307, 308];

/**
 * HTTP/1.1 头字段值必须落在 ASCII 范围内。Node 的 checkInvalidHeaderChar 遇到非 ASCII
 * 会在请求发出前就抛 ERR_INVALID_CHAR(["User-Agent"])，而 User-Agent 里携带的联系方式
 * 来自用户配置（`wikiparser.user` 可以是任意字符串，实际见过填中文的），所以统一把非
 * ASCII 字符按 UTF-8 百分号编码，保证请求一定能发出去。
 */
export function sanitizeHeaderValue(value: string): string {
	if (/^[\t\x20-\x7e]*$/.test(value)) {
		return value;
	}
	let out = '';
	for (const char of value) {
		if (/[\t\x20-\x7e]/.test(char)) {
			out += char;
			continue;
		}
		for (const byte of Buffer.from(char, 'utf8')) {
			out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
	}
	return out;
}

/**
 * 极简 HTTP 客户端：手工维护 cookie jar 并跟随重定向。
 * 不依赖 fetch 的原因：Node 内置 fetch 不会保存 cookie，而 MediaWiki 的登录态完全靠 cookie 维持。
 * 不依赖第三方库的原因：扩展宿主里越少依赖越不容易在打包/远程场景出问题。
 *
 * **只与一个主机通信。** `allowedHost` 之外的目标一律拒绝，包括重定向目标——
 * 否则站点只要回一个 307，就能把会话 cookie 和登录表单（或待上传正文）转交给另一个主机。
 * 同理，cookie jar 也只服务这一个主机。
 */
export class WikiHttpClient {
	/** name -> value。只服务单站点，不需要按 domain 分桶。 */
	private readonly cookies = new Map<string, string>();

	/** 允许通信的主机（小写、不含端口）与协议。未设置时拒绝任何请求。 */
	private allowedHost?: string;
	private allowedScheme?: string;

	constructor(
		private readonly userAgent: string,
		private readonly timeoutMs: number,
		private readonly insecureTls: boolean,
	) {}

	/**
	 * 设定唯一允许通信的主机（以及配置时的协议）。换主机时清空 cookie jar——
	 * 否则上一个站点的会话 cookie 会被带到新站点去。
	 */
	setHost(host: string, scheme?: string): void {
		// scheme 可能传成 'https://' / 'https:' / 'https'，统一成 'https:' 形式。
		// 注意不能用 replace(/:+$/, '')——对 'https://' 它什么也去不掉。
		const bareScheme = scheme?.trim().replace(/\/+$/, '').split(':')[0];
		const normalisedScheme = bareScheme ? `${bareScheme.toLowerCase()}:` : undefined;

		// 必须与 URL.host 口径一致：走一遍 URL 解析，默认端口会被去掉、显式端口会保留
		// （'127.0.0.1:8080' 要保持带端口，而 'wiki.example:443' + https 会归一成
		// 'wiki.example'）。否则和 assertAllowed 里的 target.host 比对时必然对不上，
		// 任何使用非默认端口的站点都会被自己的白名单挡掉。
		let normalisedHost = host.trim().toLowerCase();
		if (normalisedScheme) {
			try {
				normalisedHost = new URL(`${normalisedScheme}//${normalisedHost}`).host.toLowerCase();
			} catch {
				// 解析不了就按原样比较，后面 assertAllowed 会给出明确错误
			}
		}

		if (this.allowedHost === normalisedHost && this.allowedScheme === normalisedScheme) {
			return;
		}
		this.cookies.clear();
		this.allowedHost = normalisedHost;
		this.allowedScheme = normalisedScheme;
	}

	get host(): string | undefined {
		return this.allowedHost;
	}

	get cookieHeader(): string | undefined {
		if (this.cookies.size === 0) {
			return undefined;
		}
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
	}

	get cookieCount(): number {
		return this.cookies.size;
	}

	clearCookies(): void {
		this.cookies.clear();
	}

	/**
	 * 请求前的最后一道闸：主机必须是唯一被授权的那个，且不允许 https→http 降级。
	 * 抛错发生在建立连接之前，所以 Cookie、密码表单和待上传正文都不会被发出去。
	 * 同主机的 http→https 升级（MediaWiki 常见）仍然允许。
	 */
	private assertAllowed(target: URL): void {
		if (!this.allowedHost) {
			throw new Error('内部错误：尚未为该客户端设定允许通信的主机');
		}
		const hostname = target.host.toLowerCase();
		if (hostname !== this.allowedHost) {
			throw new Error(
				`出于凭据安全，已拒绝向 ${hostname} 发送请求——本客户端只被授权与 ${this.allowedHost} 通信。` +
					`常见原因：站点配置里的 apiPath / articlePath 指向了别的主机，或站点把请求重定向到了别的主机。`,
			);
		}
		if (this.allowedScheme === 'https:' && target.protocol === 'http:') {
			throw new Error(`出于凭据安全，已拒绝从 https 降级到 http 的请求（${target.host}）。`);
		}
	}

	private captureCookies(raw: string[] | undefined): void {
		for (const line of raw ?? []) {
			const first = line.split(';')[0] ?? '';
			const eq = first.indexOf('=');
			if (eq <= 0) {
				continue;
			}
			const name = first.slice(0, eq).trim();
			const value = first.slice(eq + 1).trim();
			const lower = line.toLowerCase();
			if (value === '' || lower.includes('max-age=0') || lower.includes('expires=thu, 01 jan 1970')) {
				this.cookies.delete(name);
			} else {
				this.cookies.set(name, value);
			}
		}
	}

	private send(
		target: URL,
		method: 'GET' | 'POST',
		headers: Record<string, string>,
		payload: string | undefined,
		redirectsLeft: number,
	): Promise<HttpResponse> {
		// 这里是唯一的出口：首次请求和每一次重定向都经过它，所以主机白名单无法被绕过。
		// 校验在建立连接之前完成，Cookie / 密码表单 / 待上传正文都不会离开本机。
		// 注意要返回 rejected promise 而不是同步抛出——重定向是在 'end' 回调里发起的，
		// 在那里同步抛错会变成未捕获异常。
		try {
			this.assertAllowed(target);
		} catch (error) {
			return Promise.reject(error);
		}
		return new Promise<HttpResponse>((resolve, reject) => {
			const transport = target.protocol === 'https:' ? https : http;
			const request = transport.request(
				{
					protocol: target.protocol,
					hostname: target.hostname,
					port: target.port || undefined,
					path: `${target.pathname}${target.search}`,
					method,
					headers,
					rejectUnauthorized: !this.insecureTls,
				},
				response => {
					this.captureCookies(response.headers['set-cookie']);
					const chunks: Buffer[] = [];
					response.on('data', (chunk: Buffer) => chunks.push(chunk));
					response.on('error', reject);
					response.on('end', () => {
						const raw = Buffer.concat(chunks);
						let body: string;
						try {
							body = decompress(raw, response.headers['content-encoding']).toString('utf8');
						} catch {
							body = raw.toString('utf8');
						}
						const status = response.statusCode ?? 0;
						const location = response.headers.location;

						if (REDIRECT_CODES.includes(status) && location) {
							if (redirectsLeft <= 0) {
								reject(new Error('重定向次数过多'));
								return;
							}
							let next: URL;
							try {
								next = new URL(location, target);
							} catch {
								reject(new Error(`无法解析重定向地址：${location}`));
								return;
							}
							// 303、以及历史上的 301/302 都会把 POST 降级为 GET
							const downgrade = status === 303 || ((status === 301 || status === 302) && method === 'POST');
							const nextHeaders: Record<string, string> = { ...headers, Host: next.host };
							delete nextHeaders['Content-Length'];
							delete nextHeaders['Content-Type'];
							this.send(next, downgrade ? 'GET' : method, nextHeaders, downgrade ? undefined : payload, redirectsLeft - 1)
								.then(resolve, reject);
							return;
						}

						const result: HttpResponse = { status, headers: response.headers, body };
						if (location !== undefined) {
							result.location = location;
						}
						resolve(result);
					});
				},
			);
			request.setTimeout(this.timeoutMs, () => {
				request.destroy(new Error(`请求超时（${this.timeoutMs}ms）：${target.href}`));
			});
			request.on('error', reject);
			if (payload !== undefined) {
				request.write(payload);
			}
			request.end();
		});
	}

	async request(rawUrl: string, options: RequestOptions = {}): Promise<HttpResponse> {
		const target = new URL(rawUrl);
		const query = options.query ? encode(options.query) : '';
		if (query) {
			target.search = target.search ? `${target.search}&${query}` : `?${query}`;
		}

		const method = options.method ?? 'GET';
		const payload = options.form ? encode(options.form) : undefined;

		const headers: Record<string, string> = {
			'User-Agent': this.userAgent,
			Accept: options.accept ?? 'application/json, text/plain, */*',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
			'Accept-Encoding': 'gzip, deflate, br',
			Host: target.host,
			Connection: 'close',
		};
		const cookie = this.cookieHeader;
		if (cookie) {
			headers.Cookie = cookie;
		}
		if (payload !== undefined) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
			headers['Content-Length'] = String(Buffer.byteLength(payload));
		}

		// 最后一道防线：任何来源的头值都不允许含非 ASCII，否则 Node 会在发请求前抛错。
		for (const [name, value] of Object.entries(headers)) {
			headers[name] = sanitizeHeaderValue(value);
		}

		return this.send(target, method, headers, payload, 5);
	}
}
