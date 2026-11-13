export const example={cores:3,lines:2,words:2,memory:Array(16).fill(0),operations:[
 {kind:'read',core:0,address:0},
 {kind:'write',core:0,address:0,value:7},
 {kind:'read',core:1,address:1},
 {kind:'write',core:1,address:1,value:9},
 {kind:'read',core:0,address:0},
 {kind:'write',core:0,address:0,value:11},
 {kind:'write',core:0,address:4,value:42},
 {kind:'flush',core:0},
]};
function integer(value,min,max,label){if(!Number.isInteger(value)||value<min||value>max)throw Error(`${label} must be an integer from ${min} to ${max}.`);return value;}
export function validate(raw){
 if(!raw||typeof raw!=='object')throw Error('Expected a scenario object.');integer(raw.cores,2,4,'Cores');if(![1,2,4].includes(raw.lines))throw Error('Cache slots must be 1, 2, or 4.');if(![1,2,4].includes(raw.words))throw Error('Words per block must be 1, 2, or 4.');
 if(!Array.isArray(raw.memory)||raw.memory.length<4||raw.memory.length>32||raw.memory.length%raw.words)throw Error('Memory must contain 4–32 words and be divisible by the block size.');raw.memory.forEach(v=>integer(v,-999999,999999,'Memory value'));
 if(!Array.isArray(raw.operations)||raw.operations.length>200)throw Error('Use at most 200 operations.');
 const operations=raw.operations.map(op=>{
  if(!op||!['read','write','flush'].includes(op.kind))throw Error('Operation must be read, write, or flush.');integer(op.core,0,raw.cores-1,'Core');
  const allowed=op.kind==='flush'?['kind','core']:op.kind==='read'?['kind','core','address']:['kind','core','address','value'];if(Object.keys(op).sort().join(',')!==allowed.sort().join(','))throw Error('Unexpected or missing operation fields.');
  if(op.kind!=='flush')integer(op.address,0,raw.memory.length-1,'Address');if(op.kind==='write')integer(op.value,-999999,999999,'Write value');return {...op};
 });return {cores:raw.cores,lines:raw.lines,words:raw.words,memory:[...raw.memory],operations};
}
export function initial(input){return {memory:[...input.memory],caches:Array.from({length:input.cores},()=>Array.from({length:input.lines},()=>({state:'I',block:null,values:[]}))),stats:{reads:0,writes:0,hits:0,misses:0,BusRd:0,BusRdX:0,BusUpgr:0,writebacks:0,invalidations:0,evictions:0,silentUpgrades:0}};}
export function invariant(input,state,expected=null){
 const errors=[];
 for(let block=0;block<input.memory.length/input.words;block++){
  const copies=state.caches.flatMap((cache,core)=>cache.filter(line=>line.state!=='I'&&line.block===block).map(line=>({core,...line})));
  if(copies.some(l=>['M','E'].includes(l.state))&&copies.length!==1)errors.push(`Block ${block} has an exclusive owner and another valid copy.`);
  const current=copies.find(l=>l.state==='M')?.values||state.memory.slice(block*input.words,(block+1)*input.words);
  for(const line of copies){if(line.values.some((v,i)=>v!==current[i]))errors.push(`Block ${block} has inconsistent cached data.`);if(line.state!=='M'&&line.values.some((v,i)=>v!==state.memory[block*input.words+i]))errors.push(`Clean block ${block} differs from memory.`);}
  if(expected&&current.some((v,i)=>v!==expected[block*input.words+i]))errors.push(`Block ${block} differs from the sequential reference.`);
 }
 state.caches.forEach((cache,core)=>cache.forEach((line,slot)=>{if(line.state!=='I'&&(line.block%input.lines!==slot||line.values.length!==input.words))errors.push(`Core ${core} slot ${slot} violates placement or block length.`);}));
 return errors;
}
export function execute(input,previous,op){
 const state=structuredClone(previous),events=[],stats=state.stats;
 const record=(type,core,block,from,to,detail)=>events.push({type,core,block,from,to,detail});
 const writeback=(core,line,reason)=>{for(let i=0;i<input.words;i++)state.memory[line.block*input.words+i]=line.values[i];stats.writebacks++;record('Writeback',core,line.block,'M','M',`${reason}: publish [${line.values.join(', ')}] to memory.`);};
 if(op.kind==='flush'){
  for(const line of state.caches[op.core])if(line.state==='M'){writeback(op.core,line,'Explicit flush');line.state='E';record('Transition',op.core,line.block,'M','E','Retain a clean exclusive copy.');}
  if(!events.length)record('No-op',op.core,null,null,null,'No modified blocks to flush.');
  return {state,events,result:null,hit:null};
 }
 const block=Math.floor(op.address/input.words),offset=op.address%input.words,slot=block%input.lines,line=state.caches[op.core][slot],hit=line.state!=='I'&&line.block===block;
 stats[op.kind==='read'?'reads':'writes']++;stats[hit?'hits':'misses']++;
 const snoops=()=>state.caches.flatMap((cache,core)=>core===op.core?[]:cache.filter(l=>l.state!=='I'&&l.block===block).map(line=>({core,line})));
 const invalidate=()=>{for(const {core,line:other}of snoops()){const from=other.state;if(from==='M')writeback(core,other,'Ownership transfer');other.state='I';stats.invalidations++;record('Invalidate',core,block,from,'I','Invalidate the entire block, including neighboring words.');}};
 if(!hit){
  if(line.state!=='I'){if(line.state==='M')writeback(op.core,line,'Conflict eviction');stats.evictions++;record('Evict',op.core,line.block,line.state,'I',`Block ${block} maps to occupied slot ${slot}.`);}
  line.state='I';line.block=block;line.values=[];
  const bus=op.kind==='read'?'BusRd':'BusRdX';stats[bus]++;record(bus,op.core,block,'I',null,op.kind==='read'?'Request a shared read.':'Request data and exclusive ownership.');
  if(op.kind==='read'){
   const others=snoops();for(const {core,line:other}of others){const from=other.state;if(from==='M')writeback(core,other,'Read intervention');if(from!=='S'){other.state='S';record('Transition',core,block,from,'S','Another reader now shares this block.');}}
   line.values=state.memory.slice(block*input.words,(block+1)*input.words);line.state=others.length?'S':'E';record('Fill',op.core,block,'I',line.state,`Fill slot ${slot} with [${line.values.join(', ')}].`);
  }else{
   invalidate();line.values=state.memory.slice(block*input.words,(block+1)*input.words);line.state='M';record('Fill',op.core,block,'I','M',`Write-allocate block into slot ${slot}.`);
  }
 }else if(op.kind==='write'){
  if(line.state==='S'){stats.BusUpgr++;record('BusUpgr',op.core,block,'S',null,'Keep local data; request invalidation of other copies.');invalidate();line.state='M';record('Transition',op.core,block,'S','M','Shared copy becomes the sole modified owner.');}
  else if(line.state==='E'){line.state='M';stats.silentUpgrades++;record('Silent upgrade',op.core,block,'E','M','No bus request: this core already has the only valid copy.');}
 }
 let value=line.values[offset];
 if(op.kind==='write'){line.values[offset]=op.value;value=op.value;record('Write',op.core,block,line.state,line.state,`Address ${op.address} := ${op.value}. Main memory may remain stale.`);}
 else record('Read',op.core,block,line.state,line.state,`Address ${op.address} returns ${value}.`);
 return {state,events,result:value,hit};
}
export function analyze(raw){
 const input=validate(raw),reference=[...input.memory],snapshots=[{state:initial(input),events:[],result:null,hit:null,operation:null,invariants:[]}];
 for(const operation of input.operations){const next=execute(input,snapshots.at(-1).state,operation);if(operation.kind==='write')reference[operation.address]=operation.value;if(operation.kind==='read'&&next.result!==reference[operation.address])throw Error('Read disagrees with sequential memory.');const invariants=invariant(input,next.state,reference);if(invariants.length)throw Error(invariants.join(' '));snapshots.push({...next,operation,invariants});}
 return {input,snapshots,reference};
}
