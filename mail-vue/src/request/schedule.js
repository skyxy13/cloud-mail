import http from '@/axios/index.js';

export function emailSchedule(form) {
    return http.post('/email/schedule', form)
}

export function emailScheduleList() {
    return http.get('/email/schedule/list', {noMsg: true})
}

export function emailScheduleCancel(scheduleId) {
    return http.delete('/email/schedule/cancel?scheduleId=' + scheduleId)
}
