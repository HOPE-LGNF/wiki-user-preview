/**
 * scripts/batch-grab.mjs 是给用户直接 `node` 运行的零依赖工具，所以本体是纯 JS。
 * 这份声明只为让仓库内的调用方（冒烟测试等）获得类型检查。
 */
export interface BatchGrabOptions {
	site?: string;
	scheme?: string;
	apiPath?: string;
	ua?: string;
	pages?: string[];
	file?: string;
	prefix?: string;
	category?: string;
	all?: boolean;
	out: string;
	nameStyle: 'dash' | 'raw';
	pageInfo: boolean;
	overwrite: boolean;
	batch: number;
	delay: number;
	quiet: boolean;
	dryRun: boolean;
}

export interface BatchGrabResult {
	written: number;
	skipped: number;
	failed: string[];
	/** 仅 dry-run 会给出 */
	planned?: number;
}

export type ApiCall = (params: Record<string, unknown>) => Promise<any>;

export function fileNameFor(title: string, contentModel: string | undefined, nameStyle: string): string;
export function pageInfoHead(info: { title: string; pageid?: number; revid?: number; contentModel?: string; contentFormat?: string }): string;
export function createClient(opts: Partial<BatchGrabOptions>, fetchImpl?: typeof fetch): ApiCall;
export function collectTitles(opts: Partial<BatchGrabOptions>, api: ApiCall): Promise<string[]>;
export function run(opts: BatchGrabOptions, api: ApiCall, log?: (...args: unknown[]) => void): Promise<BatchGrabResult>;
