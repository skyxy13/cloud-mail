import http from '@/axios/index.js';

export function suppressionList(params = {}) {
    return http.get('/suppression/list', {params})
}

export function suppressionAdd(email, reason) {
    return http.post('/suppression/add', {email, reason})
}

export function suppressionDelete(emails) {
    return http.delete('/suppression/delete?emails=' + emails)
}
