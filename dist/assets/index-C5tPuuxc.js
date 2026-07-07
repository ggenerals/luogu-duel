(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e={OK:0,WA:1,TL:2,RE:3,CE:4,MLE:5,OLE:6,UKE:7,PD:8},t=e=>({roomId:e,phase:e===`global`?`home`:`lobby`,players:{},problems:[],chats:[],feed:[],votes:{},system:[],lamport:0}),n=e=>{let t=e.trim().toUpperCase();return/^P\d{1,5}$/.test(t)?t:``},r=(e,t,r)=>{let i=r.split(/[\s,，]+/).map(n).filter(Boolean);if(i.length>0)return i.map((e,t)=>({pid:e,score:d(t)}));let a=new Set,o=[],s=pe(t);for(;o.length<e;){let e=`P${1e3+Math.floor(s()*16001)}`;a.has(e)||(a.add(e),o.push({pid:e,score:d(o.length)}))}return o},i=(e,n)=>n.filter(t=>t.roomId===e).sort(ie).reduce(a,t(e)),a=(e,t)=>{let n=ae(e);switch(n.lamport=Math.max(n.lamport,t.lamport),t.type){case`room.configured`:n.problems.length===0&&t.problems.length>0&&(n.problems=t.problems.map(e=>({...e})),n.system.push(`[系统] 房间题目已生成，共 ${t.problems.length} 题。`));break;case`player.joined`:n.players[t.actorId]={id:t.actorId,luoguName:t.luoguName.trim()||he(t.actorId),team:t.team,ready:n.players[t.actorId]?.ready??!1,online:!0},n.system.push(`[系统] ${t.luoguName} 加入 ${p(t.team)}。`);break;case`player.teamChanged`:n.players[t.actorId]&&n.phase===`lobby`&&(n.players[t.actorId].team=t.team,n.players[t.actorId].ready=!1,n.system.push(`[系统] ${m(n,t.actorId)} 切换到 ${p(t.team)}。`));break;case`player.readyChanged`:n.players[t.actorId]&&n.phase===`lobby`&&(n.players[t.actorId].ready=t.ready);break;case`game.started`:c(n)&&(n.phase=`arena`,n.system.push(`[系统] ${me(n)} 对决开始。`));break;case`chat.sent`:oe(n,t);break;case`vote.opened`:se(n,t.vote,t.issuedAt,t.actorId);break;case`vote.cast`:ce(n,t.voteId,t.actorId,t.approve);break;case`vote.cancelled`:le(n,t.voteId,t.actorId);break;case`judge.recordSeen`:ue(n,t.record),de(n,t.record,t.id);break}return fe(n),n},o=(e,t)=>e.problems.reduce((e,n)=>e+(n.solvedBy?.team===t?n.score:0),0),s=e=>Math.ceil(e.problems.reduce((e,t)=>e+t.score,0)/2),c=e=>{let t=Object.values(e.players);return e.phase===`lobby`&&e.problems.length>0&&t.length>=2&&t.every(e=>e.ready)&&t.some(e=>e.team===`red`)&&t.some(e=>e.team===`blue`)},ee=(e,t)=>{let n=e.players[t];return e.chats.filter(e=>e.visibility===`all`||e.team===n?.team)},l=e=>Object.keys(e.players).sort(),te=(e,t)=>t.kind===`surrender`&&t.team?l(e).filter(n=>e.players[n]?.team===t.team):l(e),ne=(e,t,n)=>{let r=new Set(e.problems.map(e=>e.pid)),i=pe(`${t}:${n}:${e.problems.length}`);for(let t=0;t<5e3;t+=1){let t=`P${1e3+Math.floor(i()*16001)}`;if(!r.has(t))return{pid:t,score:e.problems.find(e=>e.pid===n)?.score??d(e.problems.length)}}return{pid:`P${17e3+e.problems.length+1}`,score:d(e.problems.length)}},re=(e,t,n,r)=>({id:crypto.randomUUID(),kind:e,proposerId:t.id,team:e===`surrender`?t.team:void 0,targetPid:n,replacement:r}),ie=(e,t)=>e.lamport-t.lamport||e.issuedAt-t.issuedAt||e.id.localeCompare(t.id),ae=e=>({...e,players:Object.fromEntries(Object.entries(e.players).map(([e,t])=>[e,{...t}])),problems:e.problems.map(e=>({...e,solvedBy:e.solvedBy?{...e.solvedBy}:void 0})),chats:[...e.chats],feed:[...e.feed],votes:Object.fromEntries(Object.entries(e.votes).map(([e,t])=>[e,{...t,replacement:t.replacement?{...t.replacement}:void 0,approvals:{...t.approvals},rejections:{...t.rejections}}])),system:[...e.system]}),oe=(e,t)=>{let n=e.players[t.actorId];!n||t.text.trim().length===0||e.chats.push({id:t.id,actorId:t.actorId,luoguName:n.luoguName,team:n.team,visibility:t.visibility,text:t.text.trim().slice(0,500),at:t.issuedAt})},se=(e,t,n,r)=>{if(!e.players[r]||e.votes[t.id])return;let i={...t,approvals:{[r]:!0},rejections:{},status:`open`,createdAt:n};e.votes[i.id]=i,e.system.push(`[系统] ${m(e,r)} 发起${f(i)}。`),u(e,i)},ce=(e,t,n,r)=>{let i=e.votes[t];!i||i.status!==`open`||!te(e,i).includes(n)||(r?(i.approvals[n]=!0,delete i.rejections[n]):(i.rejections[n]=!0,i.status=`rejected`,e.system.push(`[系统] ${m(e,n)} 拒绝${f(i)}。`)),u(e,i))},le=(e,t,n)=>{let r=e.votes[t];!r||r.status!==`open`||r.proposerId!==n||(r.status=`cancelled`,e.system.push(`[系统] ${m(e,n)} 取消${f(r)}。`))},u=(e,t)=>{if(t.status!==`open`)return;let n=te(e,t);if(!(n.length===0||!n.every(e=>t.approvals[e]))){if(t.status=`passed`,t.kind===`replace-problem`&&t.targetPid&&t.replacement){let n={...t.replacement};e.problems=e.problems.map(e=>e.pid===t.targetPid?n:e),e.system.push(`[系统] ${t.targetPid} 已更换为 ${n.pid}。`)}t.kind===`delete-problem`&&t.targetPid&&(e.problems=e.problems.filter(e=>e.pid!==t.targetPid),e.system.push(`[系统] ${t.targetPid} 已删除。`)),t.kind===`draw`&&(e.phase=`finished`,e.winner=`draw`,e.system.push(`[系统] 双方同意平局。`)),t.kind===`surrender`&&t.team&&(e.phase=`finished`,e.winner=t.team===`red`?`blue`:`red`,e.system.push(`[系统] ${p(t.team)} 投降。`))}},ue=(t,n)=>{t.feed.some(e=>e.recordId===n.recordId&&e.pid===n.pid)||(t.feed.push(n),t.feed.sort((t,n)=>n.at-t.at||e[t.status]-e[n.status]||t.luoguName.localeCompare(n.luoguName)||t.pid.localeCompare(n.pid)),t.feed=t.feed.slice(0,120))},de=(e,t,n)=>{if(t.status!==`OK`)return;let r=Object.values(e.players).find(e=>e.luoguName===t.luoguName),i=e.problems.find(e=>e.pid===t.pid);if(!r||!i)return;let a={team:r.team,playerId:r.id,luoguName:r.luoguName,recordId:t.recordId||n,at:t.at},o=i.solvedBy;(!o||a.at<o.at||a.at===o.at&&a.recordId<o.recordId)&&(i.solvedBy=a,e.system.push(`[系统] ${p(r.team)} ${r.luoguName} 抢占 ${t.pid}。`))},fe=e=>{if(e.phase===`finished`||e.problems.length===0)return;let t=s(e);o(e,`red`)>=t&&(e.phase=`finished`,e.winner=`red`),o(e,`blue`)>=t&&(e.phase=`finished`,e.winner=`blue`)},d=e=>100+Math.floor(e/3)*50,pe=e=>{let t=2166136261;for(let n=0;n<e.length;n+=1)t^=e.charCodeAt(n),t=Math.imul(t,16777619);return()=>{t+=1831565813;let e=t;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}},me=e=>{let t=Object.values(e.players).filter(e=>e.team===`red`).map(e=>e.luoguName).join(` / `),n=Object.values(e.players).filter(e=>e.team===`blue`).map(e=>e.luoguName).join(` / `);return`${t||`红方`} vs ${n||`蓝方`}`},f=e=>e.kind===`replace-problem`?`更换 ${e.targetPid}`:e.kind===`delete-problem`?`删除 ${e.targetPid}`:e.kind===`draw`?`平局`:`投降`,p=e=>e===`red`?`红方`:`蓝方`,m=(e,t)=>e.players[t]?.luoguName??he(t),he=e=>e.slice(0,6),ge=`https://vd.gengen.qzz.io`,_e=`luogu-duel:v1`,ve=async e=>{let t=await fetch(`${ge}/get?key=${encodeURIComponent(be(e))}`,{cache:`no-store`});if(!t.ok)throw Error(`cloud get failed: ${t.status}`);let n=xe(await t.text());if(!n)return[];let r=JSON.parse(n);return r.roomId===e&&Array.isArray(r.envelopes)?r.envelopes:[]},ye=async(e,t)=>{let n={version:1,roomId:e,savedAt:Date.now(),envelopes:t.slice(-1e3)},r=await fetch(`${ge}/set?key=${encodeURIComponent(be(e))}`,{method:`POST`,headers:{"content-type":`application/json`},body:JSON.stringify(n),keepalive:!0});if(!r.ok)throw Error(`cloud set failed: ${r.status}`)},be=e=>`${_e}:room:${e}`,xe=e=>{let t=e.trim();if(!t||t===`null`||t===`undefined`)return``;try{let e=JSON.parse(t);if(typeof e==`string`)return e;if(e&&typeof e==`object`&&`value`in e){let t=e.value;return typeof t==`string`?t:JSON.stringify(t)}}catch{return t}return t},h=`luogu-duel.identity.v1`,Se=async()=>{let e=localStorage.getItem(h);return e?JSON.parse(e):Ce(`player_${Math.floor(Math.random()*1e4)}`)},Ce=async e=>{let t=await crypto.subtle.generateKey({name:`ECDSA`,namedCurve:`P-256`},!0,[`sign`,`verify`]),n=await crypto.subtle.exportKey(`jwk`,t.publicKey),r=await crypto.subtle.exportKey(`jwk`,t.privateKey),i={id:await De(n),luoguName:e,publicKey:n,privateKey:r};return localStorage.setItem(h,JSON.stringify(i)),i},we=async(e,t)=>{let n={...e,luoguName:t.trim()||e.luoguName};return localStorage.setItem(h,JSON.stringify(n)),n},Te=async(e,t)=>{let n=await crypto.subtle.importKey(`jwk`,e.privateKey,{name:`ECDSA`,namedCurve:`P-256`},!1,[`sign`]),r=await crypto.subtle.sign({name:`ECDSA`,hash:`SHA-256`},n,_(g(t)));return{publicKey:e.publicKey,event:t,signature:Oe(r)}},Ee=async e=>{if(await De(e.publicKey)!==e.event.actorId)return!1;let t=await crypto.subtle.importKey(`jwk`,e.publicKey,{name:`ECDSA`,namedCurve:`P-256`},!1,[`verify`]);return crypto.subtle.verify({name:`ECDSA`,hash:`SHA-256`},t,ke(e.signature),_(g(e.event)))},De=async e=>{let t=await crypto.subtle.digest(`SHA-256`,_(g(e)));return[...new Uint8Array(t)].map(e=>e.toString(16).padStart(2,`0`)).join(``).slice(0,24)},g=e=>typeof e!=`object`||!e?JSON.stringify(e):Array.isArray(e)?`[${e.map(g).join(`,`)}]`:`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${g(e[t])}`).join(`,`)}}`,_=e=>{let t=new TextEncoder().encode(e);return t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength)},Oe=e=>btoa(String.fromCharCode(...new Uint8Array(e))),ke=e=>{let t=Uint8Array.from(atob(e),e=>e.charCodeAt(0));return t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength)},Ae={12:`OK`,0:`PD`,2:`CE`,3:`WA`,4:`RE`,5:`TL`,6:`MLE`,7:`OLE`,11:`UKE`,AC:`OK`,Accepted:`OK`},je=async(e,t)=>{let n=new URL(`https://www.luogu.com.cn/record/list`);n.searchParams.set(`pid`,e),n.searchParams.set(`_contentOnly`,`1`);let r=await fetch(n,{credentials:`include`,headers:{accept:`application/json`}});if(!r.ok)throw Error(`Luogu records request failed: ${r.status}`);let i=v(await r.json()),a=new Set(t);return i.map(t=>{let n=t.user?.name,r=Me(t.status),i=t.problem?.pid??e;return!n||!r||!a.has(n)||i!==e?null:{id:crypto.randomUUID(),luoguName:n,pid:e,at:Ne(t.submitTime),status:r,recordId:String(t.id??`${n}-${e}-${t.submitTime??Date.now()}`)}}).filter(e=>!!e)},v=e=>{if(!e||typeof e!=`object`)return[];if(Array.isArray(e))return e.flatMap(v);let t=e;return Array.isArray(t.records)?t.records:Array.isArray(t.result)?t.result:Array.isArray(t.data)?t.data:Object.values(t).flatMap(v)},Me=e=>e===void 0?null:Ae[String(e)]??null,Ne=e=>typeof e==`number`?e<1e10?e*1e3:e:Date.now(),y=`85694b6a-9167-48dc-9e00-343d23d826ef`,b=`https://www.cpoauth.com`,Pe=`openid profile link:luogu`,x=`luogu-duel.oauth.verifier`,S=`luogu-duel.oauth.state`,C=`luogu-duel.oauth.return`,w=`luogu-duel.cp-session.v1`,T=async()=>{let e=Be(96),t=Be(32),n=await Ve(e);sessionStorage.setItem(x,e),sessionStorage.setItem(S,t),sessionStorage.setItem(C,location.pathname===`/callback`?`/`:`${location.pathname}${location.search}${location.hash}`);let r=new URL(`/oauth/authorize`,b);r.searchParams.set(`response_type`,`code`),r.searchParams.set(`client_id`,y),r.searchParams.set(`redirect_uri`,D()),r.searchParams.set(`scope`,Pe),r.searchParams.set(`state`,t),r.searchParams.set(`code_challenge`,n),r.searchParams.set(`code_challenge_method`,`S256`),location.href=r.toString()},Fe=async()=>{if(location.pathname!==`/callback`)return null;let e=new URLSearchParams(location.search),t=e.get(`code`),n=e.get(`state`),r=sessionStorage.getItem(S),i=sessionStorage.getItem(x),a=sessionStorage.getItem(C)||`/`;if(!t||!n||!r||n!==r||!i)throw Error(`CP OAuth 回调校验失败`);let o=await fetch(new URL(`/api/oauth/token`,b),{method:`POST`,headers:{"content-type":`application/json`},body:JSON.stringify({grant_type:`authorization_code`,code:t,redirect_uri:D(),client_id:y,code_verifier:i})});if(!o.ok)throw Error(`CP OAuth token failed: ${o.status}`);let s=await o.json(),c=await fetch(new URL(`/api/oauth/userinfo`,b),{headers:{authorization:`Bearer ${s.access_token}`}});if(!c.ok)throw Error(`CP OAuth userinfo failed: ${c.status}`);let ee=await c.json();E(),history.replaceState(null,``,a);let l=ze(ee);return l&&Le(l),l},Ie=()=>{let e=localStorage.getItem(w);return e?JSON.parse(e):null},Le=e=>{let t={luoguName:e,signedInAt:Date.now()};return localStorage.setItem(w,JSON.stringify(t)),t},Re=()=>{localStorage.removeItem(w),E()},E=()=>{sessionStorage.removeItem(x),sessionStorage.removeItem(S),sessionStorage.removeItem(C)},ze=e=>{let t=e.linked_accounts?.find(e=>e.platform?.toLowerCase()===`luogu`);return t?.username||t?.name||e.luogu?.username||e.luogu?.name||e.username||null},D=()=>`${location.origin}/callback`,Be=e=>[...crypto.getRandomValues(new Uint8Array(e))].map(e=>`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~`[e%66]).join(``),Ve=async e=>{let t=new TextEncoder().encode(e),n=await crypto.subtle.digest(`SHA-256`,t);return btoa(String.fromCharCode(...new Uint8Array(n))).replace(/\+/g,`-`).replace(/\//g,`_`).replace(/=+$/,``)},O=document.querySelector(`#app`);if(!O)throw Error(`Missing #app`);var k,A=`global`,He=`public-lobby`,j=[],M=t(A),N,Ue=0,P,F,I=!1,L=new Set,R=`正在初始化`,z=null,B=!1,V=``,We=()=>`luogu-duel.log.${A}`,H=`luogu-duel.history.v1`,Ge=async()=>{k=await Se(),window.addEventListener(`hashchange`,U),document.addEventListener(`visibilitychange`,()=>{document.hidden||K(`页面恢复`)}),O.addEventListener(`click`,tt),O.addEventListener(`submit`,et);let e=null,t=!1;try{e=await Fe(),e&&(k=await we(k,e),R=`已通过 CP OAuth 绑定 ${e}`)}catch(e){V=e instanceof Error?e.message:`CP OAuth 登录失败`,R=V,t=!0}if(z=Ie(),!z&&t){rt();return}if(!z&&location.pathname!==`/callback`){await T();return}if(!z){V=`CP OAuth 未能完成登录`,rt();return}z&&(k=await we(k,z.luoguName)),await U(),e&&await W({...G(`player.joined`),luoguName:e,team:M.players[k.id]?.team??Z()}),X()},U=async()=>{let e=new URLSearchParams(location.hash.slice(1));A=e.get(`room`)||`global`,He=e.get(`secret`)||(A===`global`?`public-lobby`:`public-room`),Xe(),j=ht(),M=i(A,j.map(e=>e.event)),L=new Set,await K(`进入房间`),await Ke(),Ye(),nt(),R=A===`global`?`公共大厅已连接 API 同步`:`房间已连接 API 同步`,X()},Ke=async()=>{j.some(e=>e.event.type===`player.joined`&&e.event.actorId===k.id)||await W({...G(`player.joined`),luoguName:k.luoguName,team:Z()})},W=async e=>{await qe(await Te(k,e)),L.add(e.id),q(350)},qe=async e=>{j.some(t=>t.event.id===e.event.id)||await Ee(e)&&(j.push(e),gt(),M=i(A,j.map(e=>e.event)),mt(),X(),Je())},G=e=>({type:e,roomId:A,actorId:k.id,id:crypto.randomUUID(),lamport:M.lamport+1,issuedAt:Date.now()}),Je=async()=>{c(M)&&(j.some(e=>e.event.type===`game.started`)||await W(G(`game.started`)))},Ye=()=>{let e=async()=>{await K(`轮询同步`),P=window.setTimeout(e,Qe())};P=window.setTimeout(e,Qe())},Xe=()=>{P&&window.clearTimeout(P),F&&window.clearTimeout(F),P=void 0,F=void 0,I=!1},K=async e=>{if(!I){I=!0;try{let t=await ve($e()),n=new Set(t.map(e=>e.event.id)),r=0;for(let e of t)j.some(t=>t.event.id===e.event.id)||(await qe(e),r+=1);L=new Set([...L].filter(e=>!n.has(e))),L.size>0&&q(900),R=r>0?`${e}：合并 ${r} 条事件`:`${e}：已是最新`}catch(e){R=e instanceof Error?e.message:`API 同步失败`}finally{I=!1,X()}}},q=e=>{F&&window.clearTimeout(F),F=window.setTimeout(()=>void Ze(),e)},Ze=async()=>{if(I||L.size===0){L.size>0&&q(1200);return}try{await ye($e(),j),R=`API 已写入 ${L.size} 条待确认事件`}catch(e){R=e instanceof Error?e.message:`API 写入失败`,q(3e3)}X()},Qe=()=>document.hidden?3e4:1e4,$e=()=>A===`global`?`global`:`${A}:${He}`,et=async e=>{e.preventDefault();let t=e.target,n=t.dataset.action,i=new FormData(t);if(n===`create-room`){let e=_t(Number(i.get(`count`)||9),3,21),t=String(i.get(`manual`)||``),n=Q(),a=Q()+Q();history.pushState(null,``,`#room=${n}&secret=${a}`),await U(),await W({...G(`room.configured`),problems:r(e,n,t)})}if(n===`chat`){let e=String(i.get(`message`)||``).trim();if(!e)return;t.reset(),await W({...G(`chat.sent`),text:e.startsWith(`/`)?e.slice(1).trim():e,visibility:e.startsWith(`/`)?`team`:`all`})}},tt=async e=>{let t=e.target.closest(`button[data-action]`);if(!t)return;let n=t.dataset.action,r=t.dataset.pid,i=t.dataset.vote,a=M.players[k.id];n===`home`&&(location.hash=``),n===`copy-link`&&await navigator.clipboard.writeText(location.href),n===`sync-now`&&await K(`手动同步`),n===`toggle-user-menu`&&(B=!B,X()),n===`oauth-login`&&await T(),n===`logout`&&(Re(),B=!1,await T()),n===`reset-id`&&(k=await Ce(k.luoguName),location.reload()),n===`team`&&t.dataset.team&&await W({...G(`player.teamChanged`),team:t.dataset.team}),n===`ready`&&await W({...G(`player.readyChanged`),ready:!(a?.ready??!1)}),n===`judge`&&r&&await Y(r),n===`vote-replace`&&r&&a&&await J(`replace-problem`,r,ne(M,crypto.randomUUID(),r)),n===`vote-delete`&&r&&await J(`delete-problem`,r),n===`vote-draw`&&await J(`draw`),n===`vote-surrender`&&await J(`surrender`),n===`vote-yes`&&i&&await W({...G(`vote.cast`),voteId:i,approve:!0}),n===`vote-no`&&i&&await W({...G(`vote.cast`),voteId:i,approve:!1}),n===`vote-cancel`&&i&&await W({...G(`vote.cancelled`),voteId:i})},J=async(e,t,n)=>{let r=M.players[k.id];r&&await W({...G(`vote.opened`),vote:re(e,r,t,n)})},Y=async e=>{let t=Object.values(M.players).map(e=>e.luoguName);try{R=`正在抓取 ${e} 的洛谷提交`,X();let n=await je(e,t);for(let e of n)await W({...G(`judge.recordSeen`),record:e});R=n.length>0?`${e} 同步到 ${n.length} 条记录`:`${e} 暂无参赛者提交`}catch(e){R=e instanceof Error?e.message:`洛谷记录抓取失败`}X()},nt=()=>{N&&window.clearInterval(N),N=window.setInterval(()=>{if(M.phase!==`arena`||M.problems.length===0)return;let e=M.problems[Ue%M.problems.length];Ue+=1,Y(e.pid)},1e4)},X=()=>{if(A===`global`){O.innerHTML=it(at());return}O.innerHTML=it(M.phase===`arena`||M.phase===`finished`?st():ot())},rt=()=>{O.innerHTML=`
    <main class="auth-gate">
      <section class="panel auth-card">
        <p class="eyebrow">CP OAUTH</p>
        <h1>登录没有完成</h1>
        <p class="lead">${$(V||`需要通过 CP OAuth 绑定洛谷用户名后继续。`)}</p>
        <div class="actions">
          <button class="primary" data-action="oauth-login">重新登录</button>
        </div>
      </section>
    </main>
  `},it=e=>`
  <header class="topbar">
    <div class="brand-row">
      <button class="brand" data-action="home">Luogu Duel</button>
      <span class="status-pill">${$(R)}</span>
      <span class="muted">待确认 ${L.size}</span>
    </div>
    <div class="user-area">
      <button class="user-button" data-action="toggle-user-menu">${$(z?.luoguName??k.luoguName)}</button>
      ${B?`<div class="user-menu">
              <button data-action="sync-now">立即同步</button>
              <button data-action="reset-id">重置本机密钥</button>
              <button data-action="logout">登出</button>
            </div>`:``}
    </div>
  </header>
  ${e}
