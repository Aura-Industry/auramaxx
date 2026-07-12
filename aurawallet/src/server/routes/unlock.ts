import { Router, Request, Response } from 'express';
import { unlock, isUnlocked, hasColdWallet, getColdWalletAddress, unlockAgent, getAgentAddress, autoUnlockLinkedAgents, autoUnlockChildAgents, recoverPrimaryAgentWithMnemonic, getAgentMnemonic } from '../lib/cold';
import { log } from '../lib/pino';
import { createAdminToken, createToken, validateToken, getTokenHash } from '../lib/auth';
import { isRevoked, revokeToken } from '../lib/sessions';
import { parseEncryptedPassword } from '../lib/transport';
import { isValidAgentPubkey, normalizeAgentPubkey } from '../lib/credential-transport';
import { isAdmin } from '../lib/permissions';
import { logger } from '../lib/logger';
import { events } from '../lib/events';
import { getErrorMessage, HttpError } from '../lib/error';
import { getDefaultSync } from '../lib/defaults';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import { syncGlobalAuraIdForAgent } from '../lib/social/global-aura-id';

const router = Router();

// GET /unlock - Self-contained HTML unlock page
// Served from Express so it's same-origin with /auth/connect and POST /unlock
export function unlockPageHandler(_req: Request, res: Response) {
  res.type('html').send(UNLOCK_PAGE_HTML);
}

const UNLOCK_PAGE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AuraMaxx — Unlock</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-family:'Inter',system-ui,sans-serif;background:#0a0a0a;color:#ffffff;font-size:14px;-webkit-font-smoothing:antialiased}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(#fff 1px,transparent 1px);background-size:4px 4px;opacity:0.02;pointer-events:none}

.container{width:100%;max-width:380px;padding:24px}

