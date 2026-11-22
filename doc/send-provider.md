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

## 发件渠道优先级

1. 收件人全部是站内邮箱 → 站内投递
2. 配置了 Cloudflare Email（`wrangler.toml` 里的 `send_email` 绑定）→ Cloudflare Email
3. 当前发件域名的服务商 → Resend / Mailtrap / AhaSend / Plunk
4. 都没有 → 报错「发信服务未配置，只能给站内邮箱发件」

## 服务商对照

| 服务商 | API Key 获取 | 请求端点 | 附件 | 抄送 / 密送 |
| --- | --- | --- | --- | --- |
| Resend | https://resend.com/api-keys（`re_` 开头） | `POST https://api.resend.com/emails` | 支持 | 支持 |
| Mailtrap | https://mailtrap.io → Sending Domains → API Tokens | `POST https://send.api.mailtrap.io/api/send` | 支持 | 支持 |
| AhaSend | https://ahasend.com 控制台 → API Keys | v1：`POST /v1/email/send`；v2：`POST /v2/accounts/{accountId}/messages` | 支持 | v2 支持（走 conversation 接口），v1 不支持 |
| Plunk | https://app.useplunk.com → Settings → API Keys（`sk_` 开头） | `POST https://api.useplunk.com/v1/send` | 支持（10 个 / 10MB） | 接口没有抄送密送字段 |

### 各服务商注意事项

- **Resend**：域名需在 Resend 后台验证。使用「分开发送」时走批量接口，一次最多 100 位收件人且不支持附件（包含正文内嵌图片）；普通发送不受此限制。投递状态可通过 Resend Webhook 回写（默认地址 `/api/webhooks`，需在 Resend 后台配置）。
- **Mailtrap**：需要 `send.api.mailtrap.io`（Sending / 事务邮件）的 API Token，免费版只能向自己的测试收件箱投递，正式投递需要付费套餐并验证域名。
- **AhaSend**：
  - 只填 API Key 时使用 v1 接口（维护模式，功能可用），v1 没有抄送密送，抄送密送收件人会并入收件人列表（AhaSend 对每位收件人单独投递，彼此看不到其他地址）。
  - 同时填写账户 ID 时使用 v2 接口，支持抄送密送与更细的返回结果（每位收件人的 message id 会写入发件记录）。
- **Plunk**：正文必须是 HTML，纯文本邮件会被包一层 `<div>` 转成 HTML；接口没有抄送密送字段，同样并入收件人列表。

## 分开发送

「分开发送」会为每位收件人单独创建一条发件记录（附件、正文内嵌图每封都会带上）。除 Resend 走批量接口外，其余服务商按收件人逐个调用 API，失败时已成功的记录会保留，前端可以只重试失败收件人。

## 相关代码

- `mail-worker/src/service/send-provider-service.js`：服务商适配（请求体构造、错误信息、配置解析/合并/脱敏）
- `mail-worker/src/service/email-service.js`：渠道选择与 `sendProvider` 生成器
- `mail-worker/src/init/init.js`：`v3_7DB` 迁移（新增 `send_providers` 字段并迁移旧 Resend Token）
- `mail-vue/src/views/sys-setting/index.vue`：系统设置界面
- `mail-worker/test/send-provider.spec.js`：服务商请求体、配置合并与脱敏的单元测试
- `mail-worker/test/setting-provider.worker.spec.js`：指向本地 D1 的集成测试（初始化迁移、保存/读取/删除配置），与上面的单元测试一起通过 `npm run test:provider` 执行
