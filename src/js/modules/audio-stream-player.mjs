/* global globalThis */
import { BufferedStreamReader } from './buffered-stream-reader.mjs';

function getAudioContextCtor() {
  if (typeof window !== 'undefined') {
    if (window.AudioContext || window.webkitAudioContext) {
      return window.AudioContext || window.webkitAudioContext;
    }
  }
  if (typeof globalThis !== 'undefined') {
    return globalThis.AudioContext || globalThis.webkitAudioContext;
  }
  return undefined;
}

export class AudioStreamPlayer {
  // these shouldn't change once set
  _worker;
  _url;
  _readBufferSize

  // these are reset for every session
  _sessionSeq = 0;           // monotonic id source; never reset so ids never repeat
  _sessionId             // identifies the active start() session (null when closed)
  _audioCtx;             // Created/Closed when this player starts/stops audio
  _reader;
  _audioSrcNodes         // every source node scheduled by the active session
  _totalTimeScheduled    // time scheduled of all AudioBuffers
  _playStartedAt         // audioContext.currentTime of first sched
  _downloadStartTime     // performance.now() captured at session start
  _abCreated;            // AudioBuffers created
  _abEnded;              // AudioBuffers played/ended
  _skips;                // audio skipping caused by slow download

  constructor(url, readBufferSize, decoderName) {
    switch (decoderName) {
      case 'PCM': this._worker =  new Worker('../worker-decoder-wav.js'); break;
      case 'OPUS': this._worker = new Worker('../worker-decoder-opus.js'); break;
      default: throw Error('Unsupported decoderName', decoderName);
    }

    this._worker.onerror = event => {
      this._updateState({ error: event.message });
    };
    this._worker.onmessage = this._onWorkerMessage.bind(this);

    // pause for now
    // this._audioCtx.suspend().then(_ => console.log('audio paused'));

    this._url = url;
    this._readBufferSize = readBufferSize;
    this._reset();
  }

  // Returns true only while sessionId belongs to the currently active session.
  // Every async boundary (download reads, worker replies, node events and
  // context promises) must check this before touching shared state.
  _isCurrentSession(sessionId) {
    return sessionId !== null && sessionId !== undefined && this._sessionId === sessionId;
  }

  _reset() {
    if (this._sessionId) {
      try { performance.clearMarks(this._downloadMarkKey); } catch (e) { /* marks unavailable */ }
    }

    this._sessionId = null;
    this._audioCtx = null;
    this._reader = null;
    this._audioSrcNodes = [];
    this._totalTimeScheduled = 0;
    this._playStartedAt = 0;
    this._downloadStartTime = 0;
    this._abCreated = 0;
    this._abEnded = 0;
    this._skips = 0;
  }

  close() {
    this._teardownSession();
    this._reset();
  }

  // Aborts the download, stops/disconnects every scheduled source node and
  // closes the AudioContext.  Safe to call more than once and safe to call
  // before start() (constructor/reset paths rely on this).
  _teardownSession() {
    const nodes = this._audioSrcNodes? Array.from(this._audioSrcNodes) : [];
    for (let node of nodes) {
      // detach first so stop() cannot deliver a stale onended state update
      try { node.onended = null; } catch (e) { /* ignore */ }
      try { node.stop(); } catch (e) { /* already stopped or never started */ }
      this._disconnectNode(node);
    }
    if (this._audioSrcNodes) {
      this._audioSrcNodes.length = 0;
    }

    if (this._reader) {
      try { this._reader.abort(); } catch (e) { /* ignore */ }
      this._reader = null;
    }

    if (this._audioCtx) {
      const audioCtx = this._audioCtx;
      // close() itself stops all sound and releases the context; no suspend needed.
      try {
        const result = audioCtx.close();
        if (result && typeof result.catch === 'function') {
          result.catch(_ => {});
        }
      } catch (e) { /* context already closed */ }
    }
  }

  _disconnectNode(node) {
    try {
      if (this._audioCtx && this._audioCtx.destination) {
        node.disconnect(this._audioCtx.destination);
      } else {
        node.disconnect();
      }
    } catch (e) {
      try { node.disconnect(); } catch (e2) { /* already disconnected */ }
    }
  }

  start() {
    // Repeated start() (double click) or restarting after reset must fully
    // retire the previous session before a new one is created.
    if (this._sessionId || this._audioCtx || this._reader) {
      this.close();
    }

    // A monotonic counter (rather than e.g. performance.now()) guarantees that
    // even two synchronous start() calls receive different session ids.
    const sessionId = ++this._sessionSeq;
    this._sessionId = sessionId;
    this._downloadStartTime = this._now();
    try { performance.mark(this._downloadMarkKey); } catch (e) { /* marks unavailable */ }

    const AudioContextCtor = getAudioContextCtor();
    this._audioCtx = new AudioContextCtor({ latencyHint: 'interactive' });

    const reader = new BufferedStreamReader(new Request(this._url), this._readBufferSize);
    // bind the session id at subscription time so an old reader can never
    // publish results under the new session's id
    reader.onRead = (data) => this._downloadProgress(data, sessionId);
    reader.onBufferFull = (data) => this._decode(data, sessionId);

    reader.read()
    .catch(e => {
      if (!this._isCurrentSession(sessionId)) return;
      this._updateState({ error: e.toString() });
    });

    this._reader = reader;
    this.resume();

    return sessionId;
  }

