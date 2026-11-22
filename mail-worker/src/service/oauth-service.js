import BizError from "../error/biz-error";
import orm from "../entity/orm";
import {oauth} from "../entity/oauth";
import { and, eq, inArray } from 'drizzle-orm';
import userService from "./user-service";
import loginService from "./login-service";
import cryptoUtils from "../utils/crypto-utils";
import settingService from "./setting-service";
import {t} from '../i18n/i18n';
import userContext from '../security/user-context';

const oauthService = {

	/**
	 * OAuth 登录后把身份落到邮箱上。
	 * mode = 'existing' 绑定已有邮箱（校验密码）
	 * mode = 'register' 注册新邮箱（遵守站点注册开关、注册码、人机验证等全部要求）
	 * 不传 mode 时按「邮箱是否已存在」自动判定，兼容旧前端。
	 */
	async bindUser(c, params) {

		const { email, oauthUserId, code, password, token } = params;

		const oauthRow = await this.getById(c, oauthUserId);

		if (!oauthRow) {
			throw new BizError(t('oauthUserNotExist'));
		}

		const boundUser = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (boundUser) {
			throw new BizError(t('oauthAlreadyBind'));
		}

		const existUser = await userService.selectByEmailIncludeDel(c, email);

		const mode = params.mode || (existUser ? 'existing' : 'register');

		if (mode === 'existing') {

			if (!existUser) {
				throw new BizError(t('notExistUser'));
			}

			if (!password) {
				throw new BizError(t('oauthBindNeedPwd'));
			}

			// 复用登录校验：密码、封禁/注销、人机验证（站点开启时）一并处理
			const jwtToken = await loginService.login(c, { email, password, token });

			await this.updateBindUser(c, oauthUserId, existUser.userId);

			return { userInfo: await this.getById(c, oauthUserId), token: jwtToken };
		}

		if (mode !== 'register') {
			throw new BizError(t('paramError'));
		}

		// 注册新邮箱：oauth 传 false，注册开关 / 注册码 / 人机验证 / 前缀长度等要求全部生效
		const regResult = await loginService.register(c, {
			email,
			password: password || cryptoUtils.genRandomPwd(),
			code,
			token
		});

		const newUser = await userService.selectByEmail(c, email);

		await this.updateBindUser(c, oauthUserId, newUser.userId);

		const jwtToken = await loginService.login(c, { email, password: null }, true);

		return { userInfo: await this.getById(c, oauthUserId), token: jwtToken, regVerifyOpen: regResult?.regVerifyOpen }
	},

	// 个人设置：查询当前账号已绑定的第三方登录
	async listMyOauth(c) {
		const userId = userContext.getUserId(c);
		return await orm(c).select({
			oauthId: oauth.oauthId,
			platform: oauth.platform,
			username: oauth.username,
			name: oauth.name,
			avatar: oauth.avatar,
			createTime: oauth.createTime
		}).from(oauth).where(eq(oauth.userId, userId)).all();
	},

	// 个人设置：把一次 OAuth 授权结果绑定到当前账号
	async bindMyOauth(c, params) {
		const oauthId = Number(params.oauthId);
		const userId = userContext.getUserId(c);

		if (!oauthId) {
			throw new BizError(t('paramError'));
		}

		const oauthRow = await this.getByOauthId(c, oauthId);

		if (!oauthRow) {
			throw new BizError(t('oauthUserNotExist'));
		}

		if (oauthRow.userId && oauthRow.userId !== 0) {
			throw new BizError(t('oauthAlreadyBind'));
		}

		const samePlatform = await orm(c).select().from(oauth)
			.where(and(eq(oauth.userId, userId), eq(oauth.platform, oauthRow.platform)))
			.get();

		if (samePlatform) {
			throw new BizError(t('oauthPlatformBound'));
		}

		await orm(c).update(oauth).set({ userId }).where(eq(oauth.oauthId, oauthId)).run();

		return await this.getByOauthId(c, oauthId);
	},

	// 个人设置：解绑
	async unbindMyOauth(c, params) {
		const oauthId = Number(params.oauthId);
		const userId = userContext.getUserId(c);

		const oauthRow = await orm(c).select().from(oauth)
			.where(and(eq(oauth.oauthId, oauthId), eq(oauth.userId, userId)))
			.get();

		if (!oauthRow) {
			throw new BizError(t('oauthBindNotExist'));
		}

		await orm(c).delete(oauth).where(eq(oauth.oauthId, oauthId)).run();
	},

	async updateBindUser(c, oauthUserId, userId) {
		await orm(c).update(oauth).set({ userId }).where(eq(oauth.oauthUserId, oauthUserId)).run();
	},

	async linuxDoLogin(c, params) {

		const { code, redirectUri, bind } = params;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'linuxdoSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.linuxdoClientId)
		reqParams.append('client_secret', setting.linuxdoClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')

		const tokenRes = await fetch("https://connect.linux.do/oauth2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		})

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText)
		}

		const token = await tokenRes.json()

		const userRes = await fetch('https://connect.linux.do/api/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText)
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.id);
		userInfo.active = userInfo.active ? 0 : 1;
		userInfo.silenced = userInfo.silenced ? 0 : 1;
		userInfo.trustLevel = userInfo.trust_level;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'linuxdo';

		return await this.saveAndLogin(c, userInfo, bind)
	},

	async githubLogin(c, params) {

		const { code, redirectUri, bind } = params;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'githubSwitch');

		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json"
			},
			body: JSON.stringify({
				client_id: setting.githubClientId,
				client_secret: setting.githubClientSecret,
				code: code,
				redirect_uri: redirectUri
			})
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();

		if (token.error) {
			throw new BizError(token.error_description || token.error);
		}

		const userRes = await fetch('https://api.github.com/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token,
				'User-Agent': 'cloud-mail'
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.id);
		userInfo.username = userInfo.login;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'github';

		return await this.saveAndLogin(c, userInfo, bind);
	},

	async googleLogin(c, params) {

		const { code, redirectUri, bind } = params;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'googleSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.googleClientId)
		reqParams.append('client_secret', setting.googleClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')

		const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();

		const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.sub);
		userInfo.username = userInfo.email;
		userInfo.name = userInfo.name;
		userInfo.avatar = userInfo.picture;
		userInfo.platform = 'google';

		return await this.saveAndLogin(c, userInfo, bind);
	},

	async saveAndLogin(c, userInfo, bind = false) {

		const oauthRow = await this.saveUser(c, userInfo);

		// 个人设置里「绑定」只需拿到 OAuth 身份，不签发任何账号的登录态
		if (bind) {
			return { userInfo: oauthRow, token: null };
		}

		const userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (!userRow) {
			return { userInfo: oauthRow, token: null };
		}

		const JwtToken = await loginService.login(c, { email: userRow.email, password: null }, true);
		return { userInfo: oauthRow, token: JwtToken };
	},

	async saveUser(c, userInfo) {

		const userInfoRow = await this.getById(c, userInfo.oauthUserId);

		if (!userInfoRow) {
			return await orm(c).insert(oauth).values(userInfo).returning().get();
		} else {
			return await orm(c).update(oauth).set(userInfo).where(eq(oauth.oauthUserId, userInfo.oauthUserId)).returning().get();
		}

	},

	assertEnabled(setting, switchKey) {
		if (setting[switchKey] !== 0) {
			throw new BizError(t('oauthDisabled'));
		}
	},

	async getById(c, oauthUserId) {
		return await orm(c).select().from(oauth).where(eq(oauth.oauthUserId, oauthUserId)).get();
	},

	async getByOauthId(c, oauthId) {
		return await orm(c).select().from(oauth).where(eq(oauth.oauthId, oauthId)).get();
	},

	async deleteByUserId(c, userId) {
		await this.deleteByUserIds(c, [userId]);
	},

	async deleteByUserIds(c, userIds) {
		await orm(c).delete(oauth).where(inArray(oauth.userId, userIds)).run();
	},

	//定时任务凌晨清除未绑定邮箱的oauth用户
	async clearNoBindOathUser(c) {
		await orm(c).delete(oauth).where(eq(oauth.userId, 0)).run();
	},

}

export default  oauthService
