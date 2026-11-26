/*
*  Garlmap - Gapless Almighty Rule-based Logcal Mpv Audio Player
*  Copyright (C) 2021-2026 Jelmer van Arnhem
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
* Race condition tests for cover art, lyrics and media session updates.
* Uses controllable delayed mocks to prove that late async results of
* previous songs (or of stopped playback) are discarded and never shown.
*/

import assert from "node:assert/strict"
import {mock, test} from "node:test"

// --- Minimal fake DOM, enough for the player/lyrics code paths ---

class FakeClassList {
    constructor() {
        this.values = new Set()
    }

    add(...names) {
        for (const name of names) {
            this.values.add(name)
        }
    }

    remove(...names) {
        for (const name of names) {
            this.values.delete(name)
        }
    }
}
class FakeElement {
    constructor(tag = "div") {
        this.tagName = tag
        this.style = {}
        this.children = []
        this.textContent = ""
        this.value = ""
        this.className = ""
        this.classList = new FakeClassList()
        this.ownerDocument = null
        this.matched = null
        this.scrollX = 0
        this.scrollY = 0
    }

    append(...kids) {
        this.children.push(...kids)
    }

    getAttribute(name) {
        return this[name] ?? null
    }

    querySelector() {
        return this.matched ?? null
    }

    removeAttribute(name) {
        delete this[name]
    }

    scrollTo(x, y) {
        this.scrollX = x
        this.scrollY = y
    }

    setAttribute(name, val) {
        this[name] = val
    }
}
class FakeImage extends FakeElement {}
class FakeInput extends FakeElement {
    constructor() {
        super("input")
        this.checked = false
    }
}
class FakeTextArea extends FakeElement {}
const elements = new Map()

const registerElement = (id, el) => {
    el.ownerDocument = fakeDocument
    elements.set(id, el)
    return el
}

const fakeDocument = {
    "addEventListener": () => null,
    "body": new FakeElement("body"),
    "createElement": tag => {
        const el = new FakeElement(tag)
        el.ownerDocument = fakeDocument
        return el
    },
    "defaultView": {
        "Element": FakeElement,
        "HTMLElement": FakeElement,
        "HTMLImageElement": FakeImage,
        "HTMLInputElement": FakeInput,
        "HTMLTextAreaElement": FakeTextArea
    },
    "getElementById": id => elements.get(id) ?? null
}
const coverEl = registerElement("song-cover", new FakeImage())
const coverFsEl = registerElement("fs-song-cover", new FakeImage())
registerElement("current-song", new FakeElement())
registerElement("fs-current-song", new FakeElement())
const songInfoEl = registerElement("song-info", new FakeElement())
const fsLyricsEl = registerElement("fs-lyrics", new FakeElement())
const lyricsEditEl = registerElement("lyrics-edit-field", new FakeTextArea())
const geniusToggle = registerElement("toggle-genius", new FakeInput())
geniusToggle.checked = true
const autoLyricsToggle = registerElement("toggle-autolyrics", new FakeInput())
autoLyricsToggle.checked = true
const mediaSession = {
    "metadata": null,
    "playbackState": "none",
    "setPositionState": () => null
}
class FakeMediaMetadata {
    constructor(init) {
        Object.assign(this, init)
    }
}
Object.defineProperties(globalThis, {
    "document": {"configurable": true, "value": fakeDocument},
    "navigator": {"configurable": true, "value": {mediaSession}},
    "window": {
        "configurable": true,
        "value": {"MediaMetadata": FakeMediaMetadata}
    }
})

// --- Controllable mocks for the async data sources ---

const sleep = ms => new Promise(res => {
    setTimeout(res, ms)
})

/**
 * The controllable music-metadata parseFile implementation of the mock.
 * @type {(path: string, opts?: object) => Promise<object|null>}
 */
let parseFileImpl = () => Promise.resolve(null)

mock.module("music-metadata", {
    "namedExports": {
        "parseFile": (...args) => parseFileImpl(...args),
        "selectCover": pics => pics?.[0] ?? null
    }
})

