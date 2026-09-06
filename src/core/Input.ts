export interface TouchControls {
  stick: HTMLElement;
  thumb: HTMLElement;
  boost: HTMLButtonElement;
  brake: HTMLButtonElement;
}

/** Independently captured pointers allow steering, camera and boost together. */
export class Input {
  private keys = new Set<string>();
  private active = false;
  private controls?: TouchControls;
  private stickPointer?: number;
  private boostPointer?: number;
  private brakePointer?: number;
  private touchForward = 0;
  private touchSide = 0;
  private captures = new Map<number, HTMLElement>();
  private cameraPointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  private handlers: Array<() => void> = [];
  onAction: (code: string) => void = () => {};
  onOrbit: (x: number, y: number) => void = () => {};
  onZoom: (amount: number) => void = () => {};

  get enabled() { return this.active; }
  set enabled(value: boolean) { this.active = value; if (!value) this.clear(); }

  private listen(target: EventTarget, event: string, fn: EventListener, options?: AddEventListenerOptions) {
    target.addEventListener(event, fn, options);
    this.handlers.push(() => target.removeEventListener(event, fn, options));
  }
  private capture(target: HTMLElement, event: PointerEvent) {
    event.preventDefault();
    if (event.pointerType === 'touch') document.body.classList.add('has-touch');
    target.setPointerCapture(event.pointerId); this.captures.set(event.pointerId, target);
  }
  private release(id: number) {
    const target = this.captures.get(id); this.captures.delete(id);
    if (target?.hasPointerCapture(id)) target.releasePointerCapture(id);
  }

