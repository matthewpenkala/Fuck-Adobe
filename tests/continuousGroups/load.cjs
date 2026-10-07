'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Read the published expression itself so tests cannot drift to a second copy.
function load() {
    const markdown = fs.readFileSync(path.join(__dirname, '../../Expressions/continuousGroups.md'), 'utf8');
    const source = markdown.match(/^~~~js\r?\n([\s\S]*?)^~~~\s*$/m)?.[1];
    if (!source || !/\bcgExpression\(\);\s*$/.test(source)) throw Error('Complete expression block not found');
    const core = source.replace(/\bcgExpression\(\);\s*$/, '');
    const names = [...core.matchAll(/^function (cg\w+)\(/gm)].map(m => m[1]);
    const context = vm.createContext({});
    const api = vm.runInContext(core + '\n({ CG, ' + names.join(',') + ' });', context);
    return { api, context, source, core };
}
function opts(api, changes = {}) { return { ...api.CG, ...changes }; }
function native(api, times, values, time) {
    if (time <= times[0]) return values[0];
    if (time >= times.at(-1)) return values.at(-1);
    let i = 0;
    while (i < times.length - 2 && time >= times[i + 1]) i++;
    return api.cgMix(values[i], values[i + 1], (time - times[i]) / (times[i + 1] - times[i]));
}
function analyze(api, times, values, changes = {}) {
    return api.cgAnalyze(times, values, time => native(api, times, values, time), opts(api, changes));
}
module.exports = { load, opts, native, analyze };
