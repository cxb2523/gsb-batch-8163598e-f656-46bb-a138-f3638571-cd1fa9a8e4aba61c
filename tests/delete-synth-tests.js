"use strict";

/*
 * Verification scenarios for the synthesizer deletion chain.
 *
 * The same scenarios run in two environments:
 *   1. Browser: open tests/delete-synth-tests.html (or run deleteSynthTests()
 *      from the console of the running app) - uses the real Tone.js engine.
 *   2. Node:    node tests/run-delete-synth-tests.js - uses a lightweight Tone
 *      stub that records audio-node connections, so the tests can assert that a
 *      destroyed instrument leaves no residual connections.
 *
 * Coverage:
 *   - delete a middle instrument (index remap / null-out)
 *   - delete the first instrument
 *   - delete an instrument referenced by several patterns and song sections
 *   - last-instrument deletion is rejected
 *   - sends stay aligned, stale sends are cleaned, FX slots are never rewired
 *   - synthFill collision table rebuilt with the new instrument count
 *   - playable song length recalculation and conflict detection after deletion
 *   - destroyed audio nodes leave no live connections
 */

function createDeleteSynthTests(env) {
	const { makeSongObject, assert, log, disposeSong, getNodeRegistry } = env;

	// Build a 4-instrument / 3-pattern / multi-section fixture.
	//   layers: pattern0 -> [0, 1, 2], pattern1 -> [1, 3], pattern2 -> [2, 0, 3]
	//   sends : [null, slot0, slot1, slot0]
	//   song  : pattern0 at bars 0..1, pattern1 at bar 2, pattern2 at bars 4..5
	function buildFixture() {
		const song = makeSongObject();

		song.appendSynth("synth0");
		song.appendSynth("synth1");
		song.appendSynth("synth2");
		song.appendSynth("synth3");

		// Two effect slots; several instruments send into them
		song.pluginStates = [
			{ name: "fxA", title: "FX-A", state: null },
			{ name: "fxB", title: "FX-B", state: null }
		];
		song.fxPlugins = [
			{ node: { id: "fx-node-0" }, destroy() { } },
			{ node: { id: "fx-node-1" }, destroy() { } }
		];
		song.sends = [null, 0, 1, 0];

		song.patterns = [];
		song.patterns.push(new Pattern("A1", song.barSteps));
		song.patterns.push(new Pattern("B1", song.barSteps));
		song.patterns.push(new Pattern("C1", 2 * song.barSteps));

		// pattern 0: layers on instruments 0, 1, 2
		let p0 = song.patterns[0];
		p0.patternData[0].synthIndex = 0;
		p0.patternData[0].notes[0] = "C4";
		p0.addLayer();
		p0.patternData[1].synthIndex = 1;
		p0.patternData[1].notes[1] = "D4";
		p0.addLayer();
		p0.patternData[2].synthIndex = 2;
		p0.patternData[2].notes[2] = "E4";

		// pattern 1: layers on instruments 1, 3 (instrument 1 reused)
		let p1 = song.patterns[1];
		p1.patternData[0].synthIndex = 1;
		p1.patternData[0].notes[0] = "F4";
		p1.addLayer();
		p1.patternData[1].synthIndex = 3;
		p1.patternData[1].notes[1] = "G4";

		// pattern 2: spans two bars, layers on 2, 0, 3
		let p2 = song.patterns[2];
		p2.patternData[0].synthIndex = 2;
		p2.patternData[0].notes[0] = "A4";
		p2.addLayer();
		p2.patternData[1].synthIndex = 0;
		p2.patternData[1].notes[1] = "Bb4";
		p2.addLayer();
		p2.patternData[2].synthIndex = 3;
		p2.patternData[2].notes[2] = "B4";

		// Arrange the patterns across sections of the song
		song.fillSong();
		song.song[0][0] = true; // pattern0 starts at bar 0 (1 bar long)
		song.song[2][1] = true; // pattern1 at bar 2
		song.song[4][2] = true; // pattern2 at bar 4 (2 bars long -> bars 4..5)

		song.setCurrentPattern(0);
		song.calculateSynthFill();
		return song;
	}

	function layerIndexes(song) {
		return song.patterns.map(p => p.patternData.map(layer => layer.synthIndex));
	}

	function assertIndexesInRange(song) {
		for (let pattern of song.patterns)
			for (let layer of pattern.patternData)
				assert(
					layer.synthIndex === null ||
					(layer.synthIndex >= 0 && layer.synthIndex < song.synths.length),
					"all layer synthIndex values are null or within synth range"
				);
	}

	function assertArraysAligned(song) {
		let n = song.synths.length;
		assert(song.synthNames.length === n, "synthNames aligned (" + n + ")");
		assert(song.synthParams.length === n, "synthParams aligned (" + n + ")");
		assert(song.sends.length === n, "sends aligned (" + n + ")");
		for (let i = 0; i < n; i++) {
			let send = song.sends[i];
			assert(
				send === null || (send >= 0 && send < song.pluginStates.length),
				"send of remaining synth " + i + " stays a valid FX slot"
			);
		}
		for (let col of song.synthFill)
			assert(col.length === n, "synthFill column width matches synth count");
	}

	function run() {
		log("=== Synth deletion verification ===");

		// ------------------------------------------------------------------
		// 1. Delete a MIDDLE instrument
		// ------------------------------------------------------------------
		log("[1] delete middle instrument (index 1)");
		{
			let song = buildFixture();
			let removed = song.synths[1];
			song.currentSynthIndex = 1;

			let ok = song.deleteSynth(1);
			assert(ok === true, "deleteSynth returns true");

			assert(song.synths.length === 3, "three synths remain");
			assert(song.synthNames.join(",") === "synth0,synth2,synth3",
				"remaining names kept in order");
			assert(song.currentSynthIndex === 1,
				"current selection falls back to legal index (deleted index -> same slot)");

			// sends: [null, 0, 1, 0] minus entry 1 -> [null, 1, 0]
			assert(JSON.stringify(song.sends) === "[null,1,0]",
				"sends rebuilt without the deleted entry, remaining slots preserved");

			// pattern layers: 0:[0,1,2] -> [0,null,1]; 1:[1,3] -> [null,2]; 2:[2,0,3] -> [1,0,2]
			assert(JSON.stringify(layerIndexes(song)) === "[[0,null,1],[null,2],[1,0,2]]",
				"every pattern layer remapped or nulled correctly");
			assertIndexesInRange(song);
			assertArraysAligned(song);

			// remaining instruments must still own their original parameters/mixer state
			assert(song.synthParams[0]["synth-pan"] !== undefined &&
				song.synthParams[1]["synth-pan"] !== undefined &&
				song.synthParams[2]["synth-pan"] !== undefined,
				"mixer params (volume/pan) still follow each remaining instrument");

			disposeSong(song);
			void removed;
		}

		// ------------------------------------------------------------------
		// 2. Delete the FIRST instrument
		// ------------------------------------------------------------------
		log("[2] delete first instrument (index 0)");
		{
			let song = buildFixture();
			song.currentSynthIndex = 3; // selection after the deleted index must shift

			let ok = song.deleteSynth(0);
			assert(ok === true, "deleteSynth returns true");
			assert(song.synthNames.join(",") === "synth1,synth2,synth3",
				"remaining names kept in order");
			assert(song.currentSynthIndex === 2,
				"selection after deleted index shifted down by one");

			// sends: [null, 0, 1, 0] minus entry 0 -> [0, 1, 0]
			assert(JSON.stringify(song.sends) === "[0,1,0]",
				"first send entry removed, following entries shifted");

			// 0:[0,1,2]->[null,0,1]; 1:[1,3]->[0,2]; 2:[2,0,3]->[1,null,2]
			assert(JSON.stringify(layerIndexes(song)) === "[[null,0,1],[0,2],[1,null,2]]",
				"first-instrument references nulled, later references shifted");
			assertIndexesInRange(song);
			assertArraysAligned(song);

			// Deleting while another instrument stays selected leaves it selected
			let song2 = buildFixture();
			song2.currentSynthIndex = 2;
			song2.deleteSynth(0);
			assert(song2.currentSynthIndex === 1,
				"non-deleted current selection simply shifts to its new position");
			disposeSong(song);
			disposeSong(song2);
		}

		// ------------------------------------------------------------------
		// 3. Delete an instrument referenced by several patterns AND sections
		//    (instrument 1 appears in pattern0 and pattern1; instrument 2 in
		//     pattern0 and the two-bar pattern2)
		// ------------------------------------------------------------------
		log("[3] delete instrument shared by multiple patterns/sections (index 2)");
		{
			let song = buildFixture();
			song.currentSynthIndex = 0; // unaffected selection

			let ok = song.deleteSynth(2);
			assert(ok === true, "deleteSynth returns true");
			assert(song.currentSynthIndex === 0, "selection before deleted index is untouched");

			// 0:[0,1,2]->[0,1,null]; 1:[1,3]->[1,2]; 2:[2,0,3]->[null,0,2]
			// (index 3 is greater than the deleted 2, so it shifts down to 2)
			assert(JSON.stringify(layerIndexes(song)) === "[[0,1,null],[1,2],[null,0,2]]",
				"references in every pattern and section resolved");
			assertIndexesInRange(song);
			assertArraysAligned(song);

			// Collision table width rebuilt for 3 instruments and content remapped
			let allWidthsOk = song.synthFill.every(col => col.length === 3);
			assert(allWidthsOk, "synthFill rebuilt for the new instrument count");

			// Instrument 1 still occupies bar 0 (pattern0) and bar 2 (pattern1)
			assert(song.synthFill[0][1] === true && song.synthFill[2][1] === true,
				"surviving instrument still marked in all its sections");
			// Instrument 3 shifted to index 2 and still fills bars 2, 4, 5
			assert(song.synthFill[2][2] === true &&
				song.synthFill[4][2] === true &&
				song.synthFill[5][2] === true,
				"shifted instrument fill markers follow its new index");

			disposeSong(song);
		}

		// ------------------------------------------------------------------
		// 4. Deleting the LAST instrument must be rejected
		// ------------------------------------------------------------------
		log("[4] last-instrument deletion is rejected");
		{
			let song = makeSongObject(); // starts with exactly one synth
			song.appendSynth("extra");
			song.deleteSynth(1);
			assert(song.synths.length === 1, "back to a single synth");

			let before = JSON.stringify(layerIndexes(song));
			let ok = song.deleteSynth(0);
			assert(ok === false, "deleteSynth rejects the last synth (false)");
			assert(song.synths.length === 1, "synth array untouched after rejection");
			assert(JSON.stringify(layerIndexes(song)) === before,
				"pattern layers untouched after rejection");
			assert(song.synthFill.every(col => col.length === 1),
				"synthFill untouched after rejection");
			disposeSong(song);
		}

		// ------------------------------------------------------------------
		// 5. Sends: deleted instrument removed, FX slots never rewired,
		//    stale slot references cleaned
		// ------------------------------------------------------------------
		log("[5] send routing and FX slot ownership");
		{
			let song = buildFixture();

			// Instrument 1 sends into FX slot 0; instrument 3 also sends there.
			// Deleting instrument 1 must not move slot 0 or touch other sends.
			let fxNode0 = song.fxPlugins[0].node;
			song.deleteSynth(1);
			assert(song.sends[0] === null && song.sends[1] === 1 && song.sends[2] === 0,
				"remaining sends keep pointing at their own effect slots");
			assert(song.fxPlugins[0].node === fxNode0,
				"effect slot node is shared and never reconnected to another instrument");
			assert(song.fxPlugins.length === 2, "effect slots themselves are untouched");

			// A stale send pointing past the available slots gets neutralized
			song.sends[0] = 99;
			song.deleteSynth(0);
			assert(song.sends.every(v => v === null || v < song.pluginStates.length),
				"out-of-range send cleaned up instead of routing into a wrong slot");

			disposeSong(song);
		}

		// ------------------------------------------------------------------
		// 6. Destroyed audio nodes leave no residual connections
		// ------------------------------------------------------------------
		log("[6] audio node cleanup");
		{
			let registry = getNodeRegistry();
			if (!registry) {
				log("  (node registry unavailable in this environment - skipped)");
			} else {
				let song = buildFixture();
				let victimNodes = registry.nodesOf(song.synths[1]);
				assert(victimNodes.length > 0, "victim instrument owns tracked audio nodes");

				song.deleteSynth(1);

				let leaked = victimNodes.filter(node =>
					registry.isConnected(node) && !registry.isDisposed(node));
				assert(leaked.length === 0,
					"no destroyed instrument node stays connected after deletion");

				let survivors = song.synths.flatMap(s => registry.nodesOf(s));
				let disposedSurvivors = survivors.filter(node => registry.isDisposed(node));
				assert(disposedSurvivors.length === 0,
					"nodes of surviving instruments are not disposed");

				disposeSong(song);
			}
		}

		// ------------------------------------------------------------------
		// 7. Playable song length recalculation after deletion
		// ------------------------------------------------------------------
		log("[7] song length recalculation");
		{
			let song = buildFixture();
			// pattern2 (2 bars) ends at bar 6 and only uses instruments 2, 0, 3
			let lengthBefore = song.calcSongLength();
			assert(lengthBefore === 6, "fixture song spans 6 bars before deletion");
			assert(song.playableLength === 6, "playableLength matches fixture");

			// Remove instrument 2: its layer in pattern2 is nulled, but pattern2
			// still has layers (0, 3), so length is preserved through remap.
			song.deleteSynth(2);
			assert(song.calcSongLength() === 6, "length preserved while pattern stays in use");
			assert(song.playableLength === 6, "playableLength recomputed after deletion");

			// Once the tail pattern loses every instrument AND is taken out of
			// the arrangement, the song length shrinks back to pattern1's end
			let p2 = song.patterns[2];
			p2.patternData.forEach(layer => { layer.synthIndex = null; });
			song.song[4][2] = false; // pattern2 started at bar 4
			song.song[5][2] = false;
			song.calculateSynthFill();
			assert(song.calcSongLength() === 3,
				"song length shrinks once the tail pattern is removed from the arrangement");
			assert(song.playableLength === 3,
				"playableLength follows the recalculated song length");

			disposeSong(song);
		}

		// ------------------------------------------------------------------
		// 8. Conflict detection after index remap
		// ------------------------------------------------------------------
		log("[8] collision/conflict detection after deletion");
		{
			let song = buildFixture();
			// Delete instrument 0: pattern2 keeps layers (2->1, 0->null, 3->2)
			// and pattern0 keeps (null, 1->0, 2->1). Rebuild first.
			song.deleteSynth(0);

			// Rebuild the expected fill independently from patterns + arrangement
			// and compare it cell-by-cell with song.synthFill
			let expected = song.song.map(() => new Array(song.synths.length).fill(false));
			for (let bar = 0; bar < song.song.length; bar++) {
				for (let patternIndex = 0; patternIndex < song.patterns.length; patternIndex++) {
					if (!song.song[bar][patternIndex])
						continue;

					let pattern = song.patterns[patternIndex];
					let patternBars = Math.ceil(pattern.length / song.barSteps);
					let indexes = [...new Set(pattern.patternData
						.map(layer => layer.synthIndex)
						.filter(index => index !== null))];

					for (let b = bar; b < bar + patternBars && b < expected.length; b++)
						for (let synthIndex of indexes)
							expected[b][synthIndex] = true;
				}
			}

			let matches = song.synthFill.length === expected.length &&
				song.synthFill.every((col, bar) =>
					col.length === song.synths.length &&
					col.every((value, synthIndex) => !!value === expected[bar][synthIndex]));
			assert(matches, "rebuilt synthFill exactly matches patterns and arrangement");

			// Place pattern0 (instruments 0 and 1 after remap) at bar 2 where
			// pattern1 already occupies instrument 0 -> must be reported as conflict
			assert(song.checkSynthConflict(0, 2) === true,
				"conflict still detected through remapped synth indexes");
			assert(song.checkSynthConflict(0, 8) === false,
				"empty section reports no conflict");

			disposeSong(song);
		}

		log("=== done ===");
	}

	return { run };
}

// Expose for browser usage; the Node runner imports this file directly.
if (typeof window !== "undefined")
	window.createDeleteSynthTests = createDeleteSynthTests;
