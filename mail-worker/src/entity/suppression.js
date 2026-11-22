import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const suppression = sqliteTable('suppression', {
	// 命中过的收件人地址（大小写不敏感）
	email: text('email').primaryKey(),
	reason: text('reason').default('').notNull(),
	provider: text('provider').default('').notNull(),
	emailId: integer('email_id'),
	createTime: text('create_time').default('')
});
export default suppression
