import * as path from 'node:path';
import * as net from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 必须给一个工作区目录，否则 VS Code 会停在欢迎页
const workspace = path.join(root, 'tmp-test-workspace');
mkdirSync(workspace, { recursive: true });

// 隔离用户数据目录。@vscode/test-electron 自己不传 --user-data-dir，默认会落到真实的
// ~/.config/Code —— 测试就会改到开发者的实际配置。注意：隔离必须靠 --user-data-dir 参数，
// 因为 extensionTestsEnv 只作用于扩展宿主进程，对 VS Code 主进程无效。
const userDataDir = path.join(root, '.vscode-test', 'user-data');
rmSync(userDataDir, { recursive: true, force: true });
mkdirSync(path.join(userDataDir, 'User'), { recursive: true });

/** 取一个空闲端口，交给测试里的本地假 wiki 用。 */
function freePort() {
	return new Promise(resolve => {
		const probe = net.createServer();
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
		});
	});
}

const port = await freePort();

// 预写测试设置。`wikitext.*` 属于另一个扩展，测试实例里没装它，用 configuration API 写会报
// "not a registered configuration"，所以只能落到文件里——这也是必须指定 --user-data-dir 的原因。
writeFileSync(
	path.join(userDataDir, 'User', 'settings.json'),
	JSON.stringify(
		{
			'wikitext.host': `127.0.0.1:${port}`,
			'wikitext.transferProtocol': 'http://',
			'wikitext.apiPath': '/api.php',
			'wikitext.articlePath': '/wiki/',
			// 机器人密码：登录名带 @机器人名，但账号本身叫 Alice
			'wikitext.userName': 'Alice@PreviewBot',
			'wikitext.password': 'fake-bot-password',
			'wikiUserPreview.pageTemplate': 'User:{username}/OriginalPreview/Test',
			'wikiUserPreview.confirmBeforeSave': false,
			'wikiUserPreview.targetFromPageInfo': 'never',
		},
		null,
		2,
	),
	'utf8',
);

await runTests({
	extensionDevelopmentPath: root,
	extensionTestsPath: path.join(root, 'out-test', 'integration', 'index.cjs'),
	extensionTestsEnv: {
		WIKI_USER_PREVIEW_TEST_PORT: String(port),
		// 把扩展的日志同时写到 stderr，便于在测试输出里定位卡在哪一步
		WIKI_USER_PREVIEW_DEBUG: '1',
	},
	launchArgs: [
		workspace,
		`--user-data-dir=${userDataDir}`,
		// 以普通用户跑 Electron 时 SUID sandbox 常常不可用
		'--no-sandbox',
		'--disable-gpu',
		'--disable-updates',
		'--skip-welcome',
		'--skip-release-notes',
		'--disable-workspace-trust',
		'--password-store=basic',
	],
});
console.log('集成测试通过');
