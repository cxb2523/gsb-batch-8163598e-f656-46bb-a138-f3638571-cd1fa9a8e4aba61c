// Coverage for the random-continuation state machine in music.js:
// played sets vs. candidate-set scope, filter/reload/clear/remove/drag
// transitions, cursor bounds, skipped artists, exhaustion and empty results.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, buildSongs, freshCfg, mulberry32, paths, ARTISTS } = require('./harness');

// vm-context arrays have a different Array prototype, so compare contents
// element-by-element instead of using deep(Strict)Equal
function sameMembers(actual, expected) {
	const a = [...actual].map(String).sort();
	const e = [...expected].map(String).sort();
	assert.equal(a.length, e.length);
	a.forEach((v, i) => assert.equal(v, e[i]));
}

function setup(n = 10, after = 'randomlibrary') {
	const sb = loadSandbox();
	buildSongs(sb, paths(n));
	freshCfg(sb, after);
	sb.played.length = sb.playedFiltered.length = sb.songsFiltered.length = 0;
	sb.audio[0].prepped = sb.audio[1].prepped = false;
	sb.track = 0;
	sb.drag = null;
	sb.mode = null;
	// Isolate every test from deterministic RNG overrides in earlier tests
	sb.Math.random = Math.random;
	return sb;
}

test('getRandom: every library song is picked exactly once before the played set resets', () => {
	const sb = setup(10, 'randomlibrary');
	sb.Math.random = mulberry32(42);
	const picked = [];
	for (let i = 0; i < 10; i++) picked.push(sb.getRandom());
	assert.equal(new Set(picked).size, 10, 'no repeats within a cycle');
	assert.equal(sb.played.length, 10);
	// 11th pick resets the played set and starts a new cycle
	const again = sb.getRandom();
	assert.ok(again != null);
	assert.equal(sb.played.length, 1, 'played set was reset for the new cycle');
});

test('getRandom: ids are always strings, even when added numerically', () => {
	const sb = setup(5);
	sb.add(0);
	sb.add(2);
	assert.ok(sb.played.every(id => typeof id == 'string'));
	// Re-adding the same song must not duplicate the played entry
	sb.add(0);
	sameMembers(sb.played, ['0', '2']);
});

test('getRandom: skipped artists are never selected and bounded (no infinite loop)', () => {
	const sb = setup(5);
	sb.cfg.skip = ARTISTS.map(a => a.toLowerCase());	// skip every artist
	sb.Math.random = mulberry32(7);
	const t0 = Date.now();
	const result = sb.getRandom();
	assert.equal(result, null, 'all-skipped library returns null instead of looping');
	assert.ok(Date.now() - t0 < 1000);
	assert.equal(sb.played.length, 5, 'skipped songs were recorded as consumed');
});

test('getRandom: skipped artists are skipped but other songs remain selectable', () => {
	const sb = setup(10);
	sb.cfg.skip = ['artista', 'artistc'];	// 4 of 10 songs
	sb.Math.random = mulberry32(99);
	for (let i = 0; i < 6; i++) {
		const id = sb.getRandom();
		assert.ok(id != null);
		const artist = sb.getSongInfo(sb.songs[id].path).artist.toLowerCase();
		assert.ok(!sb.cfg.skip.includes(artist), 'picked artist is not skipped');
	}
});

test('getRandom: empty library returns null safely', () => {
	const sb = setup(0);
	assert.equal(sb.getRandom(), null);
	assert.equal(sb.played.length, 0);
});

test('randomfiltered: empty filter result returns null instead of crashing/looping', () => {
	const sb = setup(10, 'randomfiltered');
	sb.buildFilteredLibrary('zzz-no-match');
	assert.equal(sb.songsFiltered.length, 0);
	assert.equal(sb.getRandom(), null);
});

test('randomfiltered: picks only come from the filtered candidate set', () => {
	const sb = setup(10, 'randomfiltered');
	sb.buildFilteredLibrary('album1');
	const eligible = new Set(sb.songsFiltered);
	assert.ok(eligible.size > 0 && eligible.size < 10);
	sb.Math.random = mulberry32(123);
	for (let i = 0; i < eligible.size; i++) {
		const id = sb.getRandom();
		assert.ok(eligible.has(id.toString()), 'pick belongs to the filtered set');
	}
	assert.equal(sb.playedFiltered.length, eligible.size);
	assert.equal(sb.played.length, 0, 'library-wide played set stays untouched in filtered mode');
});

