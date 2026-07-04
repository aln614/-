# TENYING_AI NAS Docker 部署

这个镜像运行的是 TENYING_AI 的 Web/API 服务模式，不启动 Electron 桌面窗口。

## 镜像

- 镜像名：`tenying-ai:1.0.23`
- 容器端口：`7868`
- WebUI：`http://NAS_IP:7868`

## 数据目录

容器内目录：

- `/data/runtime`：任务库、配置、运行缓存
- `/data/output`：图片、视频输出
- `/data/downloads`：导出 ZIP / Excel 等下载文件

`docker-compose.nas.yml` 使用相对目录：

- `./runtime:/data/runtime`
- `./output:/data/output`
- `./downloads:/data/downloads`

把 compose 文件放在 NAS 的一个独立文件夹中启动，就会在该文件夹下自动创建这些目录。升级镜像时保留这些目录即可保留任务和历史数据。

## Docker Compose

```bash
docker compose -f docker-compose.nas.yml up -d
```

## 离线导入镜像

如果 NAS 不能直接拉镜像，先导入 tar：

```bash
docker load -i tenying-ai_1.0.23_amd64.tar
docker compose -f docker-compose.nas.yml up -d
```
