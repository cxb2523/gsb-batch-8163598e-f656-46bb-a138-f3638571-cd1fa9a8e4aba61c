// Test harness: loads music.js (a browser global script) inside a vm.Context
// with lightweight browser/PHP globals stubbed out. No external dependencies.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Equivalent of the pathexp built from music.defaults.ini, with unique group
// names (the app's transformed regex reuses "artist", which browsers tolerate
// but Node rejects; getSongInfo is stubbed in tests anyway)
const PATHEXP = /(?<root>.*\b)\/(?<artist>.*\b) - (?<year>\d*) (?<album>.*)\/(?<track>[\d\.]*) (?<title>.*)\.(?<extension>.*\b)$/;

function fakeClassList(el) {
	const names = new Set();
	return {
		add: c => names.add(c),
		remove: c => names.delete(c),
		contains: c => names.has(c),
		toggle: c => (names.has(c) ? names.delete(c) : names.add(c)),
		_toString: () => [...names].join(' ')
	};
}

function fakeElement(tag = 'li') {
	const el = {
		tagName: tag.toUpperCase(),
		id: '',
		path: '',
		textContent: '',
		title: '',
		draggable: false,
		style: {},
		parentNode: null,
		children: [],
		childNodes: [],
		classList: null,
		_value: '',
		disabled: false,
		tabIndex: 0,
		offsetTop: 0,
		offsetHeight: 0,
		offsetWidth: 0,
		clientWidth: 0
	};
	el.classList = fakeClassList(el);
	el.appendChild = child => {
		child.parentNode = el;
		el.childNodes.push(child);
		el.children = el.childNodes;
		return child;
	};
	el.removeChild = child => {
		const i = el.childNodes.indexOf(child);
		if (i > -1) el.childNodes.splice(i, 1);
		child.parentNode = null;
		return child;
	};
	el.insertBefore = (child, ref) => {
		const i = el.childNodes.indexOf(ref);
		child.parentNode = el;
		if (i == -1) el.childNodes.push(child);
		else el.childNodes.splice(i, 0, child);
		el.children = el.childNodes;
		return child;
	};
	el.querySelectorAll = () => [];
	el.querySelector = () => null;
	el.contains = other => other === el || el.childNodes.some(c => c.contains && c.contains(other));
	el.addEventListener = () => {};
	el.remove = () => el.parentNode && el.parentNode.removeChild(el);
	el.setAttribute = () => {};
	el.getAttribute = () => null;
	el.hasChildNodes = () => el.childNodes.length > 0;
	el.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
	el.focus = () => {};
	el.blur = () => {};
	el.click = () => {};
	Object.defineProperty(el, 'value', {
		get() { return el._value; },
		set(v) { el._value = v == null ? '' : String(v); }
	});
	return el;
}

function fakeAudio() {
	return {
		src: 'data:audio/wav;base64,x',
		autoplay: false,
		preload: '',
		volume: 0.9,
		muted: false,
		paused: true,
		prepped: false,
		index: undefined,
		fade: null,
		buffered: { length: 0, end: () => 0 },
		load() {},
		play() { this.paused = false; return Promise.resolve(); },
		pause() { this.paused = true; },
		log() {}
	};
}

