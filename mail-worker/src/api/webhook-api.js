import app from '../hono/hono';
import sendWebhookService from '../service/send-webhook-service';
import { sendProviderConst } from '../service/send-provider-service';

// 各发件服务商的回调入口：/api/webhooks/{provider}
const providers = [
	sendProviderConst.RESEND,
	sendProviderConst.MAILTRAP,
	sendProviderConst.AHASEND,
	sendProviderConst.PLUNK
];

async function receive(c, provider) {
	try {
		await sendWebhookService.handle(c, provider);
		return c.text('success', 200);
	} catch (e) {
		if (e.name === 'BizError') {
			return c.text(e.message, e.code || 400);
		}
		return c.text(e.message, 500);
	}
}

// 兼容旧地址：/api/webhooks 默认按 Resend 处理
app.post('/webhooks', (c) => receive(c, sendProviderConst.RESEND));

for (const provider of providers) {
	app.post('/webhooks/' + provider, (c) => receive(c, provider));
}
