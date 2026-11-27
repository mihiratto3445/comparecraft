import { createSignal, onCleanup, onMount } from "solid-js";

/**
 * Soft word wrap for the virtualized text views. Lines are split in code so every row's height is
 * known before it renders; the views then draw each visual line as its own block.
 */

export const PROBE = "0".repeat(64);

const widthCache = new Map<string, Map<number, number>>();
let canvas: CanvasRenderingContext2D | null | undefined;

/** Column width (0, 1 or 2) of a code point in `font`, relative to one `charW`-wide cell. */
function measuredCols(cp: number, font: string, charW: number) {
  let byFont = widthCache.get(font);
  if (!byFont) widthCache.set(font, (byFont = new Map()));
  let w = byFont.get(cp);
  if (w === undefined) {
    canvas ??= document.createElement("canvas").getContext("2d");
    if (canvas && charW > 0) {
      canvas.font = font;
      w = Math.max(0, Math.min(2, Math.round(canvas.measureText(String.fromCodePoint(cp)).width / charW)));
    } else w = 1;
    byFont.set(cp, w);
  }
  return w;
}

export interface WrapSpec {
  cols: number;
  tabSize: number;
  font: string;
  charW: number;
}

/**
 * Start offsets (UTF-16) of each visual line of `text`. Breaks after whitespace when it can and
 * splits words that are wider than the line. Whitespace at a break hangs past the edge, as in CSS.
 */
export function wrapLine(text: string, spec: WrapSpec): number[] {
  const { cols, tabSize } = spec;
  if (cols <= 0 || (text.length * 2 <= cols && !text.includes("\t"))) return [0];
  const starts = [0];
  let start = 0;
  let col = 0;
  let brk = -1;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const ws = cp === 32 || cp === 9;
    const w = cp === 9 ? tabSize - (col % tabSize) : cp < 0x7f ? 1 : measuredCols(cp, spec.font, spec.charW);
    if (!ws && col > 0 && col + w > cols) {
      const at = brk > start ? brk : i;
      starts.push(at);
      start = at;
      col = 0;
      brk = -1;
      i = at;
      continue;
    }
    col += w;
    i += len;
    if (ws) brk = i;
  }
  return starts;
}

/** Memoizes `wrapLine` for one layout (width, font and tab size); recreate it when those change. */
export function wrapper(spec: WrapSpec | null) {
  const cache = new Map<string, number[]>();
  return (text: string | undefined): number[] => {
    if (!spec || text === undefined || (text.length * 2 <= spec.cols && !text.includes("\t"))) return [0];
    let s = cache.get(text);
    if (!s) cache.set(text, (s = wrapLine(text, spec)));
    return s;
  };
}

/** Vertical layout of rows measured in visual lines. */
export interface RowLayout {
  /** Visual lines in all rows. */
  total: number;
  /** First visual line of row `i` (`i` may equal the row count). */
  top(i: number): number;
  /** Visual lines in row `i`. */
  lines(i: number): number;
  /** Row containing visual line `line` (clamped to the rows). */
  at(line: number): number;
}

export function fixedLayout(count: number): RowLayout {
  return {
    total: count,
    top: (i) => i,
    lines: () => 1,
    at: (line) => Math.max(0, Math.min(count - 1, Math.floor(line))),
  };
}

/** Layout for rows of `lines(i)` visual lines each; uses the fixed layout when nothing wraps. */
export function rowLayout(count: number, lines: (i: number) => number): RowLayout {
  const tops = new Int32Array(count + 1);
  let wrapped = false;
  for (let i = 0; i < count; i++) {
    const n = Math.max(1, lines(i));
    if (n > 1) wrapped = true;
    tops[i + 1] = tops[i] + n;
  }
  if (!wrapped) return fixedLayout(count);
  return {
    total: tops[count],
    top: (i) => tops[Math.max(0, Math.min(count, i))],
    lines: (i) => tops[i + 1] - tops[i],
    at: (line) => {
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (tops[m + 1] <= line) lo = m + 1;
        else hi = m;
      }
      return Math.max(0, Math.min(count - 1, lo));
    },
  };
}

/** Rows to render for a scroll position, plus `overscan` rows on each side. */
export function layoutRange(layout: RowLayout, count: number, scrollTop: number, height: number, rowH: number, overscan = 12) {
  if (!count) return { start: 0, end: 0 };
  const start = Math.max(0, layout.at(Math.floor(scrollTop / rowH)) - overscan);
  const end = Math.min(count, layout.at(Math.ceil((scrollTop + height) / rowH)) + 1 + overscan);
  return { start, end };
}

/**
 * Watches a hidden ruler row laid out like the real rows: its `.wrap-area` gives the text width and its
 * `.wrap-probe` (containing `PROBE`) the editor font's cell width.
 */
export function useWrapMetrics(ruler: () => HTMLElement | undefined) {
  const [width, setWidth] = createSignal(0);
  const [charW, setCharW] = createSignal(0);
  const [font, setFont] = createSignal("");
  let update = () => {};
  onMount(() => {
    const r = ruler();
    const area = r?.querySelector<HTMLElement>(".wrap-area");
    const probe = r?.querySelector<HTMLElement>(".wrap-probe");
    if (!area || !probe) return;
    update = () => {
      setWidth(area.clientWidth);
      setCharW(probe.getBoundingClientRect().width / PROBE.length);
      setFont(getComputedStyle(probe).font);
    };
    const ro = new ResizeObserver(() => update());
    ro.observe(area);
    ro.observe(probe);
    update();
    onCleanup(() => ro.disconnect());
  });
  const cols = () => (charW() > 0 ? Math.max(1, Math.floor((width() + 0.01) / charW())) : 0);
  /** Measures now instead of on the next resize notification (call after the layout changed). */
  const refresh = () => update();
  return { cols, charW, font, refresh };
}

/** Clips UTF-16 highlight ranges to [a, b) and makes them relative to `a`. */
export function clipSpans(spans: [number, number][] | undefined, a: number, b: number) {
  if (!spans) return undefined;
  const out: [number, number][] = [];
  for (const [x, y] of spans) {
    const s = Math.max(x, a);
    const e = Math.min(y, b);
    if (e > s) out.push([s - a, e - a]);
  }
  return out;
}

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

const monoWidthCache = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Width of one character of the (monospace) editor font, measured once per font. */
export function monoCharWidth(font: string): number {
  const hit = monoWidthCache.get(font);
  if (hit !== undefined) return hit;
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
  let w = 0;
  if (measureCtx) {
    measureCtx.font = font;
    w = measureCtx.measureText("0".repeat(64)).width / 64;
  }
  if (!(w > 0)) w = 7.2;
  monoWidthCache.set(font, w);
  return w;
}
