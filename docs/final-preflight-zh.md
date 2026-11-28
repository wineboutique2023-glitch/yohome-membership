# YOHOME 会员系统上线前准备

基线代码是 `6c9b7d4`。本阶段未改业务代码、生产数据库、云项目配置或生产分支。

## 已完成

- 核对 Supabase Free 方案的手动备份能力。当前没有验证过生产导出文件或可还原的生产恢复点。
- 核对正确 Vercel 项目名 `yohome-membership-pi7k` 和过去的 GitHub Production 部署记录。当前 Vercel 账号仍看不到这个项目的 dashboard 设置。
- 制作本机 Preview 包，使用带独立项目名的本地 Supabase，只有虚构会员、示例服务和测试礼券。使用受保护的托管 Preview 仍需要 Vercel 项目访问权限。
- 用真实 Supabase Auth、PostgREST 和 Chromium 做了这一轮新增的会员邮件验收。执行了当前已部署函数的邮件构造逻辑，并拦截所有出站请求。核对了收据 PDF、条款 PDF、成功标记和模拟发送失败后会员仍保存。没有调用生产发信函数，没有真正发送邮件。真实邮箱收件和生产条款文件未验收。生产函数启用了网关 JWT 验证，但该函数本身未按 CRM 角色和成员记录核对收件人与金额，并由请求指定条款来源。把这些限制列入邮件上线前安全审查，本阶段未修改函数。
- 临床表的独立修复计划见 `clinical-production-access-plan.md`。

## 第一步 · 点击哪里确认生产备份

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)，选择 **yohome-clinic**，核对项目 ref 为 `yubwwqcohdjtvvryvvzs`。
2. 打开 **Database → Backups**，查看是否有日期可选。只查看。若有既有手动备份，记下日期、版本、保管位置和文件校验值。Free 方案通常需要手动导出。
3. 在项目顶部点击 **Connect → Session pooler → Connection string**。有 IPv6 时也可选 **Direct connection**。用现有数据库密码。请不要在聊天或截图中发送密码、连接串或备份。忘记密码时先安排核对现有应用，当前阶段不重置。
4. 在可信管理员 Windows 电脑，打开 **Docker Desktop** 并确认已运行。打开 **PowerShell 7**，进入已经设好加密的备份文件夹。安装受支持的 Node.js，并用固定版本运行下列备份命令。连接串密码若包含特殊字符，在 URI 内需要正确编码。所有命令使用显式生产连接地址，不需要 link 生产项目。

```powershell
$source = Read-Host -MaskInput "Production database URI"
if ($source -notmatch 'yubwwqcohdjtvvryvvzs') { throw "Unexpected source project" }
npx --yes supabase@3.2.0 db dump "--remote=$source" --role-only --file roles.sql
if ($LASTEXITCODE) { throw "Roles export failed" }
npx --yes supabase@3.2.0 db dump "--remote=$source" --file schema.sql
if ($LASTEXITCODE) { throw "Schema export failed" }
npx --yes supabase@3.2.0 db dump "--remote=$source" --data-only --use-copy -x storage.buckets_vectors -x storage.vector_indexes --file data.sql
if ($LASTEXITCODE) { throw "Data export failed" }
Remove-Variable source
Get-FileHash roles.sql,schema.sql,data.sql -Algorithm SHA256
```

在备份记录注明项目 ref、澳洲本地时间、三份文件 SHA-256、导出结果和受限保管位置。三次导出不是同一个事务快照。如果期间有 DDL 变更，或数据核对不一致，应在批准的稳定窗口重取。正式切换前安排短暂写入暂停并补取最终备份。Storage 对象内容、Auth 设置、Edge Functions、邮件密钥、外部 Webhooks 及 Vault 解密资料若有使用，按管理员专用渠道分别记录或备份。

## 第二步 · 隔离恢复

1. 在管理员可信环境建立 **全新、私有、同 PostgreSQL 主版本的 Supabase 恢复环境**，与门店验收 Preview 分开。若需购买方案或新建云项目，先确认费用与数据处理范围。恢复环境禁用邮件、付款、公开应用访问和会发外部请求的集成。
2. 先在备份记录确认是否用到 Vault、加密列、非默认扩展及自定义 Auth/Storage 结构。有加密配置时先按官方对应步骤备妥密钥和设置。下列命令适用于常规 SQL 备份。将用于环境验收的恢复目标明确检查为本机回环地址。不要将此命令连生产。

```powershell
$target = Read-Host -MaskInput "Isolated localhost restore URI"
if ($target -notmatch '^postgres(ql)?://[^@]+@(127\.0\.0\.1|localhost):[0-9]+/postgres(?:\?|$)' -or $target -match 'yubwwqcohdjtvvryvvzs') { throw "Restore target must be isolated localhost" }
psql --dbname "$target" --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql --command "SET session_replication_role = replica" --file data.sql
if ($LASTEXITCODE) { throw "Restore failed, keep target isolated" }
Remove-Variable target
```

