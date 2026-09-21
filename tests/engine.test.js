#!/usr/bin/env node
'use strict';
/*
 * Spin Widget — engine tests.
 *
 * No dependencies, no build: run `npm test`.
 *
 * These tests pull the engine straight out of index.html rather than keeping a copy of it,
 * because index.html IS the app — a copy would drift and start passing while the real thing
 * was broken. Several sessions have edited that file in parallel, so the suite also asserts
 * that the blocks it needs are still present and still export what it expects; if someone
 * renames a marker the tests fail loudly instead of silently testing nothing.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(SRC, 'utf8');

function between(start, end, what){
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if(a < 0 || b < 0 || b <= a) throw new Error('Could not find the '+what+' block in index.html ("'+start+'" .. "'+end+'"). If the markers were renamed, update this test.');
  return html.slice(a + start.length, b);
}

const WANTED = ['ZONES','GOALS','STYLES','buildPlan','effort','quickPick','unitSec','guessMeta',
  'autoPlanClass','goalForPosition','arcOrder','songEnergy','recommendSongs','provisionalTrack',
  'classTargetSec','INTERVAL_SHAPES'];

// `const`/`let` at the top of a script stay in script scope and never become globals, so the
// engine is followed by an epilogue that hands its bindings out explicitly.
const engineSrc = [
  between('/*PLAN_START*/', '/*PLAN_END*/', 'plan engine'),
  between('// ---------- automatic class planning ----------', '// ---------- YouTube API loader ----------', 'class planning / arc / recommendations'),
  ';__api = {' + WANTED.map(n => n+':(typeof '+n+'!=="undefined"?'+n+':undefined)').join(',') + '};'
].join('\n');

// The engine expects a few things the page normally provides.
const sandbox = {
  console,
  clamp: (v,a,b) => Math.max(a, Math.min(b, v)),
  store: { classLen: 45 },
  _list: [],
  __api: null,
  mashupLabel: e => (e.sourceSongs && e.sourceSongs.length)
      ? e.sourceSongs.map(s => s.artist + ' - ' + s.title).join(' x ')
      : (e.displayTitle || '')
};
sandbox.tracks = () => sandbox._list;
sandbox.rebuild = t => { t.plan = sandbox.__api.buildPlan(t, t.opts); };
vm.createContext(sandbox);
vm.runInContext(engineSrc, sandbox, { filename: 'index.html:engine' });

const api = sandbox.__api || {};
const missing = WANTED.filter(n => api[n] === undefined);
if(missing.length) throw new Error('index.html no longer defines: '+missing.join(', ')+
  '\nThe engine moved or was renamed, so these tests would not be testing what they think they are.');

const {
  ZONES, GOALS, STYLES, buildPlan, effort, quickPick, unitSec, guessMeta,
  autoPlanClass, goalForPosition, arcOrder, songEnergy, recommendSongs,
  provisionalTrack, classTargetSec, INTERVAL_SHAPES
} = api;

// ---------- tiny harness ----------
let passed = 0; const failures = [];
function check(name, fn){
  try { fn(); passed++; }
  catch(e){ failures.push(name + '\n      ' + e.message); }
}
function eq(actual, expected, msg){
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if(a !== b) throw new Error((msg||'values differ')+'\n      expected: '+b+'\n      actual:   '+a);
}
function ok(cond, msg){ if(!cond) throw new Error(msg || 'expected truthy'); }

// ---------- fixtures ----------
const song = (o={}) => Object.assign({ uid:1, title:'Song', dur:210, bpm:120, genre:'Pop', offset:0, opts:null, plan:null }, o);
function makeClass(n, o={}){
  return Array.from({length:n}, (_,i) => song(Object.assign({ uid:i+1, title:'S'+i }, o)));
}
function planned(n, o={}){ const ts = makeClass(n,o); autoPlanClass(ts, true); return ts; }

// ---------- zones and goals ----------
check('five zones, ordered light to maximum', () => {
  eq(ZONES.map(z=>z.k), ['white','blue','green','yellow','red']);
});
check('every goal has a peak above its base, and interval defaults', () => {
  for(const [k,g] of Object.entries(GOALS)){
    ok(g.peak >= g.base, k+': peak should not sit below base');
    ok(g.work > 0 && g.rest > 0, k+': needs default work/rest seconds');
  }
});

