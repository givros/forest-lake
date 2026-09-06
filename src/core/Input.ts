export class Input {
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private handlers: Array<() => void> = [];
  enabled = false;
  onAction: (code: string) => void = () => {};
  onOrbit: (x: number, y: number) => void = () => {};
  onZoom: (amount: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    const listen = (target: EventTarget, event: string, fn: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(event, fn, options);
      this.handlers.push(() => target.removeEventListener(event, fn, options));
    };
    listen(window, 'keydown', ((event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (this.enabled && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Home'].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (!event.repeat) this.onAction(event.code);
    }) as EventListener);
    listen(window, 'keyup', ((event: KeyboardEvent) => { this.keys.delete(event.code); }) as EventListener);
    listen(window, 'blur', (() => this.clear()) as EventListener);
    listen(canvas, 'pointerdown', ((event: PointerEvent) => {
      if (!this.enabled || event.button !== 0) return;
      this.dragging = true;
      this.lastX = event.clientX; this.lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    }) as EventListener);
    listen(canvas, 'pointermove', ((event: PointerEvent) => {
      if (!this.enabled || !this.dragging) return;
      this.onOrbit(event.clientX - this.lastX, event.clientY - this.lastY);
      this.lastX = event.clientX; this.lastY = event.clientY;
    }) as EventListener);
    listen(canvas, 'pointerup', (() => { this.dragging = false; }) as EventListener);
    listen(canvas, 'pointercancel', (() => { this.dragging = false; }) as EventListener);
    listen(canvas, 'wheel', ((event: WheelEvent) => {
      if (!this.enabled) return;
      event.preventDefault(); this.onZoom(Math.sign(event.deltaY));
    }) as EventListener, { passive: false });
  }

  private down(...codes: string[]) { return codes.some(code => this.keys.has(code)); }
  get forward() { return this.enabled ? Number(this.down('KeyW', 'KeyZ', 'ArrowUp')) - Number(this.down('KeyS', 'ArrowDown')) : 0; }
  get side() { return this.enabled ? Number(this.down('KeyD', 'ArrowRight')) - Number(this.down('KeyA', 'KeyQ', 'ArrowLeft')) : 0; }
  get sprint() { return this.enabled && this.down('ShiftLeft', 'ShiftRight'); }
  clear() { this.keys.clear(); this.dragging = false; }
  dispose() { this.handlers.forEach(remove => remove()); }
}
