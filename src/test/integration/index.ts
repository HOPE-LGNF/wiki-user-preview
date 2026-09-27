import * as path from 'node:path';
import Mocha from 'mocha';

/**
 * @vscode/test-electron 的测试入口。运行在真实的扩展宿主里，因此可以直接使用 vscode API
 * 断言编辑器分组、标签页位置这类只能在真机上验证的行为。
 */
export function run(): Promise<void> {
	const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120000 });
	mocha.addFile(path.resolve(__dirname, 'preview.test.cjs'));
	return new Promise((resolve, reject) => {
		mocha.run((failures: number) => {
			if (failures > 0) {
				reject(new Error(`${failures} 个集成测试失败`));
			} else {
				resolve();
			}
		});
	});
}
