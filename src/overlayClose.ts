/**
 * Closes a modal overlay on a true outside click. A plain `click` listener
 * also fires when a drag starts inside the dialog and ends on the overlay —
 * e.g. a text selection slipping out of a field — because the click lands
 * on the common ancestor of the press/release targets. Requiring both the
 * mousedown and the mouseup to land on the overlay itself filters those.
 */
export function bindOverlayClose(overlay: HTMLElement, close: () => void): void {
  let downOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => {
    downOnOverlay = e.target === overlay;
  });
  overlay.addEventListener('mouseup', (e) => {
    if (downOnOverlay && e.target === overlay) close();
    downOnOverlay = false;
  });
}
