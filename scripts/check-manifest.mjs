/**
 * 清单一致性检查：package.json 与源码必须对得上。
 * 这类漂移在 VS Code 扩展里很常见（加了配置项却忘了读、注册了命令却没声明），
 * 而且不会在编译期报错，所以单独做成一个检查。
 *
 * 运行：node scripts/check-manifest.mjs
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const extensionSrc = readFileSync('src/extension.ts', 'utf8');
const configSrc = readFileSync('src/config.ts', 'utf8');
const source = `${extensionSrc}\n${configSrc}`;

let failed = 0;
function fail(message) {
	failed++;
	console.log(`  ✗ ${message}`);
}
function ok(message) {
	console.log(`  ✓ ${message}`);
}

const commandsDeclared = (pkg.contributes?.commands ?? []).map(c => c.command);
const commandsRegistered = [...source.matchAll(/registerCommand\(\s*'([^']+)'/g)].map(m => m[1]);

console.log('\n[命令]');
for (const id of commandsDeclared) {
	if (commandsRegistered.includes(id)) {
		ok(`已声明且已注册：${id}`);
	} else {
		fail(`package.json 声明了 ${id}，但 activate() 里没有 registerCommand`);
	}
}
for (const id of commandsRegistered) {
	if (!commandsDeclared.includes(id)) {
		fail(`代码注册了 ${id}，但 package.json 的 contributes.commands 里没有声明（用户看不到）`);
	}
}

// 只检查本扩展自己的配置段
const properties = Object.keys(pkg.contributes?.configuration?.properties ?? {}).filter(k => k.startsWith('wikiUserPreview.'));
const readKeys = [...source.matchAll(/own\(\)\.get(?:<[^>]*>)?\(\s*'([^']+)'/g)].map(m => `wikiUserPreview.${m[1]}`);

console.log('\n[配置项]');
for (const key of properties) {
	if (readKeys.includes(key)) {
		ok(`已声明且被读取：${key}`);
	} else {
		fail(`package.json 声明了 ${key}，但代码里从没读过（要么是废配置，要么是漏实现）`);
	}
}
const ignoreUnread = new Set();
for (const key of new Set(readKeys)) {
	if (!properties.includes(key) && !ignoreUnread.has(key)) {
		fail(`代码读取了未声明的配置 ${key}（用户无法设置，getConfiguration 会一直返回默认值）`);
	}
}

console.log('\n[markdownDescription 内链]');
const allText = JSON.stringify(pkg.contributes?.configuration ?? {});
const links = [...allText.matchAll(/#([A-Za-z][A-Za-z0-9_.]*)#/g)].map(m => m[1]);
const ownAndForeign = Object.keys(pkg.contributes?.configuration?.properties ?? {});
for (const link of new Set(links)) {
	if (ownAndForeign.includes(link)) {
		ok(`内链有效：#${link}#`);
	} else if (link.startsWith('wikiUserPreview.')) {
		fail(`内链指向不存在的本扩展配置项：#${link}#`);
	} else {
		// 指向其它扩展（wikitext.* / wikiparser.*）的设置是有意为之：
		// 本扩展会回退读取它们的配置，所以文案里要能跳过去。
		ok(`跨扩展内链（依赖对应扩展已安装）：#${link}#`);
	}
}

console.log('\n[其它]');
const menuCommands = [
	...(pkg.contributes?.menus?.['editor/title'] ?? []),
	...(pkg.contributes?.menus?.commandPalette ?? []),
	...(pkg.contributes?.keybindings ?? []),
].map(m => m.command);
for (const id of new Set(menuCommands)) {
	if (!commandsDeclared.includes(id)) {
		fail(`menus/keybindings 引用了未声明的命令：${id}`);
	} else {
		ok(`菜单/快捷键引用有效：${id}`);
	}
}

if (pkg.main !== './dist/extension.js') {
	fail(`package.json 的 main 是 ${pkg.main}，与 esbuild 产物 dist/extension.js 不一致`);
} else {
	ok('main 指向 esbuild 产物 dist/extension.js');
}

console.log(failed === 0 ? '\n清单一致性检查通过。' : `\n清单一致性检查失败：${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
