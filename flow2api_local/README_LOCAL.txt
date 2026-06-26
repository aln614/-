Flow2API 本地服务

服务地址：http://127.0.0.1:38000
管理后台：http://127.0.0.1:38000
API Key：laig-flow2api-local-2026
管理账号：admin
管理密码：LAIG-Flow-Admin-2026

首次使用：
1. 启动 Docker Desktop。
2. 双击 start_flow2api.bat。首次启动会构建带 Xvfb/Chromium 的 headed 镜像，耗时较长；后续启动会复用镜像。
3. 登录管理后台，在 Token 管理中导入你自己的 Google Flow ST/Token。
4. Token 可用后，本软件首页选择“本地 Flow2API”即可生成。

本地部署默认使用 personal 验证码模式，不限制 Token 图片并发。reCAPTCHA 风控错误会重建浏览器并保留 Token，不再因连续三次验证码失败永久禁用账号。

如果日志出现 PUBLIC_ERROR_UNUSUAL_ACTIVITY，表示 Google 临时拒绝当前浏览器/IP 的验证码评分，不代表 ST/AT 已失效。新版会保留 Token 并允许恢复；短时间反复高并发只会延长风控时间。

停止服务：双击 stop_flow2api.bat。

验证码模式选择 browser 或 personal 时必须使用本目录的 headed 部署。标准无头镜像会报 Failed to obtain reCAPTCHA token。
