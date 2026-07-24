# Google Search Console 接入与排名检查

## 为什么需要它

Google Search Console（GSC）是 Google 官方站长后台。它提供真实的搜索查询、曝光、点击、点击率、平均排名、收录状态和抓取问题。浏览器手动搜索会受到地区、设备、语言、历史记录和个性化影响，第三方抓取也可能被验证码阻断，因此不能替代 GSC。

验证不会购买广告，也不会改变网页排名；它只是向 Google 证明你拥有 `nyy.app`。

## 推荐方式：Domain Property + GoDaddy DNS

当前 `nyy.app` 的权威 DNS 是 GoDaddy：`ns49.domaincontrol.com` 与 `ns50.domaincontrol.com`。按以下步骤操作：

1. 使用准备长期管理网站的 Google 账号打开 <https://search.google.com/search-console>。
2. 点击左上角资源选择器，再点击“添加资源”。
3. 选择左侧“网域（Domain）”，输入 `nyy.app`。不要输入 `https://`、路径或末尾斜杠。
4. Google 会生成一条 TXT 值，格式类似 `google-site-verification=xxxxxxxx`。保留页面，不要改写该值。
5. 打开 GoDaddy 的域名控制中心：<https://dcc.godaddy.com/domains>，选择 `nyy.app`，进入“DNS”或“管理 DNS”。
6. 点击“添加新记录”，类型选择 `TXT`。
7. 名称/主机填写 `@`，值完整粘贴 Google 给出的 `google-site-verification=...`，TTL 使用默认值或 1 小时。
8. 只新增这条 TXT。不要修改现有 MX、SPF、DKIM、DMARC、A 或 CNAME 记录，尤其不要影响 `mail.nyy.app`。
9. 保存后等待 DNS 生效。通常几分钟，最长可能 24–48 小时。
10. 回到 GSC 点击“验证”。若失败，不要重复添加多条；先用 `dig TXT nyy.app` 检查 TXT 是否已公开。

验证成功后 TXT 记录应长期保留。Domain Property 会覆盖 `http/https`、主域和未来子域，是本项目首选方式。

## 验证后立即完成

1. 打开“站点地图”，提交 `https://nyy.app/sitemap.xml`。
2. 用“网址检查”分别检查首页及以下页面，并在尚未收录时请求编入索引：
   - `https://nyy.app/`
   - `https://nyy.app/large-file-transfer`
   - `https://nyy.app/no-signup-file-sharing`
   - `https://nyy.app/receive-files`
   - `https://nyy.app/wechat-large-file`
   - `https://nyy.app/how-it-works`
   - `https://nyy.app/security`
   - `https://nyy.app/about`
   - `https://nyy.app/contact`
   - `https://nyy.app/privacy`
   - `https://nyy.app/terms`
3. 确认分享短码页、`/admin`、`/my` 和内部预览页显示为不编入索引，这是预期结果。
4. 在“设置 > 用户和权限”中只添加必要账号，不共享 Google 主账号密码。

## 如何看“当前排名”

新资源通常需要数天出现数据。进入“效果 > 搜索结果”，固定比较周期和筛选条件：

1. 日期先选最近 28 天；积累数据后同时比较上一周期。
2. 分别查看“查询”和“网页”，并开启点击、曝光、平均点击率和平均排名。
3. 按国家/地区与设备拆分，避免把不同搜索环境混成一个数字。
4. 品牌词单独筛选 `拿呀`、`拿呀²`、`nyy.app`；非品牌词重点观察“大文件传输”“免注册文件分享”“在线收文件”“微信大文件怎么发”。
5. 平均排名是所有实际曝光位置的平均值，不是一个永久固定的“第几名”。曝光很少时，单日排名波动没有决策价值。
6. 每周记录查询、页面、曝光、点击、CTR 和平均排名；内容调整至少观察 2–4 周再判断。

## 可选方式：URL Prefix + Meta

如果暂时无法修改 DNS，可在 GSC 选择“网址前缀”，输入 `https://nyy.app`，选择 HTML 标记验证。项目已经支持构建环境变量：

```bash
GOOGLE_SITE_VERIFICATION=Google提供的content值
```

这里只填写 `<meta name="google-site-verification" content="...">` 中的 `content` 值，不填写整段 HTML。设置后必须重新构建并部署前端。URL Prefix 只覆盖指定协议和主机，不如 Domain Property 完整，因此 DNS 验证仍是推荐方案。

## 上线后自检

```bash
curl -I https://nyy.app/
curl -I https://nyy.app/sitemap.xml
curl -I https://nyy.app/robots.txt
curl -I https://nyy.app/.env
curl -s https://nyy.app/llms.txt
dig TXT nyy.app
```

预期结果：首页、sitemap、robots 和 `llms.txt` 返回 `200`；`/.env` 返回 `404`；DNS 验证后 TXT 输出包含 Google 验证值。

## 数据安全

- 不要把 Google 账号密码、Cookie、OAuth refresh token 或服务账号私钥提交到仓库或聊天记录。
- DNS TXT 验证值可以公开存在于 DNS，但仍应只放到正确域名。
- 如果后续自动读取 GSC API，应单独创建最小权限凭据，并放在服务器环境变量或受限密钥文件中。
