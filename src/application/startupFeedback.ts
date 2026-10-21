interface StartupSink { log(text: string): void; status(message: string): void }
const LINE_LIMIT = 8192;

/** Human diagnostics are display text, never a source of session IDs or phases. */
export class StartupFeedback {
  private readonly startedAt: number;
  private lastDiagnosticAt: number;
  private pending = '';
  private dropping = false;
  private closed = false;
  private latest = '';
  private stageText = '等待 mcpy 返回启动结果';
  private waitingForLaunch = true;
  private nextReminder = 10;

  constructor(private readonly sink: StartupSink, private readonly now: () => number = Date.now) {
    this.startedAt = this.lastDiagnosticAt = now();
    sink.log('等待 mcpy 准备运行环境并返回会话。首次运行可能下载或解压资源；出现游戏窗口时，请完成其中的登录或确认。\n');
    this.report();
  }
  diagnostic(chunk: string): void {
    if (this.closed) return;
    this.pending += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\r|\n/.exec(this.pending))) {
      const line = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (!this.dropping) this.emit(line);
      this.dropping = false;
    }
    if (this.pending.length > LINE_LIMIT) {
      if (!this.dropping) this.emit(this.pending);
      this.pending = ''; this.dropping = true;
    }
  }
  tick(): void {
    if (this.closed) return;
    this.flush(); this.report();
    const elapsed = this.elapsed();
    if (elapsed >= this.nextReminder) {
      const quiet = Math.max(0, Math.floor((this.now() - this.lastDiagnosticAt) / 1000));
      const detail = this.latest ? `距最近诊断 ${quiet} 秒` : '尚无新的诊断';
      this.sink.log(`[等待] ${this.stageText} · 已耗时 ${elapsed} 秒，${detail}。${this.waitingForLaunch ? '请勿重复启动；可检查游戏窗口是否有登录或确认提示。' : ''}\n`);
      this.nextReminder = elapsed + 30;
    }
  }
  stage(message: string): void {
    if (this.closed) return;
    this.flush(); this.stageText = message; this.latest = ''; this.waitingForLaunch = false;
    this.sink.log(`${message}\n`); this.report();
  }
  finish(message: string): void {
    if (this.closed) return;
    this.flush(); this.sink.log(`${message} · 总耗时 ${this.elapsed()} 秒。\n`);
    this.sink.status(message); this.dispose();
  }
  dispose(): void { this.closed = true; this.pending = ''; }
  private elapsed(): number { return Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)); }
  private report(): void {
    this.sink.status(`${this.stageText} · ${this.elapsed()} 秒${this.latest ? ` · ${this.latest}` : ''}`);
  }
  private flush(): void {
    if (this.pending && !this.dropping) { this.emit(this.pending); this.pending = ''; }
  }
  private emit(line: string): void {
    const text = (line.slice(0, LINE_LIMIT) + (line.length > LINE_LIMIT ? ' [诊断长行显示已截断]' : '')).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
    if (!text.trim()) return;
    this.latest = text.replace(/\s+/g, ' ').slice(-180); this.lastDiagnosticAt = this.now();
    this.sink.log(`[mcpy] ${text}\n`);
  }
}
