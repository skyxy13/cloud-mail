#!/usr/bin/env node
// 校验 i18n 消息：非法占位符会让 vue-i18n 编译失败，整个组件渲染崩掉（表现为白屏）。
// 例：'{服务商}' 这种非 ASCII 标识符会触发 "Invalid token in placeholder"。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const locales = ['zh', 'en'];

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// {{ x }} 是 vue-i18n 的字面量转义，先剔掉再检查
function placeholders(message) {
	const text = String(message).replace(/\{\{[\s\S]*?\}\}/g, '');
	return [...text.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]);
}

function flatKeys(obj, prefix = '') {
	const keys = [];
	for (const [key, value] of Object.entries(obj || {})) {
		const full = prefix ? prefix + '.' + key : key;
		if (value && typeof value === 'object') {
			keys.push(...flatKeys(value, full));
		} else {
			keys.push(full);
		}
	}
	return keys;
}

function get(obj, dotted) {
	return dotted.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

const messages = {};
for (const locale of locales) {
	const file = pathToFileURL(path.join(root, 'src/i18n', locale + '.js')).href;
	const module = await import(file);
	messages[locale] = module.default;
}

const problems = [];

// 1) 占位符必须是合法标识符（vue-i18n 的命名参数）
for (const locale of locales) {
	for (const key of flatKeys(messages[locale])) {
		const value = get(messages[locale], key);
		if (typeof value !== 'string') continue;
		for (const name of placeholders(value)) {
			if (!IDENT.test(name.trim())) {
				problems.push(`[${locale}] ${key}: 非法占位符 {${name}}（只允许 a-zA-Z0-9_$），消息：${value.slice(0, 80)}`);
			}
		}
	}
}

// 2) 各语言 key 必须一致，避免漏翻译导致界面显示 key
const base = new Set(flatKeys(messages[locales[0]]));
for (const locale of locales.slice(1)) {
	const other = new Set(flatKeys(messages[locale]));
	for (const key of base) {
		if (!other.has(key)) problems.push(`[${locale}] 缺少 key：${key}`);
	}
	for (const key of other) {
		if (!base.has(key)) problems.push(`[${locales[0]}] 缺少 key：${key}`);
	}
}

if (problems.length > 0) {
	console.error('❌ i18n 校验失败（' + problems.length + ' 个问题）：');
	for (const line of problems) console.error('  - ' + line);
	process.exit(1);
}

console.log('✅ i18n 校验通过：' + locales.join(' / ') + '，共 ' + base.size + ' 个 key');
