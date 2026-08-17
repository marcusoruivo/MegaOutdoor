const{chromium}=require('playwright');
(async()=>{
  const b=await chromium.launch();
  const p=await b.newPage();
  const errs=[];
  p.on('pageerror',e=>errs.push(e.message));
  await p.setViewportSize({width:1366,height:768});
  await p.goto('http://localhost:3000',{waitUntil:'networkidle',timeout:30000});
  await p.waitForTimeout(1800);
  await p.evaluate(()=>{
    const st=document.createElement('style');
    st.textContent='#storiesShell,#ultimasComprasShell{display:block !important}';
    document.head.appendChild(st);
  });
  await p.waitForTimeout(400);
  const info=await p.evaluate(()=>{
    const g=s=>{const el=document.querySelector(s);if(!el)return null;const r=el.getBoundingClientRect();return{top:Math.round(r.top),left:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)};};
    const st=g('.stories-shell,#storiesShell');
    return{
      grid:(()=>{const ml=document.querySelector('.main-layout');if(!ml)return null;const a=document.querySelector('.sidebar-left');const c=document.getElementById('area');const r=document.querySelector('.sidebar-right');const aw=a.getBoundingClientRect().width,cw=c.getBoundingClientRect().width,rw=r.getBoundingClientRect().width,t=aw+cw+rw;return{left:Math.round(aw/t*100),center:Math.round(cw/t*100),right:Math.round(rw/t*100)};})(),
      stories:st,
      inicioAtivo:(()=>{const a=document.querySelector('.nav-desktop a.active');return a?a.textContent.trim():null;})(),
      dropdown:(()=>{const d=document.getElementById('contaDropdown');const st=d?getComputedStyle(d).display:null;return st;})(),
      dropdownOptions:Array.from(document.querySelectorAll('.conta-dropdown a')).map(a=>a.textContent.trim()),
      ticker:(()=>{const t=document.querySelector('.ultimas-compras-head');return t?t.textContent.replace(/\s+/g,' ').trim():null;})(),
      pauseBtn:(()=>{const b=document.getElementById('tickerPauseBtn');return b?{txt:b.textContent,title:b.title}:null;})(),
      zoomBtns:Array.from(document.querySelectorAll('.zoom button')).map(b=>({txt:b.textContent,title:b.title||''})),
      legendItems:Array.from(document.querySelectorAll('.map-legend .leg-item,.map-legend li,.map-legend span')).map(s=>s.textContent.trim()).slice(0,8),
      pacotes:(()=>{const c=document.getElementById('pacotesDisponiveis');if(!c)return null;return c.textContent.replace(/\s+/g,' ').trim().slice(0,120);})(),
      colecionaveisSteps:document.querySelectorAll('.card.how-it-works .step').length,
      comoFuncionaSteps:(()=>{const cards=document.querySelectorAll('.card.how-it-works');let n=0;cards.forEach(c=>{if(c.querySelector('.card-title')&&c.querySelector('.card-title').textContent.indexOf('Como Funciona?')>=0)n=c.querySelectorAll('.step').length;});return n;})(),
      resumoBoxes:document.querySelectorAll('.resumo-box').length,
      canvasW:document.getElementById('canvas').width,
      bodyBg:getComputedStyle(document.body).backgroundColor,
      scrollH:document.body.scrollHeight
    };
  });
  console.log(JSON.stringify(info,null,2));
  console.log('pageerrors:',JSON.stringify(errs));
  await b.close();
})();