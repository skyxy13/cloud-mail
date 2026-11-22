import app from '../hono/hono';
import result from '../model/result';
import draftService from '../service/draft-service';
import userContext from '../security/user-context';

app.get('/draft/list', async (c) => {
	const list = await draftService.list(c, userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.post('/draft/save', async (c) => {
	const draftId = await draftService.save(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(draftId));
});

app.delete('/draft/delete', async (c) => {
	await draftService.remove(c, c.req.query('draftIds'), userContext.getUserId(c));
	return c.json(result.ok());
});