  _now() {
    if (typeof performance !== 'undefined' && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  pause() {
    const sessionId = this._sessionId;
    const audioCtx = this._audioCtx;
    if (!audioCtx || !sessionId) return;

    let result;
    try {
      result = audioCtx.suspend();
    } catch (e) {
      return;
    }

    if (result && typeof result.then === 'function') {
      result
      .then(_ => {
        if (this._isCurrentSession(sessionId)) {
          this._updateState({ playState: 'paused'});
        }
      })
      .catch(_ => {}); // context closed by reset/switch while suspend was pending
    } else if (this._isCurrentSession(sessionId)) {
      this._updateState({ playState: 'paused'});
    }
  }

  resume() {
    const sessionId = this._sessionId;
    const audioCtx = this._audioCtx;
    if (!audioCtx || !sessionId) return;

    let result;
    try {
      result = audioCtx.resume();
    } catch (e) {
      return;
    }

    if (result && typeof result.then === 'function') {
      result
      .then(_ => {
        if (this._isCurrentSession(sessionId)) {
          this._updateState({ playState: 'playing'});
        }
      })
      .catch(_ => {}); // context closed by reset/switch while resume was pending
    } else if (this._isCurrentSession(sessionId)) {
      this._updateState({ playState: 'playing'});
    }
  }

  _updateState(props) {
    const abState = !this._abCreated? {} : {
      abCreated: this._abCreated,
      abEnded: this._abEnded,
      abRemaining: this._abCreated - this._abEnded,
      skips: this._skips
    };
    const state = Object.assign(abState, props);
    if (this.onUpdateState) {
      this.onUpdateState(state);
    }
  }

  _decode({ bytes, done }, sessionId = this._sessionId) {
    // a retired reader may still flush a trailing buffer; never forward it
    if (!this._isCurrentSession(sessionId)) return;
    this._worker.postMessage({ decode: bytes.buffer, sessionId }, [bytes.buffer]);
  }

  // prevent race condition by checking sessionId
  _onWorkerMessage(event) {
    const data = event && event.data;
    if (!data || !data.decoded) return;

    const {decoded, sessionId} = data;
    if (decoded.channelData) {
      if (!this._isCurrentSession(sessionId)) {
        console.log("race condition detected for closed session");
        return;
      }

      this._schedulePlayback(decoded, sessionId);
    }
  }

  _downloadProgress({ bytes, totalRead, totalBytes, done }, sessionId = this._sessionId) {
    if (!this._isCurrentSession(sessionId)) return;

    this._updateState({
      bytesRead: totalRead,
      bytesTotal: totalBytes,
      dlRate: totalRead*8 / (this._now() - this._getDownloadStartTime())
    });
    // console.log(done, (totalRead/totalBytes*100).toFixed(2) );
  }

  get _downloadMarkKey() {
    return `download-start-${this._sessionId}`;
  }
  _getDownloadStartTime() {
    if (this._downloadStartTime) return this._downloadStartTime;
    const mark = performance.getEntriesByName(this._downloadMarkKey)[0];
    return mark? mark.startTime : this._now();
  }

  _schedulePlayback({channelData, length, numberOfChannels, sampleRate}, sessionId = this._sessionId) {
    // worker reply may belong to an expired session: discard without touching
    // AudioContext, counters or scheduled nodes
    if (!this._isCurrentSession(sessionId) || !this._audioCtx) return;
    if (!length || length <= 0) return;

    const audioCtx = this._audioCtx;
    const audioSrc = audioCtx.createBufferSource(),
          audioBuffer = audioCtx.createBuffer(numberOfChannels, length, sampleRate);

    audioSrc.onended = () => {
      // expired session's node events must never update current stats/UI
      if (!this._isCurrentSession(sessionId)) return;

      const index = this._audioSrcNodes.indexOf(audioSrc);
      if (index >= 0) this._audioSrcNodes.splice(index, 1);
      this._disconnectNode(audioSrc);
      try { audioSrc.onended = null; } catch (e) { /* ignore */ }

      this._abEnded++;
      this._updateState();
    };
    this._abCreated++;
    this._updateState();

    // adding also ensures onended callback is fired in Safari
    this._audioSrcNodes.push(audioSrc);

    // Use performant copyToChannel() if browser supports it
    for (let c=0; c<numberOfChannels; c++) {
      if (audioBuffer.copyToChannel) {
        audioBuffer.copyToChannel(channelData[c], c);
      } else {
        let toChannel = audioBuffer.getChannelData(c);
        for (let i=0; i<channelData[c].byteLength; i++) {
          toChannel[i] = channelData[c][i];
        }
      }
    }

    let startDelay = 0;
    // initialize first play position.  initial clipping/choppiness sometimes occurs and intentional start latency needed
    // read more: https://github.com/WebAudio/web-audio-api/issues/296#issuecomment-257100626
    if (!this._playStartedAt) {
      /* this clips in Firefox, plays */
      // const startDelay = audioCtx.baseLatency || (128 / audioCtx.sampleRate);

      /* this doesn't clip in Firefox (256 value), plays */
      // startDelay = this._audioCtx.baseLatency || (256 / this._audioCtx.sampleRate);

      // 100ms allows enough time for largest 60ms Opus frame to decode
      startDelay = 100 / 1000;

      /* this could be useful for firefox but outputLatency is about 250ms in FF. too long */
      // const startDelay = audioCtx.outputLatency || audioCtx.baseLatency || (128 / audioCtx.sampleRate);

      this._playStartedAt = audioCtx.currentTime + startDelay;
      this._updateState({ latency: this._now() - this._getDownloadStartTime() + startDelay*1000 });
    }

    audioSrc.buffer = audioBuffer;
    audioSrc.connect(audioCtx.destination);

    const startAt = this._playStartedAt + this._totalTimeScheduled;
    if (audioCtx.currentTime >= startAt) {
      this._skips++;
      this._updateState();
    }
    audioSrc.start(startAt);

    this._totalTimeScheduled+= audioBuffer.duration;
  }
}
