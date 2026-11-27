import { open, save } from "../host";
import { createEffect, createSignal, Index, onCleanup, onMount, Show, type JSX } from "solid-js";
import { PATH_DROP_EVENT } from "../dropOpen";
import { editorRowHeight } from "../settings";
import { clipSpans } from "../wrap";
export { editorRowHeight };

export function PathBar(props: {
  value: string;
  onCommit: (path: string) => void;
  folder?: boolean;
  placeholder?: string;
  title?: string | null;
  readOnly?: boolean;
  dirty?: boolean;
  saveDialog?: boolean;
  info?: JSX.Element;
  /** Shows a per-side "Save" button, enabled while the side has unsaved changes. */
  onSave?: () => void;
  saveTitle?: string;
}) {
  const [text, setText] = createSignal(props.value);
  createEffect(() => setText(props.value));
  let root!: HTMLDivElement;
  // A file dropped on this side of a comparison fills this side: the drop routing resolves the
  // pointer to one of the .paths bars and dispatches on it (see dropOpen.ts).
  onMount(() => {
    const fill = (e: Event) => props.onCommit((e as CustomEvent<string>).detail);
    root.addEventListener(PATH_DROP_EVENT, fill);
    onCleanup(() => root.removeEventListener(PATH_DROP_EVENT, fill));
  });
  const browse = async () => {
    const picked = props.saveDialog
      ? await save({ defaultPath: props.value || undefined })
      : await open({ directory: !!props.folder, multiple: false, defaultPath: props.value || undefined });
    if (typeof picked === "string") {
      setText(picked);
      props.onCommit(picked);
    }
  };
  return (
    <div class="pathbar" classList={{ dirty: !!props.dirty }} ref={root}>
      {props.title ? (
        <div class="path-title" title={props.value}>
          {props.title}
        </div>
      ) : (
        <input
          class="path-input"
          value={text()}
          placeholder={props.placeholder ?? (props.folder ? "Folder path…" : "File path…")}
          spellcheck={false}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onCommit(text().trim());
          }}
          onBlur={() => {
            if (text().trim() !== props.value) props.onCommit(text().trim());
          }}
        />
      )}
      {props.readOnly && <span class="badge" title="Read-only">RO</span>}
      {props.dirty && <span class="badge warn" title="Unsaved changes">●</span>}
      <button class="icon-btn" title="Browse…" onClick={browse}>
        …
      </button>
      {props.onSave && (
        <button class="icon-btn path-save" title={props.saveTitle ?? "Save"} disabled={!props.dirty || props.readOnly} onClick={() => props.onSave!()}>
          💾
        </button>
      )}
      {props.info}
    </div>
  );
}

