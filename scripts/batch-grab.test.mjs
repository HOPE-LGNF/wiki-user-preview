import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { collectTitles, createClient, fileNameFor, pageInfoHead, run } from './batch-grab.mjs';

const silent = () => {};

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'batch-grab-'));
}

/** 造一个页面对象，形状与 formatversion=2 + rvslots=main 的真实响应一致。 */
function page(title, { revid = 123, model = 'wikitext', content = '正文', missing = false } = {}) {
	if (missing) {
		return { title, missing: true };
	}
	return {
		pageid: revid,
		ns: title.includes(':') ? 828 : 0,
		title,
		revisions: [{ revid, timestamp: '2026-01-01T00:00:00Z', slots: { main: { contentmodel: model, contentformat: 'text/x-wiki', content } } }],
	};
}

test('文件名：命名空间与子页面分隔符的处理', () => {
	// dash（默认）平铺
	assert.equal(fileNameFor('模块:实体/信息框', 'Scribunto', 'dash'), '模块_实体_信息框.lua');
	assert.equal(fileNameFor('模板:沙盒/doc', 'wikitext', 'dash'), '模板_沙盒_doc.wikitext');
	assert.equal(fileNameFor('建筑', 'wikitext', 'dash'), '建筑.wikitext');
	// raw 保留子页面层级，但仍换掉 Windows 非法的 ":"
	assert.equal(fileNameFor('模块:建筑/Base/分类', 'Scribunto', 'raw'), '模块_建筑/Base/分类.lua');
	// 扩展名随内容模型走
	assert.equal(fileNameFor('A', 'json', 'dash'), 'A.json');
	assert.equal(fileNameFor('A', 'sanitized-css', 'dash'), 'A.css');
	assert.equal(fileNameFor('A', 'javascript', 'dash'), 'A.js');
	assert.equal(fileNameFor('A', '未知模型', 'dash'), 'A.wikitext');
	// Windows 非法字符
	assert.equal(fileNameFor('A:B?C*D', 'wikitext', 'dash'), 'A_B_C_D.wikitext');
});

test('PAGE_INFO 头：与 Wikitext 期望的格式一致', () => {
	const head = pageInfoHead({ title: '模块:实体/信息框', pageid: 2085, revid: 12586, contentModel: 'Scribunto', contentFormat: 'text/plain' });
	const lines = head.split('\n');
	assert.equal(lines[0], '<%-- [PAGE_INFO]');
	assert.equal(lines.at(-1), '[END_PAGE_INFO] --%>');
	// Wikitext 的解析正则是 (?<=<%--\s*\[PAGE_INFO\])…(?=\[END_PAGE_INFO\]\s*--%>)，两端必须精确
	assert.match(head, /<%-- \[PAGE_INFO\]\n[\s\S]*\n\[END_PAGE_INFO\] --%>/);
	// 字段用 #…# 包裹
	assert.ok(head.includes('    pageTitle = #模块:实体/信息框#'));
	assert.ok(head.includes('    pageID = #2085#'));
	assert.ok(head.includes('    revisionID = #12586#'));
	assert.ok(head.includes('    contentModel = #Scribunto#'));
	assert.ok(head.includes('    contentFormat = #text/plain#'));
	assert.ok(head.includes('comment = #Please do not remove this struct'));
	// 值缺失时给空值，而不是 "undefined"
	const bare = pageInfoHead({ title: 'X' });
	assert.ok(bare.includes('    pageID = ##'), bare);
	assert.ok(!bare.includes('undefined'));
});

