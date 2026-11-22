import { Resend } from 'resend';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// 发件服务商：与 setting.send_providers 中保存的 provider 字段、前端下拉选项保持一致
export const sendProviderConst = {
	RESEND: 'resend',
	MAILTRAP: 'mailtrap',
	AHASEND: 'ahasend',
	PLUNK: 'plunk'
};

// accountId 表示除 API Key 外还需要账户 ID（AhaSend v2 接口需要）
export const sendProviderList = [
	{ id: sendProviderConst.RESEND, name: 'Resend', tokenHint: 're_xxxxxxxx', accountId: false },
	{ id: sendProviderConst.MAILTRAP, name: 'Mailtrap', tokenHint: 'Mailtrap API Token', accountId: false },
	{ id: sendProviderConst.AHASEND, name: 'AhaSend', tokenHint: 'AhaSend API Key', accountId: true },
	{ id: sendProviderConst.PLUNK, name: 'Plunk', tokenHint: 'sk_xxxxxxxx', accountId: false }
];

// 各服务商的单封邮件体积限制（正文 + 附件，未编码前的字节数），用于发件前校验：
// Resend 单封 40MB；Mailtrap 单封 10MB（Business 及以上可申请到 30MB）；
// AhaSend 整封 20MiB（请求体 30MB）；Plunk 附件合计 10MB。
const providerLimitTable = {
	resend: { maxAttachments: 10, maxTotalBytes: 40 * 1024 * 1024 },
	mailtrap: { maxAttachments: 10, maxTotalBytes: 10 * 1024 * 1024 },
	ahasend: { maxAttachments: 10, maxTotalBytes: 20 * 1024 * 1024 },
	plunk: { maxAttachments: 10, maxTotalBytes: 10 * 1024 * 1024 }
};

// 把体积限制挂到列表项上，前端可直接展示
sendProviderList.forEach(item => {
	const limit = providerLimitTable[item.id];
	item.limits = limit ? { ...limit, maxTotalText: formatSize(limit.maxTotalBytes) } : null;
});

const providerIds = sendProviderList.map(item => item.id);
const MASK = '******';
const REQUEST_TIMEOUT = 30000;


function formatSize(bytes) {
	if (!bytes) return '0';
	if (bytes >= 1024 * 1024) {
		return (bytes / 1024 / 1024).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1) + 'MB';
	}
	return Math.ceil(bytes / 1024) + 'KB';
}

function toJson(value, fallback = {}) {
	if (!value) return fallback;
	if (typeof value === 'object') return value;
	try {
		return JSON.parse(value) || fallback;
	} catch (e) {
		return fallback;
	}
}

// 统一成 { provider, token, accountId }；直接是字符串时按旧版 Resend Token 处理
function normalizeEntry(entry) {
	if (!entry) return null;
	if (typeof entry === 'string') {
		const token = entry.trim();
		return token ? { provider: sendProviderConst.RESEND, token, accountId: '' } : null;
	}
	const token = typeof entry.token === 'string' ? entry.token.trim() : '';
	if (!token) return null;
	return {
		provider: providerIds.includes(entry.provider) ? entry.provider : sendProviderConst.RESEND,
		token,
		accountId: typeof entry.accountId === 'string' ? entry.accountId.trim() : ''
	};
}

function formatFrom(from) {
	const name = (from?.name || '').trim();
	if (!name) return from.email;
	return name + ' <' + from.email + '>';
}

function toAddressList(list) {
	return (list || []).map(address => ({ email: address }));
}

function stripContentId(contentId) {
	return String(contentId).replace(/^</, '').replace(/>$/, '');
}

