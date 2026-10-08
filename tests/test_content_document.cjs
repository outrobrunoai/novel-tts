const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function load(){
  const context={console,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','content-document.js'),'utf8'),context);
  return context.NovelLocalReader.contentDocument;
}
function element(text, children=[], extra={}){
  const node={innerText:text,textContent:text,children,ownerDocument:null,...extra};
  node.querySelectorAll=(selector)=>selector==='p'?children:[];
  node.closest=(selector)=>node.closestMap?.[selector]||null;
  node.contains=(candidate)=>candidate===node||children.includes(candidate);
  return node;
}

test('document snapshots preserve order and element association',()=>{
  const api=load();
  const first=element('First paragraph.'); const second=element('Second paragraph.');
  const root=element('',[first,second]); const document={body:root,querySelectorAll:()=>[root],querySelector:()=>root};
  const snapshot=api.createPageSnapshot({document,getStyle:()=>({})});
  assert.deepEqual(Array.from(snapshot.entries,entry=>entry.text),['First paragraph.','Second paragraph.']);
  assert.equal(snapshot.entries[0].element,first);
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.entries)); assert.ok(Object.isFrozen(snapshot.entries[0]));
});

test('selection, empty text and long text follow existing chunking rules',()=>{
  const api=load();
  assert.equal(api.createSelectionSnapshot({toString:()=>''}).length,0);
  const snapshot=api.createSelectionSnapshot({toString:()=>`one. ${'word '.repeat(200)}`},50);
  assert.ok(snapshot.length>1);
  assert.equal(snapshot.entries.map(entry=>entry.text).join(' ').replace(/\s+/g,' ').trim(),`one. ${'word '.repeat(200)}`.trim());
});

test('split boundaries and unpunctuated sentences are deterministic',()=>{
  const api=load();
  assert.equal(api.splitText('Run!')[0],'Run!');
  assert.deepEqual(Array.from(api.splitText('a'.repeat(10),10)),['a'.repeat(10)]);
  assert.equal(api.splitText('a'.repeat(11),10)[0].length,11);
  assert.ok(Array.from(api.splitText(('word ').repeat(200),50)).every(item=>item.length<=50));
});

test('invalid selectors and ignored elements are safe',()=>{
  const api=load(); const ignored=element('ignored',{},{closestMap:{'[':true}});
  const root=element('',[ignored]); root.querySelectorAll=()=>[ignored];
  const document={body:root,querySelectorAll:()=>[root],querySelector:()=>{throw new Error('invalid')}};
  assert.doesNotThrow(()=>api.createPageSnapshot({document,contentSelector:'[',ignoreSelector:'[',getStyle:()=>({})}));
});

test('duplicate, nested and ignored elements are filtered without changing DOM identity',()=>{
  const api=load();
  const duplicate=element('same text');
  const nested=element('nested text');
  const ignored=element('ignored text',{},{closestMap:{'.skip':true}});
  const root=element('',[duplicate,duplicate,nested,ignored]);
  root.querySelectorAll=()=>[duplicate,duplicate,nested,ignored];
  const document={body:root,querySelectorAll:()=>[root],querySelector:()=>root};
  const snapshot=api.createPageSnapshot({document,ignoreSelector:'.skip',getStyle:()=>({})});
  assert.equal(snapshot.length,2);
  assert.equal(snapshot.entries[0].element,duplicate);
  assert.equal(snapshot.entries[1].element,nested);
  assert.notEqual(Object.isFrozen(duplicate),true);
});

test('selection snapshots, local documents and independent calls are isolated',()=>{
  const api=load();
  const local=element('Local document text with enough characters');
  const document={body:local,querySelectorAll:()=>[],querySelector:()=>null};
  const first=api.createPageSnapshot({document,getStyle:()=>({})});
  const second=api.createSelectionSnapshot({toString:()=> 'selected text with enough content'});
  assert.equal(first.entries[0].element,local);
  assert.equal(second.entries[0].element,null);
  assert.notEqual(first,second);
});

test('panel host content is excluded from page narration',()=>{
  const api=load();
  const panel=element('panel controls with text');
  const paragraph=element('A real document paragraph with enough text.');
  const root=element('',[panel,paragraph]);
  root.querySelectorAll=()=>[panel,paragraph];
  const document={body:root,querySelectorAll:()=>[root],querySelector:()=>root};
  const snapshot=api.createPageSnapshot({document,excludedRoot:panel,getStyle:()=>({})});
  assert.equal(snapshot.entries.some(entry=>entry.element===panel),false);
  assert.equal(snapshot.entries[0].element,paragraph);
});

test('mergeShortEntries keeps order, elements and input immutable',()=>{
  const api=load(); const a={text:'a',element:{id:1}}, b={text:'b',element:{id:2}}, c={text:'long '.repeat(100),element:{id:3}};
  const input=[a,b,c]; const result=api.mergeShortEntries(input,10);
  assert.deepEqual(input,[a,b,c]); assert.equal(result[0].text,'a\nb'); assert.equal(result[0].element,a.element); assert.equal(result[1].element,c.element);
});

test('merge boundaries, disabled merge and source entries are preserved',()=>{
  const api=load();
  const a={text:'a'.repeat(159),element:{id:1}}, b={text:'b'.repeat(159),element:{id:2}};
  const input=[a,b];
  const merged=api.mergeShortEntries(input,5);
  assert.equal(merged.length,2);
  assert.equal(api.mergeShortEntries(input,159).length,1);
  assert.deepEqual(input,[a,b]);
});

test('failed input construction never yields a partial snapshot',()=>{
  const api=load();
  const throwingEntries={map(){throw new Error('parse failure');}};
  assert.throws(()=>api.createSnapshot(throwingEntries),/parse failure/);
});
