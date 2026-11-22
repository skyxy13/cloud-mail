import emailService from './email-service';
import settingService from './setting-service';
import BizError from '../error/biz-error';
import { emailConst } from '../const/entity-const';
import { sendProviderConst } from './send-provider-service';

const emailStatus = emailConst.status;
// 校验回调时间戳的有效期，防止重放
const TIMESTAMP_TOLERANCE = 5 * 60;
// 已处理事件的缓存时长（秒），用于回调重复投递去重
const EVENT_CACHE_TTL = 7 * 24 * 60 * 60;

// 状态优先级：数值越大越"终态"，只允许单向升级，避免乱序回调把终态改回去
const statusRank = {
	[emailStatus.SENT]: 10,
	[emailStatus.DELAYED]: 20,
	[emailStatus.DELIVERED]: 30,
	[emailStatus.COMPLAINED]: 40,
	[emailStatus.BOUNCED]: 45,
	[emailStatus.FAILED]: 50
};

// 允许被 status 覆盖的当前状态列表（优先级更低的那些）
function allowedFromStatuses(status) {
	const rank = statusRank[status];
	if (!rank) return [];
	return Object.keys(statusRank)
		.filter(key => statusRank[key] < rank)
		.map(key => Number(key));
}

// Resend 事件 → 发件状态（保持原有行为）
const resendEvents = {
	'email.sent': emailStatus.SENT,
	'email.delivered': emailStatus.DELIVERED,
	'email.complained': emailStatus.COMPLAINED,
	'email.bounced': emailStatus.BOUNCED,
	'email.delivery_delayed': emailStatus.DELAYED,
	'email.failed': emailStatus.FAILED
};

// Mailtrap 事件 → 发件状态，null 表示不需要改状态（打开、点击、退订）
const mailtrapEvents = {
	'delivery': emailStatus.DELIVERED,
	'bounce': emailStatus.BOUNCED,
	'soft bounce': emailStatus.DELAYED,
	'spam': emailStatus.COMPLAINED,
	'suspension': emailStatus.FAILED,
	'reject': emailStatus.FAILED,
	'open': null,
	'click': null,
	'unsubscribe': null
};

// AhaSend 事件 → 发件状态，null 表示不需要改状态
const ahaSendEvents = {
	'message.delivered': emailStatus.DELIVERED,
	'message.bounced': emailStatus.BOUNCED,
	'message.complained': emailStatus.COMPLAINED,
	'message.transient_error': emailStatus.DELAYED,
	'message.failed': emailStatus.FAILED,
	'message.suppressed': emailStatus.FAILED,
	'message.opened': null,
	'message.clicked': null,
	'message.unsubscribed': null,
	'message.reception': null,
	'message.routing': null
};

// Plunk 事件 → 发件状态，null 表示不需要改状态
const plunkEvents = {
	'email.delivery': emailStatus.DELIVERED,
	'email.delivered': emailStatus.DELIVERED,
	'email.bounce': emailStatus.BOUNCED,
	'email.bounced': emailStatus.BOUNCED,
	'email.complaint': emailStatus.COMPLAINED,
	'email.complained': emailStatus.COMPLAINED,
	'email.sent': null,
	'email.open': null,
	'email.click': null
};

function textEncoder() {
	return new TextEncoder();
}

function bytesToBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToBytes(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytesToHex(bytes) {
	return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret, message, encoding = 'base64') {
	const key = await crypto.subtle.importKey(
		'raw', typeof secret === 'string' ? textEncoder().encode(secret) : secret,
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder().encode(message)));
	return encoding === 'hex' ? bytesToHex(signature) : bytesToBase64(signature);
}

// 定长比较，避免通过响应时间猜测签名
function safeEqual(left, right) {
	if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < left.length; i++) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return diff === 0;
}

// 服务商返回的邮件 ID 格式不一致（<uuid@domain>、uuid），统一成可比较的形式
function normalizeMessageId(id) {
	if (!id) return null;
	let value = String(id).trim().replace(/^</, '').replace(/>$/, '');
	const at = value.indexOf('@');
	if (at > 0) value = value.slice(0, at);
	return value || null;
}

function parseBody(raw) {
	const text = (raw || '').trim();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch (e) {
		// Mailtrap 可选 JSON Lines 格式：一行一个事件
		const events = [];
		for (const line of text.split('\n')) {
			const item = line.trim();
			if (!item) continue;
			try {
				events.push(JSON.parse(item));
			} catch (error) {
				throw new BizError('invalid webhook payload', 400);
			}
		}
		return { events };
	}
}

