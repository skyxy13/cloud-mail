import {useUserStore} from "@/store/user.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {loginUserInfo} from "@/request/my.js";
import {permsToRouter} from "@/perm/perm.js";
import router from "@/router";
import {websiteConfig} from "@/request/setting.js";
import {checkMigration} from "@/init/migration-notice.js";
import i18n from "@/i18n/index.js";

// 数据库没就绪时不会走路由，首屏 loading 遮罩需要自己撤掉，否则弹窗点不动
function removeFirstLoading() {
    const doc = document.getElementById('loading-first')
    if (doc) {
        doc.remove()
    }
}

export async function init() {
    document.title = '\u200B'

    const settingStore = useSettingStore();
    const userStore = useUserStore();
    const accountStore = useAccountStore();

    // 先把语言定下来，后面弹窗提示才不会用错语言
    if (!settingStore.lang) {
        let lang = navigator.language.split('-')[0]
        lang = lang === 'zh' ? lang : 'en'
        settingStore.lang = lang
    }
    i18n.global.locale.value = settingStore.lang

    // 数据库没初始化 / 需要迁移时先弹窗说明，避免后面每个请求都报错
    const needUpgrade = await checkMigration()
    if (needUpgrade) {
        removeFirstLoading()
        return
    }

    const token = localStorage.getItem('token');
    let setting = null;

    try {
        if (token) {
            const userPromise = loginUserInfo().catch(e => {
                console.error(e);
                return null;
            });

            const [s, user] = await Promise.all([websiteConfig(), userPromise]);
            setting = s;
            settingStore.settings = setting;
            settingStore.domainList = setting.domainList;
            document.title = setting.title;

            if (user) {
                accountStore.currentAccountId = user.account.accountId;
                accountStore.currentAccount = user.account;
                userStore.user = user;

                const routers = permsToRouter(user.permKeys);
                routers.forEach(routerData => {
                    router.addRoute('layout', routerData);
                });
            }

        } else {
            setting = await websiteConfig();
            settingStore.settings = setting;
            settingStore.domainList = setting.domainList;
            document.title = setting.title;
        }
    } catch (e) {
        // 数据库未就绪、网络异常等情况：让应用还能启动，并把迁移提示弹出来
        console.error('init failed:', e?.message)
        removeFirstLoading()
        await checkMigration(true)
    }
}