function loadSandbox() {
	const playlistEl = fakeElement('ul');
	playlistEl.id = 'playlist';
	const treeEl = fakeElement('ul');
	treeEl.id = 'tree';

	const elementMap = {
		playlist: playlistEl,
		tree: treeEl,
		filter: fakeElement('input'),
		filtertip: null,
		randomfiltered: fakeElement('button'),
		library: fakeElement('div'),
		playlistdiv: fakeElement('div'),
		doc: fakeElement('html'),
		body: fakeElement('body'),
		player: fakeElement('div'),
		playpause: fakeElement('button'),
		album: fakeElement('div'),
		title: fakeElement('div'),
		time: fakeElement('div'),
		seek: fakeElement('input'),
		cover: { src: '', style: {} },
		trash: fakeElement('div'),
		toast: fakeElement('button'),
		log: { value: '' },
		enqueue: fakeElement('button'),
		removesongs: { click() {} },
		afteroptions: fakeElement('div'),
		playlists: fakeElement('div'),
		afterdiv: fakeElement('div'),
		playlistsdiv: fakeElement('div'),
		options: fakeElement('div'),
		after: fakeElement('button'),
		stopplayback: fakeElement('button'),
		repeatplaylist: fakeElement('button'),
		playlibrary: fakeElement('button'),
		randomlibrary: fakeElement('button'),
		popupdiv: fakeElement('div'),
		popup: fakeElement('div'),
		popupcontent: fakeElement('div'),
		ok: fakeElement('button'),
		source: fakeElement('a'),
		pagetitle: fakeElement('title')
	};
	elementMap.randomfiltered.firstElementChild = { textContent: 'x' };

	const dom = new Proxy(elementMap, {
		get(target, prop) {
			if (prop in target) return target[prop];
			const stub = fakeElement('div');
			stub.id = prop;
			target[prop] = stub;
			return stub;
		},
		set(target, prop, value) {
			target[prop] = value;
			return true;
		}
	});
	dom.hide = () => {};
	dom.show = () => {};

	const sandbox = {
		// JS globals used directly
		console,
		JSON,
		Math,
		Date,
		Promise,
		setTimeout: (fn) => 0,
		clearTimeout: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		confirm: () => true,
		alert: () => {},
		prompt: () => null,
		btoa: s => Buffer.from(s, 'binary').toString('base64'),
		atob: s => Buffer.from(s, 'base64').toString('binary'),
		unescape,
		escape,
		encodeURIComponent,
		decodeURIComponent,
		URL,
		URLSearchParams,
		Blob: function () {},
		MediaMetadata: function () {},
		Audio: fakeAudio,
		document: {
			URL: 'http://localhost/music.htm',
			body: fakeElement('body'),
			createElement: () => fakeElement('li'),
			querySelectorAll: () => [],
			addEventListener: () => {},
			activeElement: null
		},
		window: {
			location: { protocol: 'http:', host: 'localhost', pathname: '/music.htm' },
			matchMedia: undefined,
			innerWidth: 1200,
			pageYOffset: 0,
			addEventListener: () => {},
			URL: 'http://localhost/music.htm'
		},
		navigator: { userAgent: 'node-test', clipboard: { writeText: () => Promise.resolve() } },
		location: { protocol: 'http:', host: 'localhost', pathname: '/music.htm' },
		localStorage: {
			_data: {},
			getItem(k) { return k in this._data ? this._data[k] : null; },
			setItem(k, v) { this._data[k] = String(v); }
		},
		// Constants normally emitted by music.php
		root: '',
		lsid: 'music_folder_player_test',
		maxerrors: 5,
		nodupes: false,
		onlinepls: true,
		sharing: false,
		pagetitle: 'Music',
		pathexp: [PATHEXP],
		ext_images: ['jpg', 'png'],
		sourceurl: 'http://localhost',
		themes: [],
		focuscolors: [],
		shareapi: {},
		// Populated by the script itself
		dom,
		str: new Proxy({}, { get: () => '' }),
		def: undefined
	};
	sandbox.window.location = sandbox.location;
	sandbox.globalThis = sandbox;

	vm.createContext(sandbox);
	const src = fs.readFileSync(path.join(__dirname, '..', 'music.js'), 'utf8');
	vm.runInContext(src, sandbox, { filename: 'music.js' });

	// music.js declares its collection state with `const`, so the bindings are
	// lexical rather than properties of the context object. Access them through
	// evaluation inside the context instead.
	const lexical = name => vm.runInContext(name, sandbox);
	sandbox.state = name => lexical(name);
	sandbox.resetState = () => vm.runInContext(
		'played.length = playedFiltered.length = songsFiltered.length = songs.length = tree.length = 0', sandbox);
	Object.defineProperty(sandbox, 'songs', { get: () => lexical('songs') });
	Object.defineProperty(sandbox, 'tree', { get: () => lexical('tree') });
	Object.defineProperty(sandbox, 'played', { get: () => lexical('played') });
	Object.defineProperty(sandbox, 'playedFiltered', { get: () => lexical('playedFiltered') });
	Object.defineProperty(sandbox, 'songsFiltered', { get: () => lexical('songsFiltered') });

	// DOM-free overrides for functions that would otherwise touch audio/DOM.
	// play() mirrors the real flow's observable result: the requested playlist
	// position becomes the cursor and is marked as prepped/playing.
	sandbox.play = function (id) {
		id = +id;
		sandbox._lastPlay = id;
		sandbox.cfg.index = id;
		sandbox.track ^= 1;
		sandbox.audio[sandbox.track].prepped = true;
		sandbox.audio[sandbox.track].index = id;
	};
	sandbox.stop = function () { sandbox._stopped = true; };
	sandbox.setToast = () => {};
	sandbox.resizePlaylist = () => {};
	sandbox.fillShare = () => {};
	// Deterministic path -> metadata (pathexp-independent) for test songs
	sandbox.getSongInfo = function (p) {
		const parts = p.split('/');
		const file = parts[parts.length - 1].replace(/\.[^.]+$/, '');
		const artistDir = parts.length > 1 ? parts[parts.length - 2] : 'Unknown';
		const artist = artistDir.split(' - ')[0];
		return { artist, title: file, album: artistDir, year: '' };
	};
	sandbox.playlistItem = function (s) {
		const li = fakeElement('li');
		if (s.id == 'last') li.id = 'last';
		else li.textContent = s.path;
		return li;
	};
	sandbox.dimSong = () => {};
	sandbox.undimSong = () => {};

	// `var` state (audio, track, drag, mode...) lives on the context object;
	// give tests a working audio pair and default playback state up front.
	sandbox.audio = [sandbox.Audio(), sandbox.Audio()];
	sandbox.track = 0;
	sandbox.drag = null;
	sandbox.mode = null;
	sandbox.touch = false;
	sandbox.errorCount = 0;

	return sandbox;
}

// Build a song tree of {id, path} li-like objects matching buildLibrary's shape
function buildSongs(sandbox, paths) {
	sandbox.songs.length = 0;
	sandbox.tree.length = 0;
	paths.forEach((p, i) => {
		const li = fakeElement('li');
		li.id = String(i);
		li.path = p;
		sandbox.songs.push(li);
		sandbox.tree.push(li);
	});
}

// Fresh config resembling ls()'s defaults, keeping storage structure intact
function freshCfg(sandbox, after = 'randomlibrary') {
	sandbox.cfg = {
		playlist: [],
		skip: [],
		index: -1,
		after,
		volume: 0.9,
		random: false,
		crossfade: false,
		enqueue: false,
		locked: false,
		debug: false
	};
	return sandbox.cfg;
}

// Seeded PRNG so randomized assertions are reproducible
function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ARTISTS = ['ArtistA', 'ArtistB', 'ArtistC', 'ArtistD', 'ArtistE'];
function songPath(i) {
	const artist = ARTISTS[i % ARTISTS.length];
	return artist +' - 2020 Album'+ (i % 2 + 1) +'/'+ String(i + 1).padStart(2, '0') +' Song'+ i +'.mp3';
}
function paths(n) {
	return Array.from({ length: n }, (_, i) => songPath(i));
}

module.exports = { loadSandbox, buildSongs, freshCfg, fakeElement, fakeAudio, mulberry32, songPath, paths, ARTISTS };