function pickDetail(source, keys) {
	if (!source || typeof source !== 'object') return null;
	const detail = {};
	keys.forEach(key => {
		if (source[key] !== undefined && source[key] !== null) detail[key] = source[key];
	});
	return Object.keys(detail).length > 0 ? JSON.stringify(detail) : null;
}

const sendWebhookService = {

	statusRank,
	allowedFromStatuses,

	// webhook 校验密钥按服务商单独配置，留空表示不校验
	async secret(c, provider) {
		const { sendWebhookSecrets } = await settingService.query(c);
		return sendWebhookSecrets?.[provider] || '';
	},

	// Mailtrap：Mailtrap-Signature = hex(HMAC-SHA256(rawBody, secret))
	async verifyMailtrap(c, rawBody, secret) {
		const signature = c.req.header('mailtrap-signature');
		if (!signature) return false;
		const expected = await hmac(secret, rawBody, 'hex');
		return safeEqual(signature.trim().toLowerCase(), expected.toLowerCase());
	},

	// Resend / AhaSend：Standard Webhooks 规范，signature = base64(HMAC-SHA256(id.timestamp.body, secret))
	async verifyStandard(c, rawBody, secret, headers) {
		const id = c.req.header(headers.id);
		const timestamp = Number(c.req.header(headers.timestamp));
		const signature = c.req.header(headers.signature) || '';
		if (!id || !signature || !Number.isFinite(timestamp)) return false;
		if (Math.abs(Date.now() / 1000 - timestamp) > TIMESTAMP_TOLERANCE) return false;

		// 生产环境里的密钥形如 whsec_<base64>，HMAC 的 key 是解码后的字节
		let key = secret;
		const raw = secret.replace(/^whsec_/, '');
		try {
			key = base64ToBytes(raw);
		} catch (e) {
			key = secret;
		}

		const expected = await hmac(key, id + '.' + timestamp + '.' + rawBody, 'base64');
		// 头部可能是多个以空格分隔的 v1,<signature>
		return signature.split(' ').some(item => {
			const part = item.includes(',') ? item.split(',')[1] : item;
			return safeEqual(part.trim(), expected);
		});
	},

	// Plunk 没有签名机制，用共享 token（Authorization: Bearer xxx 或 X-Webhook-Token）校验
	verifyPlunk(c, secret) {
		const authorization = c.req.header('authorization') || '';
		const token = c.req.header('x-webhook-token') || authorization.replace(/^Bearer\s+/i, '');
		return safeEqual(token.trim(), secret);
	},

	async verify(c, provider, rawBody, secret) {
		if (!secret) return true;

		if (provider === sendProviderConst.MAILTRAP) {
			return this.verifyMailtrap(c, rawBody, secret);
		}

		if (provider === sendProviderConst.AHASEND) {
			return this.verifyStandard(c, rawBody, secret, {
				id: 'webhook-id', timestamp: 'webhook-timestamp', signature: 'webhook-signature'
			});
		}

		if (provider === sendProviderConst.PLUNK) {
			return this.verifyPlunk(c, secret);
		}

		return this.verifyStandard(c, rawBody, secret, {
			id: 'svix-id', timestamp: 'svix-timestamp', signature: 'svix-signature'
		});
	},

	toEvents(body) {
		if (Array.isArray(body)) return body;
		if (body && Array.isArray(body.events)) return body.events;
		if (body && typeof body === 'object' && Object.keys(body).length > 0) return [body];
		return [];
	},

	// 把各服务商的事件转换成 { providerId, status, message }，返回 null 表示忽略
	mapEvent(provider, event) {
		if (!event || typeof event !== 'object') return null;

		if (provider === sendProviderConst.MAILTRAP) {
			const type = String(event.event || '').toLowerCase();
			const status = mailtrapEvents[type];
			if (!status) return null;
			return {
				providerId: event.message_id,
				status,
				message: status === emailStatus.DELIVERED ? null
					: pickDetail(event, ['response', 'response_code', 'bounce_category', 'reason'])
			};
		}

		if (provider === sendProviderConst.AHASEND) {
			const status = ahaSendEvents[event.type];
			if (!status) return null;
			const data = event.data || {};
			return {
				providerId: data.id,
				status,
				message: status === emailStatus.DELIVERED ? null
					: pickDetail(data.delivery_attempt || data, ['classification', 'smtp_code', 'enhanced_status_code', 'response', 'reason'])
			};
		}

		if (provider === sendProviderConst.PLUNK) {
			const data = typeof event.event === 'object' && event.event ? event.event : (event.data || event);
			const type = String(event.type || event.event_type || data.type || '').toLowerCase();
			let status = plunkEvents[type];
			if (status === undefined) {
				// Plunk 默认载荷不带事件名，用事件字段判断
				if (data.bouncedAt || data.bounceType) status = emailStatus.BOUNCED;
				else if (data.complainedAt || data.feedbackType) status = emailStatus.COMPLAINED;
				else if (data.deliveredAt) status = emailStatus.DELIVERED;
				else status = null;
			}
			if (!status) return null;
			return {
				providerId: data.emailId || data.email_id || event.emailId || event.email_id || data.id,
				status,
				message: status === emailStatus.DELIVERED ? null
					: pickDetail(data, ['bounceType', 'bouncedAt', 'messageId', 'feedbackType'])
			};
		}

		const status = resendEvents[event.type];
		if (!status) return null;
		const data = event.data || {};
		return {
			providerId: data.email_id,
			status,
			message: status === emailStatus.DELIVERED || status === emailStatus.SENT
				? null
				: (data.bounce ? JSON.stringify(data.bounce) : (data.failed?.reason || null))
		};
	},

	// 历史数据里存的是服务商返回的原始 ID，两种形式都试一次
	async applyStatus(c, provider, providerId, status, message) {
		const ids = [...new Set([providerId, normalizeMessageId(providerId)].filter(Boolean))];
		if (ids.length === 0) return null;

		const fromStatuses = allowedFromStatuses(status);

		for (const id of ids) {
			const emailRow = await emailService.updateEmailStatus(c, {
				resendEmailId: id, status, message, fromStatuses, provider
			});
			if (emailRow) return emailRow;
		}

		// 没更新成功：可能是已经处于更高优先级的状态（乱序回调），也可能是未知邮件
		const exists = await emailService.selectByResendEmailId(c, ids);
		if (exists) {
			if (exists.provider && exists.provider !== provider) {
				console.warn(provider + ' webhook: provider mismatch, email was sent by ' + exists.provider);
			}
			return { ignored: true, currentStatus: exists.status };
		}

		// 未知邮件事件（历史数据、测试事件）：记录日志后正常返回，
		// 避免服务商因连续收到 500 而熔断关闭 Webhook
		console.warn(provider + ' webhook: unknown email id ' + providerId + ', status ' + status);
		return null;
	},

	async strict(c) {
		const { sendWebhookStrict } = await settingService.query(c);
		return Number(sendWebhookStrict) === 1;
	},

	// 事件唯一标识：用于忽略服务商的重复投递
	eventId(provider, event, c) {
		if (provider === sendProviderConst.MAILTRAP) return event.event_id || null;
		if (provider === sendProviderConst.AHASEND) return event.webhook_id || null;
		if (provider === sendProviderConst.PLUNK) {
			const data = typeof event.event === 'object' && event.event ? event.event : (event.data || event);
			const time = data.bouncedAt || data.deliveredAt || data.complainedAt || data.sentAt || '';
			return data.emailId && time ? data.emailId + ':' + time : null;
		}
		return c.req.header('svix-id') || null;
	},

	async isDuplicate(c, provider, eventId) {
		if (!eventId || !c.env.kv) return false;
		const key = 'webhook_event:' + provider + ':' + eventId;
		if (await c.env.kv.get(key)) return true;
		await c.env.kv.put(key, '1', { expirationTtl: EVENT_CACHE_TTL });
		return false;
	},

	async handle(c, provider) {
		const rawBody = await c.req.text();
		const secret = await this.secret(c, provider);

		if (!secret) {
			// 强制校验模式下，没有配置密钥就拒绝，避免任何人伪造投递状态
			if (await this.strict(c)) {
				console.warn(provider + ' webhook: signing secret is required but not configured');
				throw new BizError(provider + ' webhook signing secret is not configured', 403);
			}
		} else if (!(await this.verify(c, provider, rawBody, secret))) {
			console.warn(provider + ' webhook: signature verification failed');
			throw new BizError(provider + ' webhook signature verification failed', 401);
		}

		const events = this.toEvents(parseBody(rawBody));
		let updated = 0;
		let ignored = 0;

		for (const event of events) {
			if (await this.isDuplicate(c, provider, this.eventId(provider, event, c))) {
				ignored++;
				continue;
			}

			const result = this.mapEvent(provider, event);
			if (!result) continue;

			const applied = await this.applyStatus(c, provider, result.providerId, result.status, result.message);
			if (applied && !applied.ignored) {
				updated++;
			} else if (applied?.ignored) {
				ignored++;
			}
		}

		return { updated, ignored };
	}
};

export default sendWebhookService;
