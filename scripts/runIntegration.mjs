import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 必须给一个工作区目录，否则 VS Code 会停在欢迎页
const workspace = path.join(root, 'tmp-test-workspace');
mkdirSync(workspace, { recursive: true });

await runTests({
	extensionDevelopmentPath: root,
	extensionTestsPath: path.join(root, 'out-test', 'integration', 'index.cjs'),
	launchArgs: [
		workspace,
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
