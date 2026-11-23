# 发件服务（Send Provider）

站外发件由第三方服务商完成。系统支持 **Resend**、**Mailtrap**、**AhaSend**、**Plunk**，按发件域名分别配置：同一个站点可以给不同域名使用不同的服务商。

## 配置入口

系统设置 → 发件服务（列表按钮查看已配置项，加号按钮新增）

1. 选择发件域名（来自环境变量 `domain`）
2. 选择服务商
3. 填写该服务商的 API Key（AhaSend 可再填账户 ID，见下文）
4. 保存；再次提交同一域名会覆盖，API Key 留空并保存则删除该域名配置

配置保存在 `setting.send_providers` 字段，格式：

```json
{
  "example.com": {
    "provider": "resend",
    "token": "re_xxxxxxxx",
    "accountId": ""
  }
}
```

> 旧版本只有 `resend_tokens`（域名 → Resend Token）。初始化接口会把它自动迁移成上面的结构，升级后不需要手动重填。
> 现在配置只写 `send_providers`，`resend_tokens` 已是历史字段（只读兜底，不再更新）。

## 发件渠道优先级

1. 收件人全部是站内邮箱 → 站内投递
2. 配置了 Cloudflare Email（`wrangler.toml` 里的 `send_email` 绑定）→ Cloudflare Email
3. 当前发件域名的服务商 → Resend / Mailtrap / AhaSend / Plunk
4. 都没有 → 报错「发信服务未配置，只能给站内邮箱发件」

每次发件都会把实际使用的渠道写进 `email.provider`（`internal` / `cloudflare` / `resend` / `mailtrap` / `ahasend` / `plunk`），
一方面便于统计各服务商的使用量与成功率，另一方面回调会校验 `provider` 是否一致，避免别的服务商（或伪造请求）改状态。

## 服务商对照

| 服务商 | API Key 获取 | 请求端点 | 附件 | 抄送 / 密送 |
| --- | --- | --- | --- | --- |
| Resend | https://resend.com/api-keys（`re_` 开头） | `POST https://api.resend.com/emails` | 支持 | 支持 |
| Mailtrap | https://mailtrap.io → Sending Domains → API Tokens | `POST https://send.api.mailtrap.io/api/send` | 支持 | 支持 |
| AhaSend | https://ahasend.com 控制台 → API Keys | v1：`POST /v1/email/send`；v2：`POST /v2/accounts/{accountId}/messages` | 支持 | v2 支持（走 conversation 接口），v1 不支持 |
| Plunk | https://app.useplunk.com → Settings → API Keys（`sk_` 开头） | `POST https://api.useplunk.com/v1/send` | 支持（10 个 / 10MB） | 接口没有抄送密送字段 |
| Sendflare | https://app.sendflare.com → API Token | `POST https://api.sendflare.com/v1/send` | 支持（base64 + inline） | 支持 |

### 各服务商注意事项

- **Sendflare**：`Authorization: Bearer <token>`；免费版 3,000 封/月（100 封/天、2 个域名）。
  正文只有 `body`（HTML）一个字段，纯文本邮件会被包一层 `<div>`；单封接口的 `to` 是字符串（本项目本来就按收件人逐个提交，正好对上）。
  返回里只有 `requestId`、没有单封 message id；**目前没有 webhook 回调**，所以状态只会停在「已发送」，不会回写已投递/退信。
  官方文档未公开单封大小与附件数量上限，这里先按 10 个 / 10MB 保守校验。

- **Resend**：域名需在 Resend 后台验证。使用「分开发送」时走批量接口，一次最多 100 位收件人且不支持附件（包含正文内嵌图片）；普通发送不受此限制。投递状态可通过 Resend Webhook 回写（默认地址 `/api/webhooks`，需在 Resend 后台配置）。
- **Mailtrap**：需要 `send.api.mailtrap.io`（Sending / 事务邮件）的 API Token，免费版只能向自己的测试收件箱投递，正式投递需要付费套餐并验证域名。
- **AhaSend**：
  - 只填 API Key 时使用 v1 接口（维护模式，功能可用），v1 没有抄送密送，抄送密送收件人会并入收件人列表（AhaSend 对每位收件人单独投递，彼此看不到其他地址）。
  - 同时填写账户 ID 时使用 v2 接口，支持抄送密送与更细的返回结果（每位收件人的 message id 会写入发件记录）。
- **Plunk**：正文必须是 HTML，纯文本邮件会被包一层 `<div>` 转成 HTML；接口没有抄送密送字段，同样并入收件人列表。