`,at=()=>`
  <main class="home-grid">
    <section class="panel chat-panel">
      <div class="panel-title">
        <span>公共聊天室</span>
        <small>API 轮询同步</small>
      </div>
      ${ut()}
    </section>
    <section class="stack">
      <div class="panel hero-panel">
        <div>
          <p class="eyebrow">LOCKOUT MATCH</p>
          <h1>创建一场洛谷抢分对决</h1>
          <p class="lead">生成题目、邀请队友、准备后自动开局。所有房间状态通过云变量事件日志同步。</p>
        </div>
        <form class="create-form" data-action="create-room">
          <label>题目数量 <input type="number" name="count" min="3" max="21" value="9" /></label>
          <label>手动题号 <textarea name="manual" placeholder="留空则随机，例如 P1000 P1001"></textarea></label>
          <button class="primary">创建房间</button>
        </form>
      </div>
      <div class="panel">
        <div class="panel-title">
          <span>历史对局</span>
          <small>本地记录</small>
        </div>
        ${pt()}
      </div>
    </section>
  </main>
`,ot=()=>`
  <main class="lobby">
    <section class="panel">
      <div class="panel-title">
        <span>准备室</span>
        <button data-action="copy-link">复制邀请链接</button>
      </div>
      <div class="teams">
        ${ct(`red`)}
        ${ct(`blue`)}
      </div>
      <div class="actions">
        <button data-action="team" data-team="red">加入红方</button>
        <button data-action="team" data-team="blue">加入蓝方</button>
        <button class="primary" data-action="ready">${M.players[k.id]?.ready?`取消准备`:`准备就绪`}</button>
      </div>
      <p class="muted">所有人准备，且红蓝双方都有人后，会自动进入对决页。</p>
    </section>
    <section class="panel">
      <div class="panel-title">
        <span>题目池</span>
        <small>${M.problems.length} 题</small>
      </div>
      ${lt(!1)}
    </section>
  </main>