// ---------- buildPlan integrity ----------
check('a plan covers the whole song with no gaps, overlaps or bad zones', () => {
  for(const style of Object.keys(STYLES)){
    for(const goal of Object.keys(GOALS)){
      for(const dur of [45, 95, 150, 210, 300, 420]){
        for(const bpm of [70, 100, 128, 155, 190]){
          const t = song({ dur, bpm });
          const p = buildPlan(t, { style, goal });
          const label = style+'/'+goal+' '+dur+'s@'+bpm+'bpm';
          ok(p.segs.length > 0, label+': produced no segments');
          ok(Math.abs(p.segs[0].start) < 1e-6, label+': first segment must start at 0');
          ok(Math.abs(p.segs[p.segs.length-1].end - p.D) < 1e-6, label+': last segment must end at the song end');
          p.segs.forEach((s,i) => {
            ok(s.end > s.start, label+': segment '+i+' has no duration');
            ok(Number.isInteger(s.z) && s.z >= 0 && s.z < ZONES.length, label+': segment '+i+' has zone '+s.z);
            ok(typeof s.label === 'string' && s.label.length, label+': segment '+i+' has no label');
            if(i) ok(Math.abs(s.start - p.segs[i-1].end) < 1e-6, label+': gap or overlap before segment '+i);
          });
        }
      }
    }
  }
});
check('a song offset shortens the planned time, it is not ignored', () => {
  const a = buildPlan(song({ dur:240, offset:0 }), { style:'interval', goal:'balanced' });
  const b = buildPlan(song({ dur:240, offset:30 }), { style:'interval', goal:'balanced' });
  eq(Math.round(a.D - b.D), 30, 'a 30s offset should remove 30s of plan');
});
check('a cool down never sends anyone into the red', () => {
  for(const dur of [90, 210, 400]){
    const p = buildPlan(song({ dur }), { style:'recover', goal:'cooldown' });
    ok(Math.max(...p.segs.map(s=>s.z)) <= 2, 'cool down reached zone '+Math.max(...p.segs.map(s=>s.z)));
  }
});
check('effort rises with intensity across goals', () => {
  const score = goal => effort(buildPlan(song({dur:240}), {style:'interval', goal}).segs).score;
  ok(score('cooldown') < score('endurance'), 'cool down should be easier than endurance');
  ok(score('endurance') < score('balanced'), 'endurance should be easier than balanced');
  ok(score('balanced') < score('high'), 'balanced should be easier than high intensity');
});
check('steps land on musical phrases of a usable length at any tempo', () => {
  // The engine deliberately doubles the bar count above 150bpm, so a phrase stays in the
  // same rough band instead of getting comically short on fast songs.
  for(const bpm of [60, 90, 120, 149, 150, 175, 200]){
    const u = unitSec(bpm);
    ok(u >= 8 && u <= 45, bpm+'bpm gives a '+u.toFixed(1)+'s phrase, outside a usable range');
  }
  ok(unitSec(90) > unitSec(140), 'within one bar count, a slower song should have longer phrases');
});
check('guessMeta reads a bpm out of a title when there is one', () => {
  eq(guessMeta('Some Banger 128 BPM', '').bpmSrc, 'title');
  eq(guessMeta('Some Banger 128 BPM', '').bpm, 128);
  eq(guessMeta('No numbers here', '').bpmSrc, 'guess');
});

