import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const draft = sqliteTable('draft', {
	draftId: integer('draft_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	accountId: integer('account_id'),
	name: text('name').default('').notNull(),
	sendEmail: text('send_email').default('').notNull(),
	receiveEmail: text('receive_email').default('[]').notNull(),
	ccEmail: text('cc_email').default('[]').notNull(),
	bccEmail: text('bcc_email').default('[]').notNull(),
	subject: text('subject').default('').notNull(),
	content: text('content').default('').notNull(),
	text: text('text').default('').notNull(),
	manyType: text('many_type').default('together').notNull(),
	replyTo: text('reply_to').default('').notNull(),
	createTime: text('create_time').default(''),
	updateTime: text('update_time').default('')
});
export default draft
