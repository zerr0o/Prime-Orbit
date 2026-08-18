import { useEffect } from "react";

/**
 * Dismisses the currently active, data-attribute identified layer when the user
 * clicks anywhere outside it or presses Escape. The listener runs during the
 * capture phase so Escape closes a menu before reaching conversation shortcuts.
 */
export function useDismissableLayer(activeLayer: string | null, onDismiss: () => void) {
  useEffect(() => {
    if (!activeLayer) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(`[data-dismissable-layer="${activeLayer}"]`)) return;
      onDismiss();
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [activeLayer, onDismiss]);
}
