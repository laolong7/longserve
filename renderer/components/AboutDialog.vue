<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="close">
      <div class="modal about-modal">
        <div class="about-head">
          <span class="about-logo">◆</span>
          <div class="about-title-wrap">
            <div class="about-title">Longserve</div>
            <div class="about-sub">带 AI 副驾的服务器终端管理工具</div>
          </div>
          <span class="about-ver mono">v{{ info.version || '…' }}</span>
          <button class="ghost" @click="close">✕</button>
        </div>

        <div class="about-layout">
          <!-- 左侧导航 -->
          <div class="about-nav">
            <div class="nav-item" :class="{ on: view === 'about' }" @click="view = 'about'">
              <span class="nav-ico">◆</span> 关于系统
            </div>
            <div class="nav-item" :class="{ on: view === 'guide' }" @click="view = 'guide'">
              <span class="nav-ico">📖</span> 使用指南
            </div>
            <div class="nav-sep"></div>
            <div class="nav-group" v-if="view === 'guide'">指南目录</div>
            <div
              v-for="s in GUIDE"
              :key="s.id"
              v-show="view === 'guide'"
              class="nav-sub"
              @click="scrollTo(s.id)"
            >{{ s.title }}</div>
          </div>

          <!-- 右侧内容 -->
          <div class="about-body" ref="bodyEl">
            <!-- ================= 关于系统 ================= -->
            <template v-if="view === 'about'">
              <div class="about-card open-line">
                <span class="tag">开源项目</span>
                作者 <b>Laolong</b> · 基于 MIT 协议在 GitHub 开源：
                <a class="mono" href="#" @click.prevent="openRepo">github.com/laolong7/laolong-server-utilities</a>
                <span class="faint">（占位链接）</span>
              </div>

              <!-- 全功能清单 -->
              <div class="about-card" v-for="g in FEATURES" :key="g.group">
                <div class="card-title">{{ g.group }}</div>
                <div class="feat-table">
                  <div class="feat-row" v-for="f in g.items" :key="f.t" :title="f.d">
                    <span class="feat-ico">{{ f.i }}</span>
                    <span class="feat-name">{{ f.t }}</span>
                    <span class="feat-desc">{{ f.d }}</span>
                  </div>
                </div>
              </div>

              <!-- 架构分层 -->
              <div class="about-card">
                <div class="card-title">架构：四层隔离，安全优先</div>
                <div class="arch">
                  <div class="arch-layer" v-for="(l, i) in ARCH" :key="l.name">
                    <div class="arch-box" :style="{ borderColor: l.color }">
                      <span class="arch-name">{{ l.name }}</span>
                      <span class="arch-desc">{{ l.desc }}</span>
                    </div>
                    <div v-if="i < ARCH.length - 1" class="arch-arrow">↕</div>
                  </div>
                </div>
                <div class="faint" style="font-size:11px; margin-top:6px">
                  渲染层不接触网络与文件系统；一切敏感操作经主进程白名单 IPC 执行，密码与密钥全程 DPAPI 加密。
                </div>
              </div>

              <!-- 技术栈 -->
              <div class="about-card">
                <div class="card-title">技术栈</div>
                <div class="stack">
                  <span class="stack-item" v-for="s in STACK" :key="s.name" :title="s.desc">
                    <b>{{ s.name }}</b><span class="faint">{{ s.ver }}</span>
                  </span>
                </div>
              </div>

              <!-- 代码构成条形图 -->
              <div class="about-card">
                <div class="card-title">代码构成 <span class="faint" style="font-weight:400">（约 7.4k 行）</span></div>
                <div class="chart">
                  <div class="chart-row" v-for="r in CODE" :key="r.name" :title="`${r.name}：${r.val} 行`">
                    <span class="chart-label">{{ r.name }}</span>
                    <div class="chart-track">
                      <div class="chart-bar" :style="{ width: (r.val / CODE_MAX * 100) + '%' }"></div>
                    </div>
                    <span class="chart-val mono">{{ r.val }}</span>
                  </div>
                </div>
              </div>

              <!-- 联系开发者 -->
              <div class="about-card">
                <div class="card-title">联系开发者</div>
                <div style="font-size:12.5px; line-height:1.9">
                  使用中有任何异常，或有什么需求，欢迎联系开发者：
                  <b class="mono" style="user-select:all">2799401288@qq.com</b>
                </div>
              </div>

              <div class="about-foot faint">
                牢笼 & 逐光 出品 · Electron {{ info.electron || '…' }} · {{ platformName }}
              </div>
            </template>

            <!-- ================= 使用指南 ================= -->
            <template v-else>
              <div class="about-card guide" v-for="s in GUIDE" :key="s.id">
                <div class="card-title" :id="'g-' + s.id">{{ s.title }}</div>
                <div v-for="(p, i) in s.paras" :key="i" class="guide-p" v-html="p"></div>
                <div v-if="s.tips" class="guide-tips">
                  <div class="tips-head">💡 建议</div>
                  <div v-for="(t, i) in s.tips" :key="i" class="guide-tip">· {{ t }}</div>
                </div>
              </div>
              <div class="about-foot faint">—— 使用指南完 ——</div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const visible = ref(false)
