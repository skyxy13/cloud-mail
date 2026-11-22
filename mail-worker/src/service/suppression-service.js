import orm from '../entity/orm';
import suppression from '../entity/suppression';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// 退信抑制名单：永久退信、垃圾邮件投诉的收件人会被记录，后续发件直接拦下
const suppressionService = {

	async suppress(c, params) {
		const address = String(params?.email || '').trim().toLowerCase();
		if (!address || !address.includes('@')) return null;

		return orm(c).insert(suppression).values({
			email: address,
			reason: params.reason || '',
			provider: params.provider || '',
			emailId: params.emailId ?? null,
			createTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		}).onConflictDoNothing().run();
	},

	async add(c, params) {
		const address = String(params?.email || '').trim().toLowerCase();
		if (!address || !address.includes('@')) {
			throw new BizError(t('notEmail'));
		}
		await this.suppress(c, {
			email: address,
			reason: params.reason || 'manual',
			provider: 'manual'
		});
		return address;
	},

	async list(c, params = {}) {
		const email = String(params.email || '').trim().toLowerCase();
		const where = email ? like(suppression.email, '%' + email + '%') : undefined;

		return orm(c).select()
			.from(suppression)
			.where(where)
			.orderBy(desc(suppression.createTime))
			.limit(500)
			.all();
	},

	async remove(c, emailList) {
		const list = (Array.isArray(emailList) ? emailList : String(emailList || '').split(','))
			.map(item => String(item).trim().toLowerCase())
			.filter(Boolean);
		if (list.length === 0) return 0;
		await orm(c).delete(suppression)
			.where(inArray(sql`${suppression.email} COLLATE NOCASE`, list))
			.run();
		return list.length;
	},

	// 返回被拦下的地址
	async blocked(c, emailList) {
		const list = [...new Set((emailList || [])
			.map(item => String(item).trim().toLowerCase())
			.filter(Boolean))];
		if (list.length === 0) return [];

		const rows = await orm(c)
			.select({ email: suppression.email, reason: suppression.reason })
			.from(suppression)
			.where(inArray(sql`${suppression.email} COLLATE NOCASE`, list))
			.all();

		return rows;
	}
};

export default suppressionService;
