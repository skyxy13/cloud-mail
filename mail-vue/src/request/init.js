import http from '@/axios/index.js';

// 数据库状态：是否已初始化、是否需要执行迁移
export function initStatus() {
    return http.get('/init/status', {noMsg: true})
}
