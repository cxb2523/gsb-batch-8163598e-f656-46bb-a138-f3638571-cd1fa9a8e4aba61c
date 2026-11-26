# ferro toggle, made with claude opus 5.5

a ferrofluid dark mode switch that claude opus 5.5 made in one html file

[![the switch turning dark mode on and off](demo.webp)](https://argofowl.github.io/ferro-toggle/)

**[try it live](https://argofowl.github.io/ferro-toggle/)**

people asked if this is really html only

it is. one [`index.html`](index.html), about 64 kb, no libraries, no build step, nothing loaded from outside

the liquid is drawn by webgl 2 shaders on one canvas, and the sound is made in the browser too

## controls

- click, drag or press space
- `m` mutes the sound
- add `?hq` to the url for full resolution

## run it

download `index.html` and open it in a browser with webgl 2

that's the whole install

## verify the audio lifecycle

`m` mute, tab visibility and window focus share one output gate, and the
checks in [`verify/`](verify/README.md) reproduce every state transition:

```bash
npm run verify   # node >= 22, drives an installed chrome/edge over cdp, no deps
```

add `?debug` for the frame/audio inspection hooks, including
`__ferro.soundCheck(events, secs)` for offline rendering


## license

[mit](LICENSE)
