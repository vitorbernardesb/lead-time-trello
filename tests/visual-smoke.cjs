const {chromium}=require(process.argv[2] || 'playwright');
const fs=require('fs');
const assert=require('node:assert/strict');
const path=require('path');
(async()=>{
const out=path.resolve(__dirname,'../../design-review');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.QA_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}, reducedMotion:'reduce'});
const errors=[];
await context.route('https://**/*',r=>r.fulfill({status:200,contentType:'application/javascript',body:''}));
await context.addInitScript(()=>{
 const now=new Date(), ago=n=>new Date(+now-n*86400000).toISOString();
 let cards=Array.from({length:24},(_,i)=>({id:'card'+i,name:['Campanha de lançamento','Conteúdo institucional','Planejamento editorial','Identidade da campanha'][i%4]+' — '+(i+1), url:'https://trello.com/c/demo'+i,currentListName:i>15?'Concluído 🏆':i%2?'Em andamento 💪':'Revisão Interna 🔎', daysInCurrent:i%9+1,enteredCurrentAt:ago(i%9+1),isConcluido:i>15,concluidoNoMes:i>15,concludedAt:i>15?ago(2):null,leadTimeReal:i>15?8+i%4:null,hasDue:true,isLate:i<5,retrabalho:i%3,isConforme:i!==3,missing:i===3?['Descrição']:[],labels:['Cliente Aurora','Vitor'],members:[],idMembers:[],nivelEsforco:['BAIXO','MÉDIO','ALTO','MUITO ALTO'][i%4],createdAt:ago(25),due:ago(-2),dueComplete:i>15,primeiraEntrega:i>7?{horas:9*(i%4+1)+i,dias:i%4+1,breakdown:{'Em andamento 💪':i+3}}:null,stages:[{listName:'Em andamento 💪',enteredAt:ago(10),leftAt:ago(3),days:5}]}));
 if(location.search.includes('empty')) cards=[];
 localStorage.setItem('leadtime_cache_demo',JSON.stringify({cards,cachedAt:Date.now(),archived:[],throughput:{}}));
 const snapshots={};for(let m=6;m<=9;m++)snapshots['snapshot_2026_'+String(m).padStart(2,'0')]={score:60+m*2,kpi1:10+m,kpi2:20+m,kpi3:3,kpi4:12,kpi5:90,kpi6:8,totalCards:24,savedAt:ago(30*(9-m))};
 const data={...snapshots,customPanels:[{id:'aurora',name:'Cliente Aurora',color:'#059669',criterion:'labels',values:['Cliente Aurora'],updatedAt:Date.now()}]};
 const t={board:async()=>({id:'demo',name:'Board de demonstração'}),get:async(a,b,key)=>key?data[key]:data,set:async(a,b,key,value)=>{data[key]=value;},alert:async()=>{},showCard:async()=>{},sizeTo:async()=>{},getContext:()=>({board:'demo'}),member:async()=>({id:'demo'})};
 window.TrelloPowerUp={iframe:()=>t};
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:8765/dashboard.html');await page.waitForSelector('#score-hero',{timeout:15000});
await page.screenshot({path:path.join(out,'tempo-real-desktop.png'),fullPage:true});
const values=await page.locator('.kpi-value').allTextContents(); assert.equal(values.length,6); console.log('metrics',values);
const health=await page.locator('#score-ring-number').textContent();
if(process.argv[3]) { const baseline=await context.newPage(); await baseline.route('**/dashboard.html',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(process.argv[3],'utf8')})); await baseline.goto('http://127.0.0.1:8765/dashboard.html'); await baseline.waitForSelector('#score-hero'); assert.deepEqual(values.map(s=>s.replace(/\s/g,'')),(await baseline.locator('.kpi-value').allTextContents()).map(s=>s.replace(/\s/g,''))); assert.equal(health,await baseline.locator('#score-ring-number').textContent()); await baseline.close(); console.log('Original KPI values and Health Score preserved'); }
await page.locator('#score-hero').press('Enter');await page.waitForSelector('.cp-overlay.on');await page.screenshot({path:path.join(out,'health-score.png')});await page.keyboard.press('Tab'); assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.cp-modal')),true); await page.keyboard.press('Escape'); await page.waitForSelector('.cp-overlay',{state:'detached'}); assert.equal(await page.evaluate(()=>document.activeElement.id),'score-hero');
for(const tab of ['funnel','history','custom','msproject','config']){
 await page.locator('[data-tab="'+tab+'"]').click();await page.waitForTimeout(350);
 if(tab==='custom'){await page.locator('.cp-panel-head').click();}
 await page.screenshot({path:path.join(out,tab+'.png'),fullPage:true});
 console.log('tab',tab,(await page.locator('#tab-'+tab).innerText()).slice(0,110));
}
await page.locator('[data-tab="realtime"]').click();await page.waitForTimeout(250);
for(const width of [1024,768,390,320]){
 await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(out,'tempo-real-'+width+'.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Realtime overflow '+width);
 for(const tab of ['funnel','history','custom','msproject','config']) { await page.locator('[data-tab="'+tab+'"]').click(); await page.waitForTimeout(220); const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth); console.log('layout',width,tab,overflow?'OVERFLOW':'OK'); assert.equal(overflow,false,tab+' overflow '+width); }
 await page.locator('[data-tab="realtime"]').click();await page.waitForTimeout(220);
}
await page.setViewportSize({width:1440,height:1000}); await page.locator('.kpi-mode-toggle [data-mode="taxa"]').click(); assert.equal(await page.locator('.kpi-value').nth(1).textContent(),'66,7%'); await page.getByRole('button',{name:'Mediana',exact:true}).click(); await page.locator('.pe-toggle').first().click(); assert.equal(await page.locator('.pe-body.open').count(),1);
 await page.goto('http://127.0.0.1:8765/dashboard.html?empty'); await page.waitForSelector('#score-hero'); assert.equal(await page.locator('#alert-banner').isDisabled(),true); assert.equal(await page.locator('.kpi-value').first().textContent(),'Sem dados'); await page.screenshot({path:path.join(out,'empty.png'),fullPage:true});
 assert.deepEqual(errors,[]); console.log('All smoke checks passed; no browser exceptions'); await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