test('randomfiltered: changing the filter rebuilds candidates and prunes played to the new scope', () => {
	const sb = setup(10, 'randomfiltered');
	sb.dom.filter.value = 'album1';
	sb.buildFilteredLibrary('album1');
	sb.Math.random = mulberry32(5);
	sb.getRandom();
	const before = [...sb.playedFiltered];
	assert.ok(before.length > 0);

	// Simulate filter()'s scope-sync call with new terms
	sb.buildFilteredLibrary('album2', true);
	const newCandidates = new Set(sb.songsFiltered);
	assert.ok(sb.playedFiltered.every(id => newCandidates.has(id)),
		'surviving played entries all belong to the new candidate set');
	assert.ok(sb.playedFiltered.length <= before.length);

	// A pick after the change is always within the new scope
	sb.Math.random = mulberry32(6);
	const id = sb.getRandom();
	assert.ok(newCandidates.has(id.toString()));
});

test('randomfiltered: filter narrowed to empty keeps safe stop, no stale references', () => {
	const sb = setup(10, 'randomfiltered');
	sb.buildFilteredLibrary('album1');
	sb.Math.random = mulberry32(11);
	sb.getRandom();
	sb.buildFilteredLibrary('nothing-matches', true);
	assert.equal(sb.playedFiltered.length, 0, 'played entries outside the new scope are pruned');
	assert.equal(sb.getRandom(), null);
});

test('mode switch: played sets stay scoped; switching back does not resurrect foreign ids', () => {
	const sb = setup(10, 'randomfiltered');
	sb.buildFilteredLibrary('album1');
	sb.Math.random = mulberry32(3);
	sb.getRandom();
	assert.equal(sb.played.length, 0);
	assert.ok(sb.playedFiltered.length > 0);

	// Switch to full-library random scope
	sb.cfg.after = 'randomlibrary';
	sb.markPlayed(sb.songs[7].id);
	assert.equal(sb.played.length, 1);
	assert.equal(sb.played[0], '7');
	// The filtered set is independent and still holds only filtered ids
	assert.ok(sb.playedFiltered.every(id => sb.songsFiltered.includes(id)));
});

test('reload: clearPlayed("reload") resets both played scopes', () => {
	const sb = setup(10);
	sb.markPlayed(1);
	sb.markPlayed(2);
	sb.playedFiltered.push('4', '5');
	sb.clearPlayed('reload');
	assert.equal(sb.played.length, 0);
	assert.equal(sb.playedFiltered.length, 0);
});

test('exhaustion then reset: a second round re-picks every song without duplicates', () => {
	const sb = setup(6, 'randomlibrary');
	sb.Math.random = mulberry32(2024);
	const first = new Set();
	for (let i = 0; i < 6; i++) first.add(sb.getRandom());
	assert.equal(first.size, 6);
	// Exhausted: next call internally clears played and returns a fresh pick
	const secondRound = sb.getRandom();
	assert.ok(secondRound != null && first.has(secondRound.toString()));
	assert.equal(sb.played.length, 1);
});

test('prepNext: exhausted/empty random candidates leave audio un-prepped (safe stop)', () => {
	const sb = setup(3, 'randomlibrary');
	sb.cfg.skip = ARTISTS.map(a => a.toLowerCase());
	sb.cfg.playlist.push({ path: sb.songs[0].path });
	sb.cfg.index = 0;
	sb.audio[+!sb.track].prepped = false;
	sb.prepNext();
	assert.equal(sb.audio[+!sb.track].prepped, false);
	assert.equal(sb.cfg.playlist.length, 1, 'nothing was enqueued');
});

test('prepNext: normal random continuation enqueues one in-scope song', () => {
	const sb = setup(8, 'randomlibrary');
	sb.cfg.playlist.push({ path: sb.songs[0].path });
	sb.cfg.index = 0;
	sb.Math.random = mulberry32(77);
	sb.prepNext();
	const prepped = sb.track ^ 1;	// prepNext always preps the other element
	assert.equal(sb.audio[prepped].prepped, true);
	assert.equal(sb.cfg.playlist.length, 2);
	const enqueuedIndex = sb.audio[prepped].index;
	// The prepped slot is the appended playlist item; its song is a played one
	assert.equal(enqueuedIndex, sb.cfg.playlist.length - 1);
	const enqueuedPath = sb.cfg.playlist[enqueuedIndex].path;
	const enqueuedId = sb.songs.findIndex(s => s.path == enqueuedPath).toString();
	assert.ok(sb.played.includes(enqueuedId), 'enqueued song is in the played set');
});

