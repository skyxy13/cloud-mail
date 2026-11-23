import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { dbInit } from '../src/init/init';
import settingService from '../src/service/setting-service';
import constant from '../src/const/constant';
import emailService from '../src/service/email-service';
import sendProviderService from '../src/service/send-provider-service';
import sendWebhookService from '../src/service/send-webhook-service';
import suppressionService from '../src/service/suppression-service';
import draftService from '../src/service/draft-service';
import scheduleService from '../src/service/schedule-service';

function makeContext(body = '', headers = {}) {
	const store = new Map();
	return {
		env,
		req: {
			param: () => env.jwt_secret,
			header: (name) => headers[String(name).toLowerCase()],
			text: async () => body
		},
		text: (value) => new Response(value),
		json: (value) => new Response(JSON.stringify(value)),
		get: (key) => store.get(key),
		set: (key, value) => store.set(key, value)
	};
}

const message = {
	from: {email: 'noreply@example.com', name: 'Demo'},
	to: ['a@test.com'],
	cc: [],
	bcc: [],
	subject: 'Hi',
	text: 'plain',
	html: '<p>hi</p>',
	headers: {},
	attachments: []
};

function mockFetch(json, status = 200) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, options) => {
		calls.push({url: String(url), options});
		return new Response(JSON.stringify(json), {status, headers: {'content-type': 'application/json'}});
	});
	return calls;
}

describe('init status endpoint', () => {
	it('reports schema version for the frontend notice', async () => {
		let res = await SELF.fetch('http://example.com/api/init/status');
		let body = await res.json();
		expect(body.code).toBe(200);
		expect(body.data.initialized).toBe(true);
		expect(body.data.requiredVersion).toBe(constant.DB_VERSION);
		expect(body.data.needUpgrade).toBe(false);

		// 模拟线上代码比库新：把 KV 里的版本改掉
		const cached = await env.kv.get('setting:', {type: 'json'});
		await env.kv.put('setting:', JSON.stringify({...cached, dbVersion: 'v3.0'}));
		res = await SELF.fetch('http://example.com/api/init/status');
		body = await res.json();
		expect(body.data.needUpgrade).toBe(true);
		expect(body.data.dbVersion).toBe('v3.0');

		// 复原
		await env.kv.put('setting:', JSON.stringify({...cached}));
	});
});

describe('reply-to', () => {
	const c = makeContext();

	beforeAll(async () => {
		await dbInit.init(c);
	});

	it('validates reply-to address', () => {
		expect(emailService.normalizeReplyTo(' reply@example.com ')).toBe('reply@example.com');
		expect(emailService.normalizeReplyTo('')).toBe('');
		expect(() => emailService.normalizeReplyTo('not-an-email')).toThrow();
	});

	it('passes reply-to to providers', async () => {
		const calls = mockFetch({success: true, message_ids: ['id-1']});
		await sendProviderService.send({provider: 'mailtrap', token: 't'}, {...message, replyTo: 'reply@example.com'});
		expect(JSON.parse(calls[0].options.body).reply_to).toEqual({email: 'reply@example.com'});

		const plunkCalls = mockFetch({success: true, data: {emails: [{email: 'p-1', status: 'queued'}]}});
		await sendProviderService.send({provider: 'plunk', token: 'sk'}, {...message, replyTo: 'reply@example.com'});
		expect(JSON.parse(plunkCalls[0].options.body).reply).toBe('reply@example.com');

		const ahaCalls = mockFetch({success_count: 1, fail_count: 0});
		await sendProviderService.send({provider: 'ahasend', token: 'k'}, {...message, replyTo: 'reply@example.com'});
		expect(JSON.parse(ahaCalls[0].options.body).content.reply_to).toEqual({email: 'reply@example.com'});
	});
});

describe('suppression list', () => {
	const c = makeContext();

	it('stores lowercased addresses and blocks sending', async () => {
		await suppressionService.suppress(c, {email: 'Bad@Test.com', reason: 'bounce', provider: 'mailtrap'});

		const blocked = await suppressionService.blocked(c, ['bad@test.com', 'ok@test.com']);
		expect(blocked.map(item => item.email)).toEqual(['bad@test.com']);

		await expect(emailService.checkSuppression(c, ['bad@test.com'])).rejects.toThrow(/bad@test.com/);
		await expect(emailService.checkSuppression(c, ['ok@test.com'])).resolves.toBeUndefined();
	});

	it('adds hard bounces and complaints from webhooks', async () => {
		await sendWebhookService.handle(makeContext(JSON.stringify({
			events: [{event: 'bounce', message_id: 'x1', email: 'hard@test.com', event_id: 'sup-1'}]
		})), 'mailtrap');
		await sendWebhookService.handle(makeContext(JSON.stringify({
			events: [{event: 'spam', message_id: 'x2', email: 'spam@test.com', event_id: 'sup-2'}]
		})), 'mailtrap');
		// 软退信（临时失败）不进抑制名单
		await sendWebhookService.handle(makeContext(JSON.stringify({
			events: [{event: 'soft bounce', message_id: 'x3', email: 'soft@test.com', event_id: 'sup-3'}]
		})), 'mailtrap');

		const list = await suppressionService.list(c, {});
		const emails = list.map(item => item.email);
		expect(emails).toContain('hard@test.com');
		expect(emails).toContain('spam@test.com');
		expect(emails).not.toContain('soft@test.com');
	});

	it('removes entries', async () => {
		await suppressionService.remove(c, ['hard@test.com']);
		const list = await suppressionService.list(c, {});
		expect(list.map(item => item.email)).not.toContain('hard@test.com');
	});
});

