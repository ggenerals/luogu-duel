(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e={OK:0,WA:1,TL:2,RE:3,CE:4,MLE:5,OLE:6,UKE:7,PD:8},t=e=>({roomId:e,phase:e===`global`?`home`:`lobby`,players:{},problems:[],chats:[],feed:[],votes:{},system:[],lamport:0}),n=e=>{let t=e.trim().toUpperCase();return/^P\d{1,5}$/.test(t)?t:``},r=(e,t,r)=>{let i=r.split(/[\s,，]+/).map(n).filter(Boolean);if(i.length>0)return i.map((e,t)=>({pid:e,score:f(t)}));let a=new Set,o=[],s=fe(t);for(;o.length<e;){let e=`P${1e3+Math.floor(s()*16001)}`;a.has(e)||(a.add(e),o.push({pid:e,score:f(o.length)}))}return o},i=(e,n)=>n.filter(t=>t.roomId===e).sort(re).reduce(a,t(e)),a=(e,t)=>{let n=ie(e);switch(n.lamport=Math.max(n.lamport,t.lamport),t.type){case`room.configured`:n.problems.length===0&&t.problems.length>0&&(n.problems=t.problems.map(e=>({...e})),n.system.push(`[系统] 房间题目已生成，共 ${t.problems.length} 题。`));break;case`player.joined`:n.players[t.actorId]={id:t.actorId,luoguName:t.luoguName.trim()||me(t.actorId),team:t.team,ready:n.players[t.actorId]?.ready??!1,online:!0},n.system.push(`[系统] ${t.luoguName} 加入 ${m(t.team)}。`);break;case`player.teamChanged`:n.players[t.actorId]&&n.phase===`lobby`&&(n.players[t.actorId].team=t.team,n.players[t.actorId].ready=!1,n.system.push(`[系统] ${h(n,t.actorId)} 切换到 ${m(t.team)}。`));break;case`player.readyChanged`:n.players[t.actorId]&&n.phase===`lobby`&&(n.players[t.actorId].ready=t.ready);break;case`game.started`:c(n)&&(n.phase=`arena`,n.system.push(`[系统] ${pe(n)} 对决开始。`));break;case`chat.sent`:ae(n,t);break;case`vote.opened`:oe(n,t.vote,t.issuedAt,t.actorId);break;case`vote.cast`:se(n,t.voteId,t.actorId,t.approve);break;case`vote.cancelled`:ce(n,t.voteId,t.actorId);break;case`judge.recordSeen`:le(n,t.record),ue(n,t.record,t.id);break}return de(n),n},o=(e,t)=>e.problems.reduce((e,n)=>e+(n.solvedBy?.team===t?n.score:0),0),s=e=>Math.ceil(e.problems.reduce((e,t)=>e+t.score,0)/2),c=e=>{let t=Object.values(e.players);return e.phase===`lobby`&&e.problems.length>0&&t.length>=2&&t.every(e=>e.ready)&&t.some(e=>e.team===`red`)&&t.some(e=>e.team===`blue`)},l=(e,t)=>{let n=e.players[t];return e.chats.filter(e=>e.visibility===`all`||e.team===n?.team)},u=e=>Object.keys(e.players).sort(),ee=(e,t)=>t.kind===`surrender`&&t.team?u(e).filter(n=>e.players[n]?.team===t.team):u(e),te=(e,t,n)=>{let r=new Set(e.problems.map(e=>e.pid)),i=fe(`${t}:${n}:${e.problems.length}`);for(let t=0;t<5e3;t+=1){let t=`P${1e3+Math.floor(i()*16001)}`;if(!r.has(t))return{pid:t,score:e.problems.find(e=>e.pid===n)?.score??f(e.problems.length)}}return{pid:`P${17e3+e.problems.length+1}`,score:f(e.problems.length)}},ne=(e,t,n,r)=>({id:crypto.randomUUID(),kind:e,proposerId:t.id,team:e===`surrender`?t.team:void 0,targetPid:n,replacement:r}),re=(e,t)=>e.lamport-t.lamport||e.issuedAt-t.issuedAt||e.id.localeCompare(t.id),ie=e=>({...e,players:Object.fromEntries(Object.entries(e.players).map(([e,t])=>[e,{...t}])),problems:e.problems.map(e=>({...e,solvedBy:e.solvedBy?{...e.solvedBy}:void 0})),chats:[...e.chats],feed:[...e.feed],votes:Object.fromEntries(Object.entries(e.votes).map(([e,t])=>[e,{...t,replacement:t.replacement?{...t.replacement}:void 0,approvals:{...t.approvals},rejections:{...t.rejections}}])),system:[...e.system]}),ae=(e,t)=>{let n=e.players[t.actorId];!n||t.text.trim().length===0||e.chats.push({id:t.id,actorId:t.actorId,luoguName:n.luoguName,team:n.team,visibility:t.visibility,text:t.text.trim().slice(0,500),at:t.issuedAt})},oe=(e,t,n,r)=>{if(!e.players[r]||e.votes[t.id])return;let i={...t,approvals:{[r]:!0},rejections:{},status:`open`,createdAt:n};e.votes[i.id]=i,e.system.push(`[系统] ${h(e,r)} 发起${p(i)}。`),d(e,i)},se=(e,t,n,r)=>{let i=e.votes[t];!i||i.status!==`open`||!ee(e,i).includes(n)||(r?(i.approvals[n]=!0,delete i.rejections[n]):(i.rejections[n]=!0,i.status=`rejected`,e.system.push(`[系统] ${h(e,n)} 拒绝${p(i)}。`)),d(e,i))},ce=(e,t,n)=>{let r=e.votes[t];!r||r.status!==`open`||r.proposerId!==n||(r.status=`cancelled`,e.system.push(`[系统] ${h(e,n)} 取消${p(r)}。`))},d=(e,t)=>{if(t.status!==`open`)return;let n=ee(e,t);if(!(n.length===0||!n.every(e=>t.approvals[e]))){if(t.status=`passed`,t.kind===`replace-problem`&&t.targetPid&&t.replacement){let n={...t.replacement};e.problems=e.problems.map(e=>e.pid===t.targetPid?n:e),e.system.push(`[系统] ${t.targetPid} 已更换为 ${n.pid}。`)}t.kind===`delete-problem`&&t.targetPid&&(e.problems=e.problems.filter(e=>e.pid!==t.targetPid),e.system.push(`[系统] ${t.targetPid} 已删除。`)),t.kind===`draw`&&(e.phase=`finished`,e.winner=`draw`,e.system.push(`[系统] 双方同意平局。`)),t.kind===`surrender`&&t.team&&(e.phase=`finished`,e.winner=t.team===`red`?`blue`:`red`,e.system.push(`[系统] ${m(t.team)} 投降。`))}},le=(t,n)=>{t.feed.some(e=>e.recordId===n.recordId&&e.pid===n.pid)||(t.feed.push(n),t.feed.sort((t,n)=>n.at-t.at||e[t.status]-e[n.status]||t.luoguName.localeCompare(n.luoguName)||t.pid.localeCompare(n.pid)),t.feed=t.feed.slice(0,120))},ue=(e,t,n)=>{if(t.status!==`OK`)return;let r=Object.values(e.players).find(e=>e.luoguName===t.luoguName),i=e.problems.find(e=>e.pid===t.pid);if(!r||!i)return;let a={team:r.team,playerId:r.id,luoguName:r.luoguName,recordId:t.recordId||n,at:t.at},o=i.solvedBy;(!o||a.at<o.at||a.at===o.at&&a.recordId<o.recordId)&&(i.solvedBy=a,e.system.push(`[系统] ${m(r.team)} ${r.luoguName} 抢占 ${t.pid}。`))},de=e=>{if(e.phase===`finished`||e.problems.length===0)return;let t=s(e);o(e,`red`)>=t&&(e.phase=`finished`,e.winner=`red`),o(e,`blue`)>=t&&(e.phase=`finished`,e.winner=`blue`)},f=e=>100+Math.floor(e/3)*50,fe=e=>{let t=2166136261;for(let n=0;n<e.length;n+=1)t^=e.charCodeAt(n),t=Math.imul(t,16777619);return()=>{t+=1831565813;let e=t;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}},pe=e=>{let t=Object.values(e.players).filter(e=>e.team===`red`).map(e=>e.luoguName).join(` / `),n=Object.values(e.players).filter(e=>e.team===`blue`).map(e=>e.luoguName).join(` / `);return`${t||`红方`} vs ${n||`蓝方`}`},p=e=>e.kind===`replace-problem`?`更换 ${e.targetPid}`:e.kind===`delete-problem`?`删除 ${e.targetPid}`:e.kind===`draw`?`平局`:`投降`,m=e=>e===`red`?`红方`:`蓝方`,h=(e,t)=>e.players[t]?.luoguName??me(t),me=e=>e.slice(0,6),he=`https://vd.gengen.qzz.io`,ge=`luogu-duel:v1`,_e=async e=>{let t=await fetch(`${he}/get?key=${encodeURIComponent(ye(e))}`,{cache:`no-store`});if(!t.ok)throw Error(`cloud get failed: ${t.status}`);let n=be(await t.text());if(!n)return[];let r=JSON.parse(n);return r.roomId===e&&Array.isArray(r.envelopes)?r.envelopes:[]},ve=async(e,t)=>{let n={version:1,roomId:e,savedAt:Date.now(),envelopes:t.slice(-1e3)},r=await fetch(`${he}/set?key=${encodeURIComponent(ye(e))}`,{method:`POST`,headers:{"content-type":`application/json`},body:JSON.stringify(n),keepalive:!0});if(!r.ok)throw Error(`cloud set failed: ${r.status}`)},ye=e=>`${ge}:room:${e}`,be=e=>{let t=e.trim();if(!t||t===`null`||t===`undefined`)return``;try{let e=JSON.parse(t);if(typeof e==`string`)return e;if(e&&typeof e==`object`&&`value`in e){let t=e.value;return typeof t==`string`?t:JSON.stringify(t)}}catch{return t}return t},g=`luogu-duel.identity.v1`,xe=async()=>{let e=localStorage.getItem(g);return e?JSON.parse(e):Se(`player_${Math.floor(Math.random()*1e4)}`)},Se=async e=>{let t=await crypto.subtle.generateKey({name:`ECDSA`,namedCurve:`P-256`},!0,[`sign`,`verify`]),n=await crypto.subtle.exportKey(`jwk`,t.publicKey),r=await crypto.subtle.exportKey(`jwk`,t.privateKey),i={id:await Ee(n),luoguName:e,publicKey:n,privateKey:r};return localStorage.setItem(g,JSON.stringify(i)),i},Ce=async(e,t)=>{let n={...e,luoguName:t.trim()||e.luoguName};return localStorage.setItem(g,JSON.stringify(n)),n},we=async(e,t)=>{let n=await crypto.subtle.importKey(`jwk`,e.privateKey,{name:`ECDSA`,namedCurve:`P-256`},!1,[`sign`]),r=await crypto.subtle.sign({name:`ECDSA`,hash:`SHA-256`},n,v(_(t)));return{publicKey:e.publicKey,event:t,signature:De(r)}},Te=async e=>{if(await Ee(e.publicKey)!==e.event.actorId)return!1;let t=await crypto.subtle.importKey(`jwk`,e.publicKey,{name:`ECDSA`,namedCurve:`P-256`},!1,[`verify`]);return crypto.subtle.verify({name:`ECDSA`,hash:`SHA-256`},t,Oe(e.signature),v(_(e.event)))},Ee=async e=>{let t=await crypto.subtle.digest(`SHA-256`,v(_(e)));return[...new Uint8Array(t)].map(e=>e.toString(16).padStart(2,`0`)).join(``).slice(0,24)},_=e=>typeof e!=`object`||!e?JSON.stringify(e):Array.isArray(e)?`[${e.map(_).join(`,`)}]`:`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${_(e[t])}`).join(`,`)}}`,v=e=>{let t=new TextEncoder().encode(e);return t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength)},De=e=>btoa(String.fromCharCode(...new Uint8Array(e))),Oe=e=>{let t=Uint8Array.from(atob(e),e=>e.charCodeAt(0));return t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength)},ke={12:`OK`,0:`PD`,2:`CE`,3:`WA`,4:`RE`,5:`TL`,6:`MLE`,7:`OLE`,11:`UKE`,AC:`OK`,Accepted:`OK`},Ae=async(e,t)=>{let n=new URL(`https://www.luogu.com.cn/record/list`);n.searchParams.set(`pid`,e),n.searchParams.set(`_contentOnly`,`1`);let r=await fetch(n,{credentials:`include`,headers:{accept:`application/json`}});if(!r.ok)throw Error(`Luogu records request failed: ${r.status}`);let i=y(await r.json()),a=new Set(t);return i.map(t=>{let n=t.user?.name,r=je(t.status),i=t.problem?.pid??e;return!n||!r||!a.has(n)||i!==e?null:{id:crypto.randomUUID(),luoguName:n,pid:e,at:Me(t.submitTime),status:r,recordId:String(t.id??`${n}-${e}-${t.submitTime??Date.now()}`)}}).filter(e=>!!e)},y=e=>{if(!e||typeof e!=`object`)return[];if(Array.isArray(e))return e.flatMap(y);let t=e;return Array.isArray(t.records)?t.records:Array.isArray(t.result)?t.result:Array.isArray(t.data)?t.data:Object.values(t).flatMap(y)},je=e=>e===void 0?null:ke[String(e)]??null,Me=e=>typeof e==`number`?e<1e10?e*1e3:e:Date.now(),b=`85694b6a-9167-48dc-9e00-343d23d826ef`,x=`https://www.cpoauth.com`,Ne=`openid profile link:luogu`,S=`luogu-duel.oauth.verifier`,C=`luogu-duel.oauth.state`,w=`luogu-duel.oauth.return`,T=`luogu-duel.cp-session.v1`,E=async()=>{let e=O(96),t=O(32),n=await ze(e);sessionStorage.setItem(S,e),sessionStorage.setItem(C,t),sessionStorage.setItem(w,location.pathname===`/callback`?`/`:`${location.pathname}${location.search}${location.hash}`);let r=new URL(`/oauth/authorize`,x);r.searchParams.set(`response_type`,`code`),r.searchParams.set(`client_id`,b),r.searchParams.set(`redirect_uri`,D()),r.searchParams.set(`scope`,Ne),r.searchParams.set(`state`,t),r.searchParams.set(`code_challenge`,n),r.searchParams.set(`code_challenge_method`,`S256`),location.href=r.toString()},Pe=async()=>{if(location.pathname!==`/callback`)return null;let e=new URLSearchParams(location.search),t=e.get(`code`),n=e.get(`state`),r=sessionStorage.getItem(C),i=sessionStorage.getItem(S),a=sessionStorage.getItem(w)||`/`;if(!t||!n||!r||n!==r||!i)throw Error(`CP OAuth 回调校验失败`);let o=await fetch(new URL(`/oauth/token`,x),{method:`POST`,headers:{"content-type":`application/json`},body:JSON.stringify({grant_type:`authorization_code`,code:t,redirect_uri:D(),client_id:b,code_verifier:i})});if(!o.ok)throw Error(`CP OAuth token failed: ${o.status}`);let s=await o.json(),c=await fetch(new URL(`/oauth/userinfo`,x),{headers:{authorization:`Bearer ${s.access_token}`}});if(!c.ok)throw Error(`CP OAuth userinfo failed: ${c.status}`);let l=await c.json();sessionStorage.removeItem(S),sessionStorage.removeItem(C),sessionStorage.removeItem(w),history.replaceState(null,``,a);let u=Re(l);return u&&Ie(u),u},Fe=()=>{let e=localStorage.getItem(T);return e?JSON.parse(e):null},Ie=e=>{let t={luoguName:e,signedInAt:Date.now()};return localStorage.setItem(T,JSON.stringify(t)),t},Le=()=>{localStorage.removeItem(T),sessionStorage.removeItem(S),sessionStorage.removeItem(C),sessionStorage.removeItem(w)},Re=e=>{let t=e.linked_accounts?.find(e=>e.platform?.toLowerCase()===`luogu`);return t?.username||t?.name||e.luogu?.username||e.luogu?.name||e.username||null},D=()=>`${location.origin}/callback`,O=e=>[...crypto.getRandomValues(new Uint8Array(e))].map(e=>`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~`[e%66]).join(``),ze=async e=>{let t=new TextEncoder().encode(e),n=await crypto.subtle.digest(`SHA-256`,t);return btoa(String.fromCharCode(...new Uint8Array(n))).replace(/\+/g,`-`).replace(/\//g,`_`).replace(/=+$/,``)},k=document.querySelector(`#app`);if(!k)throw Error(`Missing #app`);var A,j=`global`,Be=`public-lobby`,M=[],N=t(j),P,Ve=0,F,I,L=!1,R=new Set,z=`正在初始化`,B=null,V=!1,He=()=>`luogu-duel.log.${j}`,H=`luogu-duel.history.v1`,Ue=async()=>{A=await xe();let e=null;try{e=await Pe(),e&&(A=await Ce(A,e),z=`已通过 CP OAuth 绑定 ${e}`)}catch(e){z=e instanceof Error?e.message:`CP OAuth 登录失败`}if(B=Fe(),!B&&location.pathname!==`/callback`){await E();return}B&&(A=await Ce(A,B.luoguName)),await U(),e&&await W({...G(`player.joined`),luoguName:e,team:N.players[A.id]?.team??Z()}),window.addEventListener(`hashchange`,U),document.addEventListener(`visibilitychange`,()=>{document.hidden||K(`页面恢复`)}),k.addEventListener(`click`,$e),k.addEventListener(`submit`,Qe),Y()},U=async()=>{let e=new URLSearchParams(location.hash.slice(1));j=e.get(`room`)||`global`,Be=e.get(`secret`)||(j===`global`?`public-lobby`:`public-room`),Je(),M=ft(),N=i(j,M.map(e=>e.event)),R=new Set,await K(`进入房间`),await We(),qe(),tt(),z=j===`global`?`公共大厅已连接 API 同步`:`房间已连接 API 同步`,Y()},We=async()=>{M.some(e=>e.event.type===`player.joined`&&e.event.actorId===A.id)||await W({...G(`player.joined`),luoguName:A.luoguName,team:Z()})},W=async e=>{await Ge(await we(A,e)),R.add(e.id),q(350)},Ge=async e=>{M.some(t=>t.event.id===e.event.id)||await Te(e)&&(M.push(e),pt(),N=i(j,M.map(e=>e.event)),dt(),Y(),Ke())},G=e=>({type:e,roomId:j,actorId:A.id,id:crypto.randomUUID(),lamport:N.lamport+1,issuedAt:Date.now()}),Ke=async()=>{c(N)&&(M.some(e=>e.event.type===`game.started`)||await W(G(`game.started`)))},qe=()=>{let e=async()=>{await K(`轮询同步`),F=window.setTimeout(e,Xe())};F=window.setTimeout(e,Xe())},Je=()=>{F&&window.clearTimeout(F),I&&window.clearTimeout(I),F=void 0,I=void 0,L=!1},K=async e=>{if(!L){L=!0;try{let t=await _e(Ze()),n=new Set(t.map(e=>e.event.id)),r=0;for(let e of t)M.some(t=>t.event.id===e.event.id)||(await Ge(e),r+=1);R=new Set([...R].filter(e=>!n.has(e))),R.size>0&&q(900),z=r>0?`${e}：合并 ${r} 条事件`:`${e}：已是最新`}catch(e){z=e instanceof Error?e.message:`API 同步失败`}finally{L=!1,Y()}}},q=e=>{I&&window.clearTimeout(I),I=window.setTimeout(()=>void Ye(),e)},Ye=async()=>{if(L||R.size===0){R.size>0&&q(1200);return}try{await ve(Ze(),M),z=`API 已写入 ${R.size} 条待确认事件`}catch(e){z=e instanceof Error?e.message:`API 写入失败`,q(3e3)}Y()},Xe=()=>document.hidden?3e4:1e4,Ze=()=>j===`global`?`global`:`${j}:${Be}`,Qe=async e=>{e.preventDefault();let t=e.target,n=t.dataset.action,i=new FormData(t);if(n===`create-room`){let e=mt(Number(i.get(`count`)||9),3,21),t=String(i.get(`manual`)||``),n=Q(),a=Q()+Q();history.pushState(null,``,`#room=${n}&secret=${a}`),await U(),await W({...G(`room.configured`),problems:r(e,n,t)})}if(n===`chat`){let e=String(i.get(`message`)||``).trim();if(!e)return;t.reset(),await W({...G(`chat.sent`),text:e.startsWith(`/`)?e.slice(1).trim():e,visibility:e.startsWith(`/`)?`team`:`all`})}},$e=async e=>{let t=e.target.closest(`button[data-action]`);if(!t)return;let n=t.dataset.action,r=t.dataset.pid,i=t.dataset.vote,a=N.players[A.id];n===`home`&&(location.hash=``),n===`copy-link`&&await navigator.clipboard.writeText(location.href),n===`sync-now`&&await K(`手动同步`),n===`toggle-user-menu`&&(V=!V,Y()),n===`oauth-login`&&await E(),n===`logout`&&(Le(),V=!1,await E()),n===`reset-id`&&(A=await Se(A.luoguName),location.reload()),n===`team`&&t.dataset.team&&await W({...G(`player.teamChanged`),team:t.dataset.team}),n===`ready`&&await W({...G(`player.readyChanged`),ready:!(a?.ready??!1)}),n===`judge`&&r&&await et(r),n===`vote-replace`&&r&&a&&await J(`replace-problem`,r,te(N,crypto.randomUUID(),r)),n===`vote-delete`&&r&&await J(`delete-problem`,r),n===`vote-draw`&&await J(`draw`),n===`vote-surrender`&&await J(`surrender`),n===`vote-yes`&&i&&await W({...G(`vote.cast`),voteId:i,approve:!0}),n===`vote-no`&&i&&await W({...G(`vote.cast`),voteId:i,approve:!1}),n===`vote-cancel`&&i&&await W({...G(`vote.cancelled`),voteId:i})},J=async(e,t,n)=>{let r=N.players[A.id];r&&await W({...G(`vote.opened`),vote:ne(e,r,t,n)})},et=async e=>{let t=Object.values(N.players).map(e=>e.luoguName);try{z=`正在抓取 ${e} 的洛谷提交`,Y();let n=await Ae(e,t);for(let e of n)await W({...G(`judge.recordSeen`),record:e});z=n.length>0?`${e} 同步到 ${n.length} 条记录`:`${e} 暂无参赛者提交`}catch(e){z=e instanceof Error?e.message:`洛谷记录抓取失败`}Y()},tt=()=>{P&&window.clearInterval(P),P=window.setInterval(()=>{if(N.phase!==`arena`||N.problems.length===0)return;let e=N.problems[Ve%N.problems.length];Ve+=1,et(e.pid)},1e4)},Y=()=>{if(j===`global`){k.innerHTML=nt(rt());return}k.innerHTML=nt(N.phase===`arena`||N.phase===`finished`?at():it())},nt=e=>`
  <header class="topbar">
    <div class="brand-row">
      <button class="brand" data-action="home">Luogu Duel</button>
      <span class="status-pill">${$(z)}</span>
      <span class="muted">待确认 ${R.size}</span>
    </div>
    <div class="user-area">
      <button class="user-button" data-action="toggle-user-menu">${$(B?.luoguName??A.luoguName)}</button>
      ${V?`<div class="user-menu">
              <button data-action="sync-now">立即同步</button>
              <button data-action="reset-id">重置本机密钥</button>
              <button data-action="logout">登出</button>
            </div>`:``}
    </div>
  </header>
  ${e}
