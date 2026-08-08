/**
 * Decode user-provided text files without assuming that every file is UTF-8.
 * Windows editors still commonly produce GBK/GB18030 files, while some tools
 * export UTF-16 text with a BOM.
 */
export function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return "";

  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buffer.subarray(3));
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }

  // stream=true keeps an incomplete UTF-8 character at the end of a preview
  // chunk from becoming a replacement character. A real decoding error in
  // the middle of the file is treated as a strong GB18030 signal.
  const utf8 = new TextDecoder("utf-8").decode(buffer, { stream: true });
  if (!utf8.includes("\ufffd")) return utf8;

  return new TextDecoder("gb18030").decode(buffer);
}

function mojibakeScore(value: string): number {
  // These characters are common when UTF-8 bytes are decoded as Latin-1.
  const markers = /[ÃÂâæåçèéêëïðñòóôõöøùúûüÿ]/g;
  return (value.match(markers)?.length ?? 0) + (value.match(/\ufffd/g)?.length ?? 0) * 4;
}

/** Repair the Latin-1 filename variant produced by some Windows multipart clients. */
export function repairUploadedFilename(value: string): string {
  if (!value || !/[\u0080-\u00ff]/.test(value)) return value;

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (repaired.includes("\ufffd") || repaired === value) return value;
    return mojibakeScore(repaired) < mojibakeScore(value) ? repaired : value;
  } catch {
    return value;
  }
}
