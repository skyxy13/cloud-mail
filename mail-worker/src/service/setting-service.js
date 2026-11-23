import KvConst from '../const/kv-const';
import setting from '../entity/setting';
import orm from '../entity/orm';
import {settingConst, verifyRecordType} from '../const/entity-const';
import fileUtils from '../utils/file-utils';
import r2Service from './r2-service';
import constant from '../const/constant';
import BizError from '../error/biz-error';
import {t} from '../i18n/i18n'
import verifyRecordService from './verify-record-service';
import userContext from '../security/user-context';
import domainUtils from '../utils/domain-uitls';
import sendProviderService from './send-provider-service';
import dayjs from 'dayjs';

// webhook 校验密钥按服务商配置，留空表示不校验
const webhookSecretProviders = sendProviderService.sendProviderList.map(item => item.id);

function normalizeDomainQuota(value) {
	let source = {};
	if (typeof value === 'string') {
		try {
			source = JSON.parse(value) || {};
		} catch (e) {
			source = {};
		}
	} else if (value && typeof value === 'object') {
		source = value;
	}

	const quota = {};
	Object.keys(source).forEach(domain => {
		const limit = Number(source[domain]);
		if (Number.isFinite(limit) && limit > 0) quota[domain] = Math.floor(limit);
	});
	return quota;
}

function normalizeWebhookSecrets(value) {
	let source = {};
	if (typeof value === 'string') {
		try {
			source = JSON.parse(value) || {};
		} catch (e) {
			source = {};
		}
	} else if (value && typeof value === 'object') {
		source = value;
	}

	const secrets = {};
	webhookSecretProviders.forEach(provider => {
		secrets[provider] = typeof source[provider] === 'string' ? source[provider] : '';
	});
	return secrets;
}

