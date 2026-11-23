import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const email = sqliteTable('email', {
	emailId: integer('email_id').primaryKey({ autoIncrement: true }),
	sendEmail: text('send_email'),
	name: text('name'),
	senderEmail: text('sender_email').default('').notNull(),
	accountId: integer('account_id').notNull(),
	userId: integer('user_id').notNull(),
	subject: text('subject'),
	code: text('code').default('').notNull(),
	text: text('text'),
	content: text('content'),
	cc: text('cc').default('[]'),
	bcc: text('bcc').default('[]'),
	recipient: text('recipient'),
	toEmail: text('to_email').default('').notNull(),
	toName: text('to_name').default('').notNull(),
	inReplyTo: text('in_reply_to').default(''),
	relation: text('relation').default(''),
	messageId: text('message_id').default(''),
	type: integer('type').default(0).notNull(),
	status: integer('status').default(0).notNull(),
	// 各服务商返回的邮件 ID（原 resend_email_id，v3_12DB 改名）
	providerEmailId: text('provider_email_id'),
	// 实际发件的渠道：internal / cloudflare / resend / mailtrap / ahasend / plunk
	provider: text('provider').default('').notNull(),
	// 独立回复地址（Reply-To），为空表示不设置
	replyTo: text('reply_to').default('').notNull(),
	message: text('message'),
	unread: integer('unread').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	isDel: integer('is_del').default(0).notNull()
});
export default email
