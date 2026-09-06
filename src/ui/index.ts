import '../style.css';

export type TravelMode = 'walk' | 'bike' | 'horse';
export type TravelDestination = 'lake' | 'start';

export interface UICallbacks {
  onStart(): void | Promise<void>;
  onPause(): void;
  onResume(): void;
  onRestart(): void;
  onMode(mode: TravelMode): void;
  onTravel(destination: TravelDestination): void;
  onMute(muted: boolean): void;
}

export interface HikingUIState {
  altitude: number;
  ascent: number;
  distance: number;
  mode: TravelMode;
  sprinting: boolean;
  progress: number;
  heading: number;
}

const icon = (content: string, className = '') => `<svg class="ui-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
const icons = {
  ridge: icon('<path d="m2 19 7-13 4 7 3-5 6 11H2Z"/><path d="m6.7 10.3 2.3 2.2 1.8-2.9M13.3 12.5l2.7 2.2 1.7-3.6"/>'),
  arrow: icon('<path d="M4 12h15m-6-6 6 6-6 6"/>'),
  pause: icon('<path d="M9 5v14M15 5v14"/>'),
  sound: icon('<path d="m11 5-5 4H3v6h3l5 4V5Z"/><path class="sound-waves" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sound-muted" d="m16 9 5 6m0-6-5 6"/>'),
  walk: icon('<circle cx="13.5" cy="4" r="1.7"/><path d="m10 21 2-7-3-3 3-4 3 4 4 1M5 12l4-2m3 4 5 7m-5-7 1-5"/>'),
  bike: icon('<circle cx="5" cy="16" r="4"/><circle cx="19" cy="16" r="4"/><path d="m5 16 5-9 5 9H5Zm14 0-4-12h3M8 7h4"/>'),
  horse: icon('<path d="M5 21v-7l4-4-1-4 4 2 4-5 2 6 3 4-3 3-4-2-2 4v3M3 9l3 3m8-2h.1"/>'),
  lake: icon('<path d="m6 11 5-7 5 7m-13 5c2-2 4 2 6 0s4 2 6 0 4 2 6 0M3 20c2-2 4 2 6 0s4 2 6 0 4 2 6 0"/>'),
  home: icon('<path d="m3 11 9-7 9 7M6 9v11h12V9m-8 11v-6h4v6"/>'),
  restart: icon('<path d="M5 8a8 8 0 1 1-1 8M5 3v5h5"/>'),
  close: icon('<path d="m6 6 12 12M18 6 6 18"/>'),
  compass: icon('<path d="m12 3 5 17-5-3-5 3 5-17Z"/>'),
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const formatMeters = (value: number) => Math.round(Number.isFinite(value) ? value : 0).toLocaleString('en-GB');

/** One DOM overlay; game state and all movement remain owned by the caller. */
export function createUI(callbacks: UICallbacks) {
  const element = document.createElement('div');
  element.className = 'alpine-ui';
  element.innerHTML = `
    <div class="menu-scrim" data-part="scrim" aria-hidden="true"></div>
    <header class="identity" aria-label="Forest Lake">
      <span class="identity-mark">${icons.ridge}</span>
      <span class="identity-name">FOREST <span>/</span> LAKE</span>
    </header>
    <div class="utility-controls">
      <button class="icon-button mute-button" type="button" data-action="mute" aria-label="Mute sound" aria-pressed="false" title="Mute sound">${icons.sound}</button>
      <button class="icon-button" type="button" data-action="pause" aria-label="Pause and controls" title="Pause and controls · Esc" hidden>${icons.pause}</button>
    </div>

    <section class="trail-menu welcome-menu" data-part="welcome" aria-labelledby="welcome-title">
      <div class="eyebrow"><span class="small-rule"></span> THE ALPINE TRAIL</div>
      <h1 id="welcome-title">Lac des<br><em>Aiguilles.</em></h1>
      <p class="welcome-description">Through the larch woods.<br>Up to the glacial lake.</p>
      <div class="route-facts" aria-label="Route elevations">
        <div><span class="fact-label">TRAILHEAD</span><span class="fact-value">1,500 <small>m</small></span></div>
        <span class="route-connector" aria-hidden="true">${icons.arrow}</span>
        <div><span class="fact-label">THE LAKE</span><span class="fact-value">2,300 <small>m</small></span></div>
        <div class="ascent-fact"><span class="fact-label">ASCENT</span><span class="fact-value">800 <small>m</small></span></div>
      </div>
      <div class="loading-status" data-part="loading" role="status" aria-live="polite">
        <div class="loading-label"><span data-part="loading-label">Preparing the trail</span><span data-part="loading-percent">0%</span></div>
        <div class="loading-track" data-part="loading-track" role="progressbar" aria-label="Loading the environment" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-part="loading-fill"></span></div>
      </div>
      <button type="button" class="primary-button start-button" data-action="start" disabled><span>Start hiking</span>${icons.arrow}</button>
      <p class="welcome-footnote">Walk, cycle or ride. Take your time.</p>
    </section>
    <div class="scene-caption" data-part="scene-caption"><span class="caption-line"></span><span>SUMMER IN THE HIGH COUNTRY</span></div>

    <div class="game-hud" data-part="hud" hidden>
      <section class="route-hud" aria-label="Current hike">
        <div class="hud-objective"><span class="eyebrow">DESTINATION</span><span class="objective-dot" aria-hidden="true"></span></div>
        <h2>Lac des Aiguilles</h2>
        <div class="altitude-line"><span class="altitude-value" data-part="altitude">—</span><span class="altitude-unit">m<span>ALTITUDE</span></span></div>
        <div class="route-progress" data-part="route-progress" role="progressbar" aria-label="Route progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="route-progress-fill" data-part="route-fill"></span><span class="route-progress-ticks" aria-hidden="true"></span></div>
        <div class="route-endpoints"><span>1,500 m</span><span>2,300 m</span></div>
        <div class="hike-readings"><span><span class="reading-arrow" aria-hidden="true">↗</span> <strong data-part="ascent">—</strong> m climbed</span><span><strong data-part="distance">—</strong> <span data-part="distance-unit">m</span> traveled</span></div>
      </section>
      <div class="heading-hud" aria-label="Heading"><span data-part="compass">${icons.compass}</span><span data-part="heading-cardinal">N</span><span class="heading-degrees" data-part="heading-degrees">000°</span></div>
      <div class="mode-cluster">
        <div class="movement-status"><span class="status-dot" aria-hidden="true"></span><span data-part="movement-status">ON FOOT</span></div>
        <div class="mode-controls" role="group" aria-label="Travel mode">
          <button type="button" data-mode="walk" aria-pressed="true" title="Walk · 1">${icons.walk}<span>Walk</span><kbd>1</kbd></button>
          <button type="button" data-mode="bike" aria-pressed="false" title="Bike · 2">${icons.bike}<span>Bike</span><kbd>2</kbd></button>
          <button type="button" data-mode="horse" aria-pressed="false" title="Horse · 3">${icons.horse}<span>Horse</span><kbd>3</kbd></button>
        </div>
      </div>
      <div class="movement-hint" aria-hidden="true"><span><kbd>WASD</kbd> / <kbd>ZQSD</kbd> Move</span><span><kbd>SHIFT</kbd> Run</span><span data-part="camera-hint">Drag to look · Scroll to zoom</span></div>
      <div class="travel-controls" role="group" aria-label="Quick travel">
        <button class="travel-button" type="button" data-destination="lake">${icons.lake}<span>Travel to lake</span><kbd>L</kbd></button>
        <button class="travel-button secondary-travel" type="button" data-destination="start">${icons.home}<span>Return to trailhead</span><kbd>HOME</kbd></button>
      </div>
    </div>

    <section class="pause-screen" data-part="pause" hidden role="dialog" aria-modal="true" aria-labelledby="pause-title">
      <div class="pause-panel">
        <div class="pause-heading"><div class="eyebrow">ON THE TRAIL</div><button class="bare-icon-button" data-action="resume" type="button" aria-label="Resume hiking" title="Resume hiking · Esc">${icons.close}</button></div>
        <h2 id="pause-title">Take a breather.</h2>
        <p class="pause-description">The mountains can wait.</p>
        <button type="button" class="primary-button" data-action="resume"><span>Continue exploring</span>${icons.arrow}</button>
        <div class="controls-guide">
          <h3>FIND YOUR WAY</h3>
          <dl>
            <div><dt>Move</dt><dd><kbd>WASD</kbd><span>or</span><kbd>ZQSD</kbd></dd></div>
            <div><dt>Look around / zoom</dt><dd>Drag / scroll</dd></div>
            <div><dt>Run / ride faster</dt><dd><kbd>SHIFT</kbd></dd></div>
            <div><dt>Walk / bike / horse</dt><dd><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></dd></div>
            <div><dt>Travel to the lake</dt><dd><kbd>L</kbd></dd></div>
            <div><dt>Return to the trailhead</dt><dd><kbd>HOME</kbd></dd></div>
            <div><dt>Pause / resume</dt><dd><kbd>ESC</kbd></dd></div>
            <div><dt>Restart the hike</dt><dd><kbd>R</kbd></dd></div>
          </dl>
        </div>
        <button class="text-button restart-button" data-action="restart" type="button">${icons.restart}<span>Restart the hike</span></button>
      </div>
    </section>

    <section class="error-screen" data-part="error" role="alert" hidden aria-labelledby="error-title">
      <div class="error-panel"><div class="eyebrow">A PAUSE IN THE JOURNEY</div><h2 id="error-title">The trail couldn't open.</h2><p data-part="error-message"></p><button type="button" class="primary-button" data-action="retry"><span>Try again</span>${icons.restart}</button></div>
    </section>
    <div class="arrival-notice" data-part="arrival" hidden role="status" aria-live="polite"><span class="arrival-symbol">${icons.lake}</span><div><span class="eyebrow">YOU'VE ARRIVED</span><h2>Lac des Aiguilles</h2><p>A moment by the glacial lake.</p></div><button class="bare-icon-button" type="button" data-action="dismiss-arrival" aria-label="Dismiss arrival message">${icons.close}</button></div>
    <div class="trail-toast" data-part="toast" hidden role="status" aria-live="polite"></div>
  `;
  document.body.appendChild(element);

  const part = <T extends HTMLElement = HTMLElement>(name: string) => element.querySelector<T>(`[data-part="${name}"]`)!;
  const action = (name: string) => element.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;
  const modeButtons = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-mode]'));
  const state = { ready: false, started: false, paused: false, error: false, muted: false };
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
  let previousFocus: HTMLElement | null = null;
  let destroyed = false;

  function showError(message: string) {
    state.error = true;
    part('error-message').textContent = message;
    renderVisibility();
    action('retry').focus({ preventScroll: true });
  }

  function invoke(callback: () => void | Promise<void>) {
    try {
      const result = callback();
      if (result instanceof Promise) result.catch((error: unknown) => showError(error instanceof Error ? error.message : 'Please try opening the trail again.'));
    } catch (error: unknown) {
      showError(error instanceof Error ? error.message : 'Please try opening the trail again.');
    }
  }

  function renderVisibility() {
    part('welcome').hidden = state.started || state.error;
    part('scene-caption').hidden = state.started || state.error;
    part('hud').hidden = !state.started || state.paused || state.error;
    part('pause').hidden = !state.paused || state.error;
    part('error').hidden = !state.error;
    part('scrim').hidden = state.started && !state.paused && !state.error;
    action('pause').hidden = !state.started || state.paused || state.error;
    element.classList.toggle('is-playing', state.started && !state.paused && !state.error);
    element.classList.toggle('is-paused', state.paused);
  }

  action('start').addEventListener('click', () => {
    if (!state.ready || state.started) return;
    state.started = true;
    renderVisibility();
    invoke(callbacks.onStart);
    action('start').blur();
  });
  action('pause').addEventListener('click', () => invoke(callbacks.onPause));
  element.querySelectorAll<HTMLButtonElement>('[data-action="resume"]').forEach(button => button.addEventListener('click', () => invoke(callbacks.onResume)));
  action('restart').addEventListener('click', () => {
    part('arrival').hidden = true;
    part('toast').hidden = true;
    invoke(callbacks.onRestart);
  });
  action('retry').addEventListener('click', () => window.location.reload());
  action('mute').addEventListener('click', () => {
    state.muted = !state.muted;
    action('mute').setAttribute('aria-pressed', String(state.muted));
    action('mute').setAttribute('aria-label', state.muted ? 'Unmute sound' : 'Mute sound');
    action('mute').title = state.muted ? 'Unmute sound' : 'Mute sound';
    invoke(() => callbacks.onMute(state.muted));
  });
  modeButtons.forEach(button => button.addEventListener('click', () => invoke(() => callbacks.onMode(button.dataset.mode as TravelMode))));
  element.querySelectorAll<HTMLButtonElement>('[data-destination]').forEach(button => button.addEventListener('click', () => invoke(() => callbacks.onTravel(button.dataset.destination as TravelDestination))));
  action('dismiss-arrival').addEventListener('click', () => { part('arrival').hidden = true; });
  for (const event of ['pointerdown', 'pointerup', 'dblclick', 'wheel']) element.addEventListener(event, e => e.stopPropagation());

  // Focus stays in the active menu; gameplay shortcuts remain the game's concern.
  element.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !(state.paused || !state.started || state.error)) return;
    const menu = state.error ? part('error') : state.paused ? part('pause') : part('welcome');
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(button => !button.hidden);
    if (!state.started && !state.error) buttons.unshift(action('mute'));
    if (!buttons.length) return;
    const first = buttons[0]; const last = buttons[buttons.length - 1];
    if (event.shiftKey && (document.activeElement === first || !menu.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !menu.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });

  renderVisibility();

  return {
    element,
    setLoading(progress: number, label: string) {
      const percent = Math.round(clamp01(progress) * 100);
      part('loading-label').textContent = label;
      part('loading-percent').textContent = `${percent}%`;
      part('loading-fill').style.width = `${percent}%`;
      part('loading-track').setAttribute('aria-valuenow', String(percent));
    },
    setReady() {
      state.ready = true;
      part('loading-label').textContent = 'Your trail is ready';
      part('loading-percent').textContent = '100%';
      part('loading-fill').style.width = '100%';
      part('loading-track').setAttribute('aria-valuenow', '100');
      action('start').disabled = false;
      if (!state.started && !state.error) action('start').focus({ preventScroll: true });
    },
    setError: showError,
    update(value: HikingUIState) {
      part('altitude').textContent = formatMeters(value.altitude);
      part('ascent').textContent = formatMeters(Math.max(0, value.ascent));
      const distance = Math.max(0, Number.isFinite(value.distance) ? value.distance : 0);
      part('distance').textContent = distance >= 1000 ? (distance / 1000).toFixed(1) : formatMeters(distance);
      part('distance-unit').textContent = distance >= 1000 ? 'km' : 'm';
      const progress = clamp01(value.progress);
      part('route-fill').style.width = `${progress * 100}%`;
      part('route-progress').setAttribute('aria-valuenow', String(Math.round(progress * 100)));
      const heading = ((Number.isFinite(value.heading) ? value.heading : 0) % 360 + 360) % 360;
      part('heading-cardinal').textContent = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
      part('heading-degrees').textContent = `${(Math.round(heading) % 360).toString().padStart(3, '0')}°`;
      part('compass').style.transform = `rotate(${-heading}deg)`;
      modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === value.mode)));
      const labels: Record<TravelMode, string> = value.sprinting ? { walk: 'RUNNING', bike: 'PEDALING FASTER', horse: 'GALLOPING' } : { walk: 'ON FOOT', bike: 'CYCLING', horse: 'ON HORSEBACK' };
      part('movement-status').textContent = labels[value.mode] ?? 'EXPLORING';
      element.classList.toggle('is-sprinting', value.sprinting);
    },
    setPaused(paused: boolean) {
      if (state.paused === paused) return;
      state.paused = paused;
      if (paused) { part('arrival').hidden = true; part('toast').hidden = true; }
      renderVisibility();
      if (paused) {
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        part('pause').querySelector<HTMLButtonElement>('.primary-button')!.focus({ preventScroll: true });
      } else if (previousFocus?.isConnected && previousFocus.offsetParent !== null) previousFocus.focus({ preventScroll: true });
    },
    showArrival() {
      clearTimeout(arrivalTimer);
      part('arrival').hidden = false;
      arrivalTimer = setTimeout(() => { if (!destroyed) part('arrival').hidden = true; }, 8500);
    },
    showToast(message: string) {
      clearTimeout(toastTimer);
      part('toast').textContent = message;
      part('toast').hidden = false;
      toastTimer = setTimeout(() => { if (!destroyed) part('toast').hidden = true; }, 4200);
    },
    isMenuOpen: () => !state.started || state.paused || state.error,
    setCameraHint(message: string) { part('camera-hint').textContent = message; },
    destroy() { destroyed = true; clearTimeout(toastTimer); clearTimeout(arrivalTimer); element.remove(); },
  };
}

export type HikingUI = ReturnType<typeof createUI>;
