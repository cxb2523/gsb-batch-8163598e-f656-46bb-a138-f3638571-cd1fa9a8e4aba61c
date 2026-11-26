import MohayonaoWavDecoder from './MohayonaoWavDecoder.js';

const decoder = new MohayonaoWavDecoder();
let sessionId = null;

self.onmessage = event => {
  const { decode, sessionId: nextSessionId } = event.data;
  if (decode) {
    // A new session restarts from the beginning of a WAV file, so the
    // stateful header metadata from the previous session must be discarded.
    if (nextSessionId !== sessionId) {
      sessionId = nextSessionId;
      decoder.readerMeta = false;
    }

    const decoded = decoder.decodeChunkSync(event.data.decode);
    self.postMessage(
      { decoded, sessionId },
      decoded.channelData.map(({ buffer }) => buffer)
    );
  }
};
