<div align="center">

<img src="build/icon-preview-256.png" width="96" alt="Longserve" />

# Longserve

**把服务器装进桌面，把运维交给 AI**

一句话部署上线 · 双端随身掌控 · 开箱即用

[⬇️ 下载](https://github.com/laolong7/longserve/releases) · [✨ 亮点](#-亮点) · [🗺 功能全景](#-功能全景) · [🚀 快速开始](#-快速开始) · [🛠 开发](#-开发)

</div>

---

## 它是什么

一款极其方便快捷的服务器工具：内置 **AI 副驾** 和热门运维功能，**一句话就能实现项目的部署上线和日常维护管理**。

它不是一个套壳的聊天框——AI 副驾直接坐在你的终端里，**看得懂当前连接，读得到执行输出**，一句话完成部署，一条指令同时管住服务器与本地文件。DeepSeek 思考模式深度适配，思考链路原样回传；OpenAI / Anthropic 兼容协议全支持，请求参数随手可调。

往服务器上放一个轻量 Agent，**手机就是第二块屏幕**——服务状态、远程指令、运行日志，随身掌控。没有服务器在手？它就是本机的终端，AI 照样能替你打理本地文件。

## 📦 下载

| 文件 | 说明 |
|------|------|
| `Longserve Setup x.x.x.exe` | Windows 安装版（推荐） |
| `Longserve x.x.x.exe` | 便携版，免安装双击即用 |

👉 前往 **[Releases](https://github.com/laolong7/longserve/releases)** 获取最新版本

## ✨ 亮点

### 🤖 AI 副驾，真的能干活

不是装饰品——它有手。

- **一句话运维**：描述需求，AI 直接生成并执行命令，部署上线、日常维护动口不动手
- **全协议适配**：DeepSeek / OpenAI 兼容 / Anthropic 网关，思考模式（reasoning）链路完整回传
- **高级参数可调**：附加请求体、自定义请求头、思考字段名——任何 AI 服务都能接
- **上下文感知**：知道你连着哪台服务器、站在哪个目录，甚至能直接操控本机文件

### 📱 双端联动

- 桌面端是指挥舱，手机端是随身遥控器
- 服务器部署轻量 Agent 后，手机浏览器即开服务管理、远程指令、日志追踪
- 指令输出实时流动，运行中一键 **^C 中止**
- Agent 更新同端口自愈，不用手动腾位置

### 🖥 开箱即用

- 双击即战——便携版连安装都不需要
- 未连接服务器时自动接管**本地终端**，AI 照常打理本机文件
- 无边框桌面体验，日志栏、终端、AI 对话同屏协作

## 🗺 功能全景

| 分类 | 能力 |
|------|------|
| **连接** | SSH 多服务器管理 · 本地电脑终端 · 状态灯与自动重连 |
| **终端** | xterm 终端 · 逐字符回显 · 缓冲回放 |
| **指令** | 实时输出流 · ^C 一键中止 · 交互命令即时报错 |
| **文件** | SFTP 传输 · 备份管理 · 本地/远程双向 |
| **网络** | 端口转发规则 · 转发列表管理 |
| **服务** | 进程原位启动/停止 · 状态即时可见 |
| **AI** | 多协议 · 思考模式回传 · 高级参数 · 直接操控文件 |
| **Agent** | 一键部署/更新 · 同端口自愈 · 手机 Web 控制台 |

## 🚀 快速开始

1. **下载** —— [Releases](https://github.com/laolong7/longserve/releases) 取安装包或便携版，双击运行
2. **连服务器** —— 左侧添加 SSH 连接，或直接用「本地电脑」终端
3. **部署 Agent**（可选）—— 一键部署到服务器，解锁手机控制与 AI 远程运维
4. **配置 AI**（可选）—— 填入 DeepSeek / OpenAI / Anthropic 任一服务的 API Key，副驾就位

## 🛠 开发

```bash
npm install       # 安装依赖
npm run dev       # 开发模式
npm run dist      # 打包 exe（产出在 release/）
```

## 💡 常见问题

<details>
<summary>本地终端打不出 vim / top？</summary>

本地终端是管道模式（cmd 级），适合日常命令；vim、top 这类全屏交互程序请走 SSH 终端。
</details>

<details>
<summary>mysql 为什么提示输入不了密码？</summary>

指令通道不支持交互输入（`mysql -u root -p` 会停在密码提示）。把参数带全一条跑完：

```bash
mysql -u root -p'密码' -e 'show databases;'
```

注意 `-p` 和密码之间**没有空格**。
</details>

<details>
<summary>手机端怎么用？</summary>

在服务器上部署 Agent 后，手机浏览器打开 Agent 控制台地址即可——服务、指令、日志、AI 对话全在掌上。
</details>

## 📄 协议

基于 [MIT](LICENSE) 协议开源 · Issues 欢迎反馈

<div align="center">

**Longserve** · 让运维回到「一句话」的尺度

</div>