test('批量抓取：合并请求、按内容模型落盘、带 PAGE_INFO', async () => {
	const out = tempDir();
	const calls = [];
	const fakeApi = async params => {
		calls.push(params);
		const titles = params.titles.split('|');
		return { query: { pages: titles.map((t, i) => page(t, { revid: 100 + i, model: t.startsWith('模块:') ? 'Scribunto' : 'wikitext', content: `正文 ${t}` })) } };
	};

	const result = await run(
		{ out, batch: 2, delay: 0, pageInfo: true, nameStyle: 'dash', overwrite: false, quiet: true, dryRun: false, pages: ['建筑', '模块:实体/信息框', '模板:沙盒/doc'] },
		fakeApi,
		silent,
	);

	assert.equal(result.written, 3);
	assert.equal(result.skipped, 0);
	assert.deepEqual(result.failed, []);
	// batch=2 + 3 个标题 → 两次请求
	assert.equal(calls.length, 2, '应当按 --batch 合并请求');
	assert.equal(calls[0].action, 'query');
	assert.equal(calls[0].rvslots, 'main');
	assert.equal(calls[0].rvprop, 'content|ids|timestamp');

	const lua = fs.readFileSync(path.join(out, '模块_实体_信息框.lua'), 'utf8');
	assert.ok(lua.startsWith('<%-- [PAGE_INFO]'), '应带 PAGE_INFO 头');
	assert.match(lua, /revisionID = #10\d#/, '应写入该页自己的 revid');
	assert.ok(lua.includes('正文 模块:实体/信息框'));
});

test('--no-page-info 时只写纯源码', async () => {
	const out = tempDir();
	const fakeApi = async () => ({ query: { pages: [page('建筑', { content: '{{模板}}' })] } });
	await run({ out, batch: 20, delay: 0, pageInfo: false, nameStyle: 'dash', overwrite: false, quiet: true, dryRun: false, pages: ['建筑'] }, fakeApi, silent);
	assert.equal(fs.readFileSync(path.join(out, '建筑.wikitext'), 'utf8'), '{{模板}}');
});

test('已存在则跳过，--overwrite 才覆盖', async () => {
	const out = tempDir();
	fs.mkdirSync(out, { recursive: true });
	fs.writeFileSync(path.join(out, '建筑.wikitext'), '旧内容', 'utf8');
	const fakeApi = async () => ({ query: { pages: [page('建筑', { content: '新内容' })] } });
	const base = { out, batch: 20, delay: 0, pageInfo: false, nameStyle: 'dash', quiet: true, dryRun: false, pages: ['建筑'] };

	const skipped = await run({ ...base, overwrite: false }, fakeApi, silent);
	assert.equal(skipped.skipped, 1);
	assert.equal(skipped.written, 0);
	assert.equal(fs.readFileSync(path.join(out, '建筑.wikitext'), 'utf8'), '旧内容', '默认不应覆盖');

	const forced = await run({ ...base, overwrite: true }, fakeApi, silent);
	assert.equal(forced.written, 1);
	assert.equal(fs.readFileSync(path.join(out, '建筑.wikitext'), 'utf8'), '新内容');
});

test('--dry-run 不请求也不写文件', async () => {
	const out = tempDir();
	let called = false;
	const fakeApi = async () => {
		called = true;
		return { query: { pages: [] } };
	};
	const fakeApiWithList = async params => {
		if (params.list) {
			return { query: { allpages: [{ title: 'A' }, { title: 'B' }] } };
		}
		return fakeApi(params);
	};
	const result = await run({ out, batch: 20, delay: 0, pageInfo: true, nameStyle: 'dash', overwrite: false, quiet: true, dryRun: true, prefix: 'X' }, fakeApiWithList, silent);
	assert.equal(result.planned, 2, 'dry-run 应报告计划导出的页面数');
	assert.equal(result.written, 0, 'dry-run 不应写入');
	assert.equal(called, false, 'dry-run 不应请求页面内容');
	assert.deepEqual(fs.readdirSync(out), [], 'dry-run 不应写入任何文件');
});

test('页面不存在 / 未返回正文 会被如实报告，不静默跳过', async () => {
	const out = tempDir();
	const fakeApi = async params => {
		const titles = params.titles.split('|');
		return {
			query: {
				pages: titles.map(t => (t === '不存在' ? page(t, { missing: true }) : { title: t, pageid: 1, revisions: [{ revid: 1, slots: { main: { contentmodel: 'wikitext' } } }] })),
			},
		};
	};
	const result = await run({ out, batch: 20, delay: 0, pageInfo: true, nameStyle: 'dash', overwrite: false, quiet: true, dryRun: false, pages: ['不存在', '无正文'] }, fakeApi, silent);
	assert.equal(result.failed.length, 2);
	assert.ok(result.failed.some(f => f.includes('不存在') && f.includes('页面不存在')));
	assert.ok(result.failed.some(f => f.includes('未返回正文')));
});

test('整批失败会逐条重试，坏标题不牵连整批', async () => {
	const out = tempDir();
	let batchAttempts = 0;
	const fakeApi = async params => {
		const titles = params.titles.split('|');
		if (titles.length > 1) {
			batchAttempts += 1;
			throw new Error('titles 参数无效');
		}
		return { query: { pages: [page(titles[0], { content: 'ok' })] } };
	};
	const result = await run({ out, batch: 5, delay: 0, pageInfo: false, nameStyle: 'dash', overwrite: false, quiet: true, dryRun: false, pages: ['A', 'B'] }, fakeApi, silent);
	assert.equal(batchAttempts, 1, '先试整批');
	assert.equal(result.written, 2, '然后逐条成功');
	assert.deepEqual(result.failed, []);
});

test('collectTitles：--file 读标题，# 开头的行忽略', async () => {
	const dir = tempDir();
	const file = path.join(dir, 'titles.txt');
	fs.writeFileSync(file, '# 注释\n建筑\n\n模块:实体/信息框\n', 'utf8');
	const titles = await collectTitles({ file, pages: ['额外的'] }, async () => ({ query: {} }));
	assert.deepEqual(titles.sort(), ['建筑', '模块:实体/信息框', '额外的'].sort());
});

test('list 类接口的分页续抓（continue）', async () => {
	const seen = [];
	const fakeApi = async params => {
		seen.push(params);
		if (!params.apcontinue) {
			return { query: { allpages: [{ title: 'A' }] }, continue: { apcontinue: 'B' } };
		}
		return { query: { allpages: [{ title: 'B' }] } };
	};
	const titles = await collectTitles({ prefix: 'X' }, fakeApi);
	assert.deepEqual(titles, ['A', 'B']);
	assert.equal(seen.length, 2);
});

test('createClient：URL 参数、UA、错误处理', async () => {
	const requests = [];
	const server = http.createServer((req, res) => {
		requests.push({ url: req.url, ua: req.headers['user-agent'] });
		if (req.url.includes('titles=%E5%9D%8F%E9%A1%B5')) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { code: 'missingtitle', info: '不存在的页面' } }));
			return;
		}
		if (req.url.includes('boom=1')) {
			res.writeHead(403, { 'Content-Type': 'text/html' });
			res.end('<title>请稍候…</title>');
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ query: { pages: [] } }));
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;

	try {
		const api = createClient({ scheme: 'http://', site: `127.0.0.1:${port}`, apiPath: '/api.php', ua: 'batch-test/9.9' });
		await api({ action: 'query', titles: '建筑|模块:实体/信息框' });
		const first = requests.at(-1);
		assert.ok(first.url.startsWith('/api.php?'), first.url);
		assert.ok(first.url.includes('action=query'), '应带上 action');
		assert.ok(first.url.includes('format=json'));
		assert.ok(first.url.includes('formatversion=2'), '用 formatversion=2 拿更规整的结构');
		assert.ok(first.url.includes('titles=%E5%BB%BA%E7%AD%91%7C%E6%A8%A1%E5%9D%97%3A%E5%AE%9E%E4%BD%93%2F%E4%BF%A1%E6%81%AF%E6%A1%86'), `标题应被正确编码并用 | 连接：${first.url}`);
		assert.equal(first.ua, 'batch-test/9.9', 'UA 应被发送');

		await assert.rejects(() => api({ action: 'query', titles: '坏页' }), /missingtitle/, 'API 错误应抛出且带错误码');
		await assert.rejects(() => api({ action: 'query', boom: 1 }), /HTTP 403/, 'HTTP 错误应抛出且带状态码');
	} finally {
		server.close();
	}
});