function escapeHtml(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function errorMessage(body, text) {
	if (body && typeof body === 'object') {
		if (typeof body.message === 'string' && body.message) return body.message;
		if (typeof body.error === 'string' && body.error) return body.error;
		if (typeof body.detail === 'string' && body.detail) return body.detail;
		if (typeof body.status === 'string' && body.status) return body.status;
		if (Array.isArray(body.errors) && body.errors.length > 0) {
			return body.errors.map(item => typeof item === 'string' ? item : (item?.message || JSON.stringify(item))).join('; ');
		}
		if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') return body.error.message;
	}
	return (text || '').slice(0, 200);
}

async function requestJson(url, options, providerName) {
	let response;
	try {
		response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
	} catch (e) {
		throw new BizError(providerName + ': ' + e.message);
	}

	const text = await response.text();
	let body = {};
	if (text) {
		try {
			body = JSON.parse(text);
		} catch (e) {
			body = { raw: text };
		}
	}

	if (!response.ok) {
		throw new BizError(providerName + ' ' + response.status + ': ' + errorMessage(body, text));
	}

	return body;
}

const sendProviderService = {

	sendProviderList,
	sendProviderConst,
	providerLimitTable,

	// 取某服务商的体积限制，附带展示用的名字
	limits(providerId) {
		const limit = providerLimitTable[providerId] || providerLimitTable[sendProviderConst.RESEND];
		const item = sendProviderList.find(option => option.id === providerId);
		return {
			provider: providerId,
			name: item?.name || providerId,
			maxAttachments: limit.maxAttachments,
			maxTotalBytes: limit.maxTotalBytes,
			maxTotalText: formatSize(limit.maxTotalBytes)
		};
	},

	formatSize,

	// 读取数据库/KV 中的配置，兼容旧版只配置 Resend Token 的站点
	parseProviders(value, legacyResendTokens) {
		const providers = {};
		const source = toJson(value, {});

		Object.keys(source).forEach(domain => {
			const entry = normalizeEntry(source[domain]);
			if (entry) providers[domain] = entry;
		});

		const legacy = toJson(legacyResendTokens, {});
		Object.keys(legacy).forEach(domain => {
			if (providers[domain]) return;
			const entry = normalizeEntry(legacy[domain]);
			if (entry) providers[domain] = { provider: sendProviderConst.RESEND, token: entry.token, accountId: '' };
		});

		return providers;
	},

	// 合并前端提交的单条配置：token 为空表示删除，回传脱敏值表示不修改
	mergeProviders(current, incoming) {
		const providers = { ...toJson(current, {}) };
		const source = toJson(incoming, {});

		Object.keys(source).forEach(domain => {
			const raw = source[domain];
			const token = typeof raw === 'string' ? raw : raw?.token;
			const existing = providers[domain];

			// 回传的脱敏 token 表示不修改密钥，只更新服务商/账户 ID
			if (typeof token === 'string' && token.includes(MASK) && existing) {
				providers[domain] = {
					provider: providerIds.includes(raw.provider) ? raw.provider : existing.provider,
					token: existing.token,
					accountId: typeof raw.accountId === 'string' ? raw.accountId.trim() : existing.accountId
				};
				return;
			}

			const entry = normalizeEntry(raw);
			if (entry) {
				providers[domain] = entry;
			} else {
				delete providers[domain];
			}
		});

		return providers;
	},

	maskProviders(providers) {
		const result = {};
		Object.keys(providers || {}).forEach(domain => {
			const entry = providers[domain];
			result[domain] = {
				...entry,
				token: entry.token ? entry.token.slice(0, 12) + MASK : ''
			};
		});
		return result;
	},

	async send(config, message) {
		const entry = normalizeEntry(config);
		if (!entry) {
			throw new BizError(t('noSendProvider'));
		}

		if (entry.provider === sendProviderConst.MAILTRAP) return this.sendMailtrap(entry, message);
		if (entry.provider === sendProviderConst.AHASEND) return this.sendAhaSend(entry, message);
		if (entry.provider === sendProviderConst.PLUNK) return this.sendPlunk(entry, message);
		return this.sendResend(entry, message);
	},

	// Resend：官方 SDK，附件支持 filePath/内容二选一，这里统一传 base64 内容
	async sendResend({ token }, message) {
		const resend = new Resend(token);

		const sendForm = {
			from: formatFrom(message.from),
			to: message.to,
			subject: message.subject
		};

		if (message.cc?.length > 0) sendForm.cc = message.cc;
		if (message.bcc?.length > 0) sendForm.bcc = message.bcc;
		if (message.text) sendForm.text = message.text;
		if (message.html) sendForm.html = message.html;
		if (message.headers && Object.keys(message.headers).length > 0) sendForm.headers = message.headers;

		if (message.attachments?.length > 0) {
			sendForm.attachments = message.attachments.map(item => ({
				filename: item.filename,
				content: item.content,
				...(item.contentType ? { contentType: item.contentType } : {}),
				...(item.contentId ? { contentId: stripContentId(item.contentId) } : {})
			}));
		}

		const result = await resend.emails.send(sendForm);

		if (result.error) {
			const name = result.error.name ? result.error.name + ': ' : '';
			throw new BizError('Resend: ' + name + (result.error.message || 'send failed'));
		}

		return { id: result.data?.id ?? null };
	},

	// Mailtrap：POST https://send.api.mailtrap.io/api/send
	async sendMailtrap({ token }, message) {
		const body = {
			from: { email: message.from.email, ...(message.from.name ? { name: message.from.name } : {}) },
			to: toAddressList(message.to),
			subject: message.subject
		};

		if (message.cc?.length > 0) body.cc = toAddressList(message.cc);
		if (message.bcc?.length > 0) body.bcc = toAddressList(message.bcc);
		if (message.text) body.text = message.text;
		if (message.html) body.html = message.html;
		if (message.headers && Object.keys(message.headers).length > 0) body.headers = message.headers;

		if (message.attachments?.length > 0) {
			body.attachments = message.attachments.map(item => ({
				filename: item.filename,
				content: item.content,
				type: item.contentType,
				disposition: item.contentId ? 'inline' : 'attachment',
				...(item.contentId ? { content_id: stripContentId(item.contentId) } : {})
			}));
		}

		const result = await requestJson('https://send.api.mailtrap.io/api/send', {
			method: 'POST',
			headers: { 'Api-Token': token, 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}, 'Mailtrap');

		return { id: result.message_ids?.[0] ?? null };
	},

	// AhaSend：配置账户 ID 时用 v2（支持抄送密送），否则用 v1 单接口
	async sendAhaSend({ token, accountId }, message) {
		const attachments = (message.attachments || []).map(item => ({
			data: item.content,
			base64: true,
			file_name: item.filename,
			content_type: item.contentType,
			...(item.contentId ? { content_id: stripContentId(item.contentId) } : {})
		}));

		const from = { email: message.from.email, ...(message.from.name ? { name: message.from.name } : {}) };

		if (!accountId) {
			// v1 不支持抄送密送：并入收件人列表，AhaSend 会为每位收件人单独投递
			const recipients = [...message.to, ...(message.cc || []), ...(message.bcc || [])].map(email => ({ email }));
			const result = await requestJson('https://api.ahasend.com/v1/email/send', {
				method: 'POST',
				headers: { 'X-Api-Key': token, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					from,
					recipients,
					content: {
						subject: message.subject,
						...(message.text ? { text_body: message.text } : {}),
						...(message.html ? { html_body: message.html } : {}),
						...(attachments.length > 0 ? { attachments } : {}),
						...(message.headers && Object.keys(message.headers).length > 0 ? { headers: message.headers } : {})
					}
				})
			}, 'AhaSend');

			if (!result.success_count && result.fail_count) {
				throw new BizError('AhaSend: ' + errorMessage(result));
			}

			return { id: null };
		}

		const conversation = message.cc?.length > 0 || message.bcc?.length > 0;
		const url = 'https://api.ahasend.com/v2/accounts/' + encodeURIComponent(accountId) + '/messages' + (conversation ? '/conversation' : '');

		const body = {
			from,
			subject: message.subject,
			...(message.text ? { text_content: message.text } : {}),
			...(message.html ? { html_content: message.html } : {}),
			...(attachments.length > 0 ? { attachments } : {}),
			...(message.headers && Object.keys(message.headers).length > 0 ? { headers: message.headers } : {})
		};

		if (conversation) {
			body.to = toAddressList(message.to);
			if (message.cc?.length > 0) body.cc = toAddressList(message.cc);
			if (message.bcc?.length > 0) body.bcc = toAddressList(message.bcc);
		} else {
			body.recipients = toAddressList(message.to);
		}

		const result = await requestJson(url, {
			method: 'POST',
			headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}, 'AhaSend');

		const items = Array.isArray(result.data) ? result.data : [];
		const sent = items.find(item => item.status !== 'error' && item.id);
		if (!sent && items.length > 0) {
			throw new BizError('AhaSend: ' + (items.map(item => item.error).filter(Boolean).join('; ') || 'send failed'));
		}

		return { id: sent?.id ?? null };
	},

	// Plunk：POST https://api.useplunk.com/v1/send，只接受 HTML 正文，没有抄送密送字段
	async sendPlunk({ token }, message) {
		// Plunk 会为每位收件人单独投递，抄送密送并入收件人列表，彼此不会看到其他地址
		const recipients = [...message.to, ...(message.cc || []), ...(message.bcc || [])];

		const body = {
			to: recipients,
			subject: message.subject,
			body: message.html || '<div>' + escapeHtml(message.text || '').replace(/\r?\n/g, '<br>') + '</div>',
			from: { email: message.from.email, ...(message.from.name ? { name: message.from.name } : {}) }
		};

		if (message.headers && Object.keys(message.headers).length > 0) body.headers = message.headers;

		if (message.attachments?.length > 0) {
			body.attachments = message.attachments.map(item => ({
				filename: item.filename,
				content: item.content,
				contentType: item.contentType,
				disposition: item.contentId ? 'inline' : 'attachment',
				...(item.contentId ? { contentId: stripContentId(item.contentId) } : {})
			}));
		}

		const result = await requestJson('https://api.useplunk.com/v1/send', {
			method: 'POST',
			headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}, 'Plunk');

		const emails = result?.data?.emails || [];
		const sent = emails.find(item => item.status !== 'throttled' && item.email);

		return { id: sent?.email ?? null };
	}
};

export default sendProviderService;
