import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import r2Service from './service/r2-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
import { handleWsUpgrade } from './websocket/connect';
import proxyService from './service/proxy-service';
import scheduleService from './service/schedule-service';
export { MailHub } from './websocket/hub'; // Durable Object 必须从 Worker 入口导出
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		// WebSocket：浏览器连 /realtime，转到 MailHub Durable Object
		if (url.pathname === '/realtime') {
			return handleWsUpgrade(req, env);
		}

		// 邮件图片代理：校验链接签名后，由 Worker 代拉外链图。
		if (url.pathname === '/proxy') {
			return proxyService.fetchImage(env, url.searchParams);
		}

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		if (url.pathname.startsWith('/oss/')) {
			const key = url.pathname.slice('/oss/'.length);
			const resp = await r2Service.toObjResp({ env }, key);
			return resp || new Response('Not Found', { status: 404 });
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 const resp = await r2Service.toObjResp({ env }, url.pathname.substring(1));
			 return resp || new Response('Not Found', { status: 404 });
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		// 付费 plan 可配 */5 精确扫描；免费 plan cron 最小间隔 1 小时，
		// 分钟级精度由 Durable Object alarm 负责，小时任务里再做一次兜底
		if (c.cron === '*/5 * * * *') {
			await scheduleService.runDue({ env })
			return;
		}

		await scheduleService.runDue({ env })
		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await emailService.autoClean({ env })
		await analysisService.refreshEchartsCache({ env })
		await oauthService.clearNoBindOathUser({ env })
	},
};