3. 对照备份：会员、结账、客户、Intake、SOAP 行数一致；抽核外键和授权；核对数据库定义、RLS 及存在的礼券流水与收入合计。记录失败项、恢复用时和复核人。若旧库仍有匿名策略，保持恢复环境封闭。门店验收 Preview 只使用模拟数据。
4. 当前需要你回传的是 **备份日期、校验值和恢复成功记录**。不用发数据库资料本身。

[Supabase 官方备份与恢复](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

## 第三步 · 点击哪里核对正确 Vercel 项目

1. 打开 [Vercel Dashboard](https://vercel.com/dashboard)，左上角切换到历史部署所属的账号或 Team。在 **Projects** 搜索 **yohome-membership-pi7k**。点 **Settings → Domains**，确认生产域名是 `yohome-membership-pi7k.vercel.app`。
2. 点 **Settings → Git**，确认 Connected Git Repository 为 `wineboutique2023-glitch/yohome-membership`。再点 **Settings → Environments → Production → Branch Tracking**，记下实际分支。当前只有历史 Production 部署记录，不能凭默认值推定现在仍跟踪 `main`。
3. 点 **Settings → Environment Variables**，切到 **Preview**，确认该测试分支有效值对应隔离 Supabase。在正确项目获得权限后，准备 Preview 时需要 `YOHOME_PREVIEW_SUPABASE_HOST`（隔离 host）、`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`（只用公开 key）和 `VITE_ENABLE_GIFT_CARDS=true`。生产环境不做更改。邮件 Preview 使用经过验证的捕获函数或测试域名收件策略，禁止沿用生产邮件密钥。
4. 仅分享项目 Dashboard 链接、Production Branch 名称、仓库名及 Preview 的数据库 **host**，不分享任何 Key。待核实并确认隔离分支权限后，再从 **Deployments** 检查 Preview 标识及隔离项目地址。

[Vercel Git 设置](https://vercel.com/docs/git) · [GitHub 历史部署](https://api.github.com/repos/wineboutique2023-glitch/yohome-membership/deployments/5060067478)

## 第四步 · 本机 Preview 与店内扫码

1. 解压 Preview，打开 **Docker Desktop**。在解压文件夹打开 **PowerShell**，运行 `npm.cmd ci`，再运行 `node tools/start-local-preview.mjs`。首次启动会下载本地开发镜像。浏览器打开 **http://127.0.0.1:5173**。测试账号见该文件夹内的 `.yohome-preview/preview-accounts.json`。此启动器基于 Supabase CLI 的本地流程，当前执行器没有 Docker，未在 Windows 或 Docker 上实际启动验证。前一阶段验证过相同应用的本机 Auth、数据库和浏览器。若不可用，请保留终端报错文字并遮盖任何 Key。
2. **Staff** 登录 → **Members** → **Register New Member**。输入虚构名字，Email 留空 → **Save Member & Send Receipt**，再打开 **View Profile**。Staff 页面应无 **Reports**。
3. **Staff** → **Gift Cards → Sales**。使用示例库存卡 `0000100`，按当前页面选择面值或服务礼券、测试付款方式及有效期。然后 **Checkout → Gift Card Checkout**，在 **Barcode** 框输入或扫卡。选服务 → **Calculate gift card payment** → 检查抵扣和应付 → **Confirm gift card checkout**。回到 **Members → View Profile** 核对消费、抵扣和实付。
4. 测试旧卡时，**Staff → Gift Cards → Legacy Claim** 提交测试旧条码，**Owner → Gift Cards → Approvals** 审核。兑换后需要换卡时，在 **Replacement barcode** 扫未使用的 `0000200`，勾选已收回旧卡。扫描 Enter 后页面仍应等你点击确认。检查旧卡状态和新卡余额。
5. 接实体扫码枪前，先打开 Windows **记事本** 扫一张测试卡。确认字符顺序和前导零正确，扫描一次只输入一次，并使用 Enter 后缀。实际条码不同的话，**Owner → Gift Cards → Card Stock** 注册实际新测试卡。用相同设备再走步骤 3、4。全程用测试条码和假金额。最后 **Owner → Reports** 比对售卡实收加补差额，旧卡转移不增加收款。
6. 会员邮件的本地捕获验收已完成，可跳过重复操作。若上线前需要确认真正收件，请在隔离环境配置独立发信凭据及测试收件限制，再从 **Members → Register New Member** 仅填店方指定测试邮箱。检查收件箱、两份附件和失败状态。当前本机启动器未配置真实发信。
