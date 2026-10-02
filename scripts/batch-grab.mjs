#!/usr/bin/env node
/**
 * 批量导出 MediaWiki 页面源码为本地文件。
 *
 * 为什么要单独一个工具：Wikitext 扩展只有单页的「Pull page to edit」，没有批量导出；
 * 而 MediaWiki 的 action=query 一次可以问几十个标题，批量抓取非常合适。
 *
 * 导出的文件默认带与 Wikitext 兼容的 PAGE_INFO 头，所以改完可以直接用 Wikitext 的
 * 「Post your edit to the website」推回去（它会读 pageTitle 与 revisionID 做目标页与
 * 冲突基准，并在推送前把整块剥掉）。
 *
 * 零第三方依赖，需要 Node 18+（用到内置 fetch）。
 *
 * 用法示例：
 *   node batch-grab.mjs --site casualtiesunknown.huijiwiki.com --prefix "模块:建筑/"
 *   node batch-grab.mjs --site my.wiki --file titles.txt --out ./export --delay 500
 *   node batch-grab.mjs --site my.wiki --category "分类:角色" --dry-run
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 内容模型 → 文件扩展名。Scribunto 就是 Lua 模块。 */
const EXT_BY_MODEL = {
	wikitext: '.wikitext',
	'flow-board': '.wikitext',
	Scribunto: '.lua',
	json: '.json',
	jsonc: '.json',
	css: '.css',
	'sanitized-css': '.css',
	javascript: '.js',
};

const INFO_COMMENT =
	"Please do not remove this struct. It's record contains some important information of edit. This struct will be removed automatically after you push edits.";

const HELP = `批量导出 MediaWiki 页面源码

站点
  --site <host>          必填，例如 casualtiesunknown.huijiwiki.com
  --scheme <s>           默认 https://
  --api-path <p>         默认 /api.php（注意维基百科是 /w/api.php，灰机wiki 是 /api.php）
  --ua <string>          User-Agent。部分站点（Cloudflare 后面）对默认 UA 更严格，建议填浏览器的

页面来源（可叠加，结果取并集）
  --pages "A,B,C"        直接给标题
  --file <path>          从文件读标题，每行一个，# 开头忽略
  --prefix <p>           按标题前缀列举（含子页面），例如 "模块:建筑/"
  --category <c>         列举某分类的成员，例如 "分类:角色"
  --all                  列举全部页面（慎用，可能是几万页）

输出
  --out <dir>            默认 ./wiki-export
  --name-style <s>       dash（默认）把标题里的 ":" 和 "/" 换成 "_"，例如
                         模块:实体/信息框 → 模块_实体_信息框.lua
                         raw 保留 "/"，于是按子页面分目录：模块_建筑/Base/分类.lua
  --no-page-info         不写 PAGE_INFO 头（只想要纯源码时用）
  --overwrite            覆盖已存在的文件；默认跳过，便于中断后续跑

节奏与调试
  --batch <n>            每次请求合并的标题数，默认 20，上限 50
  --delay <ms>           两次请求之间的等待，默认 300
  --dry-run              只打印将要写哪些文件，不实际请求与写入
  --quiet                只打印汇总
  --help
`;

function parseArgs(argv) {
	const opts = { scheme: 'https://', apiPath: '/api.php', out: './wiki-export', nameStyle: 'dash', batch: 20, delay: 300, pageInfo: true, overwrite: false, quiet: false, dryRun: false };
	const need = (i, flag) => {
		const v = argv[i + 1];
		if (v === undefined || v.startsWith('--')) {
			throw new Error(`${flag} 需要一个值`);
		}
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case '--help':
			case '-h':
				opts.help = true;
				break;
			case '--site':
				opts.site = need(i++, a);
				break;
			case '--scheme':
				opts.scheme = need(i++, a);
				break;
			case '--api-path':
				opts.apiPath = need(i++, a);
				break;
			case '--ua':
				opts.ua = need(i++, a);
				break;
			case '--pages':
				opts.pages = need(i++, a).split(',').map(s => s.trim()).filter(Boolean);
				break;
			case '--file':
				opts.file = need(i++, a);
				break;
			case '--prefix':
				opts.prefix = need(i++, a);
				break;
			case '--category':
				opts.category = need(i++, a);
				break;
			case '--all':
				opts.all = true;
				break;
			case '--out':
				opts.out = need(i++, a);
				break;
			case '--name-style':
				opts.nameStyle = need(i++, a);
				break;
			case '--no-page-info':
				opts.pageInfo = false;
				break;
			case '--overwrite':
				opts.overwrite = true;
				break;
			case '--batch':
				opts.batch = Number.parseInt(need(i++, a), 10);
				break;
			case '--delay':
				opts.delay = Number.parseInt(need(i++, a), 10);
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--quiet':
				opts.quiet = true;
				break;
			default:
				throw new Error(`未知参数：${a}（用 --help 看用法）`);
		}
	}
	if (!opts.help && !opts.site) {
		throw new Error('缺少 --site');
	}
	if (!['dash', 'raw'].includes(opts.nameStyle)) {
		throw new Error(`--name-style 只支持 dash / raw，收到 ${opts.nameStyle}`);
	}
	opts.batch = Math.min(Math.max(Number.isFinite(opts.batch) ? opts.batch : 20, 1), 50);
	return opts;
}

