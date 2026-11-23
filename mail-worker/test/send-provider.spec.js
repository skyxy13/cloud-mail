import { describe, it, expect, vi, beforeEach } from 'vitest';
import sendProviderService from '../src/service/send-provider-service';

const message = {
	from: { email: 'noreply@example.com', name: 'Demo' },
	to: ['a@test.com', 'b@test.com'],
	cc: ['cc@test.com'],
	bcc: ['bcc@test.com'],
	subject: 'Hi',
	text: 'plain text',
	html: '<p>hello</p>',
	headers: { 'in-reply-to': '<1@test.com>' },
	attachments: [{ filename: 'a.txt', content: 'aGVsbG8=', contentType: 'text/plain', contentId: null }]
};

function mockFetch(json, status = 200) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, options) => {
		calls.push({ url: String(url), options });
		return new Response(JSON.stringify(json), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	});
	return calls;
}

describe('send provider config', () => {
	it('normalizes old resend token map', () => {
		const providers = sendProviderService.parseProviders('{}', { 'example.com': 're_abc' });
		expect(providers['example.com']).toEqual({ provider: 'resend', token: 're_abc', accountId: '' });
	});

	it('merges new config and deletes on empty token', () => {
		let providers = sendProviderService.mergeProviders({ 'example.com': { provider: 'resend', token: 're_1', accountId: '' } }, {
			'example.com': { provider: 'mailtrap', token: 'mt_1' },
			'other.com': { provider: 'plunk', token: 'sk_1' }
		});
		expect(providers['example.com']).toEqual({ provider: 'mailtrap', token: 'mt_1', accountId: '' });
		expect(providers['other.com']).toEqual({ provider: 'plunk', token: 'sk_1', accountId: '' });

		providers = sendProviderService.mergeProviders(providers, { 'other.com': { token: '' } });
		expect(providers['other.com']).toBeUndefined();
	});

	it('keeps token when masked value is echoed back', () => {
		const providers = sendProviderService.mergeProviders({ 'example.com': { provider: 'plunk', token: 'sk_secret' } }, {
			'example.com': { provider: 'plunk', token: 'sk_secret******' }
		});
		expect(providers['example.com'].token).toBe('sk_secret');
	});

	it('applies provider switch when masked token is echoed back', () => {
		const providers = sendProviderService.mergeProviders({ 'example.com': { provider: 'resend', token: 're_secret', accountId: '' } }, {
			'example.com': { provider: 'mailtrap', token: 're_secret******', accountId: '' }
		});
		expect(providers['example.com']).toEqual({ provider: 'mailtrap', token: 're_secret', accountId: '' });
	});

	it('masks and preserves backup token', () => {
		const masked = sendProviderService.maskProviders({
			'example.com': {provider: 'resend', token: 're_123456789012345', backup: {provider: 'plunk', token: 'sk_abcdefghijklm'}}
		});
		expect(masked['example.com'].token).toBe('re_123456789******');
		expect(masked['example.com'].backup.token).toBe('sk_abcdefghi******');

		const merged = sendProviderService.mergeProviders(
			{'example.com': {provider: 'resend', token: 're_real', backup: {provider: 'plunk', token: 'sk_real'}}},
			{'example.com': {provider: 'mailtrap', token: 're_real******', backup: {provider: 'plunk', token: 'sk_real******'}}}
		);
		expect(merged['example.com'].provider).toBe('mailtrap');
		expect(merged['example.com'].token).toBe('re_real');
		expect(merged['example.com'].backup).toEqual({provider: 'plunk', token: 'sk_real', accountId: ''});
	});

	it('masks tokens', () => {
		expect(sendProviderService.maskProviders({ 'example.com': { provider: 'plunk', token: 'sk_123456789012345' } }))
			.toEqual({ 'example.com': { provider: 'plunk', token: 'sk_123456789******' } });
	});
});

