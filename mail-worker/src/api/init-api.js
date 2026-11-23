import app from '../hono/hono';
import result from '../model/result';
import { dbInit } from '../init/init';
import constant from '../const/constant';
import KvConst from '../const/kv-const';

// 前端启动时查询数据库状态，用来提示需要初始化/升级（无需鉴权）
// 注意：必须注册在 /init/:secret 之前，否则会被当成 secret 参数
app.get('/init/status', async (c) => {
	let setting = null;
	try {
		setting = await c.env.kv.get(KvConst.SETTING, { type: 'json' });
	} catch (e) {
		setting = null;
	}

	const dbVersion = setting?.dbVersion || '';

	return c.json(result.ok({
		initialized: !!setting,
		dbVersion,
		requiredVersion: constant.DB_VERSION,
		needUpgrade: !setting || dbVersion !== constant.DB_VERSION
	}));
});

app.get('/init/:secret', (c) => {
	return dbInit.init(c);
})
