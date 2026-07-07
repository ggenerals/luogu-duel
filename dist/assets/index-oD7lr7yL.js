(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e={OK:0,WA:1,TL:2,RE:3,CE:4,MLE:5,OLE:6,UKE:7,PD:8},t=e=>({roomId:e,phase:e===`global`?`home`:`lobby`,players:{},problems:[],chats:[],feed:[],votes:{},system:[],lamport:0}),n=e=>{let t=e.trim().toUpperCase();return/^P\d{1,5}$/.test(t)?t:``},r=(e,t,r)=>{let i=r.split(/[\s,，]+/).map(n).filter(Boolean);if(i.length>0)return i.map((e,t)=>({pid:e,score:u(t)}));let a=new Set,o=[],s=me(t);for(;o.length<e;){let e=`P${1e3+Math.floor(s()*16001)}`;a.has(e)||(a.add(e),o.push({pid:e,score:u(o.length)}))}return o},i=(e,n)=>n.filter(t=>t.roomId===e).sort(ie).reduce(a,t(e)),a=(e,t)=>{let n=ae(e);switch(n.lamport=Math.max(n.lamport,t.lamport),t.type){case`room.configured`:n.problems.length===0&&t.problems.length>0&&(n.problems=t.problems.map(e=>({...e})),n.system.push(`[系统] 房间题目已生成，共 ${t.problems.length} 题。`));break;case`player.joined`:n.players[t.actorId]={id:t.actorId,luoguName:t.luoguName.trim()||ge(t.actorId),team:t.team,ready:n.players[t.actorId]?.ready??!1,online:!0},n.system.push(`[系统] ${t.luoguName} 加入 ${f(t.team)}。`);break;case`player.teamChanged`:n.players[t.actorId]&&n.phase===`lobby`&&(n.players[t.actorId].team=t.team,n.players[t.actorId].ready=!1,n.system.push(`[系统] ${p(n,t.actorId)} 切换到 ${f(t.team)}。`));break;case`player.readyChanged`:n.players[t.actorId]&&n.phase===`lobby`&&(n.players[t.actorId].ready=t.ready);break;case`game.started`:c(n)&&(n.phase=`arena`,n.system.push(`[系统] ${he(n)} 对决开始。`));break;case`chat.sent`:oe(n,t);break;case`vote.opened`:se(n,t.vote,t.issuedAt,t.actorId);break;case`vote.cast`:ce(n,t.voteId,t.actorId,t.approve);break;case`vote.cancelled`:le(n,t.voteId,t.actorId);break;case`judge.recordSeen`:de(n,t.record),fe(n,t.record,t.id);break}return pe(n),n},o=(e,t)=>e.problems.reduce((e,n)=>e+(n.solvedBy?.team===t?n.score:0),0),s=e=>Math.ceil(e.problems.reduce((e,t)=>e+t.score,0)/2),c=e=>{let t=Object.values(e.players);return e.phase===`lobby`&&e.problems.length>0&&t.length>=2&&t.every(e=>e.ready)&&t.some(e=>e.team===`red`)&&t.some(e=>e.team===`blue`)},ee=(e,t)=>{let n=e.players[t];return e.chats.filter(e=>e.visibility===`all`||e.team===n?.team)},l=e=>Object.keys(e.players).sort(),te=(e,t)=>t.kind===`surrender`&&t.team?l(e).filter(n=>e.players[n]?.team===t.team):l(e),ne=(e,t,n)=>{let r=new Set(e.problems.map(e=>e.pid)),i=me(`${t}:${n}:${e.problems.length}`);for(let t=0;t<5e3;t+=1){let t=`P${1e3+Math.floor(i()*16001)}`;if(!r.has(t))return{pid:t,score:e.problems.find(e=>e.pid===n)?.score??u(e.problems.length)}}return{pid:`P${17e3+e.problems.length+1}`,score:u(e.problems.length)}},re=(e,t,n,r)=>({id:crypto.randomUUID(),kind:e,proposerId:t.id,team:e===`surrender`?t.team:void 0,targetPid:n,replacement:r}),ie=(e,t)=>e.lamport-t.lamport||e.issuedAt-t.issuedAt||e.id.localeCompare(t.id),ae=e=>({...e,players:Object.fromEntries(Object.entries(e.players).map(([e,t])=>[e,{...t}])),problems:e.problems.map(e=>({...e,solvedBy:e.solvedBy?{...e.solvedBy}:void 0})),chats:[...e.chats],feed:[...e.feed],votes:Object.fromEntries(Object.entries(e.votes).map(([e,t])=>[e,{...t,replacement:t.replacement?{...t.replacement}:void 0,approvals:{...t.approvals},rejections:{...t.rejections}}])),system:[...e.system]}),oe=(e,t)=>{let n=e.players[t.actorId];!n||t.text.trim().length===0||e.chats.push({id:t.id,actorId:t.actorId,luoguName:n.luoguName,team:n.team,visibility:t.visibility,text:t.text.trim().slice(0,500),at:t.issuedAt})},se=(e,t,n,r)=>{if(!e.players[r]||e.votes[t.id])return;let i={...t,approvals:{[r]:!0},rejections:{},status:`open`,createdAt:n};e.votes[i.id]=i,e.system.push(`[系统] ${p(e,r)} 发起${d(i)}。`),ue(e,i)},ce=(e,t,n,r)=>{let i=e.votes[t];!i||i.status!==`open`||!te(e,i).includes(n)||(r?(i.approvals[n]=!0,delete i.rejections[n]):(i.rejections[n]=!0,i.status=`rejected`,e.system.push(`[系统] ${p(e,n)} 拒绝${d(i)}。`)),ue(e,i))},le=(e,t,n)=>{let r=e.votes[t];!r||r.status!==`open`||r.proposerId!==n||(r.status=`cancelled`,e.system.push(`[系统] ${p(e,n)} 取消${d(r)}。`))},ue=(e,t)=>{if(t.status!==`open`)return;let n=te(e,t);if(!(n.length===0||!n.every(e=>t.approvals[e]))){if(t.status=`passed`,t.kind===`replace-problem`&&t.targetPid&&t.replacement){let n={...t.replacement};e.problems=e.problems.map(e=>e.pid===t.targetPid?n:e),e.system.push(`[系统] ${t.targetPid} 已更换为 ${n.pid}。`)}t.kind===`delete-problem`&&t.targetPid&&(e.problems=e.problems.filter(e=>e.pid!==t.targetPid),e.system.push(`[系统] ${t.targetPid} 已删除。`)),t.kind===`draw`&&(e.phase=`finished`,e.winner=`draw`,e.system.push(`[系统] 双方同意平局。`)),t.kind===`surrender`&&t.team&&(e.phase=`finished`,e.winner=t.team===`red`?`blue`:`red`,e.system.push(`[系统] ${f(t.team)} 投降。`))}},de=(t,n)=>{t.feed.some(e=>e.recordId===n.recordId&&e.pid===n.pid)||(t.feed.push(n),t.feed.sort((t,n)=>n.at-t.at||e[t.status]-e[n.status]||t.luoguName.localeCompare(n.luoguName)||t.pid.localeCompare(n.pid)),t.feed=t.feed.slice(0,120))},fe=(e,t,n)=>{if(t.status!==`OK`)return;let r=Object.values(e.players).find(e=>e.luoguName===t.luoguName),i=e.problems.find(e=>e.pid===t.pid);if(!r||!i)return;let a={team:r.team,playerId:r.id,luoguName:r.luoguName,recordId:t.recordId||n,at:t.at},o=i.solvedBy;(!o||a.at<o.at||a.at===o.at&&a.recordId<o.recordId)&&(i.solvedBy=a,e.system.push(`[系统] ${f(r.team)} ${r.luoguName} 抢占 ${t.pid}。`))},pe=e=>{if(e.phase===`finished`||e.problems.length===0)return;let t=s(e);o(e,`red`)>=t&&(e.phase=`finished`,e.winner=`red`),o(e,`blue`)>=t&&(e.phase=`finished`,e.winner=`blue`)},u=e=>100+Math.floor(e/3)*50,me=e=>{let t=2166136261;for(let n=0;n<e.length;n+=1)t^=e.charCodeAt(n),t=Math.imul(t,16777619);return()=>{t+=1831565813;let e=t;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}},he=e=>{let t=Object.values(e.players).filter(e=>e.team===`red`).map(e=>e.luoguName).join(` / `),n=Object.values(e.players).filter(e=>e.team===`blue`).map(e=>e.luoguName).join(` / `);return`${t||`红方`} vs ${n||`蓝方`}`},d=e=>e.kind===`replace-problem`?`更换 ${e.targetPid}`:e.kind===`delete-problem`?`删除 ${e.targetPid}`:e.kind===`draw`?`平局`:`投降`,f=e=>e===`red`?`红方`:`蓝方`,p=(e,t)=>e.players[t]?.luoguName??ge(t),ge=e=>e.slice(0,6),_e=`https://vd.gengen.qzz.io`,ve=`luogu-duel:v1`,ye=async e=>{let t=await fetch(`${_e}/get?key=${encodeURIComponent(m(e))}`,{cache:`no-store`});if(!t.ok)throw Error(`cloud get failed: ${t.status}`);let n=xe(await t.text());if(!n)return[];let r=JSON.parse(n);return r.roomId===e&&Array.isArray(r.envelopes)?r.envelopes:[]},be=async(e,t)=>{let n={version:1,roomId:e,savedAt:Date.now(),envelopes:t.slice(-1e3)},r=await fetch(`${_e}/set?key=${encodeURIComponent(m(e))}`,{method:`POST`,headers:{"content-type":`application/json`},body:JSON.stringify(n),keepalive:!0});if(!r.ok)throw Error(`cloud set failed: ${r.status}`)},m=e=>`${ve}:room:${e}`,xe=e=>{let t=e.trim();if(!t||t===`null`||t===`undefined`)return``;try{let e=JSON.parse(t);if(typeof e==`string`)return e;if(e&&typeof e==`object`&&`value`in e){let t=e.value;return typeof t==`string`?t:JSON.stringify(t)}}catch{return t}return t},h=`luogu-duel.identity.v1`,Se=async()=>{let e=localStorage.getItem(h);return e?JSON.parse(e):Ce(`player_${Math.floor(Math.random()*1e4)}`)},Ce=async e=>{let t=await crypto.subtle.generateKey({name:`ECDSA`,namedCurve:`P-256`},!0,[`sign`,`verify`]),n=await crypto.subtle.exportKey(`jwk`,t.publicKey),r=await crypto.subtle.exportKey(`jwk`,t.privateKey),i={id:await _(n),luoguName:e,publicKey:n,privateKey:r};return localStorage.setItem(h,JSON.stringify(i)),i},g=async(e,t)=>{let n={...e,luoguName:t.trim()||e.luoguName};return localStorage.setItem(h,JSON.stringify(n)),n},we=async(e,t)=>{let n=await crypto.subtle.importKey(`jwk`,e.privateKey,{name:`ECDSA`,namedCurve:`P-256`},!1,[`sign`]),r=await crypto.subtle.sign({name:`ECDSA`,hash:`SHA-256`},n,y(v(t)));return{publicKey:e.publicKey,event:t,signature:Ee(r)}},Te=async e=>{if(await _(e.publicKey)!==e.event.actorId)return!1;let t=await crypto.subtle.importKey(`jwk`,e.publicKey,{name:`ECDSA`,namedCurve:`P-256`},!1,[`verify`]);return crypto.subtle.verify({name:`ECDSA`,hash:`SHA-256`},t,De(e.signature),y(v(e.event)))},_=async e=>{let t=await crypto.subtle.digest(`SHA-256`,y(v(e)));return[...new Uint8Array(t)].map(e=>e.toString(16).padStart(2,`0`)).join(``).slice(0,24)},v=e=>typeof e!=`object`||!e?JSON.stringify(e):Array.isArray(e)?`[${e.map(v).join(`,`)}]`:`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${v(e[t])}`).join(`,`)}}`,y=e=>{let t=new TextEncoder().encode(e);return t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength)},Ee=e=>btoa(String.fromCharCode(...new Uint8Array(e))),De=e=>{let t=Uint8Array.from(atob(e),e=>e.charCodeAt(0));return t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength)},Oe={12:`OK`,0:`PD`,2:`CE`,3:`WA`,4:`RE`,5:`TL`,6:`MLE`,7:`OLE`,11:`UKE`,AC:`OK`,Accepted:`OK`},ke=async(e,t)=>{let n=new URL(`https://www.luogu.com.cn/record/list`);n.searchParams.set(`pid`,e),n.searchParams.set(`_contentOnly`,`1`);let r=await fetch(`https://jiashu.1win.eu.org/${n.toString()}`,{headers:{accept:`application/json`}});if(!r.ok)throw Error(`Luogu records request failed: ${r.status}`);let i=b(await r.json()),a=new Set(t);return i.map(t=>{let n=t.user?.name,r=Ae(t.status),i=t.problem?.pid??e;return!n||!r||!a.has(n)||i!==e?null:{id:crypto.randomUUID(),luoguName:n,pid:e,at:je(t.submitTime),status:r,recordId:String(t.id??`${n}-${e}-${t.submitTime??Date.now()}`)}}).filter(e=>!!e)},b=e=>{if(!e||typeof e!=`object`)return[];if(Array.isArray(e))return e.flatMap(b);let t=e;return Array.isArray(t.records)?t.records:Array.isArray(t.result)?t.result:Array.isArray(t.data)?t.data:Object.values(t).flatMap(b)},Ae=e=>e===void 0?null:Oe[String(e)]??null,je=e=>typeof e==`number`?e<1e10?e*1e3:e:Date.now(),x=`85694b6a-9167-48dc-9e00-343d23d826ef`,S=`https://www.cpoauth.com`,Me=`https://oauth.gengen.qzz.io/oauth/callback`,Ne=`openid profile link:luogu`,C=`luogu-duel.oauth.verifier`,w=`luogu-duel.oauth.state`,T=`luogu-duel.oauth.return`,E=`luogu-duel.cp-session.v1`,D=async()=>{let e=Be(96),t=Be(32),n=await Ve(e);sessionStorage.setItem(C,e),sessionStorage.setItem(w,t),sessionStorage.setItem(T,location.pathname===`/callback`?`/`:`${location.pathname}${location.search}${location.hash}`);let r=new URL(`/oauth/authorize`,S);r.searchParams.set(`response_type`,`code`),r.searchParams.set(`client_id`,x),r.searchParams.set(`redirect_uri`,k()),r.searchParams.set(`scope`,Ne),r.searchParams.set(`state`,t),r.searchParams.set(`code_challenge`,n),r.searchParams.set(`code_challenge_method`,`S256`),location.href=r.toString()},Pe=async()=>{if(location.pathname!==`/callback`)return null;let e=new URLSearchParams(location.search),t=e.get(`code`),n=e.get(`state`),r=sessionStorage.getItem(w),i=sessionStorage.getItem(C),a=sessionStorage.getItem(T)||`/`;if(!t||!n||!r||n!==r||!i)throw Error(`CP OAuth 回调校验失败`);{let e=await Fe(t,i);return O(),history.replaceState(null,``,a),e&&Le(e),e}let o=await fetch(new URL(`/api/oauth/token`,S),{method:`POST`,headers:{"content-type":`application/json`},body:JSON.stringify({grant_type:`authorization_code`,code:t,redirect_uri:k(),client_id:x,code_verifier:i})});if(!o.ok)throw Error(`CP OAuth token failed: ${o.status}`);let s=await o.json(),c=await fetch(new URL(`/api/oauth/userinfo`,S),{headers:{authorization:`Bearer ${s.access_token}`}});if(!c.ok)throw Error(`CP OAuth userinfo failed: ${c.status}`);let ee=await c.json();O(),history.replaceState(null,``,a);let l=ze(ee);return l&&Le(l),l},Fe=async(e,t)=>{let n=await fetch(Me,{method:`POST`,headers:{"content-type":`application/json`},body:JSON.stringify({code:e,code_verifier:t,redirect_uri:k(),client_id:x})});if(!n.ok)throw Error(`CP OAuth proxy failed: ${n.status}`);let r=await n.json();return r.luoguName||r.username||(r.userinfo?ze(r.userinfo):null)},Ie=()=>{let e=localStorage.getItem(E);return e?JSON.parse(e):null},Le=e=>{let t={luoguName:e,signedInAt:Date.now()};return localStorage.setItem(E,JSON.stringify(t)),t},Re=()=>{localStorage.removeItem(E),O()},O=()=>{sessionStorage.removeItem(C),sessionStorage.removeItem(w),sessionStorage.removeItem(T)},ze=e=>{let t=e.linked_accounts?.find(e=>e.platform?.toLowerCase()===`luogu`);return t?.username||t?.name||e.luogu?.username||e.luogu?.name||e.username||null},k=()=>`${location.origin}/callback`,Be=e=>[...crypto.getRandomValues(new Uint8Array(e))].map(e=>`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~`[e%66]).join(``),Ve=async e=>{let t=new TextEncoder().encode(e),n=await crypto.subtle.digest(`SHA-256`,t);return btoa(String.fromCharCode(...new Uint8Array(n))).replace(/\+/g,`-`).replace(/\//g,`_`).replace(/=+$/,``)},A=document.querySelector(`#app`);if(!A)throw Error(`Missing #app`);var j,M=`global`,He=`public-lobby`,N=[],P=t(M),F,Ue=0,I,L,R=!1,z=new Set,B=`正在初始化`,V=null,H=!1,U=``,We=()=>`luogu-duel.log.${M}`,W=`luogu-duel.history.v1`,Ge=async()=>{j=await Se(),window.addEventListener(`hashchange`,G),document.addEventListener(`visibilitychange`,()=>{document.hidden||J(`页面恢复`)}),A.addEventListener(`click`,tt),A.addEventListener(`submit`,et);let e=null,t=!1;try{e=await Pe(),e&&(j=await g(j,e),B=`已通过 CP OAuth 绑定 ${e}`)}catch(e){U=e instanceof Error?e.message:`CP OAuth 登录失败`,B=U,t=!0}if(V=Ie(),!V&&t){ot();return}if(!V&&location.pathname!==`/callback`){await D();return}if(!V){U=`CP OAuth 未能完成登录`,ot();return}V&&(j=await g(j,V.luoguName)),await G(),e&&await K({...q(`player.joined`),luoguName:e,team:P.players[j.id]?.team??bt()}),Z()},G=async()=>{let e=new URLSearchParams(location.hash.slice(1));M=e.get(`room`)||`global`,He=e.get(`secret`)||(M===`global`?`public-lobby`:`public-room`),Xe(),N=vt(),P=i(M,N.map(e=>e.event)),z=new Set,await J(`进入房间`),await Ke(),Ye(),rt(),B=M===`global`?`公共大厅已连接 API 同步`:`房间已连接 API 同步`,Z()},Ke=async()=>{N.some(e=>e.event.type===`player.joined`&&e.event.actorId===j.id)||await K({...q(`player.joined`),luoguName:j.luoguName,team:bt()})},K=async e=>{await qe(await we(j,e)),z.add(e.id),Y(350)},qe=async e=>{N.some(t=>t.event.id===e.event.id)||await Te(e)&&(N.push(e),yt(),P=i(M,N.map(e=>e.event)),_t(),Z(),Je())},q=e=>({type:e,roomId:M,actorId:j.id,id:crypto.randomUUID(),lamport:P.lamport+1,issuedAt:Date.now()}),Je=async()=>{c(P)&&(N.some(e=>e.event.type===`game.started`)||await K(q(`game.started`)))},Ye=()=>{let e=async()=>{await J(`轮询同步`),I=window.setTimeout(e,Qe())};I=window.setTimeout(e,Qe())},Xe=()=>{I&&window.clearTimeout(I),L&&window.clearTimeout(L),I=void 0,L=void 0,R=!1},J=async e=>{if(!R){R=!0;try{let t=await ye($e()),n=new Set(t.map(e=>e.event.id)),r=0;for(let e of t)N.some(t=>t.event.id===e.event.id)||(await qe(e),r+=1);z=new Set([...[...z].filter(e=>!n.has(e)),...N.filter(e=>e.event.roomId===M&&!n.has(e.event.id)).map(e=>e.event.id)]),z.size>0&&Y(900),B=r>0?`${e}：合并 ${r} 条事件`:`${e}：已是最新`}catch(e){B=e instanceof Error?e.message:`API 同步失败`}finally{R=!1,Z()}}},Y=e=>{L&&window.clearTimeout(L),L=window.setTimeout(()=>void Ze(),e)},Ze=async()=>{if(R||z.size===0){z.size>0&&Y(1200);return}try{await be($e(),N),B=`API 已写入 ${z.size} 条待确认事件`}catch(e){B=e instanceof Error?e.message:`API 写入失败`,Y(3e3)}Z()},Qe=()=>document.hidden?3e4:1e4,$e=()=>M===`global`?`global`:`${M}:${He}`,et=async e=>{e.preventDefault();let t=e.target,n=t.dataset.action,i=new FormData(t);if(n===`create-room`){let e=xt(Number(i.get(`count`)||9),3,21),t=String(i.get(`manual`)||``),n=Q(),a=Q()+Q();history.pushState(null,``,`#room=${n}&secret=${a}`),await G(),await K({...q(`room.configured`),problems:r(e,n,t)})}if(n===`chat`){let e=String(i.get(`message`)||``).trim();if(!e)return;t.reset();let n=M!==`global`&&e.startsWith(`/`);await K({...q(`chat.sent`),text:n?e.slice(1).trim():e,visibility:n?`team`:`all`})}},tt=async e=>{let t=e.target.closest(`button[data-action]`);if(!t)return;let n=t.dataset.action,r=t.dataset.pid,i=t.dataset.vote,a=P.players[j.id];n===`home`&&(location.hash=``),n===`copy-link`&&await navigator.clipboard.writeText(location.href),n===`sync-now`&&await J(`手动同步`),n===`toggle-user-menu`&&(H=!H,Z()),n===`oauth-login`&&await D(),n===`logout`&&(Re(),H=!1,await D()),n===`reset-id`&&(j=await Ce(j.luoguName),location.reload()),n===`team`&&t.dataset.team&&await K({...q(`player.teamChanged`),team:t.dataset.team}),n===`ready`&&await K({...q(`player.readyChanged`),ready:!(a?.ready??!1)}),n===`judge`&&r&&await nt(r),n===`vote-replace`&&r&&a&&await X(`replace-problem`,r,ne(P,crypto.randomUUID(),r)),n===`vote-delete`&&r&&await X(`delete-problem`,r),n===`vote-draw`&&await X(`draw`),n===`vote-surrender`&&await X(`surrender`),n===`vote-yes`&&i&&await K({...q(`vote.cast`),voteId:i,approve:!0}),n===`vote-no`&&i&&await K({...q(`vote.cast`),voteId:i,approve:!1}),n===`vote-cancel`&&i&&await K({...q(`vote.cancelled`),voteId:i})},X=async(e,t,n)=>{let r=P.players[j.id];r&&await K({...q(`vote.opened`),vote:re(e,r,t,n)})},nt=async e=>{let t=Object.values(P.players).map(e=>e.luoguName);try{B=`正在抓取 ${e} 的洛谷提交`,Z();let n=await ke(e,t);for(let e of n)await K({...q(`judge.recordSeen`),record:e});B=n.length>0?`${e} 同步到 ${n.length} 条记录`:`${e} 暂无参赛者提交`}catch(e){B=e instanceof Error?e.message:`洛谷记录抓取失败`}Z()},rt=()=>{F&&window.clearInterval(F),F=window.setInterval(()=>{if(P.phase!==`arena`||P.problems.length===0)return;let e=P.problems[Ue%P.problems.length];Ue+=1,nt(e.pid)},1e4)},Z=()=>{let e=it();if(M===`global`){A.innerHTML=st(ct()),at(e);return}A.innerHTML=st(P.phase===`arena`||P.phase===`finished`?ut():lt()),at(e)},it=()=>{let e=document.activeElement;return{field:e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement?{formAction:e.closest(`form`)?.dataset.action,name:e.name,value:e.value,selectionStart:e.selectionStart,selectionEnd:e.selectionEnd}:void 0,scrolls:[...A.querySelectorAll(`[data-scroll-key]`)].map(e=>({key:e.dataset.scrollKey||``,top:e.scrollTop,left:e.scrollLeft,atBottom:e.scrollHeight-e.clientHeight-e.scrollTop<12}))}},at=e=>{for(let t of e.scrolls){let e=A.querySelector(`[data-scroll-key="${t.key}"]`);e&&(e.scrollTop=t.atBottom?e.scrollHeight:t.top,e.scrollLeft=t.left)}let t=e.field;if(!t?.name)return;let n=t.formAction?`form[data-action="${t.formAction}"] `:``,r=A.querySelector(`${n}[name="${t.name}"]`);r&&(r.value=t.value,r.focus(),t.selectionStart!==null&&t.selectionEnd!==null&&r.setSelectionRange(t.selectionStart,t.selectionEnd))},ot=()=>{A.innerHTML=`
    <main class="auth-gate">
      <section class="panel auth-card">
        <p class="eyebrow">CP OAUTH</p>
        <h1>登录没有完成</h1>
        <p class="lead">${$(U||`需要通过 CP OAuth 绑定洛谷用户名后继续。`)}</p>
        <div class="actions">
          <button class="primary" data-action="oauth-login">重新登录</button>
        </div>
      </section>
    </main>
  `},st=e=>`
  <header class="topbar">
    <div class="brand-row">
      <button class="brand" data-action="home">Luogu Duel</button>
      <span class="status-pill">${$(B)}</span>
      <span class="muted">待确认 ${z.size}</span>
    </div>
    <div class="user-area">
      <button class="user-button" data-action="toggle-user-menu">${$(V?.luoguName??j.luoguName)}</button>
      ${H?`<div class="user-menu">
              <button data-action="sync-now">立即同步</button>
              <button data-action="reset-id">重置本机密钥</button>
              <button data-action="logout">登出</button>
            </div>`:``}
    </div>
  </header>
  ${e}