## 投递状态回调（Webhook）

服务商把投递结果回调到本服务后，会自动更新「已发邮件」的状态（已投递 / 退信 / 投诉 / 延迟 / 失败）。

| 服务商 | 回调地址 | 处理的事件 | 签名校验 |
| --- | --- | --- | --- |
| Resend | `/api/webhooks/resend`（旧地址 `/api/webhooks` 仍然可用） | `email.sent` `email.delivered` `email.bounced` `email.complained` `email.delivery_delayed` `email.failed` | 可选：`svix-*` 头 + 签名密钥（`whsec_` 开头） |
| Mailtrap | `/api/webhooks/mailtrap` | `delivery` `bounce` `soft bounce` `spam` `suspension` `reject`（`open` / `click` / `unsubscribe` 忽略） | 可选：`Mailtrap-Signature`（hex HMAC-SHA256） |
| AhaSend | `/api/webhooks/ahasend` | `message.delivered` `message.bounced` `message.complained` `message.transient_error` `message.failed` `message.suppressed` | 可选：`webhook-*` 头（Standard Webhooks 规范） |
| Plunk | `/api/webhooks/plunk` | `email.delivery` `email.bounce` `email.complaint`（默认载荷不带事件名，按 `deliveredAt` / `bouncedAt` / `complainedAt` 字段判断） | 可选：`Authorization: Bearer <密钥>` 或 `X-Webhook-Token` |

- 校验密钥在「系统设置 → 回调校验密钥」里填写，留空表示不校验；配置后签名不正确的请求直接返回 401。
- 同一页可以打开「强制校验回调」：开启后**没有配置密钥的回调一律返回 403**，避免任何人伪造投递状态（升级默认关闭，避免旧站点回调被打断）。
- **状态只升不降**：`SENT < DELAYED < DELIVERED < COMPLAINED < BOUNCED < FAILED`，只允许升级，乱序到达的旧事件（例如 `email.sent` 晚于 `email.delivered`）不会把终态改回去。
- **重复投递去重**：Mailtrap `event_id`、AhaSend `webhook_id`、Resend `svix-id`、Plunk `emailId + 时间戳` 会写入 KV（保留 7 天），重复事件直接忽略。
- Mailtrap 支持 JSON 和 JSON Lines 两种载荷，两种都能解析。
- 服务商返回的邮件 ID 存在 `email.provider_email_id`（原 `resend_email_id`，v3_12DB 改名），会先归一化（去掉 `<>` 和 `@域名` 后缀）再匹配 `email.provider_email_id`，所以 Mailtrap 的 `<uuid@域名>` 也能对上。
- 未知邮件、重复投递、测试事件都会返回 200 并记录日志，避免服务商因连续收到 500 而熔断关闭 webhook。
- **Plunk**：webhook 由 workflow 触发。需要在 Plunk 里建 workflow，触发器选 `email.delivery` / `email.bounce` / `email.complaint`，动作选 Webhook，URL 填本站回调地址；要鉴权就在 Headers 里加 `{"Authorization": "Bearer <密钥>"}`，并在本站填同一个密钥。
- **AhaSend**：在控制台 Webhooks 页面新建 endpoint，勾选 `message.*` 事件，即可拿到 `whsec_` 签名密钥。
- **Mailtrap**：Webhooks → Create New Webhook，区域选 Email Live Sending（Transactional 流），选事件后可在详情里查看签名密钥。
- **Resend**：Webhooks → Add Endpoint，URL 填 `https://你的域名/api/webhooks/resend`，签名密钥同样以 `whsec_` 开头。

## 用 Cloudflare 自己的 Email Sending 发件（可选）

代码里已经支持：只看绑定名是不是 `email`（`const useCloudflareEmail = !!c.env.email`）。只要部署时存在这个绑定，
**所有站外发件都会优先走 Cloudflare，域名上的服务商配置会被忽略**（系统设置里「发件服务」会显示「Cloudflare 邮件发送：已启用」）。

### 启用步骤

1. Cloudflare 控制台 → Email → Email Routing，把发件域名接入并完成 DNS 验证（MX / SPF / DKIM）。
2. `mail-worker/wrangler.toml` 把注释打开：
   ```toml
   [[send_email]]
   name = "email"
   ```
3. 重新部署，然后 `/api/setting/query` 里的 `hasCfEmail` 会变成 `true`。

### 限制（决定能不能真的用）

- **Email Sending 目前是 Beta，发给任意收件人需要 Workers Paid 计划**；免费 / 仅 Email Routing 的情况下只能发给
  账号内**已验证的目的地址**（verified destination addresses），也就是基本只能发给自己。
