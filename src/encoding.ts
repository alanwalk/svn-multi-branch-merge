/** Prefer UTF-8; older Chinese Windows SVN clients can emit GBK. */
export function decodeSvnOutput(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('gbk').decode(data);
  }
}

/** Buffer bytes until a complete line so split characters remain intact. */
export function createSvnLineReader(onLine: (line: string) => void) {
  let pending = Buffer.alloc(0);
  const emit = (data: Buffer) => {
    const line = decodeSvnOutput(data).trimEnd();
    if (line) onLine(line);
  };
  return {
    write(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(0x0a)) !== -1) {
        emit(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
      }
    },
    end() {
      emit(pending);
      pending = Buffer.alloc(0);
    },
  };
}
