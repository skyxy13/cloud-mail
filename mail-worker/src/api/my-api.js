import app from '../hono/hono';
import userService from '../service/user-service';
import oauthService from '../service/oauth-service';
import result from '../model/result';
import userContext from '../security/user-context';

app.get('/my/loginUserInfo', async (c) => {
	const user = await userService.loginUserInfo(c, userContext.getUserId(c));
	return c.json(result.ok(user));
});

app.put('/my/resetPassword', async (c) => {
	await userService.resetPassword(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/my/delete', async (c) => {
	await userService.delete(c, userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/my/oauthList', async (c) => {
	const list = await oauthService.listMyOauth(c);
	return c.json(result.ok(list));
});

app.put('/my/oauthBind', async (c) => {
	const row = await oauthService.bindMyOauth(c, await c.req.json());
	return c.json(result.ok(row));
});

app.delete('/my/oauthUnbind', async (c) => {
	await oauthService.unbindMyOauth(c, c.req.query());
	return c.json(result.ok());
});