describe('domain daily quota', () => {
	const c = makeContext();

	it('enforces and counts per domain', async () => {
		await settingService.set(c, {domainDailyQuota: {'example.com': 2}});
		const setting = await settingService.query(c);
		expect(setting.domainDailyQuota).toEqual({'example.com': 2});

		await expect(emailService.checkDomainQuota(c, 'example.com', 3)).rejects.toThrow(/example.com/);
		await expect(emailService.checkDomainQuota(c, 'example.com', 2)).resolves.toBeUndefined();

		await emailService.addDomainQuotaUsage(c, 'example.com', 2);
		expect(await emailService.domainUsedToday(c, 'example.com')).toBe(2);
		await expect(emailService.checkDomainQuota(c, 'example.com', 1)).rejects.toThrow();

		// 没配额的域名不受限制
		await expect(emailService.checkDomainQuota(c, 'other.com', 100)).resolves.toBeUndefined();

		await settingService.set(c, {domainDailyQuota: {'example.com': 0}});
		const cleared = await settingService.query(c);
		expect(cleared.domainDailyQuota).toEqual({});
	});
});

describe('draft service', () => {
	const c = makeContext();

	it('saves, lists, updates and deletes drafts', async () => {
		const draftId = await draftService.save(c, {
			accountId: 1, name: 'Demo', sendEmail: 'a@example.com',
			receiveEmail: ['b@test.com'], ccEmail: [], bccEmail: [],
			subject: 'draft subject', content: '<p>x</p>', text: 'x', replyTo: 'r@example.com'
		}, 7);

		let list = await draftService.list(c, 7);
		expect(list).toHaveLength(1);
		expect(list[0].subject).toBe('draft subject');
		expect(list[0].receiveEmail).toEqual(['b@test.com']);
		expect(list[0].replyTo).toBe('r@example.com');

		await draftService.save(c, {draftId, subject: 'updated'}, 7);
		list = await draftService.list(c, 7);
		expect(list[0].subject).toBe('updated');

		// 其他用户看不到
		expect(await draftService.list(c, 8)).toHaveLength(0);

		await draftService.remove(c, [draftId], 7);
		expect(await draftService.list(c, 7)).toHaveLength(0);
	});
});

describe('scheduled send', () => {
	const c = makeContext();

	it('creates, lists and cancels schedules', async () => {
		const sendTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
		const scheduleId = await scheduleService.create(c, {
			accountId: 1, sendEmail: 'a@example.com', receiveEmail: ['b@test.com'],
			subject: 'later', content: '<p>x</p>', sendTime
		}, 9);

		let list = await scheduleService.list(c, 9);
		expect(list).toHaveLength(1);
		expect(list[0].subject).toBe('later');

		await scheduleService.cancel(c, scheduleId, 9);
		list = await scheduleService.list(c, 9);
		expect(list).toHaveLength(0);
	});

	it('rejects bad send times', async () => {
		await expect(scheduleService.create(c, {sendTime: 'not-a-date'}, 9)).rejects.toThrow();
		await expect(scheduleService.create(c, {sendTime: new Date(Date.now() + 1000).toISOString()}, 9)).rejects.toThrow();
		await expect(scheduleService.create(c, {sendTime: new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString()}, 9)).rejects.toThrow();
	});

	it('marks broken schedules as failed', async () => {
		await env.db.prepare(`INSERT INTO email_schedule (user_id, account_id, params, send_time, status, attempts)
			VALUES (9, 1, 'not-json', '2000-01-01 00:00:00', 0, 0)`).run();

		await scheduleService.runDue(c);
		const row = await env.db.prepare(`SELECT status, error FROM email_schedule WHERE params = 'not-json'`).first();
		expect(row.status).toBe(3);
		expect(row.error).toBe('invalid params');
	});
});
