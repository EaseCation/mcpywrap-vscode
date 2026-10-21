import { LogSource } from '../domain/model';

export type LogPart = 'engine' | 'script';
export interface LogRecord { source: LogSource | 'python' | 'system'; label: string; text: string; visible: boolean }
export function logPart(source: LogRecord['source']): LogPart { return source === 'game' || source === 'python' ? 'script' : 'engine'; }

/** Equivalent to mcpywrap.ui.session_tools.DebugLogFilter, scoped per stream. */
export class ProtocolFilter {
  private inScript = false;
  visible(line: string): boolean {
    if (line.includes('[Run]') && line.includes('script begin')) { this.inScript = true; return false; }
    if (line.includes('[Run]') && line.includes('script end')) { this.inScript = false; return false; }
    return !this.inScript && !['RN Call:', 'RN Return:', '__MCPY_RESULT_'].some(marker => line.includes(marker));
  }
}

/** Line framing and filtering never mix partial lines from different members. */
export class LogLines {
  private pending = '';
  private filter = new ProtocolFilter();
  private dropping = false;
  feed(chunk: string, finish = false): { text: string; visible: boolean }[] {
    const result: { text: string; visible: boolean }[] = [];
    this.pending += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n|\r(?!$)/.exec(this.pending))) {
      const end = match.index + match[0].length;
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end);
      if (!this.dropping) result.push({ text: line, visible: this.filter.visible(line) });
      this.dropping = false;
    }
    if (this.pending.length > 256 * 1024) {
      if (!this.dropping) result.push({ text: this.pending.slice(0, 256 * 1024) + '\n[日志长行显示已截断；完整内容由 mcpy 保存]\n', visible: this.filter.visible(this.pending) });
      this.pending = ''; this.dropping = true;
    }
    if (finish && this.pending) {
      if (!this.dropping) result.push({ text: this.pending, visible: this.filter.visible(this.pending) });
      this.pending = ''; this.dropping = false;
    }
    return result;
  }
}

export class LogHistory {
  private records: (LogRecord | undefined)[] = [];
  private head = 0;
  private size = 0;
  constructor(private readonly limit = 1024 * 1024) {}
  append(record: LogRecord): void {
    const label = record.label.replace(/[\r\n⟦⟧]/g, ' ').slice(0, Math.min(512, Math.floor(this.limit / 4)));
    record = { ...record, label, text: record.text.slice(-(this.limit - label.length)) };
    this.records.push(record); this.size += record.text.length + record.label.length;
    while (this.size > this.limit && this.head < this.records.length) {
      const removed = this.records[this.head]!; this.records[this.head++] = undefined;
      this.size -= removed.text.length + removed.label.length;
    }
    if (this.head > 1024 && this.head * 2 > this.records.length) { this.records = this.records.slice(this.head); this.head = 0; }
  }
  entries(): readonly LogRecord[] { return this.records.slice(this.head).filter((record): record is LogRecord => record !== undefined); }
  snapshot(raw: boolean): string { return this.entries().filter(record => raw || record.visible).map(renderRecord).join(''); }
}

export function renderRecord(record: LogRecord): string {
  return `⟦${record.label}⟧ ${record.text.endsWith('\n') ? record.text : record.text + '\n'}`;
}