// ---------- the automatic class arc ----------
check('the class opens easy and always lands on a cool down', () => {
  for(const n of [2,3,5,8,13,20]){
    eq(goalForPosition(n-1, n), 'cooldown', n+' songs: the last song must be a cool down');
    eq(goalForPosition(n-2, n), 'high', n+' songs: the second-to-last song is the big one');
    if(n > 3) eq(goalForPosition(0, n), 'endurance', n+' songs: the opener should be easy');
  }
});
check('goals only ever ramp upward through the body of the class', () => {
  const rank = { endurance:0, balanced:1, high:2 };
  const n = 16;
  const body = Array.from({length:n-2}, (_,i) => rank[goalForPosition(i, n)]);
  body.forEach((v,i) => { if(i) ok(v >= body[i-1], 'intensity dipped at position '+i+': '+body.join(',')); });
});
check('a single song still gets a real plan', () => {
  const ts = planned(1);
  ok(ts[0].plan && ts[0].plan.segs.length, 'one-song class produced no plan');
});
check('the class never repeats a workout style back to back', () => {
  for(const n of [5, 9, 13, 18]){
    const ts = planned(n, { dur:240, bpm:128, genre:'House / EDM' });
    for(let i=1;i<ts.length;i++){
      ok(ts[i].opts.style !== ts[i-1].opts.style, n+' songs: style repeated at position '+i+' ('+ts.map(t=>t.opts.style).join(',')+')');
    }
  }
});
check('interval timing varies song to song instead of one identical block', () => {
  const ts = planned(16, { dur:260, bpm:130, genre:'House / EDM' });
  const intervals = ts.filter(t => t.opts.style === 'interval');
  ok(intervals.length >= 2, 'expected several interval songs, got '+intervals.length);
  // Compare only within a single goal: the shapes differ between goals by definition, so
  // comparing across them would pass even if the per-song rotation were removed entirely.
  const byGoal = {};
  intervals.forEach(t => { (byGoal[t.opts.goal] = byGoal[t.opts.goal] || []).push(t.opts.workSec+'/'+t.opts.restSec); });
  const comparable = Object.entries(byGoal).filter(([,v]) => v.length >= 2);
  ok(comparable.length > 0, 'no goal had two interval songs to compare; cannot prove variation');
  comparable.forEach(([goal, splits]) => {
    ok(new Set(splits).size > 1, 'every '+goal+' interval song got the same split: '+splits.join(' '));
  });
  // and the splits must be real values, not silently undefined
  intervals.forEach(t => ok(t.opts.workSec > 0 && t.opts.restSec > 0, 'an interval song has no work/rest split'));
});
check('high intensity never arrives in the first half of the class', () => {
  // This is the invariant that actually keeps a race (which always rides zones 3-4, whatever
  // the goal says) out of the warm-up. The `late` guard in autoPlanClass is a belt-and-braces
  // backstop that is unreachable while this holds — if this check ever fails, that guard is
  // the thing standing between the class and a sprint as song two.
  for(const n of [5, 8, 13, 20]){
    for(let i = 0; i < Math.floor(n*0.5); i++){
      ok(goalForPosition(i, n) !== 'high', n+' songs: position '+i+' is high intensity, in the first half');
    }
  }
});
check('a race is never used as an opener or a warm-up song', () => {
  for(const n of [6, 11, 13, 20]){
    const ts = planned(n, { dur:300, bpm:150, genre:'Techno' });
    ts.forEach((t,i) => {
      if(t.opts.style === 'race') ok(i >= Math.floor(n*0.5), n+' songs: a race landed at position '+i+', in the first half');
    });
  }
});
check('a high-intensity sweep spends its time up top, not back down in the easy zones', () => {
  // A climb is allowed a short Recover tail after the summit; what matters is that the song
  // as a whole stays hard, which is what a full sweep to zone 1 used to ruin.
  for(const style of ['pyramid','climb']){
    for(const dur of [210, 300, 420]){
      const p = buildPlan(song({ dur }), { style, goal:'high' });
      const total = p.segs.reduce((a,s) => a + (s.end - s.start), 0);
      const working = p.segs.filter(s => s.z >= 2).reduce((a,s) => a + (s.end - s.start), 0);
      const pct = working / total;
      ok(pct >= 0.8, style+' at '+dur+'s spends only '+Math.round(pct*100)+'% of a high-intensity song at zone 2+');
      ok(Math.max(...p.segs.map(s=>s.z)) >= GOALS.high.peak, style+' at '+dur+'s never reaches the goal peak');
    }
  }
});
check('a song set by hand is left alone, and the force rebuild takes it back', () => {
  const ts = planned(8);
  ts[3].manual = true;
  ts[3].opts = { style:'timetrial', goal:'cooldown' };
  sandbox.rebuild(ts[3]);
  const pinned = JSON.stringify(ts[3].opts);
  autoPlanClass(ts);
  eq(JSON.stringify(ts[3].opts), pinned, 'a pinned song was re-planned anyway');
  autoPlanClass(ts, true);
  eq(ts[3].manual, false, 'the force rebuild should clear the pin');
});
check('re-planning the same class twice gives the same answer', () => {
  const a = planned(13, { dur:230, bpm:124 });
  const shape = a.map(t=>t.opts.style+'/'+t.opts.goal).join('|');
  autoPlanClass(a, true);
  eq(a.map(t=>t.opts.style+'/'+t.opts.goal).join('|'), shape, 'planning is not deterministic');
});
check('an empty class does not throw', () => { autoPlanClass([], true); });

