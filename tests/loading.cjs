const {chromium}=require(process.argv[2] || 'playwright');
const assert=require('node:assert/strict');
const live=process.argv.includes('--live');
const failArchives=process.argv.includes('--archive-failure');
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.QA_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const context=await browser.newContext();
    const board=live?'5ff876630522455b5d6aae8c':'test';
    const requests=[], errors=[];
    const stamp=Math.floor(new Date('2026-06-01T12:00:00Z').getTime()/1000).toString(16);
    const cards=Array.from({length:20},(_,i)=>({id:stamp+String(i).padStart(16,'0'),name:'Teste '+i,desc:'Descrição',closed:false,idList:'done',dateLastActivity:'v1',due:null,labels:[],idMembers:[],customFieldItems:[]}));
    const archived={...cards[0],id:stamp+'a'.repeat(16),closed:true};
    const actions=[...cards,archived].flatMap(c=>[
      {id:'done'+c.id,type:'updateCard',date:new Date().toISOString(),data:{card:{id:c.id},listBefore:{name:'Em andamento 💪'},listAfter:{name:'Concluído 🏆'}}},
      {id:'create'+c.id,type:'createCard',date:'2026-06-01T12:00:00Z',data:{card:{id:c.id},list:{name:'Em andamento 💪'}}}
    ]);
    let releaseArchives, archiveAttempts=0;
    const archiveGate=new Promise(resolve=>{releaseArchives=resolve;});
    await context.route('https://**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='api.trello.com') return route.fulfill({contentType:'application/javascript',body:''});
      assert.equal(route.request().method(),'GET','live verification must be read only');
      requests.push({path:url.pathname,filter:url.searchParams.get('filter')});
      if(live) return route.continue();
      let data;
      if(url.pathname.endsWith('/cards')) {
        if(url.searchParams.get('filter')==='closed') {await archiveGate; data=failArchives && ++archiveAttempts===1 ? {invalid:true} : [archived];}
        else {assert.equal(url.searchParams.get('filter'),'open');data=cards;}
      } else if(url.pathname.endsWith('/lists')) data=[{id:'done',name:'Concluído 🏆'}];
      else if(url.pathname.endsWith('/actions')) data=url.pathname.includes('/boards/')?actions:actions.filter(a=>url.pathname.includes(a.data.card.id));
      else data=[];
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await context.addInitScript(({board})=>{
      // SDK storage is mocked even in live mode: no snapshots or settings are written to Trello.
      const data={};
      window.TrelloPowerUp={iframe:()=>({board:async()=>({id:board}),get:async(a,b,key)=>key?data[key]:data,set:async(a,b,key,v)=>{data[key]=v;},showCard:async()=>{},alert:async()=>{},sizeTo:async()=>{},member:async()=>({id:'test'})})};
    },{board});
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    const start=Date.now();
    await page.goto('http://127.0.0.1:8765/dashboard.html');
    await page.waitForSelector('#score-hero',{timeout:180000});
    const primaryMs=Date.now()-start;
    const kpis=await page.locator('.kpi-value').allTextContents();
    if(!live) {
      assert.equal(await page.evaluate(async()=>(await import('/js/state.js')).cachedData.archived.length),0);
      releaseArchives();
    }
    if(failArchives) {
      await page.getByRole('button',{name:'Tentar novamente',exact:true}).waitFor({timeout:30000});
      assert.deepEqual(await page.locator('.kpi-value').allTextContents(),kpis);
      await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();
    }
    await page.waitForFunction(()=>document.getElementById('archive-progress')?.textContent==='Histórico de arquivados atualizado.',{},{timeout:180000});
    assert.deepEqual(await page.locator('.kpi-value').allTextContents(),kpis,'archived data must not change main KPIs');
    const completeMs=Date.now()-start;
    const coldRequests=requests.length;
    if(live) {
      const comparison=await page.evaluate(async board=>{
        const {readHistoryCache,fetchActionPages}=await import('/js/history-loader.js');
        const {apiUrl,TRELLO_TOKEN}=await import('/js/trello-api.js');
        const {buildTimeline}=await import('/js/core-time.js');
        let checked=0;
        for(const scope of ['open','closed']) {
          const cache=await readHistoryCache('actions-v2:'+board+':'+scope);
          for(const id of Object.keys(cache).slice(0,3)) {
            const actions=await fetchActionPages(async path=>{const r=await fetch(apiUrl(path,TRELLO_TOKEN));if(!r.ok)throw Error('Read failed');return r.json();},'/cards/'+id+'/actions?filter=updateCard:idList,createCard,copyCard&limit=1000&fields=id,type,date,data');
            if(JSON.stringify(buildTimeline(actions))!==JSON.stringify(buildTimeline(cache[id].a))) throw Error('Board/card history mismatch');
            checked++;
          }
        }
        return checked;
      },board);
      assert.equal(comparison,6,'compare six full histories with individual card reads');
    }
    const firstCount=requests.length;
    // Make only the small summary expire. Persisted histories must still survive page reload.
    await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('leadtime_cache_')).forEach(k=>localStorage.removeItem(k)));
    await page.reload();
    await page.waitForSelector('#score-hero',{timeout:180000});
    await page.waitForFunction(()=>document.getElementById('archive-progress')?.textContent==='Histórico de arquivados atualizado.',{},{timeout:180000});
    const warm=requests.slice(firstCount);
    if(!live) assert.equal(warm.filter(r=>r.path.endsWith('/actions')).length,0,'IndexedDB survives reload');
    assert.equal(requests.some(r=>r.filter==='all'),false,'no full board card download');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({live,primaryMs,completeMs,coldRequests,warmRequests:warm.length,warmHistoryRequests:warm.filter(r=>r.path.endsWith('/actions')).length,kpis}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
