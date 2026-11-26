"use strict";

/*
 * Console verification snippet for the running PulseQuaver application.
 *
 * Usage:
 *   1. Open the app (index.html) and create or load a song first.
 *   2. Open the browser developer console.
 *   3. Paste and run the whole contents of this file, then call:
 *
 *          runLiveDeleteSynthChecks()
 *
 * Unlike tests/delete-synth-tests.js (which builds isolated SongObject
 * fixtures), this snippet exercises the live application object end-to-end
 * and restores its exact state afterwards, including rebuilding any
 * instrument nodes it temporarily created.
 */
(function () {
	function assert(condition, message, results) {
		results.checks++;
		if (condition) {
			console.log("%c[PASS]%c " + message, "color:#4d6", "color:inherit");
		} else {
			results.failures++;
			console.log("%c[FAIL]%c " + message, "color:#f66", "color:inherit");
		}
	}

	function snapshotLayers(song) {
		return song.patterns.map(p =>
			p.patternData.map(layer => layer.synthIndex));
	}

	window.runLiveDeleteSynthChecks = function () {
		const song = window.songObject;
		if (!song) {
			console.error("%cLive songObject not found. Open a song first, or use " +
				"tests/delete-synth-tests.html for isolated fixture checks.", "color:#f66");
			return null;
		}

		const results = { checks: 0, failures: 0 };
		console.log("%c--- Live synth deletion checks ---", "color:#1ff");

		// Deep-copy everything the deletion chain mutates, so the live state
		// can be rebuilt byte-for-byte afterwards.
		const backup = {
			synthParams: JSON.parse(JSON.stringify(song.synthParams)),
			synthNames: song.synthNames.slice(),
			sends: song.sends.slice(),
			currentSynthIndex: song.currentSynthIndex,
			layerMap: snapshotLayers(song)
		};
		const originalCount = song.synths.length;

		try {
			// 1. Last-instrument guard: trim down to one synth, then reject
			while (song.synths.length > 1)
				song.deleteSynth(song.synths.length - 1);

			assert(song.synths.length === 1, "trimmed to a single synth", results);
			const rejected = song.deleteSynth(0);
			assert(rejected === false, "last synth deletion rejected (false)", results);
			assert(song.synths.length === 1, "synth array unchanged after rejection", results);

			// 2. Rebuild to three instruments and delete the middle one
			song.appendSynth("verify1");
			song.appendSynth("verify2");
			const initialCount = song.synths.length; // 3
			const deleteIndex = 1;
			song.currentSynthIndex = deleteIndex;

			const ok = song.deleteSynth(deleteIndex);
			assert(ok === true, "middle synth deletion accepted (true)", results);
			assert(song.synths.length === initialCount - 1, "synth count decreased by one", results);
			assert(song.synthNames.length === song.synths.length, "names realigned", results);
			assert(song.synthParams.length === song.synths.length, "params realigned", results);
			assert(song.sends.length === song.synths.length, "sends realigned", results);
			assert(song.currentSynthIndex === 1,
				"currentSynthIndex lands on a legal index after deletion", results);

			// 3. All pattern layer references must be null or within range
			let referencesValid = true;
			for (let pattern of song.patterns)
				for (let layer of pattern.patternData)
					if (layer.synthIndex !== null &&
						!(layer.synthIndex >= 0 && layer.synthIndex < song.synths.length))
						referencesValid = false;
			assert(referencesValid, "all pattern layer synthIndex values valid", results);

			// 4. Collision table geometry + playable length
			const fillWidthOk = song.synthFill.every(col => col.length === song.synths.length);
			assert(fillWidthOk, "synthFill rebuilt with the new synth count", results);
			assert(song.playableLength === song.calcSongLength(),
				"playableLength recalculated after deletion", results);

			// 5. Remaining sends still reference existing FX slots
			const sendsOk = song.sends.every(send =>
				send === null || (send >= 0 && send < song.pluginStates.length));
			assert(sendsOk, "remaining sends point at valid effect slots", results);

			if (typeof g_markCurrentSynth === "function")
				g_markCurrentSynth();
		} finally {
			// 6. Restore the exact original state
			for (let synth of song.synths)
				synth.destroy();

			song.synths = [];
			song.synthParams = [];
			song.synthNames = [];
			song.sends = [];

			for (let i = 0; i < backup.synthParams.length; i++)
				song.makeSynth(i, backup.synthNames[i], backup.synthParams[i]);

			song.sends = backup.sends.slice();
			song.restoreSends();
			song.currentSynthIndex = backup.currentSynthIndex;

			// Restore pattern layer assignments
			for (let p = 0; p < song.patterns.length; p++)
				for (let l = 0; l < song.patterns[p].patternData.length; l++)
					if (backup.layerMap[p] && backup.layerMap[p][l] !== undefined)
						song.patterns[p].patternData[l].synthIndex = backup.layerMap[p][l];

			song.calculateSynthFill();

			if (typeof g_markCurrentSynth === "function")
				g_markCurrentSynth();
		}

		assert(song.synths.length === originalCount,
			"original instrument count restored after checks", results);

		console.log(results.failures === 0
			? "%cAll live checks passed (" + results.checks + ")"
			: "%c" + results.failures + " check(s) failed",
			results.failures === 0 ? "color:#4d6" : "color:#f66");

		return results;
	};

	console.log("Ready: call runLiveDeleteSynthChecks() to verify the live app.");
})();
