import { parseHexLenient } from "./bytes.ts";
import { parseFrames, type Direction, type ParsedTrace, type RawHunk } from "./frames.ts";

/**
 * .h2trace（HPACK 状态镜材料格式 v1，本仓库领域专用，不是通用表格）
 *
 *   # 注释
 *   C2S:
 *     <hex>            一个 hunk = 一个帧；缩进/空白允许；可跨行用续行符 \
 *   S2C:
 *     <hex>
 *
 * 坐标：line/col 一律 1 基，指向原始材料文本，用于从显示值反查材料。
 * 无法成对/非 hex 的字符不删除，形成诊断并留在 hunk 的 rawHex 里。
 */
export interface TraceInput {
  id: string;
  title: string;
  text: string;
}

export function parseTrace(input: TraceInput): ParsedTrace & {
  textDiagnostics: { line: number; col: number; char: string; reason: string }[];
} {
  const lines = input.text.split("\n");
  const hunks: RawHunk[] = [];
  const directions: Direction[] = [];
  const textDiagnostics: ReturnType<typeof parseTrace>["textDiagnostics"] = [];
  let currentDir: Direction = "c2s";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineNo = lineIndex + 1;
    const rawLine = lines[lineIndex];
    const stripped = rawLine.replace(/#.*$/, "");
    const trimmed = stripped.trim();
    if (!trimmed) continue;
    const dirMatch = /^(c2s|s2c)\s*:/i.exec(trimmed);
    if (dirMatch) {
      currentDir = dirMatch[1].toLowerCase() === "c2s" ? "c2s" : "s2c";
      continue;
    }
    const colStart = stripped.length - stripped.replace(/^\s*/, "").length + 1;
    const parsed = parseHexLenient(stripped);
    for (const d of parsed.diagnostics) {
      textDiagnostics.push({
        line: lineNo,
        col: colStart + d.offset,
        char: d.char,
        reason: d.reason,
      });
    }
    if (parsed.oddTail) {
      textDiagnostics.push({
        line: lineNo,
        col: colStart + stripped.replace(/\s/g, "").length,
        char: "",
        reason: "odd number of hex nibbles; kept in place with low-nibble 0",
      });
    }
    const hunk: RawHunk = {
      sourceLine: lineNo,
      sourceColStart: colStart,
      sourceColEnd: colStart + stripped.trim().length,
      rawHex: stripped.trim(),
      bytes: parsed.bytes,
    };
    hunks.push(hunk);
    directions.push(currentDir);
  }

  const result = parseFrames(hunks, input.id);
  result.frames.forEach((frame) => {
    frame.direction = directions[frame.hunkIndex];
  });
  return { ...result, textDiagnostics };
}
