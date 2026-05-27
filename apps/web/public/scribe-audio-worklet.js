// Downmixes input to mono, linear-resamples from the AudioContext rate to
// 16 kHz, converts float32 to int16, gates silence with a short pre-roll
// and hangover, and posts buffers to the main thread.

const TARGET_RATE = 16000;
const CHUNK_FRAMES = 1024; // ~64 ms at 16 kHz

// RMS-based voice activity gate. Tuned conservatively so quiet speech still
// passes; the cost is a bit of silence on either side of utterances.
const THRESHOLD_DBFS = -50;
const PREROLL_CHUNKS = 3;     // ~192 ms retained before voice onset
const HANGOVER_CHUNKS = 6;    // ~384 ms emitted after voice ends
const STATS_INTERVAL_CHUNKS = 80; // emit gate stats roughly every 5 s

const THRESHOLD_RMS = Math.pow(10, THRESHOLD_DBFS / 20);

class ScribeAudioWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._sourceRate = sampleRate;
    this._ratio = this._sourceRate / TARGET_RATE;
    this._pos = 0;
    this._buffer = new Int16Array(CHUNK_FRAMES);
    this._fill = 0;
    // Ring of suppressed chunks held in case voice starts soon; bounded to
    // PREROLL_CHUNKS so the worklet never accumulates unbounded memory.
    this._preroll = [];
    // Start in the gated state so leading silence is suppressed.
    this._silentChunks = HANGOVER_CHUNKS + 1;
    this._sent = 0;
    this._gated = 0;
    this._chunksSinceStats = 0;
  }

  _emit(chunk) {
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
    this._sent += 1;
  }

  _flushPreroll() {
    while (this._preroll.length > 0) {
      this._emit(this._preroll.shift());
    }
  }

  _onChunkFilled(chunk) {
    let sumSq = 0;
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i] / 32768;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / chunk.length);
    const voiced = rms > THRESHOLD_RMS;

    if (voiced) {
      this._silentChunks = 0;
      this._flushPreroll();
      this._emit(chunk);
    } else {
      this._silentChunks += 1;
      if (this._silentChunks <= HANGOVER_CHUNKS) {
        this._emit(chunk);
      } else {
        this._preroll.push(chunk);
        if (this._preroll.length > PREROLL_CHUNKS) {
          this._preroll.shift();
        }
        this._gated += 1;
      }
    }

    this._chunksSinceStats += 1;
    if (this._chunksSinceStats >= STATS_INTERVAL_CHUNKS) {
      this.port.postMessage({
        type: "gate-stats",
        sent: this._sent,
        gated: this._gated,
      });
      this._chunksSinceStats = 0;
    }
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
        const chunk = this._buffer;
        this._buffer = new Int16Array(CHUNK_FRAMES);
        this._fill = 0;
        this._onChunkFilled(chunk);
      }
      this._pos += this._ratio;
    }
    this._pos -= frames;
    return true;
  }
}

registerProcessor("scribe-audio-worklet", ScribeAudioWorklet);
