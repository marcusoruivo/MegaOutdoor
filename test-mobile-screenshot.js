const{chromium}=require('playwright');
(async()=>{
  const b=await chromium.launch();
  const p=await b.newPage();

  // MOBILE
  await p.setViewportSize({width:390,height:844});
  await p.goto('http://localhost:3000',{waitUntil:'networkidle',timeout:30000});
  await p.waitForTimeout(2000);
  await p.evaluate(()=>{
    const m=document.getElementById('modalTutorial');if(m)m.style.display='none';
    document.querySelectorAll('.modal').forEach(el=>el.style.display='none');
  });
  await p.waitForTimeout(1000);
  await p.screenshot({path:'C:/Users/MARCUS~1/AppData/Local/Temp/megaoutdoor-playwright/dashboard-mobile-clean.png',fullPage:true});
  console.log('OK mobile 390x844');

  // DESKTOP
  await p.setViewportSize({width:1366,height:768});
  await p.waitForTimeout(1500);
  await p.evaluate(()=>{
    const m=document.getElementById('modalTutorial');if(m)m.style.display='none';
    document.querySelectorAll('.modal').forEach(el=>el.style.display='none');
  });
  await p.waitForTimeout(500);
  await p.screenshot({path:'C:/Users/MARCUS~1/AppData/Local/Temp/megaoutdoor-playwright/dashboard-desktop-clean.png',fullPage:true});
  console.log('OK desktop 1366x768');

  await b.close();
})();