describe('provider limits', () => {
	it('exposes per provider size limits', () => {
		const mailtrap = sendProviderService.limits('mailtrap');
		expect(mailtrap).toMatchObject({provider: 'mailtrap', name: 'Mailtrap', maxAttachments: 10});
		expect(mailtrap.maxTotalBytes).toBe(10 * 1024 * 1024);
		expect(mailtrap.maxTotalText).toBe('10MB');
		expect(sendProviderService.limits('ahasend').maxTotalText).toBe('20MB');
		expect(sendProviderService.limits('unknown-provider').maxTotalText).toBe('40MB');
	});

	it('rejects attachments over the provider limit', async () => {
		const emailService = (await import('../src/service/email-service')).default;
		const big = { filename: 'a.bin', content: 'A'.repeat(9 * 1024 * 1024) };
		const sendParams = {attachments: [big], html: '', text: ''};

		// Mailtrap 单封 10MB，9MB 的 base64 约 6.75MB，可以过
		expect(() => emailService.checkAttachLimit({provider: 'mailtrap'}, sendParams)).not.toThrow();
		// Plunk 只有 10MB，但附件数超限时先报个数
		expect(() => emailService.checkAttachLimit({provider: 'plunk'}, {
			attachments: new Array(11).fill(big), html: '', text: ''
		})).toThrow(/Plunk/);
		// 超体积
		expect(() => emailService.checkAttachLimit({provider: 'plunk'}, {
			attachments: [{ filename: 'b.bin', content: 'A'.repeat(15 * 1024 * 1024) }], html: '', text: ''
		})).toThrow(/10MB/);
	});
});