.badge{display:inline-block;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:#71717a;margin-bottom:24px}

.card{position:relative;border:1px solid #27272a;padding:32px 24px;background:#0a0a0a}
.card::before,.card::after{content:'';position:absolute;width:12px;height:12px;border-color:#ccff00;border-style:solid}
.card::before{top:-1px;left:-1px;border-width:1px 0 0 1px}
.card::after{bottom:-1px;right:-1px;border-width:0 1px 1px 0}

h1{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:#a1a1aa;margin-bottom:24px}

.field{margin-bottom:20px}
.field label{display:block;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:#71717a;margin-bottom:8px}
.field input{width:100%;padding:10px 12px;background:#141414;border:1px solid #27272a;color:#ffffff;font-family:'Inter',sans-serif;font-size:14px;outline:none;border-radius:0;transition:border-color 0.15s,box-shadow 0.15s}
.field input:focus{border-color:#ccff00;box-shadow:2px 2px 0 rgba(204,255,0,0.2)}
.field input::placeholder{color:#3f3f46}

button{width:100%;padding:10px 12px;background:#ffffff;color:#0a0a0a;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;font-weight:500;border:none;cursor:pointer;border-radius:0;transition:color 0.15s}
button:hover{color:#ccff00}
button:disabled{opacity:0.4;cursor:not-allowed}

.status{margin-top:16px;font-family:'JetBrains Mono',monospace;font-size:11px;min-height:20px}
.status.error{color:#ff4d00}
.status.success{color:#ccff00}
.status.loading{color:#71717a}

.address{margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#52525b;word-break:break-all}
</style>
</head>
<body>
<div class="container">
  <div class="badge">AuraMaxx</div>
  <div class="card">
    <h1>Unlock Agent</h1>
    <form id="form">
      <div class="field">
        <label for="pw">Password</label>
        <input type="password" id="pw" placeholder="Enter agent password" autocomplete="current-password" autofocus>
      </div>
      <button type="submit" id="btn">Unlock</button>
    </form>
    <div class="status" id="status"></div>
    <div class="address" id="addr"></div>
    <div id="biometric-section" style="display:none;margin-top:20px;padding-top:16px;border-top:1px solid #27272a">
      <button type="button" id="bio-btn" style="background:#0a0a0a;color:#ccff00;border:1px solid #27272a">Unlock with Face ID</button>
      <label style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;color:#a1a1aa;font-size:10px;letter-spacing:0.08em;font-family:'JetBrains Mono',monospace;text-transform:uppercase;">
        <input type="checkbox" id="bio-auto" checked style="margin:0;" />
        Auto-unlock on load
      </label>
    </div>
  </div>
</div>
<script>
(function(){
  var form=document.getElementById('form');
  var pw=document.getElementById('pw');
  var btn=document.getElementById('btn');
  var status=document.getElementById('status');
  var addr=document.getElementById('addr');

  function setStatus(msg,cls){status.textContent=msg;status.className='status '+(cls||'')}

  function pemToArrayBuffer(pem){
    var b64=pem.replace(/-----BEGIN PUBLIC KEY-----/,'').replace(/-----END PUBLIC KEY-----/,'').replace(/\\s/g,'');
    var bin=atob(b64);var bytes=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    return bytes.buffer;
  }
  function arrayBufferToBase64(buf){
    var bytes=new Uint8Array(buf);var bin='';
    for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  var agentPubkeyB64=null;
  async function ensureAgentPubkey(){
    if(agentPubkeyB64)return agentPubkeyB64;
    var pair=await crypto.subtle.generateKey(
      {name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},
      true,
      ['encrypt','decrypt']
    );
    var spki=await crypto.subtle.exportKey('spki',pair.publicKey);
    agentPubkeyB64=arrayBufferToBase64(spki);
    return agentPubkeyB64;
  }

  async function encryptPassword(password,pemKey){
    var keyData=pemToArrayBuffer(pemKey);
    var publicKey=await crypto.subtle.importKey('spki',keyData,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    var encoded=new TextEncoder().encode(password);
    var encrypted=await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,encoded);
    var bytes=new Uint8Array(encrypted);var bin='';
    for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  form.addEventListener('submit',async function(e){
    e.preventDefault();
    var password=pw.value;
    if(!password){setStatus('Password required','error');return}
    btn.disabled=true;
    setStatus('Encrypting...','loading');
    try{
      var connectRes=await fetch('/auth/connect');
      if(!connectRes.ok)throw new Error('Failed to fetch public key');
      var connectData=await connectRes.json();
      var pubkey=await ensureAgentPubkey();
      var encrypted=await encryptPassword(password,connectData.publicKey);
      setStatus('Unlocking...','loading');
      var unlockRes=await fetch('/unlock',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({encrypted:encrypted,pubkey:pubkey})
      });
      var data=await unlockRes.json();
      if(unlockRes.ok&&data.success){
        setStatus('Agent unlocked','success');
        if(data.address)addr.textContent=data.address;
        pw.value='';
      }else{
        setStatus(data.error||'Unlock failed','error');
      }
    }catch(err){
      setStatus(err.message||'Network error','error');
    }finally{
      btn.disabled=false;
    }
  });

  // ─── Biometric / Passkey Support ──────────────────────────
  var bioSection=document.getElementById('biometric-section');
  var bioBtn=document.getElementById('bio-btn');
  var bioAuto=document.getElementById('bio-auto');
  var autoPrompt=localStorage.getItem('aura:biometric:autoPrompt')!=='false';
  if (bioAuto) {
    bioAuto.checked = autoPrompt;
  }

  function base64urlToBuffer(b){var s=b.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var bin=atob(s);var a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a.buffer}
  function bufferToBase64url(b){var bytes=new Uint8Array(b);var bin='';for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}

  async function doBiometricAuth(){
    bioBtn.disabled=true;
    setStatus('Requesting biometric...','loading');
    try{
      var optRes=await fetch('/auth/passkey/authenticate/options',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
      var optData=await optRes.json();
      if(!optRes.ok){
        if(optData.error==='agent_locked'){setStatus('Password required after server restart','error');return}
        setStatus(optData.error||'Failed to get options','error');return;
      }
      // Convert for WebAuthn API
      var pubkeyOpts={challenge:base64urlToBuffer(optData.challenge),rpId:optData.rpId,timeout:optData.timeout,userVerification:optData.userVerification,allowCredentials:(optData.allowCredentials||[]).map(function(c){return{type:'public-key',id:base64urlToBuffer(c.id),transports:c.transports}})};
      var assertion=await navigator.credentials.get({publicKey:pubkeyOpts});
      setStatus('Verifying...','loading');
      var pubkey=await ensureAgentPubkey();
      var cred={id:bufferToBase64url(assertion.rawId),rawId:bufferToBase64url(assertion.rawId),type:assertion.type,response:{clientDataJSON:bufferToBase64url(assertion.response.clientDataJSON),authenticatorData:bufferToBase64url(assertion.response.authenticatorData),signature:bufferToBase64url(assertion.response.signature),userHandle:assertion.response.userHandle?bufferToBase64url(assertion.response.userHandle):null}};
      var verRes=await fetch('/auth/passkey/authenticate/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:cred,pubkey:pubkey})});
      var verData=await verRes.json();
      if(verRes.ok&&verData.success){
        setStatus('Agent unlocked via biometric','success');
        pw.value='';
      }else{
        setStatus(verData.error||'Biometric auth failed','error');
      }
    }catch(err){
      if(err.name==='NotAllowedError'){setStatus('Biometric cancelled','error');}
      else{setStatus(err.message||'Biometric error','error');}
    }finally{bioBtn.disabled=false;}
  }

  // Check if passkeys registered and WebAuthn available
  if(window.PublicKeyCredential){
    fetch('/auth/passkey/status').then(function(r){return r.json()}).then(function(d){
      if(d.registered){
        bioSection.style.display='block';
        bioBtn.addEventListener('click',doBiometricAuth);
        if (bioAuto) {
          bioAuto.addEventListener('change', function () {
            localStorage.setItem('aura:biometric:autoPrompt', String(!bioAuto.checked ? 'false' : 'true'));
          });
        }
        if(autoPrompt)doBiometricAuth();
      }
    }).catch(function(){});
  }
})();
</script>
</body>
</html>`;

// POST /unlock/rekey - Re-key session with new RSA pubkey (no password required)
// Used after page refresh: token survives in sessionStorage but keypair is lost.
// Client generates a new keypair and exchanges the old token for a new one.
router.post('/rekey', async (req: Request, res: Response) => {
  try {
    // Require Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const rawToken = authHeader.slice(7);
    const payload = validateToken(rawToken);
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const tokenHash = getTokenHash(rawToken);
    if (isRevoked(tokenHash)) {
      res.status(401).json({ error: 'Token has been revoked' });
      return;
    }
    if (!isAdmin({ token: payload })) {
      req.auth = {
        token: payload,
        tokenHash,
        raw: rawToken,
      };
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.WALLET_ADMIN,
        error: 'Admin access required',
        required: ['admin:*'],
        have: payload.permissions,
      });
      return;
    }

    // Agent must still be unlocked server-side
    if (!isUnlocked()) {
      res.status(403).json({ error: 'Agent is locked' });
      return;
    }

    // Validate new pubkey
    const pubkey = typeof req.body?.pubkey === 'string' ? req.body.pubkey : '';
    if (!pubkey.trim()) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ error: 'pubkey must be a valid RSA public key (PEM or base64)' });
      return;
    }
    const normalizedPubkey = normalizeAgentPubkey(pubkey);

    // Issue new admin token with new pubkey
    const newToken = await createAdminToken(normalizedPubkey);

    // Revoke old token only after new token issuance succeeds
    revokeToken(tokenHash);

    logger.unlocked(getColdWalletAddress() || 'rekey');

    res.json({
      success: true,
      message: 'Session re-keyed with new public key',
      token: newToken,
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// POST /unlock/recover - Recover primary agent with mnemonic and set a new password
router.post('/recover', async (req: Request, res: Response) => {
  try {
    const pubkey = typeof req.body?.pubkey === 'string' ? req.body.pubkey : '';
    if (!pubkey.trim()) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ error: 'pubkey must be a valid RSA public key (PEM or base64)' });
      return;
    }
    const normalizedPubkey = normalizeAgentPubkey(pubkey);

    const mnemonic = typeof req.body?.mnemonic === 'string' ? req.body.mnemonic : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (!mnemonic.trim()) {
      res.status(400).json({ error: 'mnemonic is required' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'newPassword must be at least 8 characters' });
      return;
    }

    const recovered = recoverPrimaryAgentWithMnemonic(mnemonic, newPassword);
    if (!recovered) {
      res.status(401).json({ error: 'Invalid seed phrase for primary agent' });
      return;
    }

    const address = getColdWalletAddress();

    logger.unlocked(address || '');
    events.agentUnlocked({ address: address || '', agentId: 'primary' });

    try {
      autoUnlockLinkedAgents();
    } catch (err) {
      log.warn({ err }, 'Failed to auto-unlock linked agents after mnemonic recovery');
    }

    const primaryMnemonic = getAgentMnemonic('primary');
    if (primaryMnemonic) {
      await syncGlobalAuraIdForAgent('primary', primaryMnemonic);
    }

    const token = await createAdminToken(normalizedPubkey);

    res.json({
      success: true,
      message: 'Wallet recovered and unlocked',
      address,
      token,
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// POST /unlock - Unlock cold wallet with encrypted password
// Returns admin token for UI access
router.post('/', async (req: Request, res: Response) => {
  try {
    const pubkey = typeof req.body?.pubkey === 'string' ? req.body.pubkey : '';
    if (!pubkey.trim()) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ error: 'pubkey must be a valid RSA public key (PEM or base64)' });
      return;
    }
    const normalizedPubkey = normalizeAgentPubkey(pubkey);
    const password = parseEncryptedPassword(req.body.encrypted);

    if (!hasColdWallet()) {
      res.status(400).json({ error: 'No cold wallet found. Run /setup first.' });
      return;
    }

    // Always validate password, even if already unlocked
    // This allows users to get a new token after page refresh
    const success = unlock(password);

    if (!success) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const address = getColdWalletAddress();

    // Log the unlock event
    logger.unlocked(address || '');
    events.agentUnlocked({ address: address || '', agentId: 'primary' });

    // After primary unlock, auto-unlock linked agents (independent agents stay locked).
    try {
      autoUnlockLinkedAgents();
    } catch (err) {
      log.warn({ err }, 'Failed to auto-unlock linked agents after unlock');
    }

    const primaryMnemonic = getAgentMnemonic('primary');
    if (primaryMnemonic) {
      await syncGlobalAuraIdForAgent('primary', primaryMnemonic);
    }

    // If scope=extension, issue a scoped token instead of admin
    const scope = req.body?.scope;
    if (scope === 'extension') {
      const ttl = getDefaultSync<number>('ttl.admin', 2592000);
      const token = await createToken('extension', 0, ['extension:*'], ttl, {
        credentialAccess: { read: ['*'] },
        agentPubkey: normalizedPubkey,
      });
      res.json({
        success: true,
        message: 'Wallet unlocked (extension scope)',
        address,
        token,
        scope: 'extension',
      });
      return;
    }

    // Create admin token on successful unlock
    const token = await createAdminToken(normalizedPubkey);

    res.json({
      success: true,
      message: 'Wallet unlocked',
      address,
      token
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// POST /unlock/:agentId - Unlock a specific agent
router.post('/:agentId', async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const { agentId } = req.params;
    const pubkey = typeof req.body?.pubkey === 'string' ? req.body.pubkey : '';
    if (!pubkey.trim()) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ error: 'pubkey must be a valid RSA public key (PEM or base64)' });
      return;
    }
    const normalizedPubkey = normalizeAgentPubkey(pubkey);
    const password = parseEncryptedPassword(req.body.encrypted);

    const success = unlockAgent(agentId, password);

    if (!success) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    // Unlock descendant child agents with the same password used for the parent unlock.
    try {
      autoUnlockChildAgents(agentId, password);
    } catch (err) {
      log.warn({ err, agentId }, 'Failed to auto-unlock child agents after parent unlock');
    }

    const mnemonic = getAgentMnemonic(agentId);
    if (mnemonic) {
      await syncGlobalAuraIdForAgent(agentId, mnemonic);
    }

    // Create admin token (or return existing if primary is already unlocked)
    const token = await createAdminToken(normalizedPubkey);
    const address = getAgentAddress(agentId);

    logger.unlocked(address || agentId);
    events.agentUnlocked({ address: address || '', agentId });

    res.json({
      success: true,
      message: `Agent ${agentId} unlocked`,
      agentId,
      address,
      token
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

export default router;
