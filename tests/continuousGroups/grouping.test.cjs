'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {load,analyze}=require('./load.cjs');
const f=load().api;
const t=[0,.9,1.8,5.8,6.7,7.6];
const circle=(times,omega)=>times.map(x=>[Math.cos(omega*x),Math.sin(omega*x)]);
const y=circle(t,.6);
const evidence=(times,values,index=2)=>analyze(f,times,values)[index];
function supported(record){
 assert.equal(record.split,false,JSON.stringify(record));
 assert.equal(record.model,'constant-turn');
 assert.ok(record.predictionResidual<1e-10,JSON.stringify(record));
}

test('independent observed flanks may accumulate beyond pi without erasing circle evidence',()=>{
 const croppedT=t.slice(1,-1),croppedY=y.slice(1,-1);
 supported(evidence(croppedT,croppedY,1));
 supported(evidence(t,y));
 // Each interval and each adjacent midpoint step is a short arc. The span
 // from the closest fitted left interval to the farthest right is > pi.
 const gaps=t.slice(1).map((x,k)=>x-t[k]);
 const midpoints=t.slice(1).map((x,k)=>(x+t[k])/2);
 assert.ok(gaps.every(h=>.6*h<Math.PI));
 assert.ok(midpoints.slice(1).every((m,k)=>.6*(m-midpoints[k])<Math.PI));
 assert.ok(.6*(midpoints.at(-1)-midpoints[1])>Math.PI);
});

test('two to four independently observed circle flanks support cumulative wraps',()=>{
 for(const count of [2,3,4]){
  const times=[0];for(let k=0;k<count;k++)times.push(times.at(-1)+.9);
  times.push(times.at(-1)+4);for(let k=0;k<count;k++)times.push(times.at(-1)+.9);
  supported(evidence(times,circle(times,.6),count));
 }
});

test('supported cumulative turn is invariant to time reversal and reflection',()=>{
 const tr=t.slice().reverse().map(x=>t.at(-1)-x),yr=y.slice().reverse();
 supported(evidence(tr,yr));
 supported(evidence(tr,yr.map(p=>[-p[0],p[1]])));
});

test('supported turn survives representable translation rotation and uniform rescaling',()=>{
 for(const timeScale of [.1,1,10])for(const valueScale of [.01,1,100])for(const angle of [.23,1.9]){
  const transformedY=y.map(p=>[
   3+valueScale*(p[0]*Math.cos(angle)-p[1]*Math.sin(angle)),
   -7+valueScale*(p[0]*Math.sin(angle)+p[1]*Math.cos(angle))
  ]);
  supported(evidence(t.map(x=>11+x*timeScale),transformedY));
 }
});

test('contradictory held-out flank still defeats an otherwise-perfect local circle',()=>{
 const values=y.map(p=>p.slice());values[0][0]+=3;
 const record=evidence(t,values);
 assert.equal(record.split,true);assert.ok(record.motionScore<.5);
});

test('antipodal outer headings do not invent a rotation plane',()=>{
 const record=evidence([0,1,5,6],[[0,0],[1,0],[1,4],[0,4]],1);
 assert.equal(record.split,true);assert.notEqual(record.model,'constant-turn');
});

test('inconsistent aliased central turn remains rejected by prediction residual',()=>{
 const times=[0,1,5,6],values=circle(times,40*Math.PI/180);
 const record=evidence(times,values,1);assert.equal(record.split,true);
});

test('non-affine turn evidence retains bounded authority against a huge gap',()=>{
 const times=[0,.9,1.8,21.8,22.7,23.6],values=circle(times,.1);
 const record=evidence(times,values);
 assert.equal(record.model,'constant-turn');assert.ok(record.predictionResidual<1e-10);
 assert.equal(record.split,true);assert.ok(record.logGapCredit<=Math.log(4));
});

test('per-interval half-turn guard remains active for helper inputs outside production window selection',()=>{
 // The normal collector only provides widths smaller than the candidate.
 // Direct helper input can exceed that contract: the last outer interval
 // spans a half-turn, while its observed average still has a finite heading.
 const gaps=[.9,.9,4,.9,10],times=[0];gaps.forEach(h=>times.push(times.at(-1)+h));
 const values=circle(times,.6);
 const record=f.cgMotionEvidence(2,gaps,values,[1,0],[3,4],[]);
 assert.notEqual(record.model,'constant-turn');
});

test('fully sample-aliased paths are not claimed to be uniquely recovered',()=>{
 // On this 0.1-second lattice, adding 20*pi radians/second completes an
 // integer number of unobserved turns between every pair of supplied keys.
 // Identical observable samples cannot justify different classifications.
 const aliased=circle(t,.6+20*Math.PI);
 y.forEach((p,k)=>p.forEach((v,d)=>assert.ok(Math.abs(v-aliased[k][d])<1e-12)));
 supported(evidence(t,aliased));
});

test('500 generated supported wraps keep prediction and reversal invariance',()=>{
 let seed=871293;const rng=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
 for(let c=0;c<500;c++){
  const count=2+c%3,gap=4,flank=.6+.39*rng(),times=[0];
  for(let k=0;k<count;k++)times.push(times.at(-1)+flank);
  times.push(times.at(-1)+gap);for(let k=0;k<count;k++)times.push(times.at(-1)+flank);
  const omega=(2.85+.25*rng())/(gap+flank),values=circle(times,omega);
  supported(evidence(times,values,count));
  supported(evidence(times.slice().reverse().map(x=>times.at(-1)-x),values.slice().reverse(),count));
 }
});
