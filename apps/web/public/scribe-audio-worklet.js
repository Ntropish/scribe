// Downmixes input to mono, linear-resamples from the AudioContext rate to
// 16 kHz, converts float32 to int16, and posts buffers to the main thread.

const TARGET_RATE = 16000;
const CHUNK_FRAMES = 1024; // ~64 ms at 16 kHz

class ScribeAudioWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._sourceRate = sampleRate;
    this._ratio = this._sourceRate / TARGET_RATE;
    this._pos = 0;
    this._buffer = new Int16Array(CHUNK_FRAMES);
    this._fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const frames = input[0].length;
    const channels = input.length;
    // Downmix to mono
    const mono = new Float32Array(frames);
    for (let c = 0; c < channels; c++) {
      const ch = input[c];
      for (let i = 0; i < frames; i++) mono[i] += ch[i];
    }
    for (let i = 0; i < frames; i++) mono[i] /= channels;

    // Linear-resample to TARGET_RATE.
    while (this._pos < frames) {
      const idx = this._pos;
      const i0 = Math.floor(idx);
      const i1 = Math.min(frames - 1, i0 + 1);
      const t = idx - i0;
      const sample = mono[i0] * (1 - t) + mono[i1] * t;
      const clamped = Math.max(-1, Math.min(1, sample));
      this._buffer[this._fill++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this._fill >= this._buffer.length) {
        const out = this._buffer.slice();
        this.port.postMessage(out.buffer, [out.buffer]);
        this._buffer = new Int16Array(CHUNK_FRAMES);
        this._fill = 0;
      }
      this._pos += this._ratio;
    }
    this._pos -= frames;
    return true;
  }
}

registerProcessor("scribe-audio-worklet", ScribeAudioWorklet);
