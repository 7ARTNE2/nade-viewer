import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Placement = "top" | "bottom" | "left" | "right";

type TipState = {
  text: string;
  placement: Placement;
  // Anchor rect in viewport coordinates.
  rect: DOMRect;
};

const SHOW_DELAY = 350;
const GAP = 8;
const EDGE = 8;

// A single global tooltip driven by `data-tip` attributes anywhere in the app.
// Rendered into a fixed-position portal so it can never be clipped by an
// ancestor's overflow/scroll container. Optional `data-tip-pos` picks a side
// (top | bottom | left | right); it auto-flips when it would leave the viewport.
export default function Tooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<number | null>(null);
  const currentAnchor = useRef<HTMLElement | null>(null);
  const pendingAnchor = useRef<HTMLElement | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number; placement: Placement } | null>(null);

  useEffect(() => {
    const clearShowTimer = () => {
      if (showTimer.current !== null) {
        window.clearTimeout(showTimer.current);
        showTimer.current = null;
      }
    };

    const hide = () => {
      clearShowTimer();
      currentAnchor.current = null;
      pendingAnchor.current = null;
      setTip(null);
      setCoords(null);
    };

    const findAnchor = (start: EventTarget | null): HTMLElement | null => {
      let el = start as HTMLElement | null;
      while (el && el !== document.body) {
        if (el.nodeType === 1 && el.hasAttribute("data-tip")) {
          const text = el.getAttribute("data-tip");
          if (text && text.trim()) return el;
        }
        el = el.parentElement;
      }
      return null;
    };

    const open = (anchor: HTMLElement) => {
      const text = (anchor.getAttribute("data-tip") || "").trim();
      if (!text) return;
      const placement = (anchor.getAttribute("data-tip-pos") as Placement | null) || "top";
      pendingAnchor.current = anchor;
      clearShowTimer();
      showTimer.current = window.setTimeout(() => {
        currentAnchor.current = anchor;
        setTip({ text, placement, rect: anchor.getBoundingClientRect() });
      }, SHOW_DELAY);
    };

    const onPointerOver = (event: PointerEvent) => {
      const anchor = findAnchor(event.target);
      if (!anchor) {
        if (currentAnchor.current || pendingAnchor.current) hide();
        return;
      }
      // Already showing or already counting down for this anchor: do nothing.
      if (anchor === currentAnchor.current || anchor === pendingAnchor.current) return;
      open(anchor);
    };

    const onPointerOut = (event: PointerEvent) => {
      const anchor = findAnchor(event.target);
      if (!anchor) return;
      const related = findAnchor(event.relatedTarget);
      if (related === anchor) return;
      hide();
    };

    const onFocusIn = (event: FocusEvent) => {
      const anchor = findAnchor(event.target);
      if (anchor) open(anchor);
    };

    const onFocusOut = () => hide();

    // Any scroll/resize/keypress dismisses the tooltip (its anchor may move).
    const onScroll = () => hide();
    const onKeyDown = () => hide();

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", hide, true);

    return () => {
      clearShowTimer();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", hide, true);
    };
  }, []);

  // Position the tooltip once it is in the DOM and measured. Auto-flips to the
  // opposite side and clamps to the viewport so it is always fully visible.
  useEffect(() => {
    if (!tip) {
      setCoords(null);
      return;
    }
    const node = tipRef.current;
    if (!node) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = node.offsetWidth;
    const th = node.offsetHeight;
    const r = tip.rect;

    const fits = (placement: Placement): boolean => {
      if (placement === "top") return r.top - GAP - th >= EDGE;
      if (placement === "bottom") return r.bottom + GAP + th <= vh - EDGE;
      if (placement === "left") return r.left - GAP - tw >= EDGE;
      return r.right + GAP + tw <= vw - EDGE;
    };

    const opposite: Record<Placement, Placement> = { top: "bottom", bottom: "top", left: "right", right: "left" };
    let placement = tip.placement;
    if (!fits(placement) && fits(opposite[placement])) placement = opposite[placement];

    let left: number;
    let top: number;
    if (placement === "top" || placement === "bottom") {
      left = r.left + r.width / 2 - tw / 2;
      top = placement === "top" ? r.top - GAP - th : r.bottom + GAP;
    } else {
      left = placement === "left" ? r.left - GAP - tw : r.right + GAP;
      top = r.top + r.height / 2 - th / 2;
    }

    // Clamp inside the viewport.
    left = Math.max(EDGE, Math.min(left, vw - tw - EDGE));
    top = Math.max(EDGE, Math.min(top, vh - th - EDGE));

    setCoords({ left, top, placement });
  }, [tip]);

  if (!tip) return null;

  return createPortal(
    <div
      ref={tipRef}
      className={`app-tooltip placement-${coords?.placement ?? tip.placement} ${coords ? "visible" : ""}`}
      role="tooltip"
      style={{ left: coords ? `${coords.left}px` : "-9999px", top: coords ? `${coords.top}px` : "-9999px" }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
