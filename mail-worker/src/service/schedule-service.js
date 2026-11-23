import orm from '../entity/orm';
import emailSchedule from '../entity/schedule';
import emailService from './email-service';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

// Worker 线上是 UTC，本地 dev 是机器时区；定时相关的读写统一按 UTC，避免 8 小时偏差
dayjs.extend(utc);
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

const SCHEDULE_STATUS = {
	PENDING: 0,
	SENT: 1,
	CANCELED: 2,
	FAILED: 3
};

const MAX_ATTEMPTS = 3;
const MAX_AHEAD_DAYS = 30;
const FORMAT = 'YYYY-MM-DD HH:mm:ss';
// 定时器挂在 MailHub 这个 Durable Object 上（免费 plan 的 cron 只能按小时，
// 分钟级精度靠 DO alarm 实现；每小时 cron 只做兜底扫描）
const SCHEDULER_HUB = 'scheduler';

// 定时发送：保存发件参数，cron 到点回放 emailService.send
const scheduleService = {

	status: SCHEDULE_STATUS,

	async create(c, params, userId) {
		// 前端提交 ISO 时间串（带时区偏移），没有时区的按 UTC 处理
		const sendTime = dayjs.utc(params.sendTime);
		if (!sendTime.isValid()) {
			throw new BizError(t('invalidSendTime'));
		}

		const now = dayjs.utc();
		if (sendTime.isBefore(now.add(1, 'minute'))) {
			throw new BizError(t('sendTimeTooEarly'));
		}
		if (sendTime.isAfter(now.add(MAX_AHEAD_DAYS, 'day'))) {
			throw new BizError(t('sendTimeTooLate'));
		}

		// 保存时去掉定时相关字段，避免回放时再次排队
		const payload = { ...params };
		['sendTime', 'scheduleId', 'draftId', 'draftIds'].forEach(key => delete payload[key]);

		const row = await orm(c).insert(emailSchedule).values({
			userId,
			accountId: Number(params.accountId) || 0,
			params: JSON.stringify(payload),
			sendTime: sendTime.format(FORMAT),
			status: SCHEDULE_STATUS.PENDING,
			attempts: 0,
			error: '',
			createTime: now.format(FORMAT)
		}).returning().get();

		return row.scheduleId;
	},

	// 下一个待发送时间（UTC 字符串），没有则返回 null
	async nextDueTime(c) {
		const row = await orm(c).select({ sendTime: emailSchedule.sendTime })
			.from(emailSchedule)
			.where(eq(emailSchedule.status, SCHEDULE_STATUS.PENDING))
			.orderBy(asc(emailSchedule.sendTime))
			.get();
		return row?.sendTime || null;
	},

	// 让 DO 按最近的任务重设 alarm；没有任务就清掉
	async arm(c) {
		if (!c.env?.ws) return;
		try {
			await c.env.ws.getByName(SCHEDULER_HUB).arm();
		} catch (e) {
			console.warn('arm scheduler failed: ' + e.message);
		}
	},

	async list(c, userId) {
		const rows = await orm(c).select().from(emailSchedule)
			.where(and(eq(emailSchedule.userId, userId), inArray(emailSchedule.status, [SCHEDULE_STATUS.PENDING, SCHEDULE_STATUS.FAILED])))
			.orderBy(asc(emailSchedule.sendTime))
			.limit(100)
			.all();

		return rows.map(row => {
			let params = {};
			try {
				params = JSON.parse(row.params);
			} catch (e) {
				params = {};
			}
			return {
				scheduleId: row.scheduleId,
				sendTime: row.sendTime,
				status: row.status,
				error: row.error,
				attempts: row.attempts,
				subject: params.subject || '',
				receiveEmail: params.receiveEmail || [],
				accountId: row.accountId
			};
		});
	},

	async cancel(c, scheduleId, userId) {
		const row = await orm(c).update(emailSchedule)
			.set({ status: SCHEDULE_STATUS.CANCELED })
			.where(and(
				eq(emailSchedule.scheduleId, Number(scheduleId) || 0),
				eq(emailSchedule.userId, userId),
				eq(emailSchedule.status, SCHEDULE_STATUS.PENDING)
			))
			.returning().get();
		if (!row) {
			throw new BizError('schedule not found');
		}
	},

	// cron 调用：发送到期的定时邮件，失败最多重试 MAX_ATTEMPTS 次
	async runDue(c) {
		const nowStr = dayjs.utc().format(FORMAT);
		const rows = await orm(c).select().from(emailSchedule)
			.where(and(eq(emailSchedule.status, SCHEDULE_STATUS.PENDING), lte(emailSchedule.sendTime, nowStr)))
			.limit(20)
			.all();

		for (const row of rows) {
			let params;
			try {
				params = JSON.parse(row.params);
			} catch (e) {
				await orm(c).update(emailSchedule)
					.set({ status: SCHEDULE_STATUS.FAILED, error: 'invalid params' })
					.where(eq(emailSchedule.scheduleId, row.scheduleId)).run();
				continue;
			}

			try {
				await emailService.send(c, params, row.userId);
				await orm(c).update(emailSchedule)
					.set({ status: SCHEDULE_STATUS.SENT, error: '' })
					.where(eq(emailSchedule.scheduleId, row.scheduleId)).run();
			} catch (e) {
				const attempts = (row.attempts || 0) + 1;
				const failed = attempts >= MAX_ATTEMPTS;
				console.warn('scheduled email ' + row.scheduleId + ' failed (' + attempts + '): ' + e.message);
				await orm(c).update(emailSchedule)
					.set({
						attempts,
						status: failed ? SCHEDULE_STATUS.FAILED : SCHEDULE_STATUS.PENDING,
						error: e.message || ''
					})
					.where(eq(emailSchedule.scheduleId, row.scheduleId)).run();
			}
		}

		return rows.length;
	}
};

export default scheduleService;