test('add: enqueued songs are recorded in the active scope and duplicates are rejected', () => {
	const sb = setup(6, 'randomfiltered');
	sb.buildFilteredLibrary('album1');
	for (const id of sb.songsFiltered) sb.add(id);
	assert.equal(sb.played.length, 0, 'library scope untouched while in filtered mode');
	sameMembers(sb.playedFiltered, sb.songsFiltered);
});

test('removeItem: deleting a non-playing item adjusts the cursor but keeps the highlight target valid', () => {
	const sb = setup(8);
	for (let i = 0; i < 5; i++) sb.add(i);
	sb.cfg.index = 3;
	const highlightedPath = sb.cfg.playlist[3].path;
	sb.drag = sb.dom.playlist.childNodes[1];	// remove item above cursor
	const event = { preventDefault() {}, stopPropagation() {} };
	sb.removeItem(event);
	assert.equal(sb.cfg.index, 2, 'cursor shifted down by one');
	assert.equal(sb.cfg.playlist[2].path, highlightedPath, 'cursor still points at the same song');
	assert.equal(sb._lastPlay, undefined, 'no playback restart for non-playing removal');
});

test('removeItem: deleting the current item moves highlight, cursor and playback together', () => {
	const sb = setup(8);
	for (let i = 0; i < 5; i++) sb.add(i);
	sb.cfg.index = 2;
	const successorPath = sb.cfg.playlist[3].path;
	sb.drag = sb.dom.playlist.childNodes[2];
	const event = { preventDefault() {}, stopPropagation() {} };
	sb.removeItem(event);
	assert.equal(sb.cfg.index, 2);
	assert.equal(sb.cfg.playlist[2].path, successorPath, 'cursor now points at the successor');
	assert.equal(sb._lastPlay, 2, 'playback jumped to the successor at the same index');
	assert.ok(sb.dom.playlist.childNodes[2].classList.contains('playing'), 'highlight follows the cursor');
});

test('removeItem: removing the last item resets the cursor and stops', () => {
	const sb = setup(4);
	sb.add(2);
	sb.cfg.index = 0;
	sb.drag = sb.dom.playlist.childNodes[0];
	const event = { preventDefault() {}, stopPropagation() {} };
	sb.removeItem(event);
	assert.equal(sb.cfg.playlist.length, 0);
	assert.equal(sb.cfg.index, -1, 'cursor reset to -1, no out-of-bounds index');
	assert.equal(sb._stopped, true);
});

test('removeItem: removed song drops out of the played sets and can be picked again', () => {
	const sb = setup(8, 'randomlibrary');
	for (let i = 0; i < 4; i++) sb.add(i);
	sameMembers(sb.played, ['0', '1', '2', '3']);
	const removedPath = sb.cfg.playlist[1].path;
	sb.cfg.index = 3;
	sb.drag = sb.dom.playlist.childNodes[1];
	sb.removeItem({ preventDefault() {}, stopPropagation() {} });
	assert.ok(!sb.played.includes('1'), 'removed id left the library played set');
	// The removed song is selectable again by random continuation
	sb.Math.random = mulberry32(31);
	const picks = new Set();
	for (let i = 0; i < sb.songs.length; i++) picks.add(String(sb.getRandom()));
	assert.ok(picks.has('1'), 'previously removed song is eligible again');
	assert.equal(removedPath, sb.songs[1].path);
});

test('clearPlaylist: empties playlist, resets cursor and both played sets', () => {
	const sb = setup(6);
	for (let i = 0; i < 4; i++) sb.add(i);
	sb.playedFiltered.push('9');
	sb.cfg.index = 2;
	sb.clearPlaylist();
	assert.equal(sb.cfg.playlist.length, 0);
	assert.equal(sb.cfg.index, -1);
	assert.equal(sb.played.length, 0);
	assert.equal(sb.playedFiltered.length, 0);
});

