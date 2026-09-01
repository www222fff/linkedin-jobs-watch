# LinkedIn Jobs Watch (职位实时雷达)

基于 Cloudflare Workers 与 Cloudflare KV 的全栈 LinkedIn 职位实时检索与监控应用。

## 🌟 特性

- **免登录实时检索**：通过 LinkedIn Guest API 接口实时获取最新职位列表与岗位详情。
- **Cloudflare KV 持久化缓存**：采用 Cache-Aside 懒加载缓存策略，自动缓存 24 小时（86400 秒 TTL），实现毫秒级二次访问响应。
- **中国境内 Remote 与 On-site 专属过滤**：
  - 支持限定中国大陆地区 Remote / On-site 办公形式（`f_WT=2` 远程 / `f_WT=1` 现场）。
  - 内置快捷搜索预设标签（中国 Remote 全栈、中国 Remote AI Agent、中国 On-site 等）。
- **国内 451 错误拦截与直达复制**：
  - 自动规范化国际版职位 URL（剔除已下线的 `linkedin.cn` 跳转）。
  - 内置一键复制链接与代理访问提示，解决国内直连 451 限制。
- **自适应响应式设计**：
  - 桌面端：左侧职位列表、右侧详情分屏联动。
  - 移动端：分段切换器（列表/详情 Tab）、紧凑型搜索表单、横向快捷标签滑动。

---

## 🛠️ 技术栈

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (Edge Serverless)
- **Database / Cache**: [Cloudflare KV](https://developers.cloudflare.com/kv/)
- **Frontend**: Vanilla JavaScript + Tailwind CSS (CDN) + Font Awesome 6
- **Deployment**: Wrangler CLI

---

## 🚀 本地开发与部署

### 1. 安装依赖

```bash
npm install -g wrangler
# 或者使用本地 npm
npm install
```

### 2. 配置 Cloudflare KV

在 `wrangler.toml` 中配置您的 KV 绑定：

```toml
name = "linkedin-jobs-explorer"
main = "src/index.js"
compatibility_date = "2026-08-25"
workers_dev = true

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"
```

### 3. 部署上线

```bash
wrangler deploy
```

---

## 📄 许可与声明

仅供个人求职检索与技术交流验证使用。数据来源于 LinkedIn 公开访客接口。