export function fileNameFor(title, contentModel, nameStyle) {
	// 命名空间分隔符 ":" 在 Windows 上非法，两种风格都要换掉。
	// dash（默认）：连子页面分隔符 "/" 也换成 "_"，全部平铺在一个目录里。
	// raw：保留 "/"，于是 模块:建筑/Base/分类 → 模块_建筑/Base/分类.lua，按子页面分目录。
	const base = nameStyle === 'raw' ? title.replace(/:/g, '_') : title.replace(/[:/]/g, '_');
	// 其余 Windows 非法字符（输出目录有可能就在 /mnt/c 上）
	const safe = base.replace(/[<>"\\|?*\u0000-\u001f]/g, '_').replace(/[\s.]+$/, '');
	const ext = EXT_BY_MODEL[contentModel] ?? '.wikitext';
	return `${safe}${ext}`;
}

export function pageInfoHead({ title, pageid, revid, contentModel, contentFormat }) {
	return [
		'<%-- [PAGE_INFO]',
		`    comment = #${INFO_COMMENT}#`,
		`    pageTitle = #${title}#`,
		`    pageID = #${pageid ?? ''}#`,
		`    revisionID = #${revid ?? ''}#`,
		`    contentModel = #${contentModel ?? ''}#`,
		`    contentFormat = #${contentFormat ?? ''}#`,
		'[END_PAGE_INFO] --%>',
	].join('\n');
}

function apiUrl(opts, params) {
	const url = new URL(`${opts.scheme}${opts.site}${opts.apiPath}`);
	for (const [k, v] of Object.entries({ ...params, format: 'json', formatversion: '2' })) {
		url.searchParams.set(k, String(v));
	}
	return url;
}

export function createClient(opts, fetchImpl = fetch) {
	const ua = opts.ua ?? 'wiki-batch-export/1.0 (https://github.com/HOPE-LGNF/wiki-user-preview)';
	return async function api(params) {
		const res = await fetchImpl(apiUrl(opts, params), { headers: { 'User-Agent': ua, Accept: 'application/json' } });
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200).replace(/\s+/g, ' ')}`);
		}
		const data = await res.json();
		if (data.error) {
			throw new Error(`${data.error.code}: ${data.error.info}`);
		}
		return data;
	};
}

/** 按前缀列举页面（走 list=allpages，含子页面）。 */
async function listByPrefix(api, prefix, into) {
	let cont;
	do {
		const data = await api({ action: 'query', list: 'allpages', apprefix: prefix, aplimit: 'max', ...(cont ?? {}) });
		for (const p of data.query?.allpages ?? []) {
			into.add(p.title);
		}
		cont = data.continue;
	} while (cont);
}

/** 列举分类成员（只取页面，不取子分类）。 */
async function listByCategory(api, category, into) {
	let cont;
	do {
		const data = await api({
			action: 'query',
			list: 'categorymembers',
			cmtitle: category.startsWith('分类:') || category.includes(':') ? category : `Category:${category}`,
			cmlimit: 'max',
			cmtype: 'page',
			...(cont ?? {}),
		});
		for (const m of data.query?.categorymembers ?? []) {
			into.add(m.title);
		}
		cont = data.continue;
	} while (cont);
}

/** 列举全部页面。 */
async function listAll(api, into) {
	let cont;
	do {
		const data = await api({ action: 'query', list: 'allpages', aplimit: 'max', ...(cont ?? {}) });
		for (const p of data.query?.allpages ?? []) {
			into.add(p.title);
		}
		cont = data.continue;
	} while (cont);
}

export async function collectTitles(opts, api) {
	const titles = new Set(opts.pages ?? []);
	if (opts.file) {
		for (const line of fs.readFileSync(opts.file, 'utf8').split(/\r?\n/)) {
			const t = line.trim();
			if (t && !t.startsWith('#')) {
				titles.add(t);
			}
		}
	}
	if (opts.prefix) {
		await listByPrefix(api, opts.prefix, titles);
	}
	if (opts.category) {
		await listByCategory(api, opts.category, titles);
	}
	if (opts.all) {
		await listAll(api, titles);
	}
	return [...titles];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function run(opts, api, log = console.log) {
	const titles = await collectTitles(opts, api);
	if (titles.length === 0) {
		log('没有收集到任何页面标题。用法见 --help。');
		return { written: 0, skipped: 0, failed: [] };
	}
	log(`共 ${titles.length} 个页面，输出到 ${path.resolve(opts.out)}`);

	// 干跑只解决「要抓哪些页面」，不请求正文：扩展名由各页的内容模型决定，
	// 那需要真的取一次内容，与干跑的用途（先核对清单）相悖。
	if (opts.dryRun) {
		log(`[dry-run] 将从以下页面导出（未请求内容、未写入任何文件）：`);
		for (const t of titles) {
			log(`  - ${t}`);
		}
		return { written: 0, skipped: 0, failed: [], planned: titles.length };
	}

	const result = { written: 0, skipped: 0, failed: [] };
	fs.mkdirSync(opts.out, { recursive: true });

	for (let i = 0; i < titles.length; i += opts.batch) {
		const chunk = titles.slice(i, i + opts.batch);
		// 必须初始化为数组：整批失败要走下面的逐条重试，那时 pages 还是空的
		let pages = [];
		try {
			const data = await api({ action: 'query', prop: 'revisions', rvprop: 'content|ids|timestamp', rvslots: 'main', titles: chunk.join('|') });
			pages = data.query?.pages ?? [];
		} catch (error) {
			// 整批失败时逐条重试，避免一个坏标题拖掉整批
			for (const title of chunk) {
				try {
					const one = await api({ action: 'query', prop: 'revisions', rvprop: 'content|ids|timestamp', rvslots: 'main', titles: title });
					pages.push(...(one.query?.pages ?? []));
				} catch (singleError) {
					result.failed.push(`${title}: ${singleError.message}`);
				}
				await sleep(opts.delay);
			}
		}

		for (const page of pages ?? []) {
			if (page.missing) {
				result.failed.push(`${page.title}: 页面不存在`);
				continue;
			}
			const rev = page.revisions?.[0];
			const slot = rev?.slots?.main;
			if (typeof slot?.content !== 'string') {
				result.failed.push(`${page.title}: 未返回正文（可能是被隐藏的版本）`);
				continue;
			}

			const file = path.join(opts.out, fileNameFor(page.title, slot.contentmodel, opts.nameStyle));
			if (opts.nameStyle === 'raw') {
				fs.mkdirSync(path.dirname(file), { recursive: true });
			}
			if (!opts.overwrite && fs.existsSync(file)) {
				result.skipped += 1;
				continue;
			}
			const body = opts.pageInfo
				? `${pageInfoHead({ title: page.title, pageid: page.pageid, revid: rev.revid, contentModel: slot.contentmodel, contentFormat: slot.contentformat })}\n\n${slot.content}`
				: slot.content;
			fs.writeFileSync(file, body, 'utf8');
			result.written += 1;
			if (!opts.quiet) {
				log(`  ✓ ${page.title} → ${path.basename(file)}（rev ${rev.revid}，${slot.content.length} 字符）`);
			}
		}

		if (i + opts.batch < titles.length) {
			await sleep(opts.delay);
		}
	}

	log(`\n完成：写入 ${result.written}，跳过（已存在）${result.skipped}，失败 ${result.failed.length}`);
	for (const f of result.failed) {
		log(`  ✗ ${f}`);
	}
	return result;
}

// 被 esbuild 打包进别处（例如冒烟测试）时 import.meta.url 可能不可用，
// 所以这里必须容错，否则单是 import 就会抛错。
const invokedDirectly = (() => {
	try {
		return Boolean(process.argv[1]) && Boolean(import.meta.url) && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
	} catch {
		return false;
	}
})();
if (invokedDirectly) {
	// 用 async IIFE 而不是顶层 await：本文件也会被 esbuild 以 CJS 格式打包进冒烟测试，
	// 那时顶层 await 会直接编译失败。
	void (async () => {
		try {
			const opts = parseArgs(process.argv.slice(2));
			if (opts.help) {
				console.log(HELP);
				return;
			}
			const result = await run(opts, createClient(opts));
			process.exit(result.failed.length > 0 ? 1 : 0);
		} catch (error) {
			console.error(`错误：${error.message}`);
			process.exit(2);
		}
	})();
}
