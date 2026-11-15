/**
 * Text fit for the human's terminal when an agent, an app or Kane wrote it and the human decides on
 * it (a spec diff, a drift plan, Kane's questions, the brief, a status line): every C0 and C1 control
 * character but tab and newline is shown as `\xNN`, and every Unicode format character (bidi
 * controls, zero-width characters, the BOM: `\p{Cf}`) as `\uXXXX`. An escape sequence or a reordering
 * mark in such text never reaches the terminal as one.
 */
export function escapeControls(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(/\p{Cf}/gu, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}`);
}