`,st=()=>`
  <main class="arena">
    <section class="panel">
      <div class="scoreboard">
        <strong class="red">红 ${o(M,`red`)}</strong>
        <span>胜利线 ${s(M)}</span>
        <strong class="blue">蓝 ${o(M,`blue`)}</strong>
      </div>
      ${M.winner?`<div class="result">${M.winner===`draw`?`平局`:`${M.winner===`red`?`红方`:`蓝方`}获胜`}</div>`:``}
      ${lt(!0)}
      <div class="actions">
        <button data-action="vote-surrender">投降</button>
        <button data-action="vote-draw">平局</button>
      </div>
      ${dt()}
    </section>
    <section class="panel chat-panel">
      <div class="panel-title">
        <span>房间通讯</span>
        <small>/ 开头为队内</small>
      </div>
      ${ut()}
      <div class="system-flow">${M.system.slice(-10).map(e=>`<p>${$(e)}</p>`).join(``)}</div>
    </section>
    <section class="panel">
      <div class="panel-title">
        <span>实时提交实况</span>
        <small>${M.feed.length} 条</small>
      </div>
      ${ft()}
    </section>
  </main>
`,ct=e=>`
  <div class="team ${e}">
    <h3>${e===`red`?`红方`:`蓝方`}</h3>
    ${Object.values(M.players).filter(t=>t.team===e).map(e=>`<div class="player"><span>${$(e.luoguName)}</span><span>${e.ready?`已准备`:`未准备`}</span></div>`).join(``)||`<p class="muted">等待玩家</p>`}
  </div>