/**
 * The controllable Genius search implementation of the mock.
 * @type {(query: string) => Promise<object[]>}
 */
let geniusSearchImpl = () => Promise.resolve([])

class FakeGeniusClient {
    constructor() {
        this.songs = {"search": query => geniusSearchImpl(query)}
    }
}
mock.module("genius-lyrics", {"defaultExport": {"Client": FakeGeniusClient}})
mock.module("electron", {
    "namedExports": {
        "ipcRenderer": {
            "invoke": () => Promise.resolve(null),
            "on": () => null,
            "send": () => null
        }
    }
})
/** @type {object|null} */
let mockCurrent = null
mock.module("../app/renderer/playlist.js", {
    "namedExports": {
        "append": () => null,
        "autoPlayOpts": () => null,
        "clearPlaylist": () => Promise.resolve(null),
        "currentAndNext": () => ({"current": mockCurrent, "next": null}),
        "decrementSong": () => null,
        "incrementSong": () => Promise.resolve(null),
        "playFromPlaylist": () => Promise.resolve(null),
        "stopAfterTrack": () => null
    }
})
mock.module("../app/renderer/dom.js", {
    "namedExports": {
        "generateSongElement": () => new FakeElement(),
        "switchFocus": () => null
    }
})
const {displayCurrentSong, stopPlayback} = await import(
    "../app/renderer/player.js")
const {fetchLyrics, resetShowingLyrics} = await import(
    "../app/renderer/lyrics.js")

// --- Helpers ---

const makeSong = (name, extra = {}) => ({
    "album": `Album ${name}`,
    "artist": `Artist ${name}`,
    "bitrate": 0,
    "date": "",
    "disc": null,
    "disctotal": null,
    "duration": 100,
    "id": `${name}.mp3`,
    "lyrics": null,
    "path": `/music/${name}.mp3`,
    "title": `Song ${name}`,
    "track": null,
    "tracktotal": null,
    ...extra
})

const pic = {"data": new Uint8Array([1, 2, 3]), "format": "image/png"}
const coverResult = {"common": {"picture": [pic]}, "format": {}}
const noCoverResult = {"common": {}, "format": {}}

const geniusHit = (title, artist, lyrics, delay) => ({
    "artist": {"name": artist},
    "instrumental": false,
    "lyrics": async() => {
        await sleep(delay)
        return lyrics
    },
    title
})

// --- Tests ---

test("rapid switches show only the last song cover and metadata", async() => {
    parseFileImpl = async p => {
        if (p.endsWith("a.mp3")) {
            await sleep(80)
            return coverResult
        }
        if (p.endsWith("b.mp3")) {
            await sleep(10)
            return coverResult
        }
        await sleep(40)
        return noCoverResult
    }
    const songA = makeSong("a")
    const songB = makeSong("b")
    const songC = makeSong("c")
    await Promise.all([
        displayCurrentSong(songA),
        displayCurrentSong(songB),
        displayCurrentSong(songC)
    ])
    await sleep(120)
    // The final song C has no cover: nothing may be displayed
    assert.equal(coverEl.style.display, "none")
    assert.equal(coverEl.src, undefined)
    assert.equal(coverFsEl.style.display, "none")
    assert.equal(coverFsEl.src, undefined)
    // Media session must match song C with empty artwork
    assert.equal(mediaSession.metadata.title, songC.title)
    assert.deepEqual(mediaSession.metadata.artwork, [])
})

test("rapid switches to a covered song show only that song cover", async() => {
    parseFileImpl = async p => {
        if (p.endsWith("d.mp3")) {
            await sleep(80)
            return coverResult
        }
        await sleep(20)
        return coverResult
    }
    const songD = makeSong("d")
    const songE = makeSong("e")
    await Promise.all([displayCurrentSong(songD), displayCurrentSong(songE)])
    await sleep(120)
    // Only the cover of the last song E may be visible
    assert.equal(coverEl.style.display, "initial")
    assert.match(coverEl.src, /^data:image\/png;base64,/)
    assert.equal(mediaSession.metadata.title, songE.title)
    assert.equal(mediaSession.metadata.artwork.length, 1)
})