  constructor(canvas: HTMLCanvasElement) {
    this.listen(window, 'keydown', ((event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (this.enabled) {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Home'].includes(event.code)) event.preventDefault();
        this.keys.add(event.code);
      }
      if (!event.repeat) this.onAction(event.code);
    }) as EventListener);
    this.listen(window, 'keyup', ((event: KeyboardEvent) => { this.keys.delete(event.code); }) as EventListener);
    this.listen(window, 'blur', (() => this.clear()) as EventListener);
    this.listen(window, 'resize', (() => this.clear()) as EventListener);
    this.listen(document, 'visibilitychange', (() => { if (document.hidden) this.clear(); }) as EventListener);
    this.listen(canvas, 'pointerdown', ((event: PointerEvent) => {
      if (!this.enabled || event.button !== 0 || this.cameraPointers.size >= 2) return;
      this.capture(canvas, event);
      this.cameraPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.pinchDistance = this.cameraDistance();
    }) as EventListener);
    this.listen(canvas, 'pointermove', ((event: PointerEvent) => {
      const previous = this.cameraPointers.get(event.pointerId);
      if (!this.enabled || !previous) return;
      event.preventDefault();
      const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
      previous.x = event.clientX; previous.y = event.clientY;
      if (this.cameraPointers.size === 2) {
        const distance = this.cameraDistance();
        if (distance > 1 && this.pinchDistance > 1) this.onZoom(Math.log(this.pinchDistance / distance) * 6);
        this.pinchDistance = distance;
      } else this.onOrbit(dx, dy);
    }) as EventListener);
    const endCamera = ((event: PointerEvent) => {
      this.cameraPointers.delete(event.pointerId); this.pinchDistance = this.cameraDistance(); this.release(event.pointerId);
    }) as EventListener;
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) this.listen(canvas, event, endCamera);
    this.listen(canvas, 'wheel', ((event: WheelEvent) => {
      if (!this.enabled) return;
      event.preventDefault(); this.onZoom(Math.sign(event.deltaY));
    }) as EventListener, { passive: false });
    this.listen(canvas, 'contextmenu', event => event.preventDefault());
  }

  private cameraDistance() {
    if (this.cameraPointers.size !== 2) return 0;
    const [a, b] = [...this.cameraPointers.values()]; return Math.hypot(a.x-b.x, a.y-b.y);
  }

  attachTouchControls(controls: TouchControls) {
    this.controls = controls;
    const updateStick = (event: PointerEvent) => {
      const box = controls.stick.getBoundingClientRect();
      const radius = Math.max(1, Math.min(box.width, box.height) * .34);
      let x = (event.clientX - box.left - box.width / 2) / radius;
      let y = (event.clientY - box.top - box.height / 2) / radius;
      const length = Math.hypot(x, y);
      if (length > 1) { x /= length; y /= length; }
      const strength = Math.max(0, (Math.min(1, length) - .12) / .88);
      const clampedLength = Math.hypot(x, y) || 1;
      this.touchSide = x / clampedLength * strength; this.touchForward = -y / clampedLength * strength;
      controls.stick.style.setProperty('--stick-x', `${x * radius}px`); controls.stick.style.setProperty('--stick-y', `${y * radius}px`);
    };
    this.listen(controls.stick, 'pointerdown', ((event: PointerEvent) => {
      if (!this.enabled || event.button !== 0 || this.stickPointer !== undefined) return;
      this.capture(controls.stick, event); this.stickPointer = event.pointerId;
      controls.stick.classList.add('is-active'); updateStick(event);
    }) as EventListener);
    this.listen(controls.stick, 'pointermove', ((event: PointerEvent) => {
      if (!this.enabled || event.pointerId !== this.stickPointer) return;
      event.preventDefault(); updateStick(event);
    }) as EventListener);
    const endStick = ((event: PointerEvent) => {
      if (event.pointerId !== this.stickPointer) return;
      this.stickPointer = undefined; this.touchSide = this.touchForward = 0;
      controls.stick.classList.remove('is-active');
      controls.stick.style.setProperty('--stick-x', '0px'); controls.stick.style.setProperty('--stick-y', '0px');
      this.release(event.pointerId);
    }) as EventListener;
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) this.listen(controls.stick, event, endStick);
    for (const [button, key] of [[controls.boost, 'boostPointer'], [controls.brake, 'brakePointer']] as const) {
      this.listen(button, 'pointerdown', ((event: PointerEvent) => {
        if (!this.enabled || event.button !== 0 || this[key] !== undefined) return;
        this.capture(button, event); this[key] = event.pointerId;
        button.classList.add('is-active'); button.setAttribute('aria-pressed', 'true');
      }) as EventListener);
      const end = ((event: PointerEvent) => {
        if (event.pointerId !== this[key]) return;
        this[key] = undefined; button.classList.remove('is-active'); button.setAttribute('aria-pressed', 'false'); this.release(event.pointerId);
      }) as EventListener;
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) this.listen(button, event, end);
    }
  }

  private down(...codes: string[]) { return codes.some(code => this.keys.has(code)); }
  get forward() { return this.enabled ? Math.max(-1, Math.min(1, this.touchForward + Number(this.down('KeyW', 'KeyZ', 'ArrowUp')) - Number(this.down('KeyS', 'ArrowDown')))) : 0; }
  get side() { return this.enabled ? Math.max(-1, Math.min(1, this.touchSide + Number(this.down('KeyD', 'ArrowRight')) - Number(this.down('KeyA', 'KeyQ', 'ArrowLeft')))) : 0; }
  get sprint() { return this.enabled && (this.boostPointer !== undefined || this.down('ShiftLeft', 'ShiftRight')); }
  get braking() { return this.enabled && (this.brakePointer !== undefined || this.down('Space')); }
  clear() {
    this.keys.clear(); this.cameraPointers.clear(); this.pinchDistance = 0;
    this.stickPointer = this.boostPointer = this.brakePointer = undefined; this.touchForward = this.touchSide = 0;
    if (this.controls) {
      const { stick, boost, brake } = this.controls;
      stick.style.setProperty('--stick-x', '0px'); stick.style.setProperty('--stick-y', '0px');
      for (const target of [stick, boost, brake]) { target.classList.remove('is-active'); target.setAttribute('aria-pressed', 'false'); }
    }
    for (const id of [...this.captures.keys()]) this.release(id);
  }
  dispose() { this.clear(); this.handlers.forEach(remove => remove()); }
}