const view = ref('about')
const info = ref({})
const bodyEl = ref(null)
const GITHUB = 'https://github.com/laolong7/laolong-server-utilities' // TODO: 仓库建好后替换为真实地址

// ---------- 全功能清单（关于系统） ----------
const FEATURES = [
  {
    group: '终端与连接',
    items: [
      { i: '⌨', t: 'SSH 终端', d: 'xterm.js 仿真终端，命令直达服务器，支持全屏程序（vim/htop）' },
      { i: '🗂', t: '多标签 / 多开', d: '多标签切换；同一服务器可开多条并行连接（⧉ 多开）' },
      { i: '◫', t: '并列分屏', d: '选一台服务器与当前终端上下各占一半（最多两个），各格可独立关闭' },
      { i: '🪟', t: '多窗口', d: '再次双击 exe 自动平铺新窗口，窗口间互不干扰' },
      { i: '📡', t: '连接质量', d: '标签实时显示延迟 RTT 与丢包率（10 秒采样）' },
      { i: '🔁', t: '断线自动重连', d: '意外掉线自动重连 3 次（间隔 3 秒），手动断开不触发' },
      { i: '🔎', t: '终端搜索', d: 'Ctrl+F 搜索终端全部输出，Enter/↑↓ 跳转命中' },
      { i: '💻', t: '本地电脑终端', d: '未连接服务器时默认开本机命令提示符；左侧列表常驻「本地电脑」入口，AI 能识别本地上下文并直接操控本机文件' }
    ]
  },
  {
    group: '服务器运维',
    items: [
      { i: '📊', t: '监控仪表盘', d: '每 3 秒采样 /proc：CPU 折线、内存、磁盘、负载、网卡吞吐（只读无侵入）' },
      { i: '⚙', t: 'systemd 服务面板', d: '扫描服务器真实存在的服务（运行中+已安装未运行）：停止/重启/启动，nginx、前后端、MySQL 等核心服务置顶，关键服务操作强确认' },
      { i: '▤', t: '日志查看器', d: 'tail -F 实时跟随任意日志文件，浮窗可拖动调宽高，关键字过滤高亮' },
      { i: '⇄', t: '端口转发', d: '本地转发(-L)与远程转发(-R)图形化配置，连接断开自动清理' },
      { i: '🛰', t: '连接日志', d: '连接过程的真实阶段日志（握手/认证/终端就绪）' }
    ]
  },
  {
    group: '手机控制',
    items: [
      { i: '📱', t: '一键部署 Agent', d: '把 Longserve Agent 单二进制部署到服务器（systemd 常驻，独立端口，不碰已有服务），老系统 glibc≥2.17 通吃' },
      { i: '🔐', t: '扫码绑定', d: '生成含密钥的二维码，手机浏览器扫码即连；重新生成密钥一键解绑全部手机' },
      { i: '◈', t: '手机控制台', d: '概览仪表盘（CPU/内存/网络/磁盘/Top 进程）+ 心跳检测（ECG 延迟波形、连接性告警）+ 全部 systemd 服务控制' },
      { i: '❯', t: '手机指令 + AI', d: '终端式指令页（手动输入/粘贴、磁盘持久化）+ AI 对话（危险命令两段式确认）' },
      { i: '🕘', t: '记录可回看', d: '桌面端手机控制里可查看网页/手机端的指令记录与聊天记录（服务器磁盘存储）' },
      { i: '🔍', t: '部署失败 AI 诊断', d: '部署失败自动分析日志给出根因与修法（按部署所选 AI 配置）' }
    ]
  },
  {
    group: '文件传输',
    items: [
      { i: '⇅', t: 'SFTP 双面板', d: '本机与远程双向浏览，上传/下载/新建/重命名/删除，文件夹递归' },
      { i: '🖱', t: '拖拽传输', d: '本机文件拖进远程面板即上传；文件拖到终端弹窗选目标路径上传' },
      { i: '📈', t: '传输进度', d: '实时进度条 + 取消按钮，逐文件任务管理' }
    ]
  },
  {
    group: 'AI 副驾',
    items: [
      { i: '✦', t: '流式对话', d: '思考过程与回答逐字流出，思考内容可折叠回看，消息标注模型名' },
      { i: '🛠', t: '工具调用', d: 'AI 直接执行终端命令、读写本机文件、查远程目录、下载服务器文件' },
      { i: '⚡', t: '命令模式', d: '自然语言直译成若干条纯指令，逐条执行或一键顺序执行（默认的对话方式叫副驾模式）' },
      { i: '✦', t: '选中问 AI', d: '终端选中报错输出，一键带上下文提问分析' },
      { i: '⟲', t: '文件快照安全网', d: 'AI 改配置前强制备份，一键还原回滚，本地写文件同样留备份' },
      { i: '⚡', t: '自定义技能', d: '把固定工作流写成技能，AI 按场景自动加载执行' },
      { i: '▶', t: '技能流水线', d: '多个技能串成步骤，检查点处暂停等人工确认' },
      { i: '🕘', t: '历史会话', d: 'AI 对话自动落盘（保留 200 个），可搜索、可恢复上下文' },
      { i: '🛡', t: '危险命令拦截', d: '规则清单 + AI 自评双保险，删除/重启类命令必须弹窗确认' }
    ]
  },
  {
    group: '录制与回放',
    items: [
      { i: '⏺', t: '会话录制', d: '一键录制终端输出为 asciinema v2 格式（.cast）' },
      { i: '▶', t: '回放管理器', d: '设置→数据里回放录制文件：播放/暂停/拖进度/0.5~8 倍速' },
      { i: '⬇', t: '导出视频', d: '一键把录制导出为 WebM 视频文件，可直接分享' }
    ]
  },
  {
    group: '外观与体验',
    items: [
      { i: '🎨', t: '主题系统', d: '默认深海蓝+真透明；5 套预设 + 自定义强调色/文字色/色相/透明度' },
      { i: '🪟', t: '窗口效果', d: '真透明（看桌面）/ Win11 磨砂 / 不透明，切换时自选重启时机' },
      { i: '🖥', t: '终端主题', d: '终端背景/文字色独立设置或跟随全局，字号 11~20px 实时生效' },
      { i: 'ⓘ', t: '关于与指南', d: '标题栏 📖 使用指南与 ⓘ 关于系统：全功能清单、架构说明、使用指南、开发者联系方式' }
    ]
  },
  {
    group: '数据与安全',
    items: [
      { i: '🔒', t: '密钥加密', d: '服务器密码与 AI Key 用 Windows DPAPI 系统级加密落盘，永不明文' },
      { i: '🔒', t: '密钥不回显', d: '已保存的密码/Key 界面不可查看，只可重置更换' },
      { i: '💾', t: '数据独立目录', d: '配置与数据独立于程序，删软件不丢数据，可迁移换机' },
      { i: '🐕', t: '超时看门狗', d: 'AI 请求三重超时保护（首响应/流空闲/总时长），永不永久转圈' },
      { i: '🧩', t: 'AI 高级参数', d: '附加请求体/自定义请求头 JSON 万能出口，适配任意类型 AI（DeepSeek 思考参数等）；思考回传字段名可配' }
    ]
  }
]