`,ct=()=>`
  <main class="home-grid">
    <section class="panel chat-panel">
      <div class="panel-title">
        <span>公共聊天室</span>
        <small>API 轮询同步</small>
      </div>
      ${pt()}
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
        ${gt()}
      </div>
    </section>
  </main>
`,lt=()=>`
  <main class="lobby">
    <section class="panel">
      <div class="panel-title">
        <span>准备室</span>
        <button data-action="copy-link">复制邀请链接</button>
      </div>
      <div class="teams">
        ${dt(`red`)}
        ${dt(`blue`)}
      </div>
      <div class="actions">
        <button data-action="team" data-team="red">加入红方</button>
        <button data-action="team" data-team="blue">加入蓝方</button>
        <button class="primary" data-action="ready">${P.players[j.id]?.ready?`取消准备`:`准备就绪`}</button>
      </div>
      <p class="muted">所有人准备，且红蓝双方都有人后，会自动进入对决页。</p>
    </section>
    <section class="panel">
      <div class="panel-title">
        <span>题目池</span>
        <small>${P.problems.length} 题</small>
      </div>
      <div class="table-scroll" data-scroll-key="lobby-problems">${ft(!1)}</div>
    </section>
  </main>
`,ut=()=>`
  <main class="arena">
    <section class="panel">
      <div class="scoreboard">
        <strong class="red">红 ${o(P,`red`)}</strong>
        <span>胜利线 ${s(P)}</span>
        <strong class="blue">蓝 ${o(P,`blue`)}</strong>
      </div>
      ${P.winner?`<div class="result">${P.winner===`draw`?`平局`:`${P.winner===`red`?`红方`:`蓝方`}获胜`}</div>`:``}
      <div class="table-scroll problem-scroll" data-scroll-key="arena-problems">${ft(!0)}</div>
      <div class="actions">
        <button data-action="vote-surrender">投降</button>
        <button data-action="vote-draw">平局</button>
      </div>
      ${mt()}
    </section>
    <section class="panel chat-panel">
      <div class="panel-title">
        <span>房间通讯</span>
        <small>/ 开头为队内</small>
      </div>
      ${pt()}
      <div class="system-flow" data-scroll-key="system">${P.system.slice(-10).map(e=>`<p>${$(e)}</p>`).join(``)}</div>
    </section>
    <section class="panel">
      <div class="panel-title">
        <span>实时提交实况</span>
        <small>${P.feed.length} 条</small>
      </div>
      <div class="table-scroll feed-scroll" data-scroll-key="feed">${ht()}</div>
    </section>
  </main>
