import { StringDecoder } from "node:string_decoder";

/** UTF-8 安全的 JSONL 管道读取器；end 消费无换行尾行，调用幂等。 */
export class JsonlReader {
  private readonly decoder = new StringDecoder("utf8");
  private rest = "";
  private ended = false;

  constructor(private readonly onLine: (line: string) => void) {}

  write(chunk: Buffer | string): void {
    if (this.ended) return;
    this.rest += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.rest += this.decoder.end();
    this.drain();
    const last = this.rest;
    this.rest = "";
    if (last.trim() !== "") this.onLine(last);
  }

  private drain(): void {
    let index = this.rest.indexOf("\n");
    while (index >= 0) {
      const line = this.rest.slice(0, index);
      this.rest = this.rest.slice(index + 1);
      if (line.trim() !== "") this.onLine(line);
      index = this.rest.indexOf("\n");
    }
  }
}