`,lt=e=>`
  <table>
    <thead><tr><th>题目</th><th>分数</th><th>解题选手</th>${e?`<th>操作</th>`:``}</tr></thead>
    <tbody>
      ${M.problems.map(t=>`
        <tr class="${t.solvedBy?.team??``}">
          <td><a href="https://www.luogu.com.cn/problem/${t.pid}" target="_blank" rel="noreferrer">${t.pid}</a></td>
          <td>${t.score}</td>
          <td>${t.solvedBy?$(t.solvedBy.luoguName):`未抢占`}</td>
          ${e?`<td class="row-actions">
                  <button data-action="judge" data-pid="${t.pid}">判题</button>
                  <button data-action="vote-replace" data-pid="${t.pid}">换题</button>
                  <button data-action="vote-delete" data-pid="${t.pid}">删除</button>
                </td>`:``}
        </tr>`).join(``)}
    </tbody>
  </table>
`,ut=()=>`
  <div class="chat-log">
    ${ee(M,k.id).slice(-80).map(e=>`
        <p class="${e.visibility===`team`?`private`:``}">
          <span>${e.visibility===`team`?`队内`:`公屏`} · ${$(e.luoguName)}</span>
          ${$(e.text)}
        </p>`).join(``)}
  </div>
  <form class="chat-form" data-action="chat">
    <input name="message" placeholder="输入消息，/ 开头为队内私聊" />
    <button>发送</button>
  </form>
