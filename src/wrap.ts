/**
 * Word wrap for the virtualized text views. Rows are positioned from computed
 * segment counts, so the break points here must match exactly what is rendered:
 * each segment is drawn as its own fixed-height line with tabs expanded to spaces.
 */

/** Expands tabs to the next tab stop; `expOfOrig[i]` is the expanded position of original index `i`. */
export function expandTabs(text: string, tabW: number): { exp: string; expOfOrig: number[] | null } {
  if (!text.includes("\t")) return { exp: text, expOfOrig: null };
  const w = Math.max(1, tabW);
  let exp = "";
  const expOfOrig: number[] = new Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    expOfOrig[i] = exp.length;
    if (text[i] === "\t") exp += " ".repeat(w - (exp.length % w));
    else exp += text[i];
  }
  expOfOrig[text.length] = exp.length;
  return { exp, expOfOrig };
}

/** Start offsets of the continuation segments: greedy word wrap, hard break for words longer than a line. */
export function wrapBreaks(exp: string, cols: number): number[] {
  const breaks: number[] = [];
  if (cols <= 0) return breaks;
  let pos = 0;
  while (exp.length - pos > cols) {
    let brk = -1;
    for (let i = pos + cols - 1; i > pos; i--) {
      if (exp[i] === " ") {
        brk = i;
        break;
      }
    }
    pos = brk > pos ? brk + 1 : pos + cols;
    breaks.push(pos);
  }
  return breaks;
}

/** Number of display segments a line occupies at `cols` columns. */
export function wrapCount(text: string, cols: number, tabW: number): number {
  if (cols <= 0 || (text.length <= cols && !text.includes("\t"))) return 1;
  return wrapBreaks(expandTabs(text, tabW).exp, cols).length + 1;
}

export interface WrapSegment {
  text: string;
  /** Highlight ranges in segment-local coordinates, clipped to this segment. */
  spans?: [number, number][];
}

/** Splits a line into display segments, remapping the original UTF-16 highlight spans onto each. */
export function wrapSegments(text: string, cols: number, tabW: number, spans?: [number, number][]): WrapSegment[] {
  const { exp, expOfOrig } = expandTabs(text, tabW);
  const starts = [0, ...wrapBreaks(exp, cols)];
  return starts.map((s, i) => {
    const e = i + 1 < starts.length ? starts[i + 1] : exp.length;
    let seg: [number, number][] | undefined;
    if (spans?.length) {
      seg = [];
      for (const [a, b] of spans) {
        const sa = Math.max(expOfOrig ? expOfOrig[a] : a, s);
        const sb = Math.min(expOfOrig ? expOfOrig[b] : b, e);
        if (sa < sb) seg.push([sa - s, sb - s]);
      }
    }
    return { text: exp.slice(s, e), spans: seg };
  });
}

const widthCache = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Width of one character of the (monospace) editor font, measured once per font. */
export function monoCharWidth(font: string): number {
  const hit = widthCache.get(font);
  if (hit !== undefined) return hit;
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
  let w = 0;
  if (measureCtx) {
    measureCtx.font = font;
    w = measureCtx.measureText("0".repeat(64)).width / 64;
  }
  if (!(w > 0)) w = 7.2;
  widthCache.set(font, w);
  return w;
}