import app from '../hono/hono';
import result from '../model/result';
import suppressionService from '../service/suppression-service';

app.get('/suppression/list', async (c) => {
	const list = await suppressionService.list(c, c.req.query());
	return c.json(result.ok(list));
});

app.post('/suppression/add', async (c) => {
	const email = await suppressionService.add(c, await c.req.json());
	return c.json(result.ok(email));
});

app.delete('/suppression/delete', async (c) => {
	await suppressionService.remove(c, c.req.query('emails'));
	return c.json(result.ok());
});
