/*
 * Node + jsdom test runner for Qwerty Hancock and JZZ.input.Qwerty.
 *
 * It loads the real, unmodified browser scripts (not mocks) inside a
 * jsdom window whose global object is the window itself - exactly like
 * a classic <script> tag in a real browser.
 *
 * Run: node tests/run-node.js
 */
'use strict';

var fs = require('fs'),
    path = require('path'),
    vm = require('vm'),
    JSDOM = require('jsdom').JSDOM,
    root = path.join(__dirname, '..');

var dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true
});

var window = dom.window,
    context = dom.getInternalVMContext();

// Count listeners attached to window/document so tests can prove cleanup.
var listenerTotals = { window: 0, document: 0 },
    listenerDetails = [];
function trackEventTarget(target, label) {
    var originalAdd = target.addEventListener,
        originalRemove = target.removeEventListener;

    target.addEventListener = function (type, listener, options) {
        listenerTotals[label]++;
        listenerDetails.push({ target: label, type: type, listener: listener });
        return originalAdd.call(this, type, listener, options);
    };
    target.removeEventListener = function (type, listener, options) {
        for (var i = listenerDetails.length - 1; i >= 0; i--) {
            if (listenerDetails[i].target === label &&
                listenerDetails[i].type === type &&
                listenerDetails[i].listener === listener) {
                listenerDetails.splice(i, 1);
                listenerTotals[label]--;
                break;
            }
        }
        return originalRemove.call(this, type, listener, options);
    };
}
trackEventTarget(window, 'window');
trackEventTarget(window.document, 'document');

function loadScript(relativePath) {
    var code = fs.readFileSync(path.join(root, relativePath), 'utf8');
    vm.runInContext(code, context, { filename: relativePath });
}

// Load the libraries exactly as the page does, as classic scripts.
loadScript('node_modules/jzz/javascript/JZZ.js');
loadScript('javascript/qwerty-hancock.js');
loadScript('javascript/JZZ.input.Qwerty.js');
loadScript('tests/scenarios.js');

var JZZ = window.JZZ,
    QwertyHancock = window.QwertyHancock,
    makeScenarios = window.QwertyHancockTestScenarios;

if (!JZZ || !QwertyHancock || !JZZ.input || !JZZ.input.Qwerty || !makeScenarios) {
    console.error('Failed to load libraries:', {
        JZZ: !!JZZ,
        QwertyHancock: !!QwertyHancock,
        input: !!(JZZ && JZZ.input && JZZ.input.Qwerty),
        scenarios: !!makeScenarios
    });
    process.exit(2);
}

var harness = {
    document: window.document,
    window: window,
    QwertyHancock: QwertyHancock,
    JZZ: JZZ,
    wait: function () { return flushTimers(); },
    listenerCount: function (target) {
        var label;
        if (target === window) {
            label = 'window';
        } else if (target === window.document) {
            label = 'document';
        } else {
            return 0;
        }
        // Exclude listeners added by JZZ's own (failing, in jsdom) engine
        // probes - they belong to JZZ, not to the code under test.
        return listenerDetails.filter(function (d) {
            return d.target === label && d.type !== 'jazz-midi-msg';
        }).length;
    }
};

function flushTimers() {
    return new Promise(function (resolve) {
        setTimeout(resolve, 30);
    });
}

async function main() {
    // Let JZZ finish its (failing-in-node) engine probes so the async
    // request queue is settled before virtual ports are opened.
    await flushTimers();

    var results = await makeScenarios(harness).run();

    await flushTimers();

    var failures = results.filter(function (r) { return !r.ok; }),
        skipped = results.filter(function (r) { return r.skipped; });

    results.forEach(function (r) {
        var mark = r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL'),
            suffix = (r.skipped || !r.ok) && r.detail ? '  -> ' + r.detail : '';
        console.log(mark + '  ' + r.name + suffix);
    });

    console.log('\n' + (results.length - failures.length - skipped.length) +
        ' passed, ' + skipped.length + ' skipped, ' +
        failures.length + ' failed (of ' + results.length + ' checks)');

    if (failures.length) {
        process.exitCode = 1;
    }

    // Sanity: nothing of ours left attached globally (JZZ's own internal
    // jazz-midi-msg probe listener is excluded - it is not ours to remove).
    var leftoverDetails = listenerDetails.filter(function (d) {
        return d.type !== 'jazz-midi-msg';
    });
    if (leftoverDetails.length !== 0) {
        console.error('ERROR: ' + leftoverDetails.length +
            ' global listener(s) still attached:');
        leftoverDetails.forEach(function (d) {
            console.error('  - ' + d.target + ' ' + d.type + ' ' +
                (d.listener.name || '(anonymous)'));
        });
        process.exitCode = 1;
    } else {
        console.log('Cleanup: no library listeners remain on window/document');
    }
}

main().catch(function (err) {
    console.error('Test runner crashed:', err);
    process.exit(2);
});
