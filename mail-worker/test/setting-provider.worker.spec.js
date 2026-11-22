import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { dbInit } from '../src/init/init';
import settingService from '../src/service/setting-service';
import emailService from '../src/service/email-service';

function makeContext() {
	const store = new Map();
	const c = {
		env,
		req: { param: () => env.jwt_secret, header: () => undefined },
		text: (body) => new Response(body),
		json: (body) => new Response(JSON.stringify(body)),
		get: (key) => store.get(key),
		set: (key, value) => store.set(key, value)
	};
	return c;
}

describe('setting send providers', () => {
	const c = makeContext();

	it('init creates send_providers column and migrates', async () => {
		const res = await dbInit.init(c);
		expect(await res.text()).toBe('success');
		const columns = (await env.db.prepare('PRAGMA table_info(setting)').all()).results.map(row => row.name);
		expect(columns).toContain('send_providers');

		// 模拟旧版本只配置了 Resend Token，再跑一次初始化应迁移到 send_providers
		await env.db.prepare(`UPDATE setting SET resend_tokens = '{"example.com":"re_oldschool"}' , send_providers = '{}'`).run();
		await dbInit.v3_7DB(c);
		const row = await env.db.prepare('SELECT send_providers FROM setting').first();
		expect(JSON.parse(row.send_providers)).toEqual({
			'example.com': { provider: 'resend', token: 're_oldschool' }
		});
		await env.db.prepare(`UPDATE setting SET resend_tokens = '{}', send_providers = '{}'`).run();
		await settingService.refresh(c);
	});

	it('saves, masks and keeps providers', async () => {
		await settingService.set(c, {
			sendProviders: { 'example.com': { provider: 'mailtrap', token: 'mt_secret_token', accountId: '' } }
		});

		let setting = await settingService.get(c);
		expect(setting.sendProviders['example.com'].provider).toBe('mailtrap');
		expect(setting.sendProviders['example.com'].token).toBe('mt_secret_to******');
		expect(setting.sendProviderList.map(item => item.id)).toEqual(['resend', 'mailtrap', 'ahasend', 'plunk']);

		// 脱敏值回传不应覆盖真实 token
		await settingService.set(c, {
			sendProviders: { 'example.com': { provider: 'plunk', token: 'mt_secret_to******' } }
		});
		setting = await settingService.query(c);
		expect(setting.sendProviders['example.com']).toEqual({ provider: 'plunk', token: 'mt_secret_token', accountId: '' });

		// 发件流程读取到的就是这份配置
		expect(setting.sendProviders['example.com'].provider).toBe('plunk');

		// token 留空删除配置
		await settingService.set(c, { sendProviders: { 'example.com': { provider: 'plunk', token: '' } } });
		setting = await settingService.get(c);
		expect(setting.sendProviders['example.com']).toBeUndefined();
	});

	it('keeps ahasend account id', async () => {
		await settingService.set(c, {
			sendProviders: { 'example.com': { provider: 'ahasend', token: 'as_key', accountId: 'acc-9' } }
		});
		const setting = await settingService.query(c);
		expect(setting.sendProviders['example.com']).toEqual({ provider: 'ahasend', token: 'as_key', accountId: 'acc-9' });
	});
});
