import http from '@/axios/index.js';

export function oauthLinuxDoLogin(code, redirectUri, bind = false) {
    return http.post('/oauth/linuxDo/login', {code, redirectUri, bind})
}

export function oauthGithubLogin(code, redirectUri, bind = false) {
    return http.post('/oauth/github/login', {code, redirectUri, bind})
}

export function oauthGoogleLogin(code, redirectUri, bind = false) {
    return http.post('/oauth/google/login', {code, redirectUri, bind})
}

export function oauthBindUser(form) {
    return http.put('/oauth/bindUser', form)
}

export function oauthMyList() {
    return http.get('/my/oauthList')
}

export function oauthMyBind(oauthId) {
    return http.put('/my/oauthBind', {oauthId})
}

export function oauthMyUnbind(oauthId) {
    return http.delete('/my/oauthUnbind', {params: {oauthId}})
}
