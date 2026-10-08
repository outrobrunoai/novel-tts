(() => {
  const allowed=['midnight','parchment','forest','persona','rose','oled'];
  const apply = theme => document.documentElement.dataset.nlrTheme = allowed.includes(theme) ? theme : 'midnight';
  apply('midnight');
  browser.storage.local.get('nlrSettings').then(s=>apply(s.nlrSettings?.theme));
  browser.storage.onChanged.addListener((changes,area)=>{
    if(area==='local' && changes.nlrSettings) apply(changes.nlrSettings.newValue?.theme);
  });
})();

