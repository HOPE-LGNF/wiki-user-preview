import * as http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * 本地假 MediaWiki，用于离线测试登录 / 编辑 / 解析流程。
 *
 * 之所以需要它：以前的冒烟测试会向真实站点（www.mediawiki.org）发一次**失败的登录尝试**
 * 来验证报错映射。那是写操作，会在第三方日志里留下失败记录，也不该由测试去触发。
 * 现在改成打本地服务器，测试全程离线，且可以精确构造 UI / 错误等响应。
 */
export interface RecordedRequest {
	method: string;
	path: string;
	host?: string;
	cookie?: string;
	params: URLSearchParams;
}

export type ClientLoginStep =
	| { status: 'UI'; requests: unknown[] }
	| { status: 'PASS'; username: string }
	| { status: 'FAIL'; message: string; messagecode?: string }
	| { status: 'RESTART' };

export interface FakeWiki {
	origin: string;
	apiUrl: string;
	/** 按到达顺序记录的全部请求 */
	requests: RecordedRequest[];
	/** 下一次请求若命中则回 307，用于测试跨主机跳转 */
	setRedirectOnce(location: string): void;
	setLoginResult(result: string, reason?: string): void;
	setClientLoginScript(steps: ClientLoginStep[]): void;
	/** 服务端确认的账号名；登录成功后会出现在 meta=userinfo 里 */
	setCanonicalUsername(name: string): void;
	/** 模拟私有 wiki：未带会话 cookie 的 action=parse 会被拒绝 */
	setRequireLoginForRead(value: boolean): void;
	close(): Promise<void>;
}

function json(res: http.ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
	// 每个响应都种一个会话 cookie：这样测试才能断言「cookie 有没有流到别的服务器」
	res.writeHead(200, {
		'Content-Type': 'application/json',
		'Set-Cookie': 'session=FAKE-SESSION-SECRET; Path=/',
		...headers,
	});
	res.end(JSON.stringify(body));
}

export async function startFakeWiki(hostname = '127.0.0.1', port = 0): Promise<FakeWiki> {
	const requests: RecordedRequest[] = [];
	let redirectOnce: string | undefined;
	let loginResult = 'Success';
	let loginReason: string | undefined;
	let clientLoginScript: ClientLoginStep[] = [];
	let canonicalUsername = 'Alice';
	let loggedIn = false;
	let requireLoginForRead = false;

	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => {
			body += chunk;
		});
		req.on('end', () => {
			const params = new URLSearchParams(body);
			const url = new URL(req.url ?? '/', `http://${hostname}`);
			for (const [key, value] of url.searchParams) {
				params.append(key, value);
			}
			requests.push({
				method: req.method ?? 'GET',
				path: url.pathname,
				host: req.headers.host,
				cookie: req.headers.cookie,
				params,
			});

			if (redirectOnce) {
				const location = redirectOnce;
				redirectOnce = undefined;
				res.writeHead(307, { Location: location });
				res.end();
				return;
			}

			const action = params.get('action');
			const meta = params.get('meta');
			const type = params.get('type');

			if (action === 'query' && meta === 'tokens') {
				json(res, { query: { tokens: type === 'login' ? { logintoken: 'LOGIN+\\' } : { csrftoken: 'CSRF+\\' } } });
				return;
			}
			if (action === 'query' && meta === 'userinfo') {
				json(res, { query: { userinfo: loggedIn ? { id: 1, name: canonicalUsername } : { id: 0, name: '127.0.0.1', anon: true } } });
				return;
			}
			if (action === 'query' && params.get('prop') === 'revisions') {
				json(res, { query: { pages: [{ pageid: 1, title: params.get('titles'), revisions: [{ revid: 100, timestamp: '2026-01-01T00:00:00Z' }] }] } });
				return;
			}
			if (action === 'login') {
				if (loginResult === 'Success') {
					loggedIn = true;
					json(res, { login: { result: 'Success', lgusername: params.get('lgname'), lguserid: 1 } });
				} else {
					json(res, { login: { result: loginResult, reason: loginReason ?? 'nope' } });
				}
				return;
			}
			if (action === 'clientlogin') {
				const step = clientLoginScript.shift();
				if (!step) {
					json(res, { clientlogin: { status: 'FAIL', message: '脚本已用尽', messagecode: 'script-exhausted' } });
					return;
				}
				if (step.status === 'PASS') {
					loggedIn = true;
					json(res, { clientlogin: { status: 'PASS', username: step.username } });
					return;
				}
				if (step.status === 'FAIL') {
					json(res, { clientlogin: { status: 'FAIL', message: step.message, messagecode: step.messagecode ?? 'fail' } });
					return;
				}
				if (step.status === 'RESTART') {
					json(res, { clientlogin: { status: 'RESTART', message: 'no linked account' } });
					return;
				}
				json(res, { clientlogin: { status: 'UI', message: '需要两步验证', requests: step.requests } });
				return;
			}
			if (action === 'parse') {
				if (requireLoginForRead && !req.headers.cookie) {
					json(res, { error: { code: 'notloggedin', info: '私有 wiki：需要登录才能读取页面' } });
					return;
				}
				const oldid = params.get('oldid');
				json(res, { parse: { title: params.get('page') ?? 'Test', text: '<p>ok</p>', revid: oldid ? Number(oldid) : 100 } });
				return;
			}
			if (action === 'edit') {
				json(res, {
					edit: {
						result: 'Success',
						title: params.get('title'),
						pageid: 1,
						oldrevid: 100,
						newrevid: 101,
						newtimestamp: '2026-01-02T00:00:00Z',
					},
				});
				return;
			}
			if (action === 'purge') {
				json(res, { purge: [{ title: params.get('titles'), purged: true }] });
				return;
			}
			if (action === 'logout') {
				loggedIn = false;
				json(res, {});
				return;
			}
			json(res, { error: { code: 'unknown_action', info: `未处理的 action=${action}` } });
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, hostname, () => resolve());
	});
	const actualPort = (server.address() as AddressInfo).port;
	const origin = `http://${hostname}:${actualPort}`;

	return {
		origin,
		apiUrl: `${origin}/api.php`,
		requests,
		setRedirectOnce(location) {
			redirectOnce = location;
		},
		setLoginResult(result, reason) {
			loginResult = result;
			loginReason = reason;
		},
		setClientLoginScript(steps) {
			clientLoginScript = [...steps];
		},
		setCanonicalUsername(name) {
			canonicalUsername = name;
		},
		setRequireLoginForRead(value) {
			requireLoginForRead = value;
		},
		close() {
			return new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

/** 一个纯粹的「接收方」服务器，用来观察凭据是否流到了别处。 */
export async function startCollector(hostname = '127.0.0.1'): Promise<{ origin: string; received: RecordedRequest[]; close(): Promise<void> }> {
	const received: RecordedRequest[] = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => {
			body += chunk;
		});
		req.on('end', () => {
			received.push({
				method: req.method ?? 'GET',
				path: req.url ?? '/',
				host: req.headers.host,
				cookie: req.headers.cookie,
				params: new URLSearchParams(body),
			});
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"ok":true}');
		});
	});
	await new Promise<void>(resolve => server.listen(0, hostname, () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return {
		origin: `http://${hostname}:${port}`,
		received,
		close() {
			return new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}
