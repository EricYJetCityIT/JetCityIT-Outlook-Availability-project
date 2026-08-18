const { app } = require('@azure/functions');
const { safeEqual } = require('../lib/secure');

// Private "get the app" landing page. Not linked from anywhere in the site,
// not indexed — the only way in is a link with the right ?token=, handed
// directly to techs. The real access control for actual data is still the
// existing @jetcityit.com MSAL sign-in on the main app; this token just
// gates discovery of the install instructions themselves, which is why an
// invalid/missing token gets a plain 404 rather than a 401 (no confirmation
// this endpoint even exists).
function pageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Get the Crew Calendar app</title>
<link rel="manifest" href="/manifest.json"/>
<meta name="theme-color" content="#16A37F"/>
<link rel="apple-touch-icon" href="/icons/icon-180.png"/>
<link rel="icon" href="/icons/icon-192.png"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="default"/>
<meta name="apple-mobile-web-app-title" content="Crew Calendar"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#F7F8FA;color:#0F1724;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#FFFFFF;border:1px solid #E4E7EC;border-radius:16px;box-shadow:0 1px 3px rgba(15,23,36,.07),0 4px 16px rgba(15,23,36,.05);max-width:440px;width:100%;padding:32px 28px}
.icon{width:72px;height:72px;border-radius:18px;display:block;margin:0 auto 20px}
h1{font-size:20px;text-align:center;margin-bottom:6px}
.sub{font-size:14px;color:#4B5565;text-align:center;margin-bottom:28px}
.steps{list-style:none;counter-reset:step;margin-bottom:24px}
.steps li{counter-increment:step;position:relative;padding-left:36px;margin-bottom:16px;font-size:14px;line-height:1.5;color:#0F1724}
.steps li::before{content:counter(step);position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;background:#E6F7F3;color:#0D6E56;font-weight:600;font-size:13px;display:flex;align-items:center;justify-content:center}
.hint{font-size:13px;color:#8A93A2;margin-top:2px}
.btn{display:block;width:100%;text-align:center;background:#16A37F;color:#fff;font-weight:600;font-size:15px;padding:13px;border-radius:10px;text-decoration:none;border:none;cursor:pointer;font-family:inherit;margin-top:8px}
.btn:active{background:#0D6E56}
.platform-toggle{display:flex;gap:8px;margin-bottom:24px;background:#F0F2F5;border-radius:10px;padding:4px}
.platform-toggle button{flex:1;padding:8px;border:none;border-radius:8px;background:transparent;font-family:inherit;font-weight:600;font-size:13px;color:#4B5565;cursor:pointer}
.platform-toggle button.active{background:#fff;color:#0F1724;box-shadow:0 1px 2px rgba(15,23,36,.08)}
.panel{display:none}
.panel.active{display:block}
</style>
</head>
<body>
<div class="card">
  <img class="icon" src="/icons/icon-192.png" alt=""/>
  <h1>Get the Crew Calendar app</h1>
  <p class="sub">Install it once — it'll show up as a regular app icon on your phone.</p>

  <div class="platform-toggle">
    <button id="btn-ios" onclick="showPanel('ios')">iPhone</button>
    <button id="btn-android" onclick="showPanel('android')">Android</button>
  </div>

  <div id="panel-ios" class="panel">
    <ol class="steps">
      <li>Open this page in <strong>Safari</strong> (not Chrome — Safari is required for this to work on iPhone)</li>
      <li>Tap the <strong>Share</strong> icon (square with an arrow) in the toolbar</li>
      <li>Scroll down and tap <strong>Add to Home Screen</strong></li>
      <li>Tap <strong>Add</strong> in the top right</li>
    </ol>
    <div class="hint">The app icon will appear on your home screen like any other app.</div>
    <a class="btn" href="/">Continue to the app</a>
  </div>

  <div id="panel-android" class="panel">
    <ol class="steps">
      <li>Open this page in <strong>Chrome</strong></li>
      <li>Tap the button below, or tap Chrome's <strong>⋮</strong> menu and choose <strong>Install app</strong></li>
    </ol>
    <button class="btn" id="android-install-btn" onclick="doInstall()">Install app</button>
    <a class="btn" href="/" style="background:#4B5565">Continue to the app</a>
  </div>
</div>
<script>
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
function doInstall(){
  if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt = null; }
  else { alert('Open Chrome\\'s ⋮ menu and choose "Install app".'); }
}
function showPanel(which){
  document.getElementById('panel-ios').classList.toggle('active', which==='ios');
  document.getElementById('panel-android').classList.toggle('active', which==='android');
  document.getElementById('btn-ios').classList.toggle('active', which==='ios');
  document.getElementById('btn-android').classList.toggle('active', which==='android');
}
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
showPanel(isIOS ? 'ios' : 'android');
</script>
</body>
</html>`;
}

app.http('install', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'install',
  handler: async (request) => {
    const expected = process.env.INSTALL_INVITE_TOKEN;
    const provided = new URL(request.url).searchParams.get('token') || '';
    if (!expected || !safeEqual(provided, expected)) {
      return { status: 404, body: 'Not found' };
    }
    return { headers: { 'Content-Type': 'text/html' }, body: pageHtml() };
  },
});
