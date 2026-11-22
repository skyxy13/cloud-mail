import http from '@/axios/index.js';

export function draftList() {
    return http.get('/draft/list', {noMsg: true})
}

export function draftSave(form) {
    return http.post('/draft/save', form, {noMsg: true})
}

export function draftDelete(draftIds) {
    return http.delete('/draft/delete?draftIds=' + draftIds)
}
