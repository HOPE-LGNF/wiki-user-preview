/**
 * 仅用于本地冒烟测试的 vscode 模块替身。
 *
 * 除了让 src/config.ts 里的纯函数能跑之外，它还**记录命令调用**与**标签页布局**，
 * 这样「预览用哪个命令、传什么参数、什么时候该把浏览器移到右侧」这类只能在 VS Code 里
 * 验证的决策逻辑也能被断言。真正的落位结果由 src/test/integration 里的真机测试负责。
 */
type Section = string | undefined;

const store = new Map<string, unknown>();

export const workspace = {
	getConfiguration(section?: Section) {
		return {
			get<T>(key: string, fallback?: T): T | undefined {
				const full = `${section ?? ''}.${key}`;
				return store.has(full) ? (store.get(full) as T) : fallback;
			},
		};
	},
};

export interface RecordedCall {
	command: string;
	args: unknown[];
}

export interface FakeTab {
	input: unknown;
}

export interface FakeTabGroup {
	viewColumn: number;
	tabs: FakeTab[];
	/** 不指定就默认最后一个标签是活动的 */
	activeTab?: FakeTab;
}

const calls: RecordedCall[] = [];
let availableCommands: string[] = [
	'workbench.action.browser.open',
	'simpleBrowser.api.open',
	'simpleBrowser.show',
	'workbench.action.moveEditorToRightGroup',
];
let activeTextEditor: unknown = { document: {} };
let tabGroups: FakeTabGroup[] = [{ viewColumn: 1, tabs: [] }];
let activeTabGroupIndex = 0;
const closedTabs: FakeTab[] = [];

export const commands = {
	async getCommands(_filterInternal?: boolean): Promise<string[]> {
		return [...availableCommands];
	},
	async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
		calls.push({ command, args });
		if (!availableCommands.includes(command)) {
			throw new Error(`command '${command}' not found`);
		}
		return undefined;
	},
};

/** 真身是 VS Code 内置类；测试里用 instanceof 判定标签类型。 */
export const TabInputWebview = class {
	constructor(public readonly viewType: string) {}
};
export const TabInputText = class {
	constructor(public readonly uri: unknown) {}
};
export const TabInputTextDiff = class {
	constructor(
		public readonly original: unknown,
		public readonly modified: unknown,
	) {}
};

function withActiveTab(group: FakeTabGroup): FakeTabGroup {
	return {
		viewColumn: group.viewColumn,
		tabs: group.tabs,
		activeTab: group.activeTab ?? group.tabs[group.tabs.length - 1],
	};
}

export const window = {
	get activeTextEditor(): unknown {
		return activeTextEditor;
	},
	get tabGroups() {
		return {
			get all(): readonly FakeTabGroup[] {
				return tabGroups;
			},
			get activeTabGroup(): FakeTabGroup {
				return withActiveTab(tabGroups[activeTabGroupIndex] ?? tabGroups[0] ?? { viewColumn: 1, tabs: [] });
			},
			async close(tab: FakeTab): Promise<boolean> {
				closedTabs.push(tab);
				for (const group of tabGroups) {
					const index = group.tabs.indexOf(tab);
					if (index >= 0) {
						group.tabs.splice(index, 1);
						return true;
					}
				}
				return false;
			},
		};
	},
} as unknown;

export const env = {} as unknown;
export const extensions = { getExtension: () => undefined } as unknown;

export const Uri = {
	parse(value: string) {
		return { scheme: 'https', toString: () => value, fsPath: value };
	},
} as unknown;

export const ProgressLocation = { Notification: 15 } as unknown;
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 } as unknown;
export const StatusBarAlignment = { Right: 2 } as unknown;
export const languages = {} as unknown;
export const EventEmitter = class {} as unknown;

export function __set(section: string | undefined, key: string, value: unknown): void {
	store.set(`${section ?? ''}.${key}`, value);
}

export function __calls(): RecordedCall[] {
	return calls;
}

export function __resetCalls(): void {
	calls.length = 0;
}

export function __commandsCalled(command: string): RecordedCall[] {
	return calls.filter(call => call.command === command);
}

export function __setAvailableCommands(list: string[]): void {
	availableCommands = list;
}

export function __setActiveEditor(value: unknown): void {
	activeTextEditor = value;
}

export function __setTabGroups(groups: FakeTabGroup[], activeIndex = 0): void {
	tabGroups = groups.map(withActiveTab);
	activeTabGroupIndex = activeIndex;
}

export function __closedTabs(): FakeTab[] {
	return closedTabs;
}

export function __resetClosedTabs(): void {
	closedTabs.length = 0;
}
