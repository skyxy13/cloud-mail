import {ElMessageBox} from 'element-plus'
import i18n from '@/i18n/index.js'
import {initStatus} from '@/request/init.js'

// 同一次会话里用户确认过就不再重复弹，避免每个请求都打断
let acknowledged = false
let showing = false

/**
 * 检查数据库是否初始化/需要迁移，需要时弹出提示。
 * @param force 为 true 时忽略"已确认过"的状态（例如接口刚返回 503）
 */
export async function checkMigration(force = false) {
    if (showing) return false
    if (acknowledged && !force) return false

    showing = true
    try {
        const status = await initStatus()
        if (!status?.needUpgrade) {
            acknowledged = true
            return false
        }

        const t = i18n.global.t
        const initialized = !!status.initialized
        const title = initialized ? t('migrationRequiredTitle') : t('migrationInitTitle')
        const message = initialized
            ? t('migrationRequiredDesc', {
                current: status.dbVersion || 'unknown',
                target: status.requiredVersion || ''
            })
            : t('migrationInitDesc')

        // 不 await：init() 需要先撤掉首屏 loading 遮罩，弹窗才能点击
        ElMessageBox.alert(message, title, {
            confirmButtonText: t('iKnowIt'),
            dangerouslyUseHTMLString: true,
            showClose: false,
            closeOnClickModal: false,
            type: 'warning'
        }).catch(() => {})
        acknowledged = true
        return true
    } catch (e) {
        // 状态接口不可用时静默处理，不影响正常使用
        console.warn('check migration failed:', e?.message)
        return false
    } finally {
        showing = false
    }
}
