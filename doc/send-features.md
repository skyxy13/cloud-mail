# 发件功能：定时发送 / 草稿箱 / Reply-To / 抑制名单 / 域名配额

本页是「发件」相关的功能说明，配套 `doc/send-provider.md`（服务商、回调、重试、体积限制）。

## 定时发送

- 写信页工具栏的时钟按钮 → 选时间 → 提交，邮件会存进 `email_schedule`，由 cron 到点回放 `emailService.send`。
- 限制：至少 1 分钟之后、最多 30 天以内；**暂不支持附件**（附件要存 R2，当前直接拒绝并提示）。
- 到点发送仍会走完整校验（权限、配额、抑制名单、体积限制），所以「定时成功」不等于「一定能发出」，失败会记录原因。
- 失败最多重试 3 次，之后状态置为失败（`status = 3`），用户可在弹窗里看到并重新安排。
- cron 触发：`wrangler.toml` 里新增 `*/5 * * * *`，即最多延迟 5 分钟；原有的 `0 * * * *` 继续跑每小时的清理/统计任务。
- 接口：`POST /api/email/schedule`、`GET /api/email/schedule/list`、`DELETE /api/email/schedule/cancel?scheduleId=`。

## 草稿箱

- 草稿有两个副本：**本地**（IndexedDB，含附件）和**服务端**（`draft` 表，跨设备，不含附件）。
- 写信页关闭时保存草稿会同时写本地与服务端；服务端返回的 ID 会回写到本地记录（`serverId`），避免重复。
- 草稿页把两边合并展示：本地草稿（可带附件）+ 服务端草稿（无附件），删除时按来源分别处理。
- 接口：`GET /api/draft/list`、`POST /api/draft/save`、`DELETE /api/draft/delete?draftIds=`。

## 独立 Reply-To

- 写信页收件人右侧的 `Reply-To` 按钮可以单独指定回复地址，与发件人地址解耦。
- 校验为合法邮箱；保存在 `email.reply_to`，并透传给各服务商：
  - Resend：`replyTo`；Mailtrap：`reply_to`；AhaSend：v1 `content.reply_to` / v2 `reply_to`；Plunk：`reply`。

## 退信抑制名单（Suppression List）

- 服务商回调里的**永久退信**（Mailtrap `bounce`、AhaSend `message.bounced`、Resend/Plunk 的 `Permanent`）和**投诉**（`spam` / `complained` / `complaint`）会自动写入 `suppression` 表；
  临时退信（`soft bounce` / `transient_error` / `Transient`）不会写入。
- 发件时只要收件人（含抄送、密送）在名单里，就直接拒绝并列出命中地址；站内邮箱不受影响。
- 系统设置 → 退信抑制名单 可以查看、手动添加、删除。
- 接口：`GET /api/suppression/list`、`POST /api/suppression/add`、`DELETE /api/suppression/delete?emails=`。

## 域名每日发件配额

- 系统设置 → 域名每日配额：按发件域名设置每天可发出的封数（收件人 + 抄送 + 密送计数），0 表示不限。
- 计数放在 KV（`domain_send_day_count:{domain}:{YYYY-MM-DD}`，48 小时过期），每天自动从 0 开始；设置页会显示今日已发数量。
- 超出后当天该域名的发送会直接报错「今日发件配额已用 x/y」，站内发信也计入配额。
- 配置存在 `setting.domain_daily_quota`（JSON：`{"example.com": 200}`）。

## 数据库

`v3_11DB` 迁移新增：`email.reply_to`、`setting.domain_daily_quota`，以及 `email_schedule`、`draft`、`suppression` 三张表；执行一次 `/init/{jwt_secret}` 即可。