describe('provider requests', () => {
	beforeEach(() => { vi.restoreAllMocks(); });

	it('mailtrap body', async () => {
		const calls = mockFetch({ success: true, message_ids: ['mt-id'] });
		const result = await sendProviderService.send({ provider: 'mailtrap', token: 'tok' }, message);
		expect(result.id).toBe('mt-id');
		expect(calls[0].url).toBe('https://send.api.mailtrap.io/api/send');
		expect(calls[0].options.headers['Api-Token']).toBe('tok');
		const body = JSON.parse(calls[0].options.body);
		expect(body.from).toEqual({ email: 'noreply@example.com', name: 'Demo' });
		expect(body.to).toEqual([{ email: 'a@test.com' }, { email: 'b@test.com' }]);
		expect(body.cc).toEqual([{ email: 'cc@test.com' }]);
		expect(body.bcc).toEqual([{ email: 'bcc@test.com' }]);
		expect(body.attachments[0]).toMatchObject({ filename: 'a.txt', type: 'text/plain', disposition: 'attachment' });
		expect(body.headers).toEqual({ 'in-reply-to': '<1@test.com>' });
	});

	it('ahasend v1 body', async () => {
		const calls = mockFetch({ success_count: 1, fail_count: 0 });
		await sendProviderService.send({ provider: 'ahasend', token: 'tok' }, message);
		expect(calls[0].url).toBe('https://api.ahasend.com/v1/email/send');
		expect(calls[0].options.headers['X-Api-Key']).toBe('tok');
		const body = JSON.parse(calls[0].options.body);
		expect(body.recipients.map(item => item.email)).toEqual(['a@test.com', 'b@test.com', 'cc@test.com', 'bcc@test.com']);
		expect(body.content.html_body).toBe('<p>hello</p>');
		expect(body.content.attachments[0]).toMatchObject({ file_name: 'a.txt', content_type: 'text/plain', base64: true });
	});

	it('ahasend v2 conversation body', async () => {
		const calls = mockFetch({ object: 'list', data: [{ id: 'as-id', status: 'queued' }] });
		const result = await sendProviderService.send({ provider: 'ahasend', token: 'tok', accountId: 'acc-1' }, message);
		expect(result.id).toBe('as-id');
		expect(calls[0].url).toBe('https://api.ahasend.com/v2/accounts/acc-1/messages/conversation');
		const body = JSON.parse(calls[0].options.body);
		expect(body.cc).toEqual([{ email: 'cc@test.com' }]);
		expect(body.bcc).toEqual([{ email: 'bcc@test.com' }]);
		expect(body.html_content).toBe('<p>hello</p>');
	});

	it('plunk body', async () => {
		const calls = mockFetch({ success: true, data: { emails: [{ email: 'plunk-id', status: 'queued' }] } });
		const result = await sendProviderService.send({ provider: 'plunk', token: 'sk' }, message);
		expect(result.id).toBe('plunk-id');
		expect(calls[0].url).toBe('https://api.useplunk.com/v1/send');
		const body = JSON.parse(calls[0].options.body);
		expect(body.to).toEqual(['a@test.com', 'b@test.com', 'cc@test.com', 'bcc@test.com']);
		expect(body.body).toBe('<p>hello</p>');
		expect(body.from).toEqual({ email: 'noreply@example.com', name: 'Demo' });
		expect(body.attachments[0]).toMatchObject({ filename: 'a.txt', contentType: 'text/plain', disposition: 'attachment' });
	});

	it('sendflare body and failure handling', async () => {
		const calls = mockFetch({requestId: 'req-1', code: 200, success: true, message: 'ok'});
		const result = await sendProviderService.send({provider: 'sendflare', token: 'tok'}, {
			...message, replyTo: 'reply@example.com'
		});

		expect(calls[0].url).toBe('https://api.sendflare.com/v1/send');
		expect(calls[0].options.headers.Authorization).toBe('Bearer tok');
		const body = JSON.parse(calls[0].options.body);
		expect(body.from).toBe('Demo <noreply@example.com>');
		expect(body.to).toBe('a@test.com');
		expect(body.subject).toBe('Hi');
		expect(body.body).toBe('<p>hello</p>');
		expect(body.cc).toEqual(['cc@test.com']);
		expect(body.bcc).toEqual(['bcc@test.com']);
		expect(body.replyTo).toEqual(['reply@example.com']);
		expect(body.attachments[0]).toMatchObject({filename: 'a.txt', contentType: 'text/plain', disposition: 'attachment'});
		expect(result.id).toBe('req-1');

		// 成功响应里有 data.emailId 时用它当邮件 ID
		mockFetch({requestId: 'req-2', code: 0, success: true, data: {emailId: 'mail-9'}});
		const withId = await sendProviderService.send({provider: 'sendflare', token: 'tok'}, message);
		expect(withId.id).toBe('mail-9');
		expect(result.provider).toBe('sendflare');

		// success=false 要抛错，不能当成功
		mockFetch({requestId: 'req-2', success: false, message: 'domain not verified'});
		await expect(sendProviderService.send({provider: 'sendflare', token: 'tok'}, message))
			.rejects.toThrow(/domain not verified/);
	});

	it('resend body via sdk', async () => {
		const calls = mockFetch({ id: 'resend-id' });
		const result = await sendProviderService.send({ provider: 'resend', token: 're' }, message);
		expect(calls[0].url).toContain('api.resend.com/emails');
		expect(result.id).toBe('resend-id');
	});

	it('retries on 429 then succeeds', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url) => {
			calls.push(String(url));
			if (calls.length === 1) {
				return new Response(JSON.stringify({errors: ['rate limited']}), {status: 429, headers: {'content-type': 'application/json'}});
			}
			return new Response(JSON.stringify({success: true, message_ids: ['ok-id']}), {status: 200, headers: {'content-type': 'application/json'}});
		});

		const result = await sendProviderService.send({provider: 'mailtrap', token: 't'}, message);
		expect(calls.length).toBe(2);
		expect(result.id).toBe('ok-id');
		expect(result.provider).toBe('mailtrap');
	});

	it('fails over to the backup provider when the primary is rejected', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url) => {
			calls.push(String(url));
			if (String(url).includes('mailtrap')) {
				return new Response(JSON.stringify({errors: ['invalid api key']}), {status: 403, headers: {'content-type': 'application/json'}});
			}
			return new Response(JSON.stringify({success: true, data: {emails: [{email: 'plunk-id', status: 'queued'}]}}), {status: 200, headers: {'content-type': 'application/json'}});
		});

		const result = await sendProviderService.send({
			provider: 'mailtrap', token: 'bad',
			backup: {provider: 'plunk', token: 'sk'}
		}, message);

		expect(calls.some(url => url.includes('mailtrap'))).toBe(true);
		expect(calls.some(url => url.includes('useplunk'))).toBe(true);
		expect(result.provider).toBe('plunk');
		expect(result.id).toBe('plunk-id');
	});

	it('does not fail over on network errors', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url) => {
			calls.push(String(url));
			throw new Error('connection reset');
		});

		await expect(sendProviderService.send({
			provider: 'mailtrap', token: 't', backup: {provider: 'plunk', token: 'sk'}
		}, message)).rejects.toThrow(/connection reset/);

		expect(calls.every(url => url.includes('mailtrap'))).toBe(true);
	});

	it('throws readable error', async () => {
		mockFetch({ message: 'Invalid API key' }, 401);
		await expect(sendProviderService.send({ provider: 'mailtrap', token: 'bad' }, message))
			.rejects.toThrow(/Mailtrap 401: Invalid API key/);
	});
});