`,dt=e=>`
  <div class="team ${e}">
    <h3>${e===`red`?`红方`:`蓝方`}</h3>
    ${Object.values(P.players).filter(t=>t.team===e).map(e=>`<div class="player"><span>${$(e.luoguName)}</span><span>${e.ready?`已准备`:`未准备`}</span></div>`).join(``)||`<p class="muted">等待玩家</p>`}
  </div>
`,ft=e=>`
  <table>
    <thead><tr><th>题目</th><th>分数</th><th>解题选手</th>${e?`<th>操作</th>`:``}</tr></thead>
    <tbody>
      ${P.problems.map(t=>`
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
`,pt=()=>`
  <div class="chat-log" data-scroll-key="chat">
    ${(M===`global`?P.chats.filter(e=>e.visibility===`all`):ee(P,j.id)).slice(-80).map(e=>`
        <p class="${e.visibility===`team`?`private`:``}">
          <span>${e.visibility===`team`?`队内`:`公屏`} · ${$(e.luoguName)}</span>
          ${$(e.text)}
        </p>`).join(``)}
  </div>
  <form class="chat-form" data-action="chat">
    <input name="message" placeholder="${M===`global`?`输入公共消息`:`输入消息，/ 开头为队内私聊`}" />
    <button>发送</button>
  </form>
`,mt=()=>{let e=Object.values(P.votes).filter(e=>e.status===`open`);return e.length===0?``:`<div class="votes">
    ${e.map(e=>`
      <div class="vote">
        <span>${e.kind} ${e.targetPid??``}</span>
        <span>${Object.keys(e.approvals).length}/${Object.keys(P.players).length}</span>
        <button data-action="vote-yes" data-vote="${e.id}">同意</button>
        <button data-action="vote-no" data-vote="${e.id}">拒绝</button>
        ${e.proposerId===j.id?`<button data-action="vote-cancel" data-vote="${e.id}">取消</button>`:``}
      </div>`).join(``)}
  </div>`},ht=()=>`
  <table>
    <thead><tr><th>用户</th><th>题目</th><th>时间</th><th>状态</th></tr></thead>
    <tbody>
      ${P.feed.map(e=>`
        <tr>
          <td>${$(e.luoguName)}</td>
          <td>${e.pid}</td>
          <td>${St(e.at)}</td>
          <td><strong>${e.status}</strong></td>
        </tr>`).join(``)}
    </tbody>
  </table>
`,gt=()=>{let e=JSON.parse(localStorage.getItem(W)||`[]`);return e.length===0?`<p class="muted">暂无历史对局。</p>`:e.slice(-8).reverse().map(e=>`<div class="history"><span>${$(e.roomId)}</span><span>${$(e.result)}</span></div>`).join(``)},_t=()=>{if(M===`global`||!P.winner)return;let e=JSON.parse(localStorage.getItem(W)||`[]`),t=P.winner===`draw`?`平局`:`${P.winner===`red`?`红方`:`蓝方`}胜`,n=e.filter(e=>e.roomId!==M).concat({roomId:M,result:t,at:Date.now()});localStorage.setItem(W,JSON.stringify(n.slice(-30)))},vt=()=>JSON.parse(localStorage.getItem(We())||`[]`),yt=()=>localStorage.setItem(We(),JSON.stringify(N.slice(-1e3))),bt=()=>Object.values(P.players).filter(e=>e.team===`red`).length<=Object.values(P.players).filter(e=>e.team===`blue`).length?`red`:`blue`,Q=()=>crypto.randomUUID().replaceAll(`-`,``).slice(0,10),xt=(e,t,n)=>Math.max(t,Math.min(n,Number.isFinite(e)?e:t)),St=e=>new Date(e).toLocaleString(`zh-CN`,{hour12:!1}),$=e=>e.replace(/[&<>"']/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`})[e]??e);Ge();