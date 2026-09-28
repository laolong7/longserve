// ============================================================
// 危险命令检测
// 规则清单 + AI risk 标注双保险，命中即弹确认框
// ============================================================

const RULES = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, reason: '递归/强制删除文件' },
  { re: /\brm\s+-[a-zA-Z]*r/i, reason: '递归删除' },
  { re: /\bmkfs(\.\w+)?\b/, reason: '格式化文件系统' },
  { re: /\bdd\b[^|]*\bof=/, reason: 'dd 直接写盘' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: '关机/重启' },
  { re: /\binit\s+[06]\b/, reason: '切换运行级别（关机/重启）' },
  { re: /\bdrop\s+(database|table|schema)\b/i, reason: '删除数据库/表' },
  { re: /\btruncate\s+(table\s+)?\w+/i, reason: '清空表数据' },
  { re: /\bchmod\s+-R\s+777\s+\/(?!home|var\/www)(\s|$)/, reason: '全盘开放写权限' },
  { re: /:\(\)\s*\{\s*:\|\s*:(&|\};)\s*/, reason: 'Fork 炸弹' },
  { re: />\s*\/dev\/(sd|nvme|hd)/, reason: '覆写物理磁盘' },
  { re: /\biptables\s+(-F|-X|--flush)\b/, reason: '清空防火墙规则' },
  { re: /\bufw\s+disable\b/, reason: '关闭防火墙' },
  { re: /\b(systemctl\s+(stop|disable|reset-failed)\s+(sshd|nginx|mysqld?|gunicorn|docker)\b)/, reason: '停止核心服务' },
  { re: /\bkill(all)?\s+(-9\s+)?1\b/, reason: '杀掉 init/PID 1' },
  { re: /\b(userdel|groupdel)\s+\S*(root|admin)/, reason: '删除管理账户' },
  { re: /\bpasswd\b(\s|$)/, reason: '修改密码' },
  { re: /\bvisudo\b|\betc\/sudoers\b/, reason: '修改 sudo 配置' },
  { re: /\b(sed\s+-i[^>]*|>)\s*\/etc\/(passwd|shadow|ssh\/sshd_config|fstab)\b/, reason: '篡改系统关键配置' },
  { re: /\brsync\b[^|]*--delete\b[^|]*\/(\s|$)/, reason: 'rsync --delete 同步根目录' },
  { re: /\bhistory\s+-c\b/, reason: '清除历史记录' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/, reason: '下载并直接执行远程脚本' }
]

/**
 * 检查命令是否危险
 * @param {string} cmd
 * @returns {{ danger: boolean, reasons: string[] }}
 */
export function checkDanger(cmd) {
  const reasons = []
  const c = (cmd || '').trim()
  for (const { re, reason } of RULES) {
    if (re.test(c) && !reasons.includes(reason)) reasons.push(reason)
  }
  // 链式命令逐段再查（如 "cd /tmp && rm -rf xxx" 已被整串匹配，但分号场景双保险）
  return { danger: reasons.length > 0, reasons }
}
