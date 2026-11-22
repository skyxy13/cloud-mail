import app from '../hono/hono';
import result from '../model/result';
import scheduleService from '../service/schedule-service';
import userContext from '../security/user-context';

app.post('/email/schedule', async (c) => {
	const scheduleId = await scheduleService.create(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(scheduleId));
});

app.get('/email/schedule/list', async (c) => {
	const list = await scheduleService.list(c, userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.delete('/email/schedule/cancel', async (c) => {
	await scheduleService.cancel(c, c.req.query('scheduleId'), userContext.getUserId(c));
	return c.json(result.ok());
});
