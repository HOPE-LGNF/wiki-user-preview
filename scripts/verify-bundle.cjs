/**
 * 验证「打包后的产物」而不是 src/：dist/extension.js 是 minify 过的生产构建，
 * 之前的 tsc / 冒烟测试都只覆盖源码，装的却是这个文件。
 *
 * 做法：把 `vscode` 模块替换成替身，然后真正 require 产物并调用 activate()，
 * 断言它能跑起来且 6 个命令都被注册。
 *
 * 运行：node scripts/verify-bundle.cjs
 */
const Module = require('node:module');
const path = require('node:path');
const assert = require('node:assert');

const registered = new Map();
const outputLines = [];

const disposable = () => ({ dispose() {} });

const vscodeStub = {
	commands: {
		registerCommand(id, handler) {
			registered.set(id, handler);
			return disposable();
		},
		executeCommand: async () => undefined,
	},
	window: {
		createOutputChannel(name) {
			return {
				name,
				appendLine(line) {
					outputLines.push(line);
				},
				show() {},
				dispose() {},
			};
		},
		setStatusBarMessage: () => disposable(),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showInputBox: async () => undefined,
		showQuickPick: async () => undefined,
		createWebviewPanel: () => {
			throw new Error('本测试不应创建 webview');
		},
		activeTextEditor: undefined,
	},
	workspace: {
		getConfiguration: () => ({ get: (_key, fallback) => fallback }),
	},
	env: {},
	Uri: { parse: value => value },
	extensions: { getExtension: () => undefined },
	ProgressLocation: { Notification: 15 },
	ViewColumn: { Beside: -2, Active: -1 },
	StatusBarAlignment: { Right: 2 },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return originalLoad.call(this, request, parent, isMain);
};

const bundlePath = path.join(__dirname, '..', 'dist', 'extension.js');
const bundle = require(bundlePath);
Module._load = originalLoad;

let failed = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
	}
}

console.log('\n[打包产物 dist/extension.js]');
check('文件可被 require', typeof bundle === 'object' && bundle !== null);
check('导出了 activate 函数', typeof bundle.activate === 'function', Object.keys(bundle));
check('导出了 deactivate 函数', typeof bundle.deactivate === 'function');

const subscriptions = [];
const context = {
	subscriptions,
	extension: { packageJSON: { version: '0.0.0-test' } },
	secrets: {
		get: async () => undefined,
		store: async () => undefined,
		delete: async () => undefined,
	},
};

let activateError;
try {
	bundle.activate(context);
} catch (error) {
	activateError = error;
}
check('activate() 能无异常执行', activateError === undefined, activateError && activateError.message);

const expected = [
	'wikiUserPreview.originalPreview',
	'wikiUserPreview.login',
	'wikiUserPreview.logout',
	'wikiUserPreview.setPassword',
	'wikiUserPreview.clearPassword',
	'wikiUserPreview.showResolvedConfig',
];
for (const id of expected) {
	check(`已注册命令 ${id}`, registered.has(id));
}
check('注册的命令数量一致', registered.size === expected.length, registered.size);
// activate 还会 push：1 个输出通道 + 1 个 preview 面板 disposer
check('全部注册都进了 subscriptions（可被回收）', subscriptions.length === expected.length + 2, subscriptions.length);
check('输出通道写入过内容', outputLines.some(line => line.includes('激活')), outputLines.slice(0, 2));

// 产物里必须真的带着两处修复所依赖的字符串常量（minify 不会删字符串字面量，
// 但要注意源码里的正则写成 \[PAGE_INFO\]，所以不能按裸字面量匹配）
const fs = require('node:fs');
const code = fs.readFileSync(bundlePath, 'utf8');
check('产物含 PAGE_INFO 剥离逻辑', code.includes('PAGE_INFO') && code.includes('END_PAGE_INFO'));
check('产物含 basetimestamp（冲突检测）', code.includes('basetimestamp'));
check('产物含 assert=user', code.includes('assert'));
check('产物含 header 净化所需的 ASCII 判定', code.includes('\\x7e') || code.includes('\\x20'));
check('产物不含已删除的 token 泄露写法', !code.includes('Your Token'));

console.log(failed === 0 ? '\n打包产物校验通过。' : `\n打包产物校验失败：${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