test("stopping while the cover is still loading never shows it", async() => {
    parseFileImpl = async() => {
        await sleep(50)
        return coverResult
    }
    const songF = makeSong("f")
    const pending = displayCurrentSong(songF)
    await stopPlayback()
    await pending
    await sleep(80)
    // After stopping, no cover and no media session info may remain
    assert.equal(coverEl.style.display, "none")
    assert.equal(coverEl.src, undefined)
    assert.equal(mediaSession.metadata, null)
    assert.ok(songInfoEl.textContent.startsWith("Welcome to Garlmap"))
})

test("switching to a coverless song clears the previous cover", async() => {
    parseFileImpl = p => {
        if (p.endsWith("g.mp3")) {
            return Promise.resolve(coverResult)
        }
        return Promise.resolve(noCoverResult)
    }
    await displayCurrentSong(makeSong("g"))
    assert.equal(coverEl.style.display, "initial")
    assert.match(coverEl.src, /^data:image\/png;base64,/)
    const songH = makeSong("h")
    await displayCurrentSong(songH)
    // The old cover must be gone, treated as having no cover
    assert.equal(coverEl.style.display, "none")
    assert.equal(coverEl.src, undefined)
    assert.equal(mediaSession.metadata.title, songH.title)
    assert.deepEqual(mediaSession.metadata.artwork, [])
})

test("a failing cover read is treated as no cover", async() => {
    parseFileImpl = () => Promise.reject(new Error("read failure"))
    await displayCurrentSong(makeSong("i"))
    assert.equal(coverEl.style.display, "none")
    assert.equal(coverEl.src, undefined)
    assert.deepEqual(mediaSession.metadata.artwork, [])
})

test("late lyrics of a previous song are discarded", async() => {
    const songJ = makeSong("j")
    const songK = makeSong("k")
    geniusSearchImpl = async query => {
        if (query.includes("Song J")) {
            await sleep(60)
            return [geniusHit("Song J", "Artist J", "lyrics of J", 0)]
        }
        await sleep(10)
        return [geniusHit("Song K", "Artist K", "lyrics of K", 0)]
    }
    mockCurrent = songJ
    const first = fetchLyrics(songJ)
    mockCurrent = songK
    const second = fetchLyrics(songK)
    await Promise.all([first, second])
    await sleep(100)
    assert.equal(songInfoEl.textContent, "lyrics of K")
    assert.equal(fsLyricsEl.textContent, "lyrics of K")
    assert.equal(lyricsEditEl.value, "lyrics of K")
})

test("repeated fetches for a song keep only the last result", async() => {
    const songL = makeSong("l")
    mockCurrent = songL
    let call = 0
    geniusSearchImpl = () => {
        call += 1
        let lyrics = "second lyrics"
        let delay = 10
        if (call === 1) {
            lyrics = "first lyrics"
            delay = 60
        }
        return Promise.resolve([geniusHit("Song L", "Artist L", lyrics, delay)])
    }
    const first = fetchLyrics(songL)
    const second = fetchLyrics(songL)
    await Promise.all([first, second])
    await sleep(100)
    // The slow first fetch must not overwrite the latest second fetch
    assert.equal(songInfoEl.textContent, "second lyrics")
})

test("resetting lyrics while fetching discards the late result", async() => {
    const songM = makeSong("m")
    mockCurrent = songM
    geniusSearchImpl = () => Promise.resolve([
        geniusHit("Song M", "Artist M", "stale lyrics", 40)
    ])
    const pending = fetchLyrics(songM)
    resetShowingLyrics()
    await pending
    await sleep(80)
    // Even though the song is still current, the reset invalidates the fetch
    assert.ok(songInfoEl.textContent.startsWith("Welcome to Garlmap"))
})