`,dt=()=>{let e=Object.values(M.votes).filter(e=>e.status===`open`);return e.length===0?``:`<div class="votes">
    ${e.map(e=>`
      <div class="vote">
        <span>${e.kind} ${e.targetPid??``}</span>
        <span>${Object.keys(e.approvals).length}/${Object.keys(M.players).length}</span>
        <button data-action="vote-yes" data-vote="${e.id}">同意</button>
        <button data-action="vote-no" data-vote="${e.id}">拒绝</button>
        ${e.proposerId===k.id?`<button data-action="vote-cancel" data-vote="${e.id}">取消</button>`:``}
      </div>`).join(``)}
  </div>`},ft=()=>`
  <table>
    <thead><tr><th>用户</th><th>题目</th><th>时间</th><th>状态</th></tr></thead>
    <tbody>
      ${M.feed.map(e=>`
        <tr>
          <td>${$(e.luoguName)}</td>
          <td>${e.pid}</td>
          <td>${vt(e.at)}</td>
          <td><strong>${e.status}</strong></td>
        </tr>`).join(``)}
    </tbody>
  </table>
`,pt=()=>{let e=JSON.parse(localStorage.getItem(H)||`[]`);return e.length===0?`<p class="muted">暂无历史对局。</p>`:e.slice(-8).reverse().map(e=>`<div class="history"><span>${$(e.roomId)}</span><span>${$(e.result)}</span></div>`).join(``)},mt=()=>{if(A===`global`||!M.winner)return;let e=JSON.parse(localStorage.getItem(H)||`[]`),t=M.winner===`draw`?`平局`:`${M.winner===`red`?`红方`:`蓝方`}胜`,n=e.filter(e=>e.roomId!==A).concat({roomId:A,result:t,at:Date.now()});localStorage.setItem(H,JSON.stringify(n.slice(-30)))},ht=()=>JSON.parse(localStorage.getItem(We())||`[]`),gt=()=>localStorage.setItem(We(),JSON.stringify(j.slice(-1e3))),Z=()=>Object.values(M.players).filter(e=>e.team===`red`).length<=Object.values(M.players).filter(e=>e.team===`blue`).length?`red`:`blue`,Q=()=>crypto.randomUUID().replaceAll(`-`,``).slice(0,10),_t=(e,t,n)=>Math.max(t,Math.min(n,Number.isFinite(e)?e:t)),vt=e=>new Date(e).toLocaleString(`zh-CN`,{hour12:!1}),$=e=>e.replace(/[&<>"']/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`})[e]??e);Ge();