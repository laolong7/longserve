# longserve

一款极其方便快捷的服务器工具，内置AI副驾和热门运维功能。一句话就能实现项目的部署上线和日常维护管理！

## 📦 下载

前往 **[Releases](https://github.com/laolong7/longserve/releases)** 下载最新安装包（`Longserve Setup x.x.x.exe`），双击安装即可使用。

> 便携版（`Longserve x.x.x.exe`）免安装，双击即用。

## ✨ 功能

- **SSH 服务器管理** —— 多服务器连接、终端、文件传输、备份
- **AI 副驾** —— 支持 DeepSeek / OpenAI 兼容 / Anthropic 协议模型，一句话部署运维，可直接操控服务器与本地文件
- **手机控制** —— 独立手机控制页，服务管理、远程指令、日志随身看
- **指令执行** —— 远程指令带输出流，支持 ^C 中止，交互式命令即时报错
- **端口转发** —— 转发规则管理，内网服务直达
- **本地终端** —— 未连接服务器时直接操作本机
- **服务管理** —— 进程原位启动/停止，状态一目了然

## 🛠 开发

```bash
npm install          # 安装依赖
npm run dev          # 开发模式
npm run dist         # 打包 exe（产出在 release/）
```

## 📄 协议

基于 [MIT](LICENSE) 协议开源。