// ---------- the arc ----------
check('the arc puts the biggest song second-to-last and lands on the gentlest', () => {
  const ts = [
    song({ uid:1, title:'gentle',  bpm:92,  genre:'R&B' }),
    song({ uid:2, title:'mid',     bpm:118, genre:'Pop' }),
    song({ uid:3, title:'banger',  bpm:150, genre:'Techno' }),
    song({ uid:4, title:'mid2',    bpm:122, genre:'Pop' }),
    song({ uid:5, title:'build',   bpm:132, genre:'House / EDM' })
  ];
  const out = arcOrder(ts);
  const energies = out.map(songEnergy);
  eq(out[out.length-2].title, 'banger', 'the most explosive song should be second-to-last');
  eq(out[out.length-1].title, 'gentle', 'the gentlest song should land the class');
  const ramp = energies.slice(0, -2);
  ramp.forEach((v,i) => { if(i) ok(v >= ramp[i-1], 'the build should rise: '+ramp.map(x=>x.toFixed(2)).join(',')); });
});
check('the arc keeps every song and invents none', () => {
  const ts = makeClass(9).map((t,i) => song({ uid:i+1, title:'S'+i, bpm:90+i*8 }));
  const out = arcOrder(ts);
  eq(out.length, ts.length, 'song count changed');
  eq(out.map(t=>t.uid).sort((a,b)=>a-b), ts.map(t=>t.uid).sort((a,b)=>a-b), 'the set of songs changed');
});
check('the arc leaves a one or two song class alone', () => {
  for(const n of [0,1,2]){
    const ts = makeClass(n);
    eq(arcOrder(ts).map(t=>t.uid), ts.map(t=>t.uid), n+' songs should be returned untouched');
  }
});
check('faster and more danceable songs score as higher energy', () => {
  ok(songEnergy(song({bpm:150})) > songEnergy(song({bpm:100})), 'tempo should raise energy');
  ok(songEnergy(song({bpm:120, genre:'House / EDM'})) > songEnergy(song({bpm:120, genre:'R&B'})), 'genre should matter at equal tempo');
});
check('the class length target is read back in seconds and kept sane', () => {
  sandbox.store.classLen = 45; eq(classTargetSec(), 2700);
  sandbox.store.classLen = 5;  ok(classTargetSec() >= 600, 'a silly small target should be clamped up');
  sandbox.store.classLen = 999; ok(classTargetSec() <= 7200, 'a silly large target should be clamped down');
  sandbox.store.classLen = 45;
});

// ---------- recommendations ----------
const catalogue = [
  { id:'c1', displayTitle:'Rave Cave',   tags:['techno'],  sourceSongs:[] },
  { id:'c2', displayTitle:'Slow Burn',   tags:['r&b'],     sourceSongs:[] },
  { id:'c3', displayTitle:'Peak Hour',   tags:['edm'],     sourceSongs:[] },
  { id:'c4', displayTitle:'Sunday Drive',tags:['country'], sourceSongs:[] },
  { id:'c5', displayTitle:'Pop Rocket',  tags:['pop'],     sourceSongs:[] }
];
check('recommendations never repeat and never re-offer what is already in the class', () => {
  const inClass = [ song({ uid:1, catalogId:'c1' }), song({ uid:2, catalogId:'c3' }) ];
  const recs = recommendSongs(catalogue, inClass, 900);
  ok(recs.length > 0, 'expected some recommendations');
  eq(new Set(recs.map(r=>r.entry.id)).size, recs.length, 'the same song was offered twice');
  recs.forEach(r => ok(!['c1','c3'].includes(r.entry.id), r.entry.id+' is already in the class'));
});
check('the peak suggestion is the hardest thing available, not merely a notch up', () => {
  const inClass = [ song({ uid:1, bpm:110, genre:'Pop' }) ];
  const recs = recommendSongs(catalogue, inClass, 900);
  const hardest = catalogue
    .map(e => ({ e, en: songEnergy(provisionalTrack(e)) }))
    .sort((a,b) => b.en - a.en)[0].e.id;
  eq(recs[0].entry.id, hardest, 'the first pick should be the hardest available song');
  ok(/peak/.test(recs[0].reason), 'it should say it is for the peak, got: '+recs[0].reason);
});
check('the last suggestion is something gentle to land on', () => {
  const recs = recommendSongs(catalogue, [song({uid:1, bpm:120})], 900);
  const gentlest = catalogue
    .map(e => ({ e, en: songEnergy(provisionalTrack(e)) }))
    .sort((a,b) => a.en - b.en)[0].e.id;
  eq(recs[recs.length-1].entry.id, gentlest, 'the last pick should be the gentlest available song');
  ok(/land the class/.test(recs[recs.length-1].reason), 'it should say it lands the class');
});
check('an exhausted library recommends nothing rather than repeating itself', () => {
  const inClass = catalogue.map((e,i) => song({ uid:i+1, catalogId:e.id }));
  eq(recommendSongs(catalogue, inClass, 900), []);
});
check('recommendations work for an empty class', () => {
  ok(recommendSongs(catalogue, [], 2700).length > 0, 'an empty class should still get suggestions');
});
check('a bigger gap asks for more songs than a small one', () => {
  const few = recommendSongs(catalogue, [song({uid:1})], 0).length;
  const many = recommendSongs(catalogue, [song({uid:1})], 1200).length;
  ok(many >= few, 'a short class should not be offered fewer songs than a full one');
});

