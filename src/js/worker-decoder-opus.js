import { OpusStreamDecoder } from 'opus-stream-decoder';
import { DecodedAudioPlaybackBuffer } from './modules/decoded-audio-playback-buffer.mjs';

const decoder = new OpusStreamDecoder({ onDecode });
const playbackBuffer = new DecodedAudioPlaybackBuffer({ onFlush });
let sessionId, flushTimeoutId;

function evalSessionId(newSessionId) {
  // detect new session and reset decoder/buffer state
  if (sessionId && sessionId === newSessionId) {
    return;
  }

  sessionId = newSessionId;

  // a pending end-of-stream flush belongs to the old session; cancel it so
  // its buffers are never posted (or re-tagged) under the new session
  if (flushTimeoutId) {
    clearTimeout(flushTimeoutId);
    flushTimeoutId = null;
  }

  playbackBuffer.reset();
}

self.onmessage = async (evt) => {
  const messageSessionId = evt.data.sessionId;
  evalSessionId(messageSessionId);
  await decoder.ready;

  // another session may have started while decoder.ready was pending;
  // decoding these bytes now would feed stale data into the current decoder
  if (sessionId !== messageSessionId) {
    return;
  }

  decoder.decode(new Uint8Array(evt.data.decode));
};

function onDecode({ left, right, samplesDecoded, sampleRate }) {
  // Decoder recovers when it receives new files, and samplesDecoded is negative.
  // For cause, see https://github.com/AnthumChris/opus-stream-decoder/issues/7
  if (samplesDecoded < 0) {
    return;
  }

  playbackBuffer.add({ left, right});
  scheduleLastFlush();
}

function onFlush({ left, right }) {
  const decoded = {
    channelData: [left, right],
    length: left.length,
    numberOfChannels: 2,
    sampleRate: 48000
  };

  self.postMessage(
    { decoded, sessionId },
    [
      decoded.channelData[0].buffer,
      decoded.channelData[1].buffer
    ]
  );
}

// No End of file is signaled from decoder. This ensures last bytes always flush
function scheduleLastFlush() {
  clearTimeout(flushTimeoutId);
  flushTimeoutId = setTimeout(_ => {
    flushTimeoutId = null;
    playbackBuffer.flush();
  }, 100);
}