const settingService = {

	async refresh(c) {
		const settingRow = await orm(c).select().from(setting).get();
		settingRow.resendTokens = JSON.parse(settingRow.resendTokens);
		settingRow.sendProviders = sendProviderService.parseProviders(settingRow.sendProviders, settingRow.resendTokens);
		settingRow.sendWebhookSecrets = normalizeWebhookSecrets(settingRow.sendWebhookSecrets);
		settingRow.domainDailyQuota = normalizeDomainQuota(settingRow.domainDailyQuota);
		// 记录当前代码要求的数据库版本，query 时会比对
		settingRow.dbVersion = constant.DB_VERSION;
		settingRow.r2Domain = '';
		c.set('setting', settingRow);
		await c.env.kv.put(KvConst.SETTING, JSON.stringify(settingRow));
	},

	async query(c) {

		if (c.get?.('setting')) {
			return c.get('setting')
		}

		const setting = await c.env.kv.get(KvConst.SETTING, { type: 'json' });

		if (!setting) {
			throw new BizError('数据库未初始化 Database not initialized.');
		}

		// 代码升级后数据库结构可能还没更新，给出明确提示而不是 D1_ERROR
		if (setting.dbVersion !== constant.DB_VERSION) {
			throw new BizError(t('dbUpgradeRequired', {
				current: setting.dbVersion || 'unknown', target: constant.DB_VERSION
			}), 503);
		}

		let domainList = c.env.domain;

		if (typeof domainList === 'string') {
			try {
				domainList = JSON.parse(domainList)
			} catch (error) {
				throw new BizError(t('notJsonDomain'));
			}
		}

		if (!c.env.domain) {
			throw new BizError(t('noDomainVariable'));
		}

		domainList = domainList.map(item => '@' + item);
		setting.domainList = domainList;

		let projectLink = c.env.project_link;
		if (typeof projectLink === 'string' && projectLink === 'false') {
			projectLink = false
		} else if (projectLink === false) {
			projectLink = false
		} else {
			projectLink = true
		}

		setting.projectLink = projectLink;
		setting.loginVerify ??= settingConst.loginVerify.CLOSE;
		setting.loginVerifyCount ??= 1;

		// KV 缓存可能还是升级前的数据，这里统一补齐发件服务配置
		setting.sendProviders = sendProviderService.parseProviders(setting.sendProviders, setting.resendTokens);
		setting.sendWebhookSecrets = normalizeWebhookSecrets(setting.sendWebhookSecrets);
		setting.domainDailyQuota = normalizeDomainQuota(setting.domainDailyQuota);

		setting.emailPrefixFilter = setting.emailPrefixFilter.split(",").filter(Boolean);
		setting.autoRefresh = Number(setting.autoRefresh) === 1 ? 1 : 2; // 1 关闭，2 开启

		c.set?.('setting', setting);
		return setting;
	},

	async get(c) {

		// 先浅拷贝再脱敏，避免脱敏值写回同一请求内缓存的配置
		const [row, recordList] = await Promise.all([
			await this.query(c),
			verifyRecordService.selectListByIP(c)
		]);
		const settingRow = { ...row, resendTokens: { ...row.resendTokens } };

		settingRow.secretKey = settingRow.secretKey ? `${settingRow.secretKey.slice(0, 6)}******` : null;

		Object.keys(settingRow.resendTokens).forEach(key => {
			settingRow.resendTokens[key] = `${settingRow.resendTokens[key].slice(0, 12)}******`;
		});

		settingRow.sendProviders = sendProviderService.maskProviders(settingRow.sendProviders);

		const webhookSecrets = {};
		Object.keys(settingRow.sendWebhookSecrets).forEach(provider => {
			const secret = settingRow.sendWebhookSecrets[provider];
			webhookSecrets[provider] = secret ? `${secret.slice(0, 6)}******` : '';
		});
		settingRow.sendWebhookSecrets = webhookSecrets;

		settingRow.s3AccessKey = settingRow.s3AccessKey ? `${settingRow.s3AccessKey.slice(0, 12)}******` : null;
		settingRow.s3SecretKey = settingRow.s3SecretKey ? `${settingRow.s3SecretKey.slice(0, 12)}******` : null;
		settingRow.tgBotToken = settingRow.tgBotToken ? `${settingRow.tgBotToken.slice(0, 20)}******` : null;
		settingRow.hasR2 = !!c.env.r2
		settingRow.hasCfEmail = !!c.env.email
		// 前台发件服务下拉选项，新增服务商时只改这里即可
		settingRow.sendProviderList = sendProviderService.sendProviderList
		settingRow.domainQuotaUsage = await this.domainQuotaUsage(c, settingRow.domainList)

		let regVerifyOpen = false
		let addVerifyOpen = false
		let loginVerifyOpen = false

		recordList.forEach(row => {
			if (row.type === verifyRecordType.REG) {
				regVerifyOpen = row.count >= settingRow.regVerifyCount
			}
			if (row.type === verifyRecordType.ADD) {
				addVerifyOpen = row.count >= settingRow.addVerifyCount
			}
			if (row.type === verifyRecordType.LOGIN) {
				loginVerifyOpen = row.count >= settingRow.loginVerifyCount
			}
		})

		settingRow.regVerifyOpen = regVerifyOpen
		settingRow.addVerifyOpen = addVerifyOpen
		settingRow.loginVerifyOpen = loginVerifyOpen

		settingRow.storageType = await r2Service.storageType(c);

		return settingRow;
	},

	async set(c, params) {
		const settingData = await this.query(c);
		let resendTokens = { ...settingData.resendTokens, ...params.resendTokens };
		Object.keys(resendTokens).forEach(domain => {
			if (!resendTokens[domain]) delete resendTokens[domain];
		});

		// 发件服务配置：新版前端提交 sendProviders，旧版前端只提交 Resend Token，这里统一合并
		const incomingProviders = { ...(params.sendProviders || {}) };
		Object.keys(resendTokens).forEach(domain => {
			if (!resendTokens[domain] || incomingProviders[domain] !== undefined) return;
			incomingProviders[domain] = { provider: 'resend', token: resendTokens[domain] };
		});
		// 只用 send_providers 存配置，resend_tokens 是历史字段（v3_7DB 已迁移），不再写入
		const sendProviders = sendProviderService.mergeProviders(settingData.sendProviders, incomingProviders);

		if (Array.isArray(params.emailPrefixFilter)) {
			params.emailPrefixFilter = params.emailPrefixFilter + '';
		}

		if (Array.isArray(params.aiCodeFilter)) {
			params.aiCodeFilter = params.aiCodeFilter + '';
		}

		if (params.webhookUrl !== undefined) {
			params.webhookUrl = domainUtils.toOssDomain(params.webhookUrl) || '';
		}

		// webhook 校验密钥：留空或回传脱敏值都表示不修改
		const mergedWebhookSecrets = { ...settingData.sendWebhookSecrets };
		const incomingWebhookSecrets = params.sendWebhookSecrets && typeof params.sendWebhookSecrets === 'object'
			? params.sendWebhookSecrets : {};
		Object.keys(incomingWebhookSecrets).forEach(provider => {
			const value = incomingWebhookSecrets[provider];
			if (!webhookSecretProviders.includes(provider) || typeof value !== 'string') return;
			if (value.includes('******')) return;
			mergedWebhookSecrets[provider] = value.trim();
		});

		params.sendProviders = JSON.stringify(sendProviders);
		params.sendWebhookSecrets = JSON.stringify(mergedWebhookSecrets);

		// 域名每日配额：提交的域名按数值合并，0 或空表示不限（删除该域名）
		const mergedQuota = { ...settingData.domainDailyQuota };
		const incomingQuota = params.domainDailyQuota && typeof params.domainDailyQuota === 'object'
			? params.domainDailyQuota : {};
		Object.keys(incomingQuota).forEach(domain => {
			const limit = Number(incomingQuota[domain]);
			if (!Number.isFinite(limit) || limit <= 0) {
				delete mergedQuota[domain];
				return;
			}
			mergedQuota[domain] = Math.floor(limit);
		});
		params.domainDailyQuota = JSON.stringify(mergedQuota);

		if (params.autoRefresh !== undefined) {
			params.autoRefresh = Number(params.autoRefresh) === 1 ? 1 : 2;
		}

		if (params.loginVerifyCount !== undefined && (!Number.isSafeInteger(params.loginVerifyCount) || params.loginVerifyCount < 1)) {
			params.loginVerifyCount = 1;
		}

		await orm(c).update(setting).set({ ...params }).returning().get();
		await this.refresh(c);
	},

	// 各域名今天已发出的封数（KV 计数），用于设置页展示配额使用情况
	async domainQuotaUsage(c, domainList) {
		const usage = {};
		const date = dayjs().format('YYYY-MM-DD');
		for (const item of domainList || []) {
			const domain = String(item).replace(/^@/, '');
			usage[domain] = Number(await c.env.kv.get(KvConst.DOMAIN_SEND_DAY_COUNT + domain + ':' + date)) || 0;
		}
		return usage;
	},

	async deleteBackground(c) {

		const { background } = await this.query(c);
		if (!background) return

		if (background.startsWith('http')) {
			await orm(c).update(setting).set({ background: '' }).run();
			await this.refresh(c)
			return;
		}

		if (background) {
			await r2Service.delete(c,background)
			await orm(c).update(setting).set({ background: '' }).run();
			await this.refresh(c)
		}
	},

	async setBackground(c, params) {

		let { background } = params

		await this.deleteBackground(c);

		if (background && !background.startsWith('http')) {

			const file = fileUtils.base64ToFile(background)

			const arrayBuffer = await file.arrayBuffer();
			background = constant.BACKGROUND_PREFIX + await fileUtils.getBuffHash(arrayBuffer) + fileUtils.getExtFileName(file.name);


			await r2Service.putObj(c, background, arrayBuffer, {
				contentType: file.type,
				cacheControl: `public, max-age=31536000, immutable`,
				contentDisposition: `inline; filename="${file.name}"`
			});

		}

		await orm(c).update(setting).set({ background }).run();
		await this.refresh(c);
		return background;
	},


	async setBlacklist(c, params) {
		const { blackSubject, blackContent, blackFrom  } = params
		await orm(c).update(setting).set({ blackSubject, blackContent, blackFrom }).run();
		await this.refresh(c);
		return this.get(c);
	},

	async websiteConfig(c) {

		const settingRow = await this.get(c);
		const token = await userContext.getToken(c);

		return {
			register: settingRow.register,
			title: settingRow.title,
			manyEmail: settingRow.manyEmail,
			addEmail: settingRow.addEmail,
			autoRefresh: settingRow.autoRefresh,
			addEmailVerify: settingRow.addEmailVerify,
			registerVerify: settingRow.registerVerify,
			loginVerify: settingRow.loginVerify,
			send: settingRow.send,
			r2Domain: settingRow.r2Domain,
			siteKey: settingRow.siteKey,
			background: settingRow.background,
			loginOpacity: settingRow.loginOpacity,
			domainList: settingRow.loginDomain === 1 && !token ? [] : settingRow.domainList,
			regKey: settingRow.regKey,
			// 各域名发件服务商的体积限制，前端发件前预校验用（不含任何密钥，仅登录用户可见）
			sendProviderLimits: token ? Object.fromEntries(
				Object.entries(settingRow.sendProviders || {}).map(([domain, item]) => [
					domain, sendProviderService.limits(item.provider)
				])
			) : {},
			regVerifyOpen: settingRow.regVerifyOpen,
			addVerifyOpen: settingRow.addVerifyOpen,
			loginVerifyOpen: settingRow.loginVerifyOpen,
			noticeTitle: settingRow.noticeTitle,
			noticeContent: settingRow.noticeContent,
			noticeType: settingRow.noticeType,
			noticeDuration: settingRow.noticeDuration,
			noticePosition: settingRow.noticePosition,
			noticeWidth: settingRow.noticeWidth,
			noticeOffset: settingRow.noticeOffset,
			notice: settingRow.notice,
			loginDomain: settingRow.loginDomain,
			linuxdoClientId: settingRow.linuxdoClientId,
			linuxdoSwitch: settingRow.linuxdoSwitch,
			githubClientId: settingRow.githubClientId,
			githubSwitch: settingRow.githubSwitch,
			googleClientId: settingRow.googleClientId,
			googleSwitch: settingRow.googleSwitch,
			minEmailPrefix: settingRow.minEmailPrefix,
			projectLink: settingRow.projectLink
		};
	},

};

export default settingService;
