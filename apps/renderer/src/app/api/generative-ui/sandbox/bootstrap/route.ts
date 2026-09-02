import { NextResponse } from "next/server";

/**
 * The sandbox bootstrap (P04-F04 steps 1-4).
 *
 * It runs inside the origin-isolated surface and is the only script there
 * that talks to the host. Its job is narrow and fixed:
 *
 *  1. wait for the host's one `init` message on the channel named in its own
 *     hash, and refuse anything from another window or another channel;
 *  2. load the validated artifact from this origin by id;
 *  3. mount it with the display-safe props the host supplied;
 *  4. send the `ready` handshake -- and only then, and only once.
 *
 * Registration and load-start are explicitly not readiness: `ready` is sent
 * after React has committed a frame, which is what the trusted server is
 * actually waiting on before `ui.generate` may answer `ready`.
 *
 * Served as a string rather than a bundled module so the sandbox's CSP can
 * stay `default-src 'none'; script-src 'self'` with no import map.
 */
const BOOTSTRAP = String.raw`(function(){"use strict";
var V=2;
var p=new URLSearchParams(location.hash.slice(1));
var ch=p.get("channel");
if(!ch||!/^[A-Za-z0-9_-]{1,128}$/.test(ch))return;
var env=null,seq=0,readySent=false,mounted=false;
function send(msg){if(!env)return;seq+=1;var out={bridgeVersion:V,channel:env.channel,instanceId:env.instanceId,artifactId:env.artifactId,planDigest:env.planDigest,inputDigest:env.inputDigest,revision:env.revision,sequence:seq};for(var k in msg)out[k]=msg[k];parent.postMessage(out,"*");}
function fail(code){send({type:"telemetry",event:"render_error",code:code});}
function mount(){
  if(mounted)return;
  var bridge=globalThis.__generatedUiRuntime;
  if(!bridge||!bridge.hasComponent()){fail("ARTIFACT_NOT_REGISTERED");return;}
  var root=document.getElementById("root");
  if(!root){fail("NO_ROOT");return;}
  mounted=true;
  var ok=false;
  try{ok=bridge.mount(root,env.props,function(code){fail(code);});}catch(e){ok=false;}
  if(!ok){fail("MOUNT_FAILED");return;}
  // One frame after the commit: the handshake means "this rendered", not
  // "this was asked to render".
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    if(readySent)return;
    readySent=true;
    send({type:"ready"});
    send({type:"telemetry",event:"rendered",code:null});
    report();
    setInterval(function(){send({type:"telemetry",event:"heartbeat",code:null});report();},5000);
  });});
}
function report(){
  var el=document.getElementById("root");
  if(!el)return;
  var h=Math.max(120,Math.min(4096,Math.ceil(el.getBoundingClientRect().height)||120));
  send({type:"resize",height:h});
}
addEventListener("message",function(e){
  if(e.source!==parent)return;
  var d=e.data;
  if(!d||d.type!=="init"||d.bridgeVersion!==V||d.channel!==ch)return;
  if(env)return;
  env={channel:d.channel,instanceId:d.instanceId,artifactId:d.artifactId,planDigest:d.planDigest,inputDigest:d.inputDigest,revision:d.revision,props:d.props};
  if(!/^gui_[a-f0-9]{64}$/.test(String(env.artifactId))){env=null;return;}
  var s=document.createElement("script");
  s.src="/api/generative-ui/artifacts/"+env.artifactId;
  s.addEventListener("load",mount);
  s.addEventListener("error",function(){fail("ARTIFACT_LOAD_FAILED");});
  document.head.appendChild(s);
});
// Read-only surface: a submit or a link click inside generated content is a
// policy violation, not a navigation.
addEventListener("submit",function(e){e.preventDefault();send({type:"telemetry",event:"policy_violation",code:"FORM_BLOCKED"});},true);
addEventListener("click",function(e){
  var t=e.target;
  while(t&&t!==document.body){if(t.tagName==="A"){e.preventDefault();send({type:"telemetry",event:"policy_violation",code:"NAVIGATION_BLOCKED"});return;}t=t.parentNode;}
},true);
addEventListener("keydown",function(e){if(e.key==="Tab")send({type:"focus",direction:e.shiftKey?"backward":"forward"});},true);
})();`;

export function GET(): NextResponse {
  return new NextResponse(BOOTSTRAP, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