const ARCH = [
  { name: '界面层', desc: 'Vue 3 + Pinia（渲染进程，零特权）', color: 'var(--violet)' },
  { name: '安全桥', desc: 'contextBridge 白名单 IPC（contextIsolation 隔离）', color: 'var(--blue)' },
  { name: '主进程', desc: 'Electron Node.js：窗口 / 配置加密存储 / 看门狗', color: 'var(--green)' },
  { name: '连接层', desc: 'ssh2 终端流 · SFTP 传输 · AI 网关（SSE 双协议）', color: 'var(--amber)' }
]

const STACK = [
  { name: 'Electron', ver: '44', desc: '桌面壳与多窗口' },
  { name: 'Vue', ver: '3.5', desc: '界面框架' },
  { name: 'Pinia', ver: '3', desc: '状态管理' },
  { name: 'xterm.js', ver: '5.5', desc: '终端仿真' },
  { name: 'ssh2', ver: '1.17', desc: 'SSH/SFTP 协议实现' },
  { name: 'Vite', ver: '7', desc: '构建工具' },
  { name: 'DPAPI', ver: '', desc: 'Windows 系统级加密存储' }
]

const CODE = [
  { name: '界面组件', val: 4200 },
  { name: '主进程', val: 1900 },
  { name: '状态与工具', val: 1300 }
]
const CODE_MAX = Math.max(...CODE.map((c) => c.val))

// ---------- 使用指南 ----------
const GUIDE = [
  {
    id: 'start',
    title: '① 快速上手：连上你的第一台服务器',
    paras: [
      '1. 点左下角 <b>⚙ 实例与 AI 设置</b> → 服务器实例 → <b>＋ 新增服务器</b>，填名称、IP、端口（默认 22）、用户名和密码，保存。密码经 Windows DPAPI 加密存储，保存后不再显示，只能重置。',
      '2. 在左侧服务器列表<b>双击</b>实例建立连接（也可以右键 → 连接）。连接中会显示真实的握手/认证阶段日志。',
      '3. 同一台服务器想要多条终端？点 <b>⧉ 多开</b> 再开一条并行连接。',
      '4. 想两个终端上下对照着看？点 <b>◫ 并列</b> 选择要并列的服务器（可以是别的机器），上下各占一半；每格右上角有独立红叉，切到其他标签页时并列保留，点回并列标签自动恢复。',
      '5. 终端里 <b>Ctrl+F</b> 可搜索全部输出（Enter 跳下一个，Esc 关闭）。'
    ],
    tips: ['意外断网会自动重连 3 次；手动关闭的标签不会自动重连。', '标签上的数字是实时延迟（如 23ms），变黄说明网络慢，变红说明丢包严重。']
  },
  {
    id: 'monitor',
    title: '② 监控仪表盘与服务面板',
    paras: [
      '<b>监控仪表盘</b>在左栏下方：CPU 折线（40 个采样点）、内存/磁盘占用条、系统负载、网卡上下行速率。原理是每 3 秒通过 SSH 读取 /proc 与 df 做差值计算，<b>不在服务器上安装任何东西</b>，全程只读。',
      '<b>服务面板</b>在监控下方：自动扫描服务器上<b>真实存在</b>的服务——运行中的和已安装但没运行的，不会凭空捏造。每行显示状态：<b>运行中的可停止/重启，没运行的可启动</b>；点行展开可切换<b>开机自启</b>。排序按重要度而非字母序：nginx、前后端应用、MySQL 等核心服务置顶（如果存在）。顶部输入框可快速筛选（如输入 gunicorn）。面板高度不超过左栏一半。',
      '<b>日志查看器</b>：点标签栏 <b>▤</b> → 选择服务器（未连接会自动建一条专用连接）→ 输入日志路径（Ubuntu 默认 /var/log/syslog，CentOS 用 /var/log/messages）→ 终端下方浮出日志窗，实时滚动、可拖动位置、右下角拖拽调宽高、输入关键字过滤并高亮。'
    ],
    tips: ['对 sshd、network 等关键服务操作会额外强确认——那真的可能把你自己的连接掐断。', '监控与服务面板跟随"当前激活的标签"采样，切换服务器时数据自动跟着切。']
  },
  {
    id: 'files',
    title: '③ 文件传输与端口转发',
    paras: [
      '<b>SFTP 双面板</b>：点标签栏 <b>⇅</b>，左边本机、右边远程。勾选文件点中间「上传/下载」；本机文件可直接<b>拖进远程面板</b>上传；传输任务有实时进度可取消。注意：下载前先在左侧进入要保存到的具体文件夹（"此电脑"视图下会拦截提醒）。',
      '<b>终端拖拽上传</b>：把文件直接拖到终端黑框上，弹窗填远程目标目录（默认 home），确认后开始上传，右下角显示进度。',
      '<b>端口转发</b>：点 <b>⇄</b>。本地转发(-L)：访问"本机端口"相当于访问"服务器能访问的地址"，典型用途是把服务器的 MySQL(3306) 映射到本机 13306；远程转发(-R)：反过来，让服务器上的端口穿过隧道回到你本机的服务。连接断开后转发自动失效。'
    ],
    tips: ['远程转发需要服务器防火墙放行监听端口，否则外部访问不到。', '转发列表里随时可点「停止」回收端口。']
  },
  {
    id: 'ai',
    title: '④ AI 副驾：让 AI 替你操作服务器',
    paras: [
      '先在 <b>设置 → AI 配置</b> 填好接口地址与 API Key（支持 OpenAI 兼容协议与 Anthropic 原生协议，点「测试连接」验证）。然后在右侧 AI 面板直接说话即可，比如"看看磁盘占用，超过 80% 的分区列出来"。',
      'AI 能：<b>在终端里真实执行命令</b>（你能全程看到打字过程）、读取终端画面、查远程/本机目录、读写本机文件、下载服务器文件。回答和思考过程<b>逐字流式</b>显示，消息标签显示所用模型。',
      '<b>命令模式</b>（⚡）：对话框有两种模式——默认的<b>副驾模式</b>正常对话、AI 自己动手干活；切到<b>命令模式</b>后描述需求（如"清理 nginx 日志并重载"），AI 直译成<b>若干条纯指令</b>，可逐条执行，也可一键顺序执行，每条危险指令都会先弹窗确认。',
      '<b>选中问 AI</b>：终端里遇到看不懂的报错，用鼠标选中那几行，点右下角「✦ 问 AI」，自动带上下文分析。',
      '<b>技能</b>：设置→AI 技能里预设了服务器体检、nginx 重载、日志排查、部署学子急事通、磁盘清理五个技能，也可以写自己的。AI 在任务匹配时自动加载。',
      '<b>流水线</b>（▶）：把多个技能串成步骤一键顺序执行，带检查点的步骤完成后暂停等你确认再继续。预设了"服务器例行体检""学子急事通发布""nginx 变更发布""服务故障排查"四条。'
    ],
    tips: [
      '<b>快照安全网</b>：AI 修改任何配置文件前会强制先备份（.laoji-bak-时间戳），AI 面板点 ⟲ 可随时一键还原。养成先看快照再放心的习惯。',
      '删除、重启等危险命令无论怎么触发都会弹窗二次确认——不要嫌烦，这道闸拦过事故。',
      'AI 历史会话自动保存，点 📜 可搜索并恢复上下文接着聊。'
    ]
  },
  {
    id: 'record',
    title: '⑤ 会话录制与视频导出',
    paras: [
      '点标签栏 <b>⏺</b> 开始录制当前终端的全部输出，再点一次停止并自动保存为 asciinema 格式（.cast），文件名 = 服务器名 + 时间戳。',
      '到 <b>设置 → 数据 → 会话录制</b> 查看/修改保存位置，点「▶ 预览 / 回放录制」打开回放器：选文件、播放/暂停、拖进度条、0.5~8 倍速。',
      '回放器里点「<b>⬇ 导出视频</b>」会把录制完整回放一遍并录成 WebM 视频文件，存到录制文件同目录，可以直接发给别人看。'
    ],
    tips: ['导出耗时 = 回放时长 ÷ 倍速，赶时间用 4x/8x。', '录制只录"开始那一刻所在的连接"，切到别的服务器不录。']
  },
  {
    id: 'look',
    title: '⑥ 外观与个性化',
    paras: [
      '默认主题是<b>深海蓝 + 真透明</b>（界面透明度 60%，终端背景 #16181d、终端文字 #00ffee，均独立配色不跟随全局）。设置 → 外观里可以：',
      '· 换 5 套预设主题（深海蓝/磷光绿/暖橙/紫夜/灰岩）或自定义强调色、文字色、背景色相；',
      '· 调<b>界面透明度</b>（数值越小越通透，实时生效）；',
      '· 窗口效果三选一：<b>真透明</b>（直接看到桌面壁纸）、<b>磨砂玻璃</b>（Win11 亚克力）、<b>不透明</b>。切换磨砂/真透明需要重启应用——会弹窗让你选"重新打开"或"下次打开时应用"，选后者不会打断你现在的工作；',
      '· 终端背景/文字色可独立设置或跟随全局，字号 11~20px 拖动即生效。'
    ],
    tips: ['改动的所有外观项即时生效并自动保存，不用找保存按钮。', '透明模式下终端与面板从同一底色透出，颜色永远是一体的。']
  },
  {
    id: 'data',
    title: '⑦ 数据与安全须知',
    paras: [
      '所有数据（服务器配置、加密后的密码、AI 配置、对话历史、录制文件）保存在独立数据目录，删除软件不会丢。设置→数据里，数据保存位置下方就是<b>打开数据文件夹 / 更改保存位置 / 恢复默认位置</b>三个按钮；再往下是会话录制的保存位置与回放入口。换电脑时"更改保存位置"或直接拷贝数据文件夹即可迁移。',
      '密码与 API Key 用 Windows DPAPI 加密——绑定你的 Windows 账户，拷到别的机器也解不开。若系统级加密环境变化导致解密失败，界面会明确提示重填。',
      '已保存的密码与 API Key 在界面中<b>永远不可查看</b>，只能点「重置」后重新输入。'
    ],
    tips: ['换目录操作会自动重启应用完成迁移；恢复默认位置也在同一排按钮里。']
  }
]