`,rt=()=>`
  <main class="home-grid">
    <section class="panel chat-panel">
      <div class="panel-title">
        <span>公共聊天室</span>
        <small>API 轮询同步</small>
      </div>
      ${X()}
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
        ${ut()}
      </div>
    </section>
  </main>
`,it=()=>`
  <main class="lobby">
    <section class="panel">
      <div class="panel-title">
        <span>准备室</span>
        <button data-action="copy-link">复制邀请链接</button>
      </div>
      <div class="teams">
        ${ot(`red`)}
        ${ot(`blue`)}
      </div>
      <div class="actions">
        <button data-action="team" data-team="red">加入红方</button>
        <button data-action="team" data-team="blue">加入蓝方</button>
        <button class="primary" data-action="ready">${N.players[A.id]?.ready?`取消准备`:`准备就绪`}</button>
      </div>
      <p class="muted">所有人准备，且红蓝双方都有人后，会自动进入对决页。</p>
    </section>
    <section class="panel">
      <div class="panel-title">
        <span>题目池</span>
        <small>${N.problems.length} 题</small>
      </div>
      ${st(!1)}
    </section>
  </main>
`,at=()=>`
  <main class="arena">
    <section class="panel">
      <div class="scoreboard">
        <strong class="red">红 ${o(N,`red`)}</strong>
        <span>胜利线 ${s(N)}</span>
        <strong class="blue">蓝 ${o(N,`blue`)}</strong>
      </div>
      ${N.winner?`<div class="result">${N.winner===`draw`?`平局`:`${N.winner===`red`?`红方`:`蓝方`}获胜`}</div>`:``}
      ${st(!0)}
      <div class="actions">
        <button data-action="vote-surrender">投降</button>
        <button data-action="vote-draw">平局</button>
      </div>
      ${ct()}
    </section>
    <section class="panel chat-panel">
      <div class="panel-title">
        <span>房间通讯</span>
        <small>/ 开头为队内</small>
      </div>
      ${X()}
      <div class="system-flow">${N.system.slice(-10).map(e=>`<p>${$(e)}</p>`).join(``)}</div>
    </section>
    <section class="panel">
      <div class="panel-title">
        <span>实时提交实况</span>
        <small>${N.feed.length} 条</small>
      </div>
      ${lt()}
    </section>
  </main>
