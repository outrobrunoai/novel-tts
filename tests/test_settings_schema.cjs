const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'..','settings-schema.js'),'utf8');
function schema(){const context={};context.globalThis=context;vm.createContext(context);vm.runInContext(source,context);return context.NovelLocalReader.settingsSchema;}

test('schema exposes one immutable contract and all live preference values',()=>{
  const s=schema();
  assert.deepEqual([...s.keys],['autoNext','autoNextDelay','cacheLimitMb','characterVoices','compact','dialogueVoice','expressionMode','interfaceLanguage','mergeShortLines','nextSelector','playbackRate','preGenerateChapters','prefetch','seed','shortLineLimit','temperature','theme','voice','volume']);
  for(const value of ['auto','pt','en','es']) assert.equal(s.valid('interfaceLanguage',value),true);
  assert.equal(s.valid('interfaceLanguage','fr'),false);
  assert.equal(s.valid('expressionMode','off'),true);assert.equal(s.valid('expressionMode','smart'),true);assert.equal(s.valid('expressionMode','narration'),true);assert.equal(s.valid('expressionMode','expressive'),false);
  for(const value of [0,false,'']) assert.equal(s.valid(value===false?'autoNext':value===0?'seed':'voice',value),true);
  assert.equal(Object.isFrozen(s.defaults),true);assert.equal(Object.isFrozen(s.rules),true);assert.equal(Object.isFrozen(s.rules.prefetch),true);
});

test('normalization is defensive and does not mutate its input',()=>{
  const s=schema();const input={prefetch:0,temperature:0,seed:0,autoNext:false,voice:'',expressionMode:'smart',unknown:'private'};const copy=JSON.parse(JSON.stringify(input));
  const normalized=s.normalize(input);assert.deepEqual(input,copy);assert.equal(normalized.prefetch,0);assert.equal(normalized.temperature,0);assert.equal(normalized.seed,0);assert.equal(normalized.autoNext,false);assert.equal(normalized.expressionMode,'smart');assert.equal(normalized.unknown,undefined);assert.notEqual(normalized,s.defaults);assert.notEqual(s.cloneDefaults(),s.cloneDefaults());
});
