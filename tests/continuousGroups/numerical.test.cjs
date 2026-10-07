'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { load, opts } = require('./load.cjs');
const candidate = load();
const f = candidate.api;
const modes = ['shape', 'shapeC2', 'smooth'];
function close(actual, expected, tolerance = 3e-13) {
    assert.ok(Number.isFinite(actual), `Expected finite ${expected}; got ${actual}`);
    assert.ok(Math.abs(actual / expected - 1) <= tolerance,
        `Expected ${expected}; got ${actual}`);
}
function group(t, times, values, changes, api=f) {
    return api.cgGroup(t, times, values, 0, times.length - 1, opts(api, changes));
}
function adapter(times, values, t, native, changes) {
    const settings = opts(f, changes);
    const context = vm.createContext({
        numKeys: times.length,
        value: native,
        time: t,
        key: i => ({ time: times[i-1], value: values[i-1] }),
        thisProperty: { valueAtTime: () => native }
    });
    return vm.runInContext(candidate.core + '\nObject.assign(CG,' + JSON.stringify(settings) + ');\ncgExpression();', context);
}
test('representable endpoint-relative excess survives opposite-sign difference overflow in all modes', () => {
    const times=[0,.5,1], normalized=[-1,0,1], values=normalized.map(v=>v*1e308);
    for(const interpolation of modes) for(const t of [.125,.25,.375,.625,.75,.875]) {
        const changes={curve:[.5,-.25,.5,1.25],interpolation,gapRatio:0};
        const reference=group(t,times,normalized,changes)*1e308;
        close(group(t,times,values,changes),reference);
        close(adapter(times,values,t,-123,changes),reference);
    }
});
test('zero corrected excess does not multiply an overflowing endpoint difference', () => {
    // For Y=[-.25,1.25], the symmetric interior point at .5 is also a knot.
    // Shift the knot so .5 exercises a zero excess inside a segment instead.
    const times=[0,.25,.75,1], values=[-1e308,-5e307,5e307,1e308];
    for(const interpolation of modes) {
        const changes={curve:[.5,-.25,.5,1.25],interpolation,gapRatio:0};
        const reference=group(.5,times,values.map(v=>v/1e308),changes)*1e308;
        const actual=group(.5,times,values,changes);
        assert.ok(Number.isFinite(actual));
        assert.ok(Math.abs(actual-reference)<1e295);
    }
});
test('closed loops suppress endpoint-relative excess even when excess correction overflows', () => {
    const times=[0,.1,1],values=[0,1,0];
    for(const interpolation of modes) for(const curve of [[.5,1e308,.5,1e308],[.5,-1e308,.5,1e308],[.5,-1e308,.5,-1e308]]) {
        const actual=group(.3,times,values,{curve,interpolation});
        const carrier=f.cgCarrierCurve(curve);
        const reference=group(.3,times,values,{curve:carrier,interpolation});
        assert.ok(Number.isFinite(actual));
        assert.equal(actual,reference);
    }
});
test('huge finite handles and tiny endpoint displacement recover a representable excess correction', () => {
    const times=[0,.1,1],values=[0,1e-308,2e-308],curve=[.5,1e308,.5,1e308];
    const samples=times.map(t=>f.cgCurveSample(t,curve));
    const x=samples.map(s=>s.carrier), normalizedDeltas=samples.map(s=>s.delta/1e308);
    for(const interpolation of modes)for(const t of [.05,.2,.3,.5,.8]) {
        const current=f.cgCurveSample(t,curve),segment=current.carrier>x[1]?1:0;
        // Natural cubic is homogeneous in its ordinate units. Solve the same
        // correction in 1e308 units before multiplying by the tiny displacement.
        const correction=f.cgSplineValue(x,normalizedDeltas,segment,current.carrier,'smooth');
        const normalizedExcess=current.delta/1e308-correction;
        const base=f.cgSplineValue(x,values,segment,current.carrier,interpolation);
        const reference=base+normalizedExcess*((values[2]-values[0])*1e308);
        const changes={curve,interpolation,gapRatio:0};
        close(group(t,times,values,changes),reference,1e-12);
        close(adapter(times,values,t,-123,changes),reference,1e-12);
    }
});
test('sparse malformed native arrays are not sampled-rest equality evidence', () => {
    const sparse=new Array(2);
    assert.equal(f.cgEqual(sparse,[1,2]),false);
    const records=f.cgAnalyze([0,1,2,3],[[0,0],[1,2],[1,2],[3,4]],()=>sparse,opts(f,{gapRatio:0}));
    assert.equal(records[1].split,false);
    assert.equal(records[1].reason,'moving');
});
test('scaled excess addition recovers overflow followed by representable cancellation', () => {
    const cases=[
        {base:-1e308,first:0,last:1e308,excess:2,expected:1e308},
        {base:1e308,first:0,last:-1e308,excess:2,expected:-1e308},
        {base:-1e308,first:-1e308,last:1e308,excess:1,expected:1e308},
        {base:1e308,first:-1e308,last:1e308,excess:-1,expected:-1e308},
        {base:-Number.MAX_VALUE,first:-Number.MAX_VALUE,last:Number.MAX_VALUE,excess:1,expected:Number.MAX_VALUE},
        {base:Number.MAX_VALUE,first:-Number.MAX_VALUE,last:Number.MAX_VALUE,excess:-1,expected:-Number.MAX_VALUE}
    ];
    for(const c of cases) {
        assert.ok(!Number.isFinite(c.base+(c.last-c.first)*c.excess));
        close(f.cgAddExcess(c.base,c.first,c.last,c.excess),c.expected,2e-15);
    }
});
test('zero excess and equal endpoints preserve subnormal base without scaling', () => {
    assert.equal(f.cgAddExcess(Number.MIN_VALUE,-Number.MAX_VALUE,Number.MAX_VALUE,0),Number.MIN_VALUE);
    assert.equal(f.cgAddExcess(Number.MIN_VALUE,Number.MAX_VALUE,Number.MAX_VALUE,NaN),Number.MIN_VALUE);
    assert.equal(f.cgAddExcess(-0,-Number.MAX_VALUE,Number.MAX_VALUE,0),-0);
});
test('unrepresentable excess output remains an explicit nonfinite failure', () => {
    assert.equal(f.cgAddExcess(Number.MAX_VALUE,0,Number.MAX_VALUE,1),Infinity);
    assert.equal(f.cgAddExcess(-Number.MAX_VALUE,0,-Number.MAX_VALUE,1),-Infinity);
    assert.ok(Number.isNaN(f.cgAddExcess(1,0,1,NaN)));
});
test('ordinary finite excess addition retains the original arithmetic fast path', () => {
    for (const base of [-1e20, -100, 0, 3, 1e20])
    for (const first of [-1000, 0, 2, 1000])
    for (const last of [-800, -2, 0, 800])
    for (const excess of [-.25, .01, .25, 2]) {
        if (first === last) continue;
        assert.equal(f.cgAddExcess(base, first, last, excess), base + (last - first) * excess);
    }
});