test('moveItem: drag reordering keeps cfg.index on the same song in every direction', () => {
	const sb = setup(8);
	for (let i = 0; i < 5; i++) sb.add(i);
	const pathAt = idx => sb.cfg.playlist[idx].path;

	// Drag the playing item down
	sb.cfg.index = 1;
	const movingPath = pathAt(1);
	const dragLi = sb.dom.playlist.childNodes[1];
	const toLi = sb.dom.playlist.childNodes[3];
	sb.moveItem(dragLi, toLi, 1, 3);
	assert.equal(sb.cfg.playlist[sb.cfg.index].path, movingPath);
	assert.equal(sb.cfg.index, 2);

	// Rebuild and drag an item below the cursor up
	sb.dom.playlist.childNodes.length = 0;
	sb.cfg.playlist.length = 0;
	for (let i = 0; i < 5; i++) sb.add(i);
	sb.cfg.index = 3;
	const anchorPath = pathAt(3);
	sb.moveItem(sb.dom.playlist.childNodes[4], sb.dom.playlist.childNodes[1], 4, 1);
	assert.equal(sb.cfg.playlist[sb.cfg.index].path, anchorPath);
	assert.equal(sb.cfg.index, 4);
});

test('load: out-of-bounds index is rejected instead of throwing', () => {
	const sb = setup(4);
	sb.cfg.playlist.push({ path: sb.songs[0].path });
	assert.doesNotThrow(() => sb.load(5));
	assert.equal(sb.audio[1].prepped, false);
	assert.doesNotThrow(() => sb.load(-1));
});

test('playNext: with nothing prepped and no continuation, it stops without touching playlist', () => {
	const sb = setup(4, 'stopplayback');
	sb.cfg.playlist.push({ path: sb.songs[0].path });
	sb.cfg.index = 0;
	sb.audio[0].prepped = false;
	sb.audio[1].prepped = false;
	assert.doesNotThrow(() => sb.playNext(true));
	assert.equal(sb.cfg.playlist.length, 1);
});

test('prunePlayed/unmarkPlayed: adjacent entries are all handled (reverse-splice regression)', () => {
	const sb = setup(6);
	sb.played.push('0', '1', '2', '3', '4', '5');
	// Keep only even candidates: three adjacent removals must not skip any
	sb.prunePlayed(sb.played, ['0', '2', '4']);
	sameMembers(sb.played, ['0', '2', '4']);
	// Unmarking two adjacent ids likewise removes both
	sb.unmarkPlayed(sb.played, ['2', '4']);
	sameMembers(sb.played, ['0']);
});

test('randomfiltered: songs outside the current filter can never be enqueued after narrowing', () => {
	const sb = setup(12, 'randomfiltered');
	sb.Math.random = mulberry32(555);
	sb.dom.filter.value = 'album';
	sb.filter();
	const wide = new Set(sb.songsFiltered);
	// Consume part of the wide candidate set
	for (let i = 0; i < 3; i++) sb.getRandom();
	// Narrow to album2: the played set must only retain in-scope entries,
	// and every subsequent pick must match album2
	sb.dom.filter.value = 'album2';
	sb.filter();
	assert.ok(sb.playedFiltered.every(id => sb.songsFiltered.includes(id)));
	for (let i = 0; i < sb.songsFiltered.length; i++) {
		const id = String(sb.getRandom());
		assert.ok(wide.has(id));
		assert.ok(sb.songs[id].path.toLowerCase().includes('album2'));
	}
});

test('end-to-end: filter change mid-session never enqueues an out-of-filter or repeated song', () => {
	const sb = setup(12, 'randomfiltered');
	sb.Math.random = mulberry32(888);
	sb.dom.filter.value = 'album1';
	sb.filter();
	assert.ok(sb.songsFiltered.length > 0);
	const seen = new Set();
	for (let i = 0; i < sb.songsFiltered.length; i++) {
		const id = sb.getRandom();
		assert.ok(sb.songsFiltered.includes(id.toString()));
		assert.ok(!seen.has(id), 'no duplicate enqueue within a cycle');
		seen.add(id);
		sb.cfg.playlist.push({ path: sb.songs[id].path });
		sb.cfg.index = sb.cfg.playlist.length - 1;
	}
	// Narrow the filter: candidates and played scope must reconcile
	sb.dom.filter.value = 'album2';
	sb.filter();
	assert.ok(sb.songsFiltered.every(id => sb.songs[id].path.toLowerCase().includes('album2')));
	assert.ok(sb.playedFiltered.every(id => sb.songsFiltered.includes(id)));
	const id = sb.getRandom();
	assert.ok(sb.songsFiltered.includes(id.toString()));
	assert.ok(sb.songs[id].path.toLowerCase().includes('album2'));
});
