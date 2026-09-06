/** Quiet original wind, footsteps and riding sounds, synthesized locally. */
export class TrailAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private wind?: GainNode;
  private noise?: AudioBuffer;
  private step = 0;
  private bird = 0;
  private muted = false;
  private paused = true;

  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      const c = this.context;
      this.master = c.createGain(); this.master.gain.value = 0.45;
      this.master.connect(c.destination);
      this.noise = c.createBuffer(1, c.sampleRate * 4, c.sampleRate);
      const samples = this.noise.getChannelData(0);
      let last = 0;
      for (let i = 0; i < samples.length; i++) {
        last = (last + (Math.random() * 2 - 1) * 0.035) / 1.035;
        samples[i] = last * 3.5;
      }
      const source = c.createBufferSource(); source.buffer = this.noise; source.loop = true;
      const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 650;
      this.wind = c.createGain(); this.wind.gain.value = 0;
      source.connect(filter).connect(this.wind).connect(this.master); source.start();
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  setMuted(value: boolean) { this.muted = value; this.volume(); }
  setPaused(value: boolean) { this.paused = value; this.volume(); }
  private volume() {
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.muted || this.paused ? 0 : 0.45, this.context.currentTime, .12);
  }
  cue() {
    if (!this.context || !this.master || this.muted) return;
    const c = this.context;
    for (const [frequency, offset] of [[523, 0], [784, .12]]) {
      const tone = c.createOscillator(), gain = c.createGain();
      tone.type = 'sine'; tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0, c.currentTime + offset);
      gain.gain.linearRampToValueAtTime(.06, c.currentTime + offset + .015);
      gain.gain.exponentialRampToValueAtTime(.001, c.currentTime + offset + .5);
      tone.connect(gain).connect(this.master); tone.start(c.currentTime + offset); tone.stop(c.currentTime + offset + .52);
    }
  }
  update(dt: number, speed: number, mode: string, altitude: number) {
    if (!this.context || !this.master || !this.noise || this.paused || this.muted) return;
    const c = this.context;
    this.wind?.gain.setTargetAtTime(.09 + Math.max(0, altitude - 1500) / 18000 + speed * .0015, c.currentTime, .5);
    this.step += dt * (mode === 'horse' ? Math.max(1.8, speed * .45) : speed * .55);
    if (speed > .25 && this.step >= 1) {
      this.step %= 1;
      const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
      source.buffer = this.noise;
      filter.type = 'bandpass'; filter.frequency.value = mode === 'horse' ? 260 : mode === 'bike' ? 1600 : 750;
      filter.Q.value = .6;
      const volume = mode === 'bike' ? .05 : mode === 'horse' ? .34 : .18;
      gain.gain.setValueAtTime(volume, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, c.currentTime + .13);
      source.connect(filter).connect(gain).connect(this.master); source.start(0, Math.random()); source.stop(c.currentTime + .15);
    }
    this.bird += dt;
    if (this.bird > 15 && altitude < 2080) {
      this.bird = -Math.random() * 15;
      const bird = c.createOscillator(), gain = c.createGain();
      bird.frequency.setValueAtTime(2600, c.currentTime);
      bird.frequency.exponentialRampToValueAtTime(3800, c.currentTime + .08);
      bird.frequency.exponentialRampToValueAtTime(2400, c.currentTime + .3);
      gain.gain.setValueAtTime(.001, c.currentTime); gain.gain.linearRampToValueAtTime(.012, c.currentTime + .05);
      gain.gain.exponentialRampToValueAtTime(.001, c.currentTime + .32);
      bird.connect(gain).connect(this.master); bird.start(); bird.stop(c.currentTime + .35);
    }
  }
  dispose() { void this.context?.close(); }
}
