import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const emailSchedule = sqliteTable('email_schedule', {
	scheduleId: integer('schedule_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	accountId: integer('account_id').notNull(),
	// 原始发件参数（JSON），到点直接回放
	params: text('params').notNull(),
	sendTime: text('send_time').notNull(),
	status: integer('status').default(0).notNull(),
	attempts: integer('attempts').default(0).notNull(),
	error: text('error').default('').notNull(),
	createTime: text('create_time').default('')
});
export default emailSchedule
