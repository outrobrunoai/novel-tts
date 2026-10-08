// Visual-only harness; deliberately not loaded by the extension manifest.
(() => {
  const i18n = globalThis.NovelLocalReader?.i18n;
  i18n?.apply(document);
  const saved={};const listeners=[];
  globalThis.browser={runtime:{id:'preview',getURL:p=>p,onMessage:{addListener:fn=>listeners.push(fn),removeListener:()=>{}},
    sendMessage:async message=>{
      if(message.type==='voices')return {voices:['Narrador · exemplo']};
      if(message.type==='profile')return {fingerprint:'preview'};
      if(message.type==='health')return {ok:false,error:i18n?.t('preview.noConnection')};
      if(message.type==='cache-stats')return {ok:true,count:0,bytes:0,mode:'hd'};
      if(message.type==='open-page'){alert(i18n?.t('preview.openNotice'));return {};}
      if(message.type==='synthesize')throw new Error(i18n?.t('preview.noGeneration'));
      return {ok:true};
    }},storage:{local:{get:async key=>typeof key==='string'?{[key]:saved[key]}:saved,set:async data=>Object.assign(saved,data),remove:async key=>delete saved[key]}}};
  const script=document.createElement('script');script.src='content.js';
  script.onload=()=>{
    document.querySelector('nlr-reader-host')?.setAttribute('data-embed','');
    for(const listener of listeners)listener({type:'toggle-panel'});
  };
  document.head.appendChild(script);
})();