// ---------- red cap, ring of fire / tunnel, time trial and race changes ----------
check('a self-planned time trial never rides all red — it tops out at yellow', () => {
  for(const dur of [120, 180, 240, 300]){
    for(const bpm of [130, 150, 170]){
      const p = buildPlan(song({dur,bpm}), {style:'timetrial', goal:'high'});
      ok(Math.max(...p.segs.map(s=>s.z)) <= 3, dur+'s@'+bpm+'bpm: an unset time trial reached red');
    }
  }
});
check('a manually-set red time trial still gets the last-15s white cooldown tail', () => {
  const p = buildPlan(song({dur:240,bpm:130}), {style:'timetrial', goal:'high', ttZone:4});
  const last = p.segs[p.segs.length-1];
  eq(last.z, 0, 'the final segment of a long time trial should be white');
  ok(last.end - last.start <= 20 && last.end - last.start >= 10, 'the white tail should be roughly 15s, got '+(last.end-last.start).toFixed(1));
});
check('a long red segment gets capped into red, ring of fire, tunnel, then a drop back down', () => {
  const p = buildPlan(song({dur:300,bpm:120}), {style:'timetrial', goal:'high', ttZone:4});
  const reds = p.segs.filter(s=>s.z===4 && !s.effect);
  reds.forEach(s => ok(s.end-s.start <= 35, 'a plain-red stretch ran '+(s.end-s.start).toFixed(1)+'s, expected it capped near 30s'));
  const fire = p.segs.find(s=>s.effect==='fire'), tunnel = p.segs.find(s=>s.effect==='tunnel');
  ok(fire, 'expected a ring-of-fire segment on a long red plan');
  ok(tunnel, 'expected a tunnel segment on a long red plan');
  ok(fire.end-fire.start <= 20, 'ring of fire should be capped near 15s');
  ok(tunnel.end-tunnel.start <= 20, 'tunnel should be capped near 15s');
  const afterTunnel = p.segs[p.segs.indexOf(tunnel)+1];
  if(afterTunnel) ok(afterTunnel.z <= 1, 'after the tunnel it should drop back to a much lower color, got zone '+afterTunnel.z);
});
check('a short red stretch is left alone (nothing to cap)', () => {
  const p = buildPlan(song({dur:60,bpm:120}), {style:'timetrial', goal:'high', ttZone:4});
  ok(!p.segs.some(s=>s.effect), 'a short time trial should not trigger ring of fire / tunnel');
});
check('a race is one continuous spectrum segment for the whole song, no intervals', () => {
  for(const dur of [120, 210, 300]){
    const p = buildPlan(song({dur, bpm:150}), {style:'race', goal:'high'});
    eq(p.segs.length, 1, 'a race should be a single segment');
    ok(p.segs[0].race, 'the race segment should be flagged race');
  }
});
check('interval cues are left to the instructor — no prescriptive voice lines', () => {
  const p = buildPlan(song({dur:300,bpm:128}), {style:'interval', goal:'balanced'});
  const cues = p.segs.map(s=>s.cue).filter(Boolean);
  ok(!cues.some(c=>/find your rhythm|push!|ease off and breathe/i.test(c)), 'a removed coaching cue is still present: '+cues.join(', '));
});
check('a 20/10 interval shape is available for high-intensity songs', () => {
  const shapes = INTERVAL_SHAPES.high.map(([w,r])=>w+'/'+r);
  ok(shapes.includes('20/10'), 'expected a 20/10 shape in INTERVAL_SHAPES.high, got: '+shapes.join(', '));
});

// ---------- report ----------
if(failures.length){
  console.error('\n  ' + failures.length + ' failing, ' + passed + ' passing\n');
  failures.forEach((f,i) => console.error('  ' + (i+1) + ') ' + f + '\n'));
  process.exit(1);
}
console.log('\n  ' + passed + ' passing — engine checks out against index.html\n');
