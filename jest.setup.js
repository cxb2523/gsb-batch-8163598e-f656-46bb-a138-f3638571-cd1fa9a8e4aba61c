import '@testing-library/jest-dom'

// Mock Web Audio API
global.AudioContext = jest.fn().mockImplementation(() => ({
  createAnalyser: jest.fn().mockReturnValue({
    fftSize: 2048,
    frequencyBinCount: 1024,
    context: { sampleRate: 48000 },
    getByteFrequencyData: jest.fn(),
    getFloatTimeDomainData: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
  }),
  createGain: jest.fn().mockReturnValue({
    gain: { value: 1 },
    connect: jest.fn(),
    disconnect: jest.fn(),
  }),
  createScriptProcessor: jest.fn().mockReturnValue({
    connect: jest.fn(),
    disconnect: jest.fn(),
    onaudioprocess: null,
  }),
  createMediaStreamSource: jest.fn().mockReturnValue({
    connect: jest.fn(),
    disconnect: jest.fn(),
  }),
  sampleRate: 48000,
  close: jest.fn().mockResolvedValue(undefined),
  destination: {},
}))

// Mock MediaDevices API
Object.defineProperty(global.navigator, 'mediaDevices', {
  writable: true,
  value: {
    getUserMedia: jest.fn().mockResolvedValue({
      getTracks: jest.fn().mockReturnValue([
        {
          stop: jest.fn(),
          kind: 'audio',
        },
      ]),
    }),
  },
})

// Mock Canvas API
HTMLCanvasElement.prototype.getContext = jest.fn().mockReturnValue({
  fillStyle: '',
  fillRect: jest.fn(),
  clearRect: jest.fn(),
  getImageData: jest.fn(),
  putImageData: jest.fn(),
  createImageData: jest.fn(),
  setTransform: jest.fn(),
  drawImage: jest.fn(),
  save: jest.fn(),
  restore: jest.fn(),
  scale: jest.fn(),
  rotate: jest.fn(),
  translate: jest.fn(),
  transform: jest.fn(),
  beginPath: jest.fn(),
  closePath: jest.fn(),
  moveTo: jest.fn(),
  lineTo: jest.fn(),
  bezierCurveTo: jest.fn(),
  quadraticCurveTo: jest.fn(),
  arc: jest.fn(),
  arcTo: jest.fn(),
  ellipse: jest.fn(),
  rect: jest.fn(),
  fill: jest.fn(),
  stroke: jest.fn(),
  clip: jest.fn(),
  isPointInPath: jest.fn(),
  isPointInStroke: jest.fn(),
  measureText: jest.fn().mockReturnValue({ width: 0 }),
  fillText: jest.fn(),
  strokeText: jest.fn(),
  createLinearGradient: jest.fn().mockReturnValue({ addColorStop: jest.fn() }),
  canvas: document.createElement('canvas'),
})

HTMLCanvasElement.prototype.toBlob = jest.fn((callback) => {
  callback(new Blob(['fake-image-data'], { type: 'image/png' }))
})

// jsdom does not implement ImageData without the optional `canvas` package.
// Provide a small spec-compatible shim so components can construct ImageData.
if (typeof global.ImageData === 'undefined') {
  class ImageDataShim {
    constructor(arg1, arg2, arg3) {
      if (arg1 instanceof Uint8ClampedArray) {
        this.data = arg1;
        this.width = arg2;
        // Spec: height optional when data + width are supplied.
        this.height = typeof arg3 === 'number'
          ? arg3
          : arg1.length / (4 * arg2);
      } else {
        this.width = arg1;
        this.height = arg2;
        this.data = new Uint8ClampedArray(Math.max(1, arg1) * Math.max(1, arg2) * 4);
      }
    }
  }
  global.ImageData = ImageDataShim;
  if (typeof window !== 'undefined') {
    window.ImageData = ImageDataShim;
  }
}

// Ensure the Web Audio mock is visible through `window` as well.
if (typeof window !== 'undefined' && !window.AudioContext) {
  window.AudioContext = global.AudioContext;
}

// Suppress console errors in tests
const originalError = console.error
beforeAll(() => {
  console.error = jest.fn()
})

afterAll(() => {
  console.error = originalError
})