const platformName = ref('Windows')
onMounted(async () => {
  try {
    info.value = await window.api.appInfo()
    platformName.value = info.value.platform === 'darwin' ? 'macOS' : info.value.platform === 'linux' ? 'Linux' : 'Windows'
  } catch { /* 版本信息拿不到不影响浏览 */ }
})

function open(viewName) {
  visible.value = true
  view.value = viewName === 'guide' ? 'guide' : 'about'
}
function close() {
  visible.value = false
}
function scrollTo(id) {
  const el = bodyEl.value?.querySelector('#g-' + id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function openRepo() {
  window.api.openExternal(GITHUB)
}
defineExpose({ open })
</script>

<style scoped>
.about-modal { width: 860px; height: 640px; }
.about-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.about-logo { font-size: 24px; color: var(--green); }
.about-title { font-size: 15px; font-weight: 600; }
.about-sub { font-size: 11.5px; color: var(--text-faint); margin-top: 2px; }
.about-ver {
  margin-left: auto;
  font-size: 11px;
  color: var(--green);
  background: var(--green-dim);
  border-radius: 10px;
  padding: 2px 9px;
}
.about-layout { display: flex; flex: 1; min-height: 0; }

/* 左侧导航 */
.about-nav {
  width: 150px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 10px 8px;
  overflow-y: auto;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-dim);
  cursor: pointer;
}
.nav-item:hover { background: var(--bg3); }
.nav-item.on { background: var(--bg3); color: var(--text); border-left: 2px solid var(--green); }
.nav-ico { font-size: 12px; }
.nav-sep { height: 1px; background: var(--border); margin: 8px 4px; }
.nav-group { font-size: 10.5px; color: var(--text-faint); letter-spacing: 1px; padding: 2px 10px 6px; }
.nav-sub {
  padding: 5px 10px 5px 18px;
  font-size: 11.5px;
  color: var(--text-faint);
  cursor: pointer;
  border-radius: var(--radius-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-sub:hover { color: var(--text); background: var(--bg3); }

/* 右侧内容 */
.about-body { padding: 14px 18px 18px; overflow-y: auto; flex: 1; min-width: 0; }
.about-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg0);
  padding: 12px 14px;
  margin-bottom: 12px;
}
.open-line { font-size: 12.5px; line-height: 1.8; }
.open-line .tag {
  font-size: 10.5px;
  color: var(--green);
  background: var(--green-dim);
  border-radius: 8px;
  padding: 1px 8px;
  margin-right: 6px;
}
.open-line a { color: var(--blue); text-decoration: none; }
.open-line a:hover { text-decoration: underline; }
.card-title { font-size: 12.5px; font-weight: 600; margin-bottom: 10px; }

/* 全功能清单表 */
.feat-table { display: flex; flex-direction: column; gap: 2px; }
.feat-row {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.feat-row:hover { background: var(--bg2); }
.feat-ico { width: 18px; text-align: center; flex-shrink: 0; font-size: 12px; }
.feat-name { font-weight: 600; flex-shrink: 0; min-width: 108px; }
.feat-desc { color: var(--text-faint); font-size: 11.5px; line-height: 1.5; }

/* 架构分层图 */
.arch { display: flex; flex-direction: column; align-items: stretch; }
.arch-layer { display: flex; flex-direction: column; align-items: center; }
.arch-box {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 10px;
  border: 1px solid var(--border-strong);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  background: var(--bg1);
}
.arch-name { font-size: 12.5px; font-weight: 600; flex-shrink: 0; }
.arch-desc { font-size: 11px; color: var(--text-dim); }
.arch-arrow { color: var(--text-faint); font-size: 11px; line-height: 1.4; }

/* 技术栈徽章 */
.stack { display: flex; flex-wrap: wrap; gap: 7px; }
.stack-item {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11.5px;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 3px 10px;
  background: var(--bg1);
  cursor: default;
}
.stack-item b { font-size: 12px; }

/* 代码构成条形图：单色系、thin bar、直接标注 */
.chart { display: flex; flex-direction: column; gap: 8px; }
.chart-row { display: flex; align-items: center; gap: 10px; }
.chart-label { width: 76px; flex-shrink: 0; font-size: 11.5px; color: var(--text-dim); text-align: right; }
.chart-track { flex: 1; height: 10px; }
.chart-bar {
  height: 100%;
  min-width: 2px;
  background: var(--green);
  border-radius: 0 4px 4px 0;
  opacity: 0.85;
}
.chart-row:hover .chart-bar { opacity: 1; }
.chart-val { width: 40px; font-size: 11px; color: var(--text-dim); }

/* 使用指南 */
.guide-p { font-size: 12.3px; line-height: 1.85; color: var(--text-dim); margin-bottom: 6px; }
.guide-p :deep(b) { color: var(--text); }
.guide-tips {
  margin-top: 8px;
  border-left: 3px solid rgba(242, 177, 85, 0.5);
  background: var(--amber-dim);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  padding: 7px 11px;
}
.tips-head { font-size: 11.5px; font-weight: 600; color: var(--amber); margin-bottom: 4px; }
.guide-tip { font-size: 11.5px; color: var(--text-dim); line-height: 1.7; }
.about-foot { text-align: center; font-size: 11px; padding-top: 2px; }
</style>
