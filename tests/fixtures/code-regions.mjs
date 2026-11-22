// Minimal stand-in for OpenClaw's plugin-sdk findCodeRegions(text): returns [{ start, end }] for fenced code blocks
// (``` or ~~~) and inline `code` spans. Tests use the real SDK function instead when OPENCLAW_SDK_TEXT_CHUNKING
// points at it (a file path to the installed plugin-sdk text-chunking.js).
export function findCodeRegions(text) {
  const regions = [];
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\1[ \t]*(?=\n|$)|(?![\s\S]))/gm;
  let m;
  while ((m = fence.exec(text)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
  const inline = /(`+)(?!`)[^\n]*?[^`]\1(?!`)/g;
  while ((m = inline.exec(text)) !== null) {
    const s = m.index, e = m.index + m[0].length;
    if (!regions.some((r) => s >= r.start && e <= r.end)) regions.push({ start: s, end: e });
  }
  return regions.sort((a, b) => a.start - b.start);
}