- 没有投递回执 / webhook：本项目里走 Cloudflare 渠道的邮件会直接记为「已投递」，回调相关的状态机不参与。
- 附件、抄送密送、Reply-To 都支持（`send_email` 绑定参数）。

结论：**对外给客户发信不建议用 Cloudflare**（除非升级 Workers Paid 且接受 Beta），继续用 Resend / Mailtrap / AhaSend / Plunk。

## 重试与主备切换

- **重试**：服务商返回 408 / 425 / 429 / 5xx 或出现网络错误时，最多重试 3 次，间隔 400ms → 800ms 指数退避并带抖动；仍失败才把错误抛给用户。
- **主备切换**：在「发件服务」里可以给域名再配一个**备用服务商**（另一个服务商 + 它的 API Key）。主服务商**明确返回错误码**（4xx/5xx/429）时才切到备用；
  网络超时**不会**切换——那种情况下邮件可能已经投递，切换会导致重复发送。
- **并发**：「分开发送」时按 3 个并发提交，避免上百封串行等待超时；每封的发件记录独立保存，失败的收件人会回传给前端重试。
- 备注：主备两个服务商都要验证同一个发件域名，否则备用会因域名未验证被拒。

## 体积限制

发件前会按服务商限制做本地校验（正文 + 附件，未 base64 编码前的字节数），超限直接报错，不会先把附件传完再失败：

| 服务商 | 单封上限 | 附件个数 |
| --- | --- | --- |
| Resend | 40 MB | 10 |
| Mailtrap | 10 MB（Business 及以上可申请到 30 MB） | 10 |
| AhaSend | 20 MiB（请求体 30 MB） | 10 |
| Plunk | 10 MB（附件合计） | 10 |

- 服务端校验在 `emailService.checkAttachLimit`，前端在发件前用 `websiteConfig.sendProviderLimits`（按域名下发，只含限制、不含密钥）先做一次预检。
- 限制值集中在 `send-provider-service.js` 的 `providerLimitTable`，服务商调整额度时改这一处即可。

## 分开发送

「分开发送」会为每位收件人单独创建一条发件记录（附件、正文内嵌图每封都会带上）。除 Resend 走批量接口外，其余服务商按收件人逐个调用 API，失败时已成功的记录会保留，前端可以只重试失败收件人。

## 数据库升级

- 所有迁移在 `/init/{jwt_secret}` 里按顺序执行，执行结果登记到 `db_migration`（`name` / `version` / `applied_at`），方便排查线上到底是哪个版本。
- `const/constant.js` 里的 `DB_VERSION` 与 KV 缓存的版本不一致时，接口会直接返回 503 并提示「数据库结构需要升级，请访问一次 /init/{jwt_secret}」，而不是抛 D1 的 `no such column`。
- 改了 `init.js` 里的迁移，记得同步改 `DB_VERSION`。
- 前端启动时会请求 `GET /api/init/status`（无需鉴权），返回 `{initialized, dbVersion, requiredVersion, needUpgrade}`：
  未初始化或版本不一致时弹窗提示「去访问 `/api/init/<jwt_secret>`」，并在弹窗关掉前撤掉首屏 loading；
  任意接口返回 `code: 503`（就是数据库需要升级）时也会再次弹窗，用户点「我知道了」后本次会话不再重复打扰。

## 相关代码

- `mail-worker/src/service/send-provider-service.js`：服务商适配（请求体构造、错误信息、配置解析/合并/脱敏、重试与主备切换、体积限制）
- `mail-worker/src/service/send-webhook-service.js`：回调事件解析、状态映射、签名校验
- `mail-worker/src/api/webhook-api.js`：`/api/webhooks/{provider}` 路由
- `mail-worker/src/service/email-service.js`：渠道选择与 `sendProvider` 生成器
- `mail-worker/src/init/init.js`：数据库迁移（`v3_7DB`~`v3_10DB`）与 `db_migration` 登记
- `mail-vue/src/views/sys-setting/index.vue`：系统设置界面
- `mail-worker/test/send-provider.spec.js`：服务商请求体、配置合并与脱敏的单元测试
- `mail-worker/test/setting-provider.worker.spec.js`：指向本地 D1 的集成测试（初始化迁移、保存/读取/删除配置）
- `mail-worker/test/send-webhook.spec.js`：回调事件映射、签名校验与路由（含 401 拒绝）测试

以上测试统一通过 `npm run test:provider` 执行。