`,ot=e=>`
  <div class="team ${e}">
    <h3>${e===`red`?`红方`:`蓝方`}</h3>
    ${Object.values(N.players).filter(t=>t.team===e).map(e=>`<div class="player"><span>${$(e.luoguName)}</span><span>${e.ready?`已准备`:`未准备`}</span></div>`).join(``)||`<p class="muted">等待玩家</p>`}
  </div>
`,st=e=>`
  <table>
    <thead><tr><th>题目</th><th>分数</th><th>解题选手</th>${e?`<th>操作</th>`:``}</tr></thead>
    <tbody>
      ${N.problems.map(t=>`
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
`,X=()=>`
  <div class="chat-log">
    ${l(N,A.id).slice(-80).map(e=>`
        <p class="${e.visibility===`team`?`private`:``}">
          <span>${e.visibility===`team`?`队内`:`公屏`} · ${$(e.luoguName)}</span>
          ${$(e.text)}
        </p>`).join(``)}
  </div>
  <form class="chat-form" data-action="chat">
    <input name="message" placeholder="输入消息，/ 开头为队内私聊" />
    <button>发送</button>
  </form>
`,ct=()=>{let e=Object.values(N.votes).filter(e=>e.status===`open`);return e.length===0?``:`<div class="votes">
    ${e.map(e=>`
      <div class="vote">
        <span>${e.kind} ${e.targetPid??``}</span>
        <span>${Object.keys(e.approvals).length}/${Object.keys(N.players).length}</span>
        <button data-action="vote-yes" data-vote="${e.id}">同意</button>
        <button data-action="vote-no" data-vote="${e.id}">拒绝</button>
        ${e.proposerId===A.id?`<button data-action="vote-cancel" data-vote="${e.id}">取消</button>`:``}
      </div>`).join(``)}
  </div>`},lt=()=>`
  <table>
    <thead><tr><th>用户</th><th>题目</th><th>时间</th><th>状态</th></tr></thead>
    <tbody>
      ${N.feed.map(e=>`
        <tr>
          <td>${$(e.luoguName)}</td>
          <td>${e.pid}</td>
          <td>${ht(e.at)}</td>
          <td><strong>${e.status}</strong></td>
        </tr>`).join(``)}
    </tbody>
  </table>
`,ut=()=>{let e=JSON.parse(localStorage.getItem(H)||`[]`);return e.length===0?`<p class="muted">暂无历史对局。</p>`:e.slice(-8).reverse().map(e=>`<div class="history"><span>${$(e.roomId)}</span><span>${$(e.result)}</span></div>`).join(``)},dt=()=>{if(j===`global`||!N.winner)return;let e=JSON.parse(localStorage.getItem(H)||`[]`),t=N.winner===`draw`?`平局`:`${N.winner===`red`?`红方`:`蓝方`}胜`,n=e.filter(e=>e.roomId!==j).concat({roomId:j,result:t,at:Date.now()});localStorage.setItem(H,JSON.stringify(n.slice(-30)))},ft=()=>JSON.parse(localStorage.getItem(He())||`[]`),pt=()=>localStorage.setItem(He(),JSON.stringify(M.slice(-1e3))),Z=()=>Object.values(N.players).filter(e=>e.team===`red`).length<=Object.values(N.players).filter(e=>e.team===`blue`).length?`red`:`blue`,Q=()=>crypto.randomUUID().replaceAll(`-`,``).slice(0,10),mt=(e,t,n)=>Math.max(t,Math.min(n,Number.isFinite(e)?e:t)),ht=e=>new Date(e).toLocaleString(`zh-CN`,{hour12:!1}),$=e=>e.replace(/[&<>"']/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`})[e]??e);Ue();