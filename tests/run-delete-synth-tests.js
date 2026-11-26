"use strict";

/*
 * Node runner for the synthesizer deletion verification scenarios.
 *
 * It loads the real application sources (pattern.js, song-object.js, ...)
 * inside a VM context with a lightweight Tone.js stub. The stub records every
 * audio node and its connections, which lets the tests assert that deleting a
 * synthesizer destroys its nodes and leaves no residual audio connections.
 *
 * Run:  node tests/run-delete-synth-tests.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const jsDir = path.join(repoRoot, "js");

// ---------------------------------------------------------------------------
// Audio node registry: tracks connections/disposal of every stubbed Tone node
// ---------------------------------------------------------------------------
const nodeRegistry = [];
let nodeCounter = 0;

class FakeAudioNode {
	constructor() {
		this._id = "node-" + (nodeCounter++);
		this._disposed = false;
		this._outputs = new Set();
		nodeRegistry.push(this);
	}

	connect(node) {
		if (!node)
			return node;
		this._outputs.add(node);
		if (node._inputs)
			node._inputs.add(this);
		return node;
	}

	disconnect(node) {
		if (node === undefined) {
			for (let target of this._outputs)
				if (target._inputs)
					target._inputs.delete(this);
			this._outputs.clear();
		} else {
			this._outputs.delete(node);
			if (node._inputs)
				node._inputs.delete(this);
		}
	}

	chain(...nodes) {
		let current = this;
		for (let node of nodes) {
			current.connect(node);
			current = node;
		}
		return nodes[nodes.length - 1];
	}

	dispose() {
		this.disconnect();
		this._disposed = true;
		return this;
	}
}

class FakeParam {
	constructor(value) {
		this.value = value;
	}

	linearRampTo() { }
	setValueAtTime() { }
}

class FakeToneNode extends FakeAudioNode {
	constructor() {
		super();
		this._inputs = new Set();
		this.gain = new FakeParam(1);
		this.frequency = new FakeParam(440);
		this.detune = new FakeParam(0);
		this.Q = new FakeParam(1);
		this.wet = new FakeParam(1);
		this.delayTime = new FakeParam(0);
		this.feedback = new FakeParam(0);
		this.depth = new FakeParam(0);
		this.pan = new FakeParam(0);
		this.decay = 0;
	}

	start() { }
	stop() { }
	triggerAttack() { }
	triggerRelease() { }
	get ready() {
		return Promise.resolve(this);
	}
}

class FakeCompressor extends FakeToneNode {
	constructor(threshold, ratio) {
		super();
		this.threshold = new FakeParam(threshold);
		this.ratio = new FakeParam(ratio);
	}
	toDestination() { }
}

class FakeSignal extends FakeToneNode {
	constructor(options) {
		super();
		this.units = options && options.units;
	}
}

const Tone = {
	context: {
		lookAhead: 0.15,
		sampleRate: 44100,
		rawContext: { baseLatency: 0 }
	},
	Transport: {
		bpm: { value: 120 },
		start() { },
		stop() { },
		cancel() { },
		scheduleRepeat() { return 0; },
		clear() { }
	},
	Compressor: FakeCompressor,
	Gain: FakeToneNode,
	Signal: FakeSignal,
	Oscillator: FakeToneNode,
	Noise: FakeToneNode,
	AmplitudeEnvelope: FakeToneNode,
	Envelope: FakeToneNode,
	BiquadFilter: FakeToneNode,
	Panner: FakeToneNode,
	Distortion: FakeToneNode,
	FeedbackDelay: FakeToneNode,
	PingPongDelay: FakeToneNode,
	AutoPanner: FakeToneNode,
	Reverb: FakeToneNode,
	Chorus: FakeToneNode,
	StereoWidener: FakeToneNode,
	Phaser: FakeToneNode,
	Tremolo: FakeToneNode,
	Vibrato: FakeToneNode,
	ToneAudioNode: FakeToneNode,
	Frequency: {
		noteToFrequency(note) {
			return 440;
		},
		toFrequency() {
			return 440;
		},
		toMidi() {
			return 60;
		}
	},
	now() {
		return 0;
	},
	connect(source, target) {
		if (source && source.connect)
			source.connect(target);
	},
	Offline: class { }
};

// ---------------------------------------------------------------------------
// Minimal DOM / UI stubs - only what the constructors touch
// ---------------------------------------------------------------------------
function makeElement() {
	return {
		style: {},
		classList: { add() { }, remove() { }, toggle() { } },
		appendChild() { },
		addEventListener() { },
		removeEventListener() { },
		querySelectorAll() { return []; },
		remove() { },
		focus() { }
	};
}

const documentStub = {
	getElementById() {
		return makeElement();
	},
	querySelectorAll() {
		return [];
	},
	createElement() {
		return makeElement();
	},
	addEventListener() { }
};

// ---------------------------------------------------------------------------
// VM context
// ---------------------------------------------------------------------------
const sandbox = {
	Tone,
	console,
	window: {},
	document: documentStub,
	showAlert() { },
	showConfirm() { },
	showPrompt() { },
	showToast() { },
	showModal() { },
	hideModal() { },
	setTimeout,
	clearTimeout
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(file) {
	const code = fs.readFileSync(path.join(jsDir, file), "utf8");
	vm.runInContext(code, sandbox, { filename: file });
}

// Application dependencies needed to exercise SongObject + Pattern
load("defaults.js");
load("synth-param-apply.js");
load("synth-proto.js");
load("synth.js");
load("wam-synth.js");
load("pattern.js");

// WamInit / WamUi are instantiated by SongObject; stub them out
vm.runInContext(`
	function WamInit() {
		this.loadModule = async function () { return null; };
	}
	function WamUi() {
		this.showLoadingIndicator = function () { };
		this.appendFxGui = function () { };
		this.showFxSlotError = function () { };
		this.resetFxSlotState = function () { };
		this.appendIPluginGui = function () { };
	}
`, sandbox);

load("loader.js");
load("song-object.js");

// Shared scenario file (also used by the browser runner)
const testCode = fs.readFileSync(path.join(__dirname, "delete-synth-tests.js"), "utf8");
vm.runInContext(testCode, sandbox, { filename: "delete-synth-tests.js" });

// ---------------------------------------------------------------------------
// Test environment implementation for this runner
// ---------------------------------------------------------------------------
let failures = 0;
const checks = [];

function assert(condition, message) {
	checks.push({ ok: !!condition, message });
	if (!condition)
		failures++;
}

function log(message) {
	console.log(message);
}

const registryApi = {
	nodesOf(synth) {
		const owned = [];
		for (let key of Object.keys(synth)) {
			let value = synth[key];
			if (value instanceof FakeAudioNode)
				owned.push(value);
		}
		return owned;
	},
	isConnected(node) {
		return node._outputs.size > 0 || node._inputs.size > 0;
	},
	isDisposed(node) {
		return node._disposed;
	}
};

const env = {
	makeSongObject() {
		// onSynthChange callback is a no-op in the headless environment
		return new sandbox.SongObject(function () { });
	},
	assert,
	log,
	getNodeRegistry() {
		return registryApi;
	},
	disposeSong(song) {
		for (let synth of song.synths) {
			if (synth && typeof synth.destroy === "function")
				synth.destroy();
		}
		if (song.compressor && typeof song.compressor.dispose === "function")
			song.compressor.dispose();
	}
};
sandbox.__testEnv = env;

vm.runInContext(`
	const suite = createDeleteSynthTests(__testEnv);
	suite.run();
`, sandbox);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log("");
console.log("Checks: " + checks.length + ", failures: " + failures);

if (failures > 0) {
	console.log("\nFAILED assertions:");
	for (let check of checks) {
		if (!check.ok)
			console.log("  - " + check.message);
	}
	process.exit(1);
}

console.log("All synth deletion checks passed.");
