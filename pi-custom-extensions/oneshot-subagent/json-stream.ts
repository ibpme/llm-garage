export class JsonEventStream {
  private pending = "";
  private readonly accept: (event: unknown) => void;
  constructor(accept: (event: unknown) => void) { this.accept = accept; }

  feed(chunk: string, eof = false): void {
    this.pending += chunk;
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, "");
      this.pending = this.pending.slice(end + 1);
      if (line.length > 16 * 1024 * 1024) throw new Error("JSON event exceeds 16 MiB");
      if (line.trim()) this.accept(JSON.parse(line));
    }
    if (this.pending.length > 16 * 1024 * 1024) throw new Error("JSON event exceeds 16 MiB");
    if (eof && this.pending.trim()) {
      this.accept(JSON.parse(this.pending));
      this.pending = "";
    }
  }
}
