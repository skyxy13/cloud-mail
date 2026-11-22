import orm from '../entity/orm';
import draft from '../entity/draft';
import { and, desc, eq, inArray } from 'drizzle-orm';
import dayjs from 'dayjs';
import BizError from '../error/biz-error';

function nowStr() {
	return dayjs().format('YYYY-MM-DD HH:mm:ss');
}

function parseList(value) {
	if (Array.isArray(value)) return value;
	if (!value) return [];
	try {
		const list = JSON.parse(value);
		return Array.isArray(list) ? list : [];
	} catch (e) {
		return [];
	}
}

// 服务端草稿：换浏览器/换设备也能接着写（附件仍保存在本地）
const draftService = {

	async save(c, params, userId) {
		const data = {
			userId,
			accountId: params.accountId ? Number(params.accountId) : null,
			name: params.name || '',
			sendEmail: params.sendEmail || '',
			receiveEmail: JSON.stringify(params.receiveEmail || []),
			ccEmail: JSON.stringify(params.ccEmail || []),
			bccEmail: JSON.stringify(params.bccEmail || []),
			subject: params.subject || '',
			content: params.content || '',
			text: params.text || '',
			manyType: params.manyType === 'divide' ? 'divide' : 'together',
			replyTo: params.replyTo || '',
			updateTime: nowStr()
		};

		const draftId = Number(params.draftId) || 0;

		if (draftId) {
			const row = await orm(c).update(draft).set(data)
				.where(and(eq(draft.draftId, draftId), eq(draft.userId, userId)))
				.returning().get();
			if (!row) {
				throw new BizError('draft not found');
			}
			return row.draftId;
		}

		const row = await orm(c).insert(draft).values({ ...data, createTime: nowStr() }).returning().get();
		return row.draftId;
	},

	async list(c, userId) {
		const rows = await orm(c).select().from(draft)
			.where(eq(draft.userId, userId))
			.orderBy(desc(draft.updateTime))
			.limit(200)
			.all();

		return rows.map(row => ({
			...row,
			receiveEmail: parseList(row.receiveEmail),
			ccEmail: parseList(row.ccEmail),
			bccEmail: parseList(row.bccEmail)
		}));
	},

	async remove(c, draftIds, userId) {
		const list = (Array.isArray(draftIds) ? draftIds : String(draftIds || '').split(','))
			.map(item => Number(item))
			.filter(item => Number.isSafeInteger(item) && item > 0);
		if (list.length === 0) return;

		await orm(c).delete(draft)
			.where(and(inArray(draft.draftId, list), eq(draft.userId, userId)))
			.run();
	}
};

export default draftService;
