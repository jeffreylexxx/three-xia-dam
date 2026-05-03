# 三峡水库实时监测网页

## 本地打开方式

1. 在终端进入这个文件夹。
2. 运行 `node server.mjs`。
3. 终端出现 `Three Gorges dashboard: http://127.0.0.1:5173` 后，打开 `http://127.0.0.1:5173`。

不要直接双击 `index.html` 作为主要使用方式。浏览器直接打开本地 HTML 时没有本地代理，官方水文页面又没有开放跨域读取权限，图表容易空白。

## GitHub Pages / 在线打开方式

只把 `index.html`、`server.mjs`、`README.md` 上传到 GitHub Pages 不够。GitHub Pages 只托管静态文件，不会运行 `server.mjs`，所以在线版无法通过 `/api/hydro` 抓取官方水情。

在线版需要额外部署一个代理后端。可选方案：

1. 把 `cloudflare-worker.js` 部署到 Cloudflare Workers。
2. 得到 Worker 地址，例如 `https://three-gorges-proxy.example.workers.dev`。
3. 用带参数的 GitHub Pages 地址打开：`https://你的用户名.github.io/仓库名/index.html?api=https://three-gorges-proxy.example.workers.dev`。

第一次带 `api=` 参数打开后，网页会把代理地址保存到浏览器本地存储；之后普通打开同一个 GitHub Pages 页面也会继续用这个代理。

水情数据来自湖北水文“三峡水库水文站”公开页面，站码 `60106980`。发电量只展示官方公开披露节点；实时小时级发电功率未找到公开官方接口，页面中的功率与设备利用率均明确标为基于真实水情的估算。
