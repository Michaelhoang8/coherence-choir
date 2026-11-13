import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze,example,initial,invariant,execute,validate} from '../core.js';
const config={cores:2,lines:2,words:1,memory:Array(8).fill(0),operations:[]};
const read=(core,address)=>({kind:'read',core,address}),write=(core,address,value)=>({kind:'write',core,address,value}),flush=core=>({kind:'flush',core});
const run=operations=>analyze({...config,operations});
test('first read fills exclusive and a local write silently upgrades without memory publication',()=>{
 const a=run([read(0,0),write(0,0,7)]);assert.equal(a.snapshots[1].state.caches[0][0].state,'E');const s=a.snapshots[2].state;assert.equal(s.caches[0][0].state,'M');assert.equal(s.memory[0],0);assert.equal(s.stats.BusRd,1);assert.equal(s.stats.BusRdX,0);assert.equal(s.stats.silentUpgrades,1);
});
test('another reader intervenes on modified data and both copies become shared',()=>{
 const a=run([write(0,0,7),read(1,0)]),s=a.snapshots.at(-1);assert.equal(s.result,7);assert.equal(s.state.memory[0],7);assert.deepEqual(s.state.caches.map(c=>c[0].state),['S','S']);assert.equal(s.state.stats.writebacks,1);
});
test('shared write upgrades ownership and invalidates other copies',()=>{
 const a=run([read(0,0),read(1,0),write(1,0,9)]),s=a.snapshots.at(-1).state;assert.deepEqual(s.caches.map(c=>c[0].state),['I','M']);assert.equal(s.stats.BusUpgr,1);assert.equal(s.stats.invalidations,1);assert.equal(s.memory[0],0);
});
test('write miss transfers modified ownership and preserves untouched block words',()=>{
 const a=analyze({...config,words:2,operations:[write(0,0,7),write(1,1,9),read(1,0)]}),s=a.snapshots.at(-1);assert.equal(s.result,7);assert.deepEqual(s.state.caches[1][0].values,[7,9]);assert.equal(s.state.stats.writebacks,1);assert.equal(s.state.memory[0],7);assert.equal(s.state.memory[1],0);
});
test('direct-mapped conflicts write back modified blocks before filling replacements',()=>{
 const a=run([write(0,0,11),write(0,2,22)]),s=a.snapshots.at(-1).state;assert.equal(s.memory[0],11);assert.equal(s.memory[2],0);assert.equal(s.caches[0][0].block,2);assert.equal(s.stats.evictions,1);assert.equal(s.stats.writebacks,1);
});
test('clean eviction is silent and remaining shared owner need not become exclusive',()=>{
 const a=run([read(0,0),read(1,0),read(0,2)]),s=a.snapshots.at(-1).state;assert.equal(s.caches[1][0].state,'S');assert.equal(s.stats.writebacks,0);assert.equal(s.stats.evictions,1);
});
test('neighboring-word writes cause false sharing only when grouped in the same block',()=>{
 const operations=[read(0,0),read(1,1),write(0,0,1),write(1,1,2)];const shared=analyze({...config,words:2,operations}).snapshots.at(-1).state.stats,separate=run(operations).snapshots.at(-1).state.stats;
 assert.equal(separate.invalidations,0);assert(shared.invalidations>0);assert.equal(separate.silentUpgrades,2);
});
test('explicit flush publishes dirty data and retains exclusive ownership',()=>{
 const a=run([write(0,0,5),flush(0),flush(0)]);assert.equal(a.snapshots[2].state.memory[0],5);assert.equal(a.snapshots[2].state.caches[0][0].state,'E');assert.equal(a.snapshots[3].events[0].type,'No-op');assert.equal(a.snapshots[3].state.stats.writebacks,1);
});
test('historical snapshots do not mutate and replay is deterministic',()=>{
 const a=analyze(example),b=analyze(example);assert.deepEqual(a,b);assert(a.snapshots[0].state.caches.flat().every(l=>l.state==='I'));assert.equal(a.snapshots[2].state.memory[0],0);assert.equal(a.snapshots.at(-1).state.memory[0],11);assert.equal(a.snapshots.at(-1).state.memory[1],9);assert.equal(a.snapshots.at(-1).state.memory[4],42);
});
let seed=127;const random=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%n;};
test('120 randomized 200-operation histories match sequential memory after every operation',()=>{
 for(let trial=0;trial<120;trial++){
  const input={cores:2+random(3),lines:[1,2,4][random(3)],words:[1,2,4][random(3)],memory:Array.from({length:16},()=>random(20)-10),operations:[]};
  for(let i=0;i<200;i++){const core=random(input.cores),address=random(16),kind=random(10);input.operations.push(kind<4?read(core,address):kind<9?write(core,address,random(100)-50):flush(core));}
  const result=analyze(input),reference=[...input.memory];
  result.snapshots.slice(1).forEach((snap,i)=>{const op=input.operations[i];if(op.kind==='write')reference[op.address]=op.value;if(op.kind==='read')assert.equal(snap.result,reference[op.address]);assert.deepEqual(invariant(input,snap.state,reference),[]);assert.equal(snap.state.stats.hits+snap.state.stats.misses,snap.state.stats.reads+snap.state.stats.writes);});
  let state=result.snapshots.at(-1).state;for(let core=0;core<input.cores;core++)state=execute(input,state,flush(core)).state;assert.deepEqual(state.memory,reference);
 }
});
test('invariant checker detects illegal ownership and stale clean copies',()=>{
 const s=initial(config);s.caches[0][0]={state:'M',block:0,values:[1]};s.caches[1][0]={state:'S',block:0,values:[0]};assert(invariant(config,s).some(x=>x.includes('exclusive')));assert(invariant(config,s).some(x=>x.includes('inconsistent')));
 s.caches[0][0].state='I';s.caches[1][0].values=[9];assert(invariant(config,s).some(x=>x.includes('Clean')));
});
test('configuration and operation bounds reject ambiguous scenarios',()=>{
 for(const patch of [{cores:1},{lines:3},{words:3},{memory:[0,0,0]},{operations:[read(2,0)]},{operations:[write(0,0,Infinity)]},{operations:[{kind:'flush',core:0,address:0}]},{operations:Array(201).fill(read(0,0))}])assert.throws(()=>validate({...config,...patch}));
});