export function Btn(props: {
  onClick: () => void;
  title: string;
  children: JSX.Element;
  disabled?: boolean;
  active?: boolean;
  kbd?: string;
}) {
  return (
    <button
      class="tb-btn"
      classList={{ active: !!props.active }}
      disabled={props.disabled}
      title={props.kbd ? `${props.title} (${props.kbd})` : props.title}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

const PANE_INTERACTIVE = "input, textarea, select, button, a, [contenteditable], [role='button']";

/** Keeps a view's active side in sync with real DOM focus without intercepting native control shortcuts. */
export function usePaneFocus<S extends string | number>(initial: S, onFocus?: (side: S) => void) {
  const [focused, setFocused] = createSignal(initial);
  /** Binding for a scroller shared by logical panes; exposes the active side for commands and tests. */
  const sharedPaneProps = () => ({ "data-pane": "shared", "data-pane-side": String(focused()) });
  const focus = (side: S, target?: HTMLElement) => {
    setFocused(() => side);
    onFocus?.(side);
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  };
  const paneProps = (side: S, options: { tabIndex?: number; target?: () => HTMLElement | undefined; preventDefault?: boolean } = {}) => ({
    tabIndex: options.tabIndex ?? 0,
    "data-pane": "",
    "data-pane-side": String(side),
    // Programmatic focus never bubbles; this keeps the active side in sync (e.g. after swapping sides).
    onFocusIn: () => focus(side),
    onMouseDown: (e: MouseEvent & { currentTarget: HTMLDivElement }) => {
      const hit = e.target instanceof Element ? e.target : null;
      if (hit?.closest(PANE_INTERACTIVE)) return;
      // Logical columns share one scroller; keep the real focus boundary there.
      if (options.preventDefault) e.preventDefault();
      focus(side, options.target?.() ?? e.currentTarget);
    },
  });
  return { focused, focus, paneProps, sharedPaneProps };
}

/** Tracks size of a scroll container and computes a virtual window. */
export function useViewport(el: () => HTMLElement | undefined) {
  const [height, setHeight] = createSignal(600);
  const [width, setWidth] = createSignal(0);
  const [scrollTop, setTop] = createSignal(0);
  // DOM scroll events fire at pointer/touch rate; coalesce only those updates to one
  // per frame. Programmatic writes stay synchronous so read-modify-write sequences
  // (keyboard navigation, jump-to-row) cannot lose a step.
  let pending: number | undefined;
  let nextTop = 0;
  const setScrollTop = (top: number) => {
    if (pending !== undefined) {
      cancelAnimationFrame(pending);
      pending = undefined;
    }
    setTop(top);
  };
  const onScrollTop = (top: number) => {
    nextTop = top;
    if (pending === undefined) pending = requestAnimationFrame(() => {
      pending = undefined;
      setTop(nextTop);
    });
  };
  onCleanup(() => {
    if (pending !== undefined) cancelAnimationFrame(pending);
  });
  onMount(() => {
    const e = el();
    if (!e) return;
    const ro = new ResizeObserver(() => {
      setHeight(e.clientHeight);
      setWidth(e.clientWidth);
    });
    ro.observe(e);
    setHeight(e.clientHeight);
    setWidth(e.clientWidth);
    onCleanup(() => ro.disconnect());
  });
  const range = (count: number, rowH = editorRowHeight(), overscan = 12) => {
    const start = Math.max(0, Math.floor(scrollTop() / rowH) - overscan);
    const end = Math.min(count, Math.ceil((scrollTop() + height()) / rowH) + overscan);
    return { start, end };
  };
  return { height, width, scrollTop, setScrollTop, onScrollTop, range };
}

/** Renders a line with highlighted UTF-16 ranges. */
export function Highlighted(props: { text: string; spans?: [number, number][]; cls: string }) {
  const parts = () => {
    const t = props.text;
    const sp = props.spans;
    if (!sp || sp.length === 0) return [{ s: t, h: false }];
    const out: { s: string; h: boolean }[] = [];
    let pos = 0;
    for (const [a, b] of sp) {
      if (a > pos) out.push({ s: t.slice(pos, a), h: false });
      out.push({ s: t.slice(a, b), h: true });
      pos = b;
    }
    if (pos < t.length) out.push({ s: t.slice(pos), h: false });
    return out;
  };
  return <>{parts().map((p) => (p.h ? <span class={props.cls}>{p.s}</span> : p.s))}</>;
}

/** `Highlighted` split into one block per visual line at the UTF-16 offsets in `starts`. */
export function WrappedText(props: { text: string; starts: number[]; spans?: [number, number][]; cls: string }) {
  return (
    <Show when={props.starts.length > 1} fallback={<Highlighted text={props.text} spans={props.spans} cls={props.cls} />}>
      <Index each={props.starts}>
        {(start, i) => {
          const end = () => props.starts[i + 1] ?? props.text.length;
          return (
            <span class="seg">
              <Highlighted text={props.text.slice(start(), end())} spans={clipSpans(props.spans, start(), end())} cls={props.cls} />
            </span>
          );
        }}
      </Index>
    </Show>
  );
}

/** Moves focus into a dialog when it opens, keeps Tab inside it and restores focus on close. */
export function trapFocus(el: HTMLElement) {
  const prev = document.activeElement as HTMLElement | null;
  const focusables = () =>
    [...el.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
      (x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null,
    );
  setTimeout(() => {
    if (el.contains(document.activeElement)) return;
    const f = focusables();
    (f.find((x) => !x.classList.contains("icon-btn")) ?? f[0] ?? el).focus();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && (i <= 0)) (e.preventDefault(), f[f.length - 1].focus());
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) (e.preventDefault(), f[0].focus());
  };
  el.addEventListener("keydown", onKey);
  onCleanup(() => {
    el.removeEventListener("keydown", onKey);
    if (prev && document.contains(prev)) prev.focus();
  });
}

export function Modal(props: { title: string; onClose: () => void; children: JSX.Element; wide?: boolean }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal" classList={{ wide: !!props.wide }} tabIndex={-1} ref={(el) => onMount(() => trapFocus(el))}>
        <div class="modal-head">
          <span>{props.title}</span>
          <button class="icon-btn" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}
