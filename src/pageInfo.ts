/**
 * 解析 Wikitext 扩展（RoweWilsonFrederiskHolme.wikitext）在「Pull page to edit」时插入的
 * PAGE_INFO 元信息块。
 *
 * 块的样子（字段之间用 \r 分隔）：
 *
 *   <%-- [PAGE_INFO]
 *       pageTitle = #Foo#
 *       pageID = #12345#
 *       revisionID = #67890#
 *       contentModel = #wikitext#
 *       contentFormat = #text/x-wiki#
 *   [END_PAGE_INFO] --%>
 *
 * 注意：对 `wikitext` 内容模型，Wikitext 用的注释符是空串（非 wikitext 模型才是
 * `/* *\/` 或 `--[=[ ]=]`），所以这个块在 wikitext 里**不是注释**。它必须在上传前剥掉，
 * 否则会明文出现在页面正文里。
 */

/** 允许外层带非 wikitext 模型的注释符，以便同一个正则处理所有内容模型。 */
const BLOCK_RE = /(?:\/\*|--\[=\[)?[ \t]*(<%--[ \t]*\[PAGE_INFO\]([\s\S]*?)\[END_PAGE_INFO\][ \t]*--%>)[ \t]*(?:\*\/|--\]=\])?/;
const FIELD_RE = /([A-Za-z]+)[ \t]*=[ \t]*#([^#]*)#/g;

const USER_NAMESPACES = /^(?:User|用户|使用者|用戶)[ \t]*:/i;

export interface PageInfo {
	pageTitle?: string;
	pageID?: string;
	revisionID?: string;
	revisionTime?: string;
	contentModel?: string;
	contentFormat?: string;
}

export interface ExtractedContent {
	/** 剥掉 PAGE_INFO 之后、可以直接上传的正文 */
	content: string;
	info?: PageInfo;
	/** PAGE_INFO 块在原文中的绝对范围，用于回写 revisionID */
	block?: { start: number; end: number };
	/**
	 * 出现在正文中间、因此**未被识别**的同形块。
	 * 只用于提示用户，内容原样保留——否则正文里贴的格式示例会被静默删掉。
	 */
	misplacedBlock?: { start: number; end: number };
}

function parseFields(body: string): PageInfo {
	const info: PageInfo = {};
	for (const field of body.matchAll(FIELD_RE)) {
		const key = field[1]?.toLowerCase();
		const value = field[2]?.trim();
		if (!key || !value) {
			continue;
		}
		switch (key) {
			case 'pagetitle':
				info.pageTitle = value;
				break;
			case 'pageid':
				info.pageID = value;
				break;
			case 'revisionid':
				info.revisionID = value;
				break;
			case 'revisiontime':
				info.revisionTime = value;
				break;
			case 'contentmodel':
				info.contentModel = value;
				break;
			case 'contentformat':
				info.contentFormat = value;
				break;
			default:
				break;
		}
	}
	return info;
}

export function extractPageInfo(raw: string): ExtractedContent {
	const match = BLOCK_RE.exec(raw);
	if (!match || match.index === undefined) {
		return { content: raw };
	}

	const block = { start: match.index, end: match.index + match[0].length };

	// 只认「文件开头」的块。getPageCode 写的是 infoHead + "\r\r" + 正文，所以真实来源
	// 一定在开头；正文中间出现的同形块（最典型的是文档里贴的格式示例）必须原样保留——
	// 否则既会删掉正文，其中的 pageTitle 还会把上传目标劫持到别的页面。
	if (raw.slice(0, match.index).trim() !== '') {
		return { content: raw, misplacedBlock: block };
	}

	const info = parseFields(match[2] ?? '');
	let content = raw.slice(0, match.index) + raw.slice(block.end);

	// 块后跟着 getPageCode 写入的空行，剥掉之后不要把它带上站
	content = content.replace(/^(?:[ \t]*\r?\n|[ \t]*\r)+/, '');

	return { content, info, block };
}

/**
 * 定位块内某个字段「值」的绝对字符范围（不含两侧的 `#`）。
 * 用于在保存成功后原地更新 revisionID，避免同一个 buffer 连续推送被误判为自我冲突。
 */
export function pageInfoFieldRange(raw: string, block: { start: number; end: number }, field: string): { start: number; end: number } | undefined {
	const slice = raw.slice(block.start, block.end);
	const re = new RegExp(FIELD_RE.source, 'g');
	for (let match = re.exec(slice); match; match = re.exec(slice)) {
		if (match[1]?.toLowerCase() !== field.toLowerCase()) {
			continue;
		}
		const end = block.start + match.index + match[0].length - 1;
		return { start: end - (match[2]?.length ?? 0), end };
	}
	return undefined;
}

/** `User:` 及其本地化写法（MediaWiki 的规范名 `User:` 在任何语言站点都有效）。 */
export function isUserNamespaceTitle(title: string): boolean {
	return USER_NAMESPACES.test(title.replace(/_/g, ' ').trim());
}
