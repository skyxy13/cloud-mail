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

	it('masks tokens', () => {
		expect(sendProviderService.maskProviders({ 'example.com': { provider: 'plunk', token: 'sk_123456789012345' } }))
			.toEqual({ 'example.com': { provider: 'plunk', token: 'sk_123456789******' } });
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

	it('resend body via sdk', async () => {
		const calls = mockFetch({ id: 'resend-id' });
		const result = await sendProviderService.send({ provider: 'resend', token: 're' }, message);
		expect(calls[0].url).toContain('api.resend.com/emails');
		expect(result.id).toBe('resend-id');
	});

	it('throws readable error', async () => {
		mockFetch({ message: 'Invalid API key' }, 401);
		await expect(sendProviderService.send({ provider: 'mailtrap', token: 'bad' }, message))
			.rejects.toThrow(/Mailtrap 401: Invalid API key/);
	});
});
