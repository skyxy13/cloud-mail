const constant = {
	TOKEN_HEADER: 'Authorization',
	JWT_UID: 'user_id:',
	JWT_TOKEN: 'token:',
	TOKEN_EXPIRE: 60 * 60 * 24 * 30,
	// Bump this number to invalidate every existing login token.
	AUTH_GEN: 1,
	ATTACHMENT_PREFIX: 'attachments/',
	BACKGROUND_PREFIX: 'static/background/',
	// 当前数据库结构版本：改了 init 里的迁移就要同步改这里，
	// 运行时会拿 KV 里缓存的值对比，不一致时提示去执行 /init/{jwt_secret}
	DB_VERSION: 'v3.12',
	ADMIN_ROLE: {
		name: 'admin',
		sendCount: 0,
		sendType: 'count',
		accountCount: 0
	}
}

export default constant
