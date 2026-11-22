import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { dbInit } from '../src/init/init';
import settingService from '../src/service/setting-service';
import sendWebhookService from '../src/service/send-webhook-service';

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

async function hmacHex(secret, message) {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
	const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
	return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacBase64(keyBytes, message) {
	const key = await crypto.subtle.importKey('raw', keyBytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
	const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

describe('send webhook', () => {
	beforeAll(async () => {
		await dbInit.init(makeContext());
	});

	it('maps mailtrap events', () => {
		const base = {message_id: '<0c7fd939-02cf-11ed-88c2-0a58a9feac02@example.com>', email: 'a@test.com'};
		expect(sendWebhookService.mapEvent('mailtrap', {...base, event: 'delivery'})).toMatchObject({
			providerId: '<0c7fd939-02cf-11ed-88c2-0a58a9feac02@example.com>', status: 2, message: null, suppress: false
		});
		const bounced = sendWebhookService.mapEvent('mailtrap', {...base, event: 'bounce', response_code: 550, response: 'mailbox unavailable'});
		expect(bounced.status).toBe(3);
		expect(JSON.parse(bounced.message)).toEqual({response_code: 550, response: 'mailbox unavailable'});
		expect(sendWebhookService.mapEvent('mailtrap', {...base, event: 'soft bounce'}).status).toBe(5);
		expect(sendWebhookService.mapEvent('mailtrap', {...base, event: 'spam'}).status).toBe(4);
		expect(sendWebhookService.mapEvent('mailtrap', {...base, event: 'open'})).toBeNull();
	});

	it('maps ahasend events', () => {
		const data = {id: 'msg-1', recipient: 'a@test.com'};
		expect(sendWebhookService.mapEvent('ahasend', {type: 'message.delivered', data})).toMatchObject({providerId: 'msg-1', status: 2, message: null});
		const bounced = sendWebhookService.mapEvent('ahasend', {
			type: 'message.bounced',
			data: {...data, delivery_attempt: {classification: 'InvalidRecipient', smtp_code: 550}}
		});
		expect(bounced.status).toBe(3);
		expect(JSON.parse(bounced.message).smtp_code).toBe(550);
		expect(sendWebhookService.mapEvent('ahasend', {type: 'message.complained', data}).status).toBe(4);
		expect(sendWebhookService.mapEvent('ahasend', {type: 'message.transient_error', data}).status).toBe(5);
		expect(sendWebhookService.mapEvent('ahasend', {type: 'message.opened', data})).toBeNull();
	});

	it('maps plunk events by type and by payload fields', () => {
		expect(sendWebhookService.mapEvent('plunk', {type: 'email.delivery', emailId: 'plunk-1'})).toMatchObject({
			providerId: 'plunk-1', status: 2, message: null
		});
		// 默认载荷没有事件名，用字段判断
		const delivered = sendWebhookService.mapEvent('plunk', {event: {emailId: 'plunk-2', deliveredAt: '2026-01-01T00:00:00Z'}});
		expect(delivered.status).toBe(2);
		const bounced = sendWebhookService.mapEvent('plunk', {event: {emailId: 'plunk-3', bounceType: 'Permanent', bouncedAt: '2026-01-01T00:00:00Z'}});
		expect(bounced.status).toBe(3);
		expect(sendWebhookService.mapEvent('plunk', {event: {emailId: 'plunk-4', complainedAt: '2026-01-01T00:00:00Z'}}).status).toBe(4);
		expect(sendWebhookService.mapEvent('plunk', {emailId: 'plunk-5'})).toBeNull();
	});

	it('normalizes provider message ids', () => {
		const event = sendWebhookService.mapEvent('mailtrap', {event: 'delivery', message_id: '<abc-123@example.com>'});
		expect(event.providerId).toBe('<abc-123@example.com>');
	});

	it('verifies mailtrap signature', async () => {
		const secret = 'a'.repeat(32);
		const body = JSON.stringify({events: [{event: 'delivery', message_id: 'x'}]});
		const signature = await hmacHex(secret, body);

		expect(await sendWebhookService.verifyMailtrap(makeContext(body, {'mailtrap-signature': signature}), body, secret)).toBe(true);
		expect(await sendWebhookService.verifyMailtrap(makeContext(body, {'mailtrap-signature': signature.slice(1) + '0'}), body, secret)).toBe(false);
		expect(await sendWebhookService.verifyMailtrap(makeContext(body, {}), body, secret)).toBe(false);
	});

	it('verifies standard webhook signature (resend / ahasend)', async () => {
		const secretBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		let binary = '';
		for (const byte of secretBytes) binary += String.fromCharCode(byte);
		const secret = 'whsec_' + btoa(binary);
		const id = 'msg_1';
		const timestamp = String(Math.floor(Date.now() / 1000));
		const body = '{"type":"message.delivered","data":{"id":"m1"}}';
		const signature = await hmacBase64(secretBytes, id + '.' + timestamp + '.' + body);

		const headers = {
			'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,' + signature
		};
		const options = {id: 'webhook-id', timestamp: 'webhook-timestamp', signature: 'webhook-signature'};

		expect(await sendWebhookService.verifyStandard(makeContext(body, headers), body, secret, options)).toBe(true);
		expect(await sendWebhookService.verifyStandard(makeContext(body, {...headers, 'webhook-signature': 'v1,abc'}), body, secret, options)).toBe(false);
		// 过期时间戳拒绝
		const oldTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
		const oldSignature = await hmacBase64(secretBytes, id + '.' + oldTimestamp + '.' + body);
		expect(await sendWebhookService.verifyStandard(
			makeContext(body, {'webhook-id': id, 'webhook-timestamp': oldTimestamp, 'webhook-signature': 'v1,' + oldSignature}),
			body, secret, options
		)).toBe(false);
	});

	it('verifies plunk shared token', () => {
		expect(sendWebhookService.verifyPlunk(makeContext('', {authorization: 'Bearer token-1'}), 'token-1')).toBe(true);
		expect(sendWebhookService.verifyPlunk(makeContext('', {'x-webhook-token': 'token-1'}), 'token-1')).toBe(true);
		expect(sendWebhookService.verifyPlunk(makeContext('', {authorization: 'Bearer other'}), 'token-1')).toBe(false);
	});

	it('only upgrades status, never regresses', () => {
		expect(sendWebhookService.allowedFromStatuses(1)).toEqual([]); // SENT 不能被覆盖
		expect(sendWebhookService.allowedFromStatuses(2)).toEqual([1, 5]); // DELIVERED 只能覆盖 SENT/DELAYED
		expect(sendWebhookService.allowedFromStatuses(3)).toEqual([1, 2, 4, 5]); // BOUNCED 还能覆盖 DELIVERED/COMPLAINED
		expect(sendWebhookService.allowedFromStatuses(8)).toEqual([1, 2, 3, 4, 5]);
	});

	it('keeps delivered status when events arrive out of order', async () => {
		await env.db.prepare(`INSERT INTO email (account_id, user_id, send_email, subject, type, status, resend_email_id)
			VALUES (1, 1, 'a@example.com', 'order test', 1, 1, 'order-1')`).run();

		await sendWebhookService.handle(makeContext(JSON.stringify({
			events: [{event: 'delivery', message_id: 'order-1', event_id: 'evt-1'}]
		})), 'mailtrap');
		let row = await env.db.prepare(`SELECT status FROM email WHERE resend_email_id = 'order-1'`).first();
		expect(row.status).toBe(2);

		// 乱序到达的 email.sent 不应把 DELIVERED 改回 SENT
		await sendWebhookService.handle(makeContext(JSON.stringify({
			type: 'email.sent', data: {email_id: 'order-1'}
		})), 'resend');
		row = await env.db.prepare(`SELECT status FROM email WHERE resend_email_id = 'order-1'`).first();
		expect(row.status).toBe(2);

		// 迟到的退信仍然可以覆盖 DELIVERED
		await sendWebhookService.handle(makeContext(JSON.stringify({
			events: [{event: 'bounce', message_id: 'order-1', response_code: 550, event_id: 'evt-2'}]
		})), 'mailtrap');
		row = await env.db.prepare(`SELECT status, message FROM email WHERE resend_email_id = 'order-1'`).first();
		expect(row.status).toBe(3);
		expect(JSON.parse(row.message).response_code).toBe(550);
	});

	it('ignores callbacks coming from another provider', async () => {
		await env.db.prepare(`INSERT INTO email (account_id, user_id, send_email, subject, type, status, resend_email_id, provider)
			VALUES (1, 1, 'a@example.com', 'provider check', 1, 1, 'prov-1', 'mailtrap')`).run();

		const result = await sendWebhookService.handle(makeContext(JSON.stringify({
			type: 'email.delivered', data: {email_id: 'prov-1'}
		})), 'resend');

		expect(result.updated).toBe(0);
		expect(result.ignored).toBe(1);
		const row = await env.db.prepare(`SELECT status FROM email WHERE resend_email_id = 'prov-1'`).first();
		expect(row.status).toBe(1);
	});

	it('ignores duplicated events', async () => {
		const body = JSON.stringify({events: [{event: 'delivery', message_id: 'order-1', event_id: 'evt-dup'}]});
		const first = await sendWebhookService.handle(makeContext(body), 'mailtrap');
		const second = await sendWebhookService.handle(makeContext(body), 'mailtrap');
		expect(second.ignored).toBe(1);
		expect(second.updated).toBe(0);
		expect(first).toBeTruthy();
	});

	it('accepts callbacks and rejects bad signatures', async () => {
		const c = makeContext();

		// 未配置密钥时直接接收
		let res = await SELF.fetch('http://example.com/api/webhooks/mailtrap', {method: 'POST', body: JSON.stringify({
			events: [{event: 'delivery', message_id: '<unknown@example.com>', email: 'a@test.com'}]
		})});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('success');

		// 旧地址继续按 Resend 处理
		res = await SELF.fetch('http://example.com/api/webhooks', {method: 'POST', body: JSON.stringify({
			type: 'email.delivered', data: {email_id: 'unknown-resend-id'}
		})});
		expect(res.status).toBe(200);

		// 配置密钥后，签名不正确直接拒绝
		await settingService.set(c, {sendWebhookSecrets: {mailtrap: 'b'.repeat(32)}});
		res = await SELF.fetch('http://example.com/api/webhooks/mailtrap', {method: 'POST', body: '{}'});
		expect(res.status).toBe(401);

		const body = JSON.stringify({events: [{event: 'delivery', message_id: '<unknown@example.com>'}]});
		res = await SELF.fetch('http://example.com/api/webhooks/mailtrap', {
			method: 'POST', body, headers: {'mailtrap-signature': await hmacHex('b'.repeat(32), body)}
		});
		expect(res.status).toBe(200);

		// 强制校验：没有配置密钥时直接 403
		await settingService.set(c, {sendWebhookStrict: 1, sendWebhookSecrets: {mailtrap: ''}});
		res = await SELF.fetch('http://example.com/api/webhooks/mailtrap', {method: 'POST', body: '{}'});
		expect(res.status).toBe(403);

		// 配置密钥后带正确签名即可通过
		await settingService.set(c, {sendWebhookSecrets: {mailtrap: 'c'.repeat(32)}});
		const signedBody = JSON.stringify({events: [{event: 'delivery', message_id: '<unknown@example.com>'}]});
		res = await SELF.fetch('http://example.com/api/webhooks/mailtrap', {
			method: 'POST', body: signedBody, headers: {'mailtrap-signature': await hmacHex('c'.repeat(32), signedBody)}
		});
		expect(res.status).toBe(200);

		await settingService.set(c, {sendWebhookStrict: 0, sendWebhookSecrets: {mailtrap: ''}});
		const setting = await settingService.query(c);
		expect(setting.sendWebhookSecrets.mailtrap).toBe('');
		expect(Number(setting.sendWebhookStrict)).toBe(0);
	});
});
