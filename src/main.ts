import "./style.css";
import {
  applyEvents,
  buildVote,
  canStart,
  createInitialState,
  createReplacementProblem,
  makeProblemSet,
  scoreOf,
  visibleChats,
  winThreshold
} from "./domain";
import { loadCloudSnapshot, saveCloudSnapshot } from "./cloudStore";
import { createIdentity, loadIdentity, renameIdentity, signEvent, verifyEnvelope, type LocalIdentity } from "./identity";
import { fetchLuoguRecords } from "./luogu";
import { completeCpOAuthLogin, loadCpSession, logoutCpSession, startCpOAuthLogin, type CpSession } from "./oauth";
import type { DuelEvent, DuelState, Problem, SignedEnvelope, Team, VoteKind } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

let identity: LocalIdentity;
let roomId = "global";
let roomSecret = "public-lobby";
let envelopes: SignedEnvelope[] = [];
let state: DuelState = createInitialState(roomId);
let judgeTimer: number | undefined;
let judgeCursor = 0;
let apiPollTimer: number | undefined;
let apiSaveTimer: number | undefined;
let apiBusy = false;
let dirtyEventIds = new Set<string>();
let statusText = "正在初始化";
let cpSession: CpSession | null = null;
let userMenuOpen = false;
let authErrorText = "";

const storageKey = () => `luogu-duel.log.${roomId}`;
const historyKey = "luogu-duel.history.v1";

const boot = async () => {
  identity = await loadIdentity();
  window.addEventListener("hashchange", enterFromHash);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pullApiSnapshot("页面恢复");
  });
  app.addEventListener("click", handleClick);
  app.addEventListener("submit", handleSubmit);

  let oauthLuoguName: string | null = null;
  let oauthFailed = false;
  try {
    oauthLuoguName = await completeCpOAuthLogin();
    if (oauthLuoguName) {
      identity = await renameIdentity(identity, oauthLuoguName);
      statusText = `已通过 CP OAuth 绑定 ${oauthLuoguName}`;
    }
  } catch (error) {
    authErrorText = error instanceof Error ? error.message : "CP OAuth 登录失败";
    statusText = authErrorText;
    oauthFailed = true;
  }
  cpSession = loadCpSession();
  if (!cpSession && oauthFailed) {
    renderAuthGate();
    return;
  }
  if (!cpSession && location.pathname !== "/callback") {
    await startCpOAuthLogin();
    return;
  }
  if (!cpSession) {
    authErrorText = "CP OAuth 未能完成登录";
    renderAuthGate();
    return;
  }
  if (cpSession) {
    identity = await renameIdentity(identity, cpSession.luoguName);
  }
  await enterFromHash();
  if (oauthLuoguName) {
    await emit({ ...baseEvent("player.joined"), luoguName: oauthLuoguName, team: state.players[identity.id]?.team ?? pickTeam() });
  }
  render();
};

const enterFromHash = async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  roomId = params.get("room") || "global";
  roomSecret = params.get("secret") || (roomId === "global" ? "public-lobby" : "public-room");

  stopApiSync();
  envelopes = loadLog();
  state = applyEvents(roomId, envelopes.map((item) => item.event));
  dirtyEventIds = new Set();

  await pullApiSnapshot("进入房间");
  await ensureJoined();
  startApiSync();
  startJudgeLoop();
  statusText = roomId === "global" ? "公共大厅已连接 API 同步" : "房间已连接 API 同步";
  render();
};

const ensureJoined = async () => {
  if (envelopes.some((item) => item.event.type === "player.joined" && item.event.actorId === identity.id)) return;
  await emit({
    ...baseEvent("player.joined"),
    luoguName: identity.luoguName,
    team: pickTeam()
  });
};

const emit = async (event: DuelEvent) => {
  const envelope = await signEvent(identity, event);
  await receiveEnvelope(envelope);
  dirtyEventIds.add(event.id);
  scheduleApiSave(350);
};

const receiveEnvelope = async (envelope: SignedEnvelope) => {
  if (envelopes.some((item) => item.event.id === envelope.event.id)) return;
  if (!(await verifyEnvelope(envelope))) return;
  envelopes.push(envelope);
  saveLog();
  state = applyEvents(roomId, envelopes.map((item) => item.event));
  saveHistory();
  render();
  maybeAutoStart();
};

const baseEvent = <T extends DuelEvent["type"]>(type: T) => ({
  type,
  roomId,
  actorId: identity.id,
  id: crypto.randomUUID(),
  lamport: state.lamport + 1,
  issuedAt: Date.now()
});

const maybeAutoStart = async () => {
  if (!canStart(state)) return;
  if (envelopes.some((item) => item.event.type === "game.started")) return;
  await emit(baseEvent("game.started") as DuelEvent);
};

const startApiSync = () => {
  const loop = async () => {
    await pullApiSnapshot("轮询同步");
    apiPollTimer = window.setTimeout(loop, currentPollInterval());
  };
  apiPollTimer = window.setTimeout(loop, currentPollInterval());
};

const stopApiSync = () => {
  if (apiPollTimer) window.clearTimeout(apiPollTimer);
  if (apiSaveTimer) window.clearTimeout(apiSaveTimer);
  apiPollTimer = undefined;
  apiSaveTimer = undefined;
  apiBusy = false;
};

const pullApiSnapshot = async (reason: string) => {
  if (apiBusy) return;
  apiBusy = true;
  try {
    const remote = await loadCloudSnapshot(cloudKey());
    const remoteIds = new Set(remote.map((item) => item.event.id));
    let added = 0;
    for (const envelope of remote) {
      if (!envelopes.some((item) => item.event.id === envelope.event.id)) {
        await receiveEnvelope(envelope);
        added += 1;
      }
    }
    dirtyEventIds = new Set([
      ...[...dirtyEventIds].filter((id) => !remoteIds.has(id)),
      ...envelopes.filter((item) => item.event.roomId === roomId && !remoteIds.has(item.event.id)).map((item) => item.event.id)
    ]);
    if (dirtyEventIds.size > 0) scheduleApiSave(900);
    statusText = added > 0 ? `${reason}：合并 ${added} 条事件` : `${reason}：已是最新`;
  } catch (error) {
    statusText = error instanceof Error ? error.message : "API 同步失败";
  } finally {
    apiBusy = false;
    render();
  }
};

const scheduleApiSave = (delay: number) => {
  if (apiSaveTimer) window.clearTimeout(apiSaveTimer);
  apiSaveTimer = window.setTimeout(() => void flushApiSave(), delay);
};

const flushApiSave = async () => {
  if (apiBusy || dirtyEventIds.size === 0) {
    if (dirtyEventIds.size > 0) scheduleApiSave(1200);
    return;
  }
  try {
    await saveCloudSnapshot(cloudKey(), envelopes);
    statusText = `API 已写入 ${dirtyEventIds.size} 条待确认事件`;
  } catch (error) {
    statusText = error instanceof Error ? error.message : "API 写入失败";
    scheduleApiSave(3000);
  }
  render();
};

const currentPollInterval = (): number => {
  return document.hidden ? 30_000 : 10_000;
};

const cloudKey = (): string => (roomId === "global" ? "global" : `${roomId}:${roomSecret}`);

const handleSubmit = async (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const action = form.dataset.action;
  const data = new FormData(form);

  if (action === "create-room") {
    const count = clamp(Number(data.get("count") || 9), 3, 21);
    const manual = String(data.get("manual") || "");
    const nextRoom = compactId();
    const nextSecret = compactId() + compactId();
    history.pushState(null, "", `#room=${nextRoom}&secret=${nextSecret}`);
    await enterFromHash();
    await emit({ ...baseEvent("room.configured"), problems: makeProblemSet(count, nextRoom, manual) });
  }

  if (action === "chat") {
    const raw = String(data.get("message") || "").trim();
    if (!raw) return;
    form.reset();
    const teamMessage = roomId !== "global" && raw.startsWith("/");
    await emit({
      ...baseEvent("chat.sent"),
      text: teamMessage ? raw.slice(1).trim() : raw,
      visibility: teamMessage ? "team" : "all"
    });
  }
};

const handleClick = async (event: MouseEvent) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const pid = button.dataset.pid;
  const voteId = button.dataset.vote;
  const player = state.players[identity.id];

  if (action === "home") location.hash = "";
  if (action === "copy-link") await navigator.clipboard.writeText(location.href);
  if (action === "sync-now") await pullApiSnapshot("手动同步");
  if (action === "toggle-user-menu") {
    userMenuOpen = !userMenuOpen;
    render();
  }
  if (action === "oauth-login") await startCpOAuthLogin();
  if (action === "logout") {
    logoutCpSession();
    userMenuOpen = false;
    await startCpOAuthLogin();
  }
  if (action === "reset-id") {
    identity = await createIdentity(identity.luoguName);
    location.reload();
  }
  if (action === "team" && button.dataset.team) {
    await emit({ ...baseEvent("player.teamChanged"), team: button.dataset.team as Team });
  }
  if (action === "ready") {
    await emit({ ...baseEvent("player.readyChanged"), ready: !(player?.ready ?? false) });
  }
  if (action === "judge" && pid) await judgeProblem(pid);
  if (action === "vote-replace" && pid && player) {
    await openVote("replace-problem", pid, createReplacementProblem(state, crypto.randomUUID(), pid));
  }
  if (action === "vote-delete" && pid) await openVote("delete-problem", pid);
  if (action === "vote-draw") await openVote("draw");
  if (action === "vote-surrender") await openVote("surrender");
  if (action === "vote-yes" && voteId) await emit({ ...baseEvent("vote.cast"), voteId, approve: true });
  if (action === "vote-no" && voteId) await emit({ ...baseEvent("vote.cast"), voteId, approve: false });
  if (action === "vote-cancel" && voteId) await emit({ ...baseEvent("vote.cancelled"), voteId });
};

const openVote = async (kind: VoteKind, targetPid?: string, replacement?: Problem) => {
  const player = state.players[identity.id];
  if (!player) return;
  await emit({ ...baseEvent("vote.opened"), vote: buildVote(kind, player, targetPid, replacement) });
};

const judgeProblem = async (pid: string) => {
  const users = Object.values(state.players).map((p) => p.luoguName);
  try {
    statusText = `正在抓取 ${pid} 的洛谷提交`;
    render();
    const records = await fetchLuoguRecords(pid, users);
    for (const record of records) {
      await emit({ ...baseEvent("judge.recordSeen"), record });
    }
    statusText = records.length > 0 ? `${pid} 同步到 ${records.length} 条记录` : `${pid} 暂无参赛者提交`;
  } catch (error) {
    statusText = error instanceof Error ? error.message : "洛谷记录抓取失败";
  }
  render();
};

const startJudgeLoop = () => {
  if (judgeTimer) window.clearInterval(judgeTimer);
  judgeTimer = window.setInterval(() => {
    if (state.phase !== "arena" || state.problems.length === 0) return;
    const problem = state.problems[judgeCursor % state.problems.length];
    judgeCursor += 1;
    void judgeProblem(problem.pid);
  }, 10_000);
};

const render = () => {
  const uiState = captureUiState();
  if (roomId === "global") {
    app.innerHTML = shell(renderHome());
    restoreUiState(uiState);
    return;
  }
  app.innerHTML = shell(state.phase === "arena" || state.phase === "finished" ? renderArena() : renderLobby());
  restoreUiState(uiState);
};

type UiState = {
  field?: {
    formAction?: string;
    name: string;
    value: string;
    selectionStart: number | null;
    selectionEnd: number | null;
  };
  scrolls: Array<{
    key: string;
    top: number;
    left: number;
    atBottom: boolean;
  }>;
};

const captureUiState = (): UiState => {
  const active = document.activeElement;
  const field =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? {
          formAction: active.closest("form")?.dataset.action,
          name: active.name,
          value: active.value,
          selectionStart: active.selectionStart,
          selectionEnd: active.selectionEnd
        }
      : undefined;

  const scrolls = [...app.querySelectorAll<HTMLElement>("[data-scroll-key]")].map((element) => ({
    key: element.dataset.scrollKey || "",
    top: element.scrollTop,
    left: element.scrollLeft,
    atBottom: element.scrollHeight - element.clientHeight - element.scrollTop < 12
  }));

  return { field, scrolls };
};

const restoreUiState = (uiState: UiState) => {
  for (const scroll of uiState.scrolls) {
    const element = app.querySelector<HTMLElement>(`[data-scroll-key="${scroll.key}"]`);
    if (!element) continue;
    element.scrollTop = scroll.atBottom ? element.scrollHeight : scroll.top;
    element.scrollLeft = scroll.left;
  }

  const field = uiState.field;
  if (!field?.name) return;
  const formSelector = field.formAction ? `form[data-action="${field.formAction}"] ` : "";
  const element = app.querySelector<HTMLInputElement | HTMLTextAreaElement>(`${formSelector}[name="${field.name}"]`);
  if (!element) return;
  element.value = field.value;
  element.focus();
  if (field.selectionStart !== null && field.selectionEnd !== null) {
    element.setSelectionRange(field.selectionStart, field.selectionEnd);
  }
};

const renderAuthGate = () => {
  app.innerHTML = `
    <main class="auth-gate">
      <section class="panel auth-card">
        <p class="eyebrow">CP OAUTH</p>
        <h1>登录没有完成</h1>
        <p class="lead">${escapeHtml(authErrorText || "需要通过 CP OAuth 绑定洛谷用户名后继续。")}</p>
        <div class="actions">
          <button class="primary" data-action="oauth-login">重新登录</button>
        </div>
      </section>
    </main>
  `;
};

const shell = (content: string) => `
  <header class="topbar">
    <div class="brand-row">
      <button class="brand" data-action="home">Luogu Duel</button>
      <span class="status-pill">${escapeHtml(statusText)}</span>
      <span class="muted">待确认 ${dirtyEventIds.size}</span>
    </div>
    <div class="user-area">
      <button class="user-button" data-action="toggle-user-menu">${escapeHtml(cpSession?.luoguName ?? identity.luoguName)}</button>
      ${
        userMenuOpen
          ? `<div class="user-menu">
              <button data-action="sync-now">立即同步</button>
              <button data-action="reset-id">重置本机密钥</button>
              <button data-action="logout">登出</button>
            </div>`
          : ""
      }
    </div>
  </header>
  ${content}
`;

const renderHome = () => `
  <main class="home-grid">
    <section class="panel chat-panel">
      <div class="panel-title">
        <span>公共聊天室</span>
        <small>API 轮询同步</small>
      </div>
      ${renderChat()}
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
        ${renderHistory()}
      </div>
    </section>
  </main>
`;

const renderLobby = () => `
  <main class="lobby">
    <section class="panel">
      <div class="panel-title">
        <span>准备室</span>
        <button data-action="copy-link">复制邀请链接</button>
      </div>
      <div class="teams">
        ${renderTeam("red")}
        ${renderTeam("blue")}
      </div>
      <div class="actions">
        <button data-action="team" data-team="red">加入红方</button>
        <button data-action="team" data-team="blue">加入蓝方</button>
        <button class="primary" data-action="ready">${state.players[identity.id]?.ready ? "取消准备" : "准备就绪"}</button>
      </div>
      <p class="muted">所有人准备，且红蓝双方都有人后，会自动进入对决页。</p>
    </section>
    <section class="panel">
      <div class="panel-title">
        <span>题目池</span>
        <small>${state.problems.length} 题</small>
      </div>
      <div class="table-scroll" data-scroll-key="lobby-problems">${renderProblems(false)}</div>
    </section>
  </main>
`;

const renderArena = () => `
  <main class="arena">
    <section class="panel">
      <div class="scoreboard">
        <strong class="red">红 ${scoreOf(state, "red")}</strong>
        <span>胜利线 ${winThreshold(state)}</span>
        <strong class="blue">蓝 ${scoreOf(state, "blue")}</strong>
      </div>
      ${state.winner ? `<div class="result">${state.winner === "draw" ? "平局" : `${state.winner === "red" ? "红方" : "蓝方"}获胜`}</div>` : ""}
      <div class="table-scroll problem-scroll" data-scroll-key="arena-problems">${renderProblems(true)}</div>
      <div class="actions">
        <button data-action="vote-surrender">投降</button>
        <button data-action="vote-draw">平局</button>
      </div>
      ${renderVotes()}
    </section>
    <section class="panel chat-panel">
      <div class="panel-title">
        <span>房间通讯</span>
        <small>/ 开头为队内</small>
      </div>
      ${renderChat()}
      <div class="system-flow" data-scroll-key="system">${state.system.slice(-10).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
    </section>
    <section class="panel">
      <div class="panel-title">
        <span>实时提交实况</span>
        <small>${state.feed.length} 条</small>
      </div>
      <div class="table-scroll feed-scroll" data-scroll-key="feed">${renderFeed()}</div>
    </section>
  </main>
`;

const renderTeam = (team: Team) => `
  <div class="team ${team}">
    <h3>${team === "red" ? "红方" : "蓝方"}</h3>
    ${Object.values(state.players)
      .filter((p) => p.team === team)
      .map((p) => `<div class="player"><span>${escapeHtml(p.luoguName)}</span><span>${p.ready ? "已准备" : "未准备"}</span></div>`)
      .join("") || '<p class="muted">等待玩家</p>'}
  </div>
`;

const renderProblems = (withActions: boolean) => `
  <table>
    <thead><tr><th>题目</th><th>分数</th><th>解题选手</th>${withActions ? "<th>操作</th>" : ""}</tr></thead>
    <tbody>
      ${state.problems
        .map(
          (p) => `
        <tr class="${p.solvedBy?.team ?? ""}">
          <td><a href="https://www.luogu.com.cn/problem/${p.pid}" target="_blank" rel="noreferrer">${p.pid}</a></td>
          <td>${p.score}</td>
          <td>${p.solvedBy ? escapeHtml(p.solvedBy.luoguName) : "未抢占"}</td>
          ${
            withActions
              ? `<td class="row-actions">
                  <button data-action="judge" data-pid="${p.pid}">判题</button>
                  <button data-action="vote-replace" data-pid="${p.pid}">换题</button>
                  <button data-action="vote-delete" data-pid="${p.pid}">删除</button>
                </td>`
              : ""
          }
        </tr>`
        )
        .join("")}
    </tbody>
  </table>
`;

const renderChat = () => `
  <div class="chat-log" data-scroll-key="chat">
    ${(roomId === "global" ? state.chats.filter((chat) => chat.visibility === "all") : visibleChats(state, identity.id))
      .slice(-80)
      .map(
        (chat) => `
        <p class="${chat.visibility === "team" ? "private" : ""}">
          <span>${chat.visibility === "team" ? "队内" : "公屏"} · ${escapeHtml(chat.luoguName)}</span>
          ${escapeHtml(chat.text)}
        </p>`
      )
      .join("")}
  </div>
  <form class="chat-form" data-action="chat">
    <input name="message" placeholder="${roomId === "global" ? "输入公共消息" : "输入消息，/ 开头为队内私聊"}" />
    <button>发送</button>
  </form>
`;

const renderVotes = () => {
  const openVotes = Object.values(state.votes).filter((vote) => vote.status === "open");
  if (openVotes.length === 0) return "";
  return `<div class="votes">
    ${openVotes
      .map(
        (vote) => `
      <div class="vote">
        <span>${vote.kind} ${vote.targetPid ?? ""}</span>
        <span>${Object.keys(vote.approvals).length}/${Object.keys(state.players).length}</span>
        <button data-action="vote-yes" data-vote="${vote.id}">同意</button>
        <button data-action="vote-no" data-vote="${vote.id}">拒绝</button>
        ${vote.proposerId === identity.id ? `<button data-action="vote-cancel" data-vote="${vote.id}">取消</button>` : ""}
      </div>`
      )
      .join("")}
  </div>`;
};

const renderFeed = () => `
  <table>
    <thead><tr><th>用户</th><th>题目</th><th>时间</th><th>状态</th></tr></thead>
    <tbody>
      ${state.feed
        .map(
          (item) => `
        <tr>
          <td>${escapeHtml(item.luoguName)}</td>
          <td>${item.pid}</td>
          <td>${formatTime(item.at)}</td>
          <td><strong>${item.status}</strong></td>
        </tr>`
        )
        .join("")}
    </tbody>
  </table>
`;

const renderHistory = () => {
  const history = JSON.parse(localStorage.getItem(historyKey) || "[]") as Array<{
    roomId: string;
    result: string;
    at: number;
  }>;
  if (history.length === 0) return '<p class="muted">暂无历史对局。</p>';
  return history
    .slice(-8)
    .reverse()
    .map((item) => `<div class="history"><span>${escapeHtml(item.roomId)}</span><span>${escapeHtml(item.result)}</span></div>`)
    .join("");
};

const saveHistory = () => {
  if (roomId === "global" || !state.winner) return;
  const history = JSON.parse(localStorage.getItem(historyKey) || "[]") as Array<{ roomId: string; result: string; at: number }>;
  const result = state.winner === "draw" ? "平局" : `${state.winner === "red" ? "红方" : "蓝方"}胜`;
  const next = history.filter((item) => item.roomId !== roomId).concat({ roomId, result, at: Date.now() });
  localStorage.setItem(historyKey, JSON.stringify(next.slice(-30)));
};

const loadLog = (): SignedEnvelope[] => JSON.parse(localStorage.getItem(storageKey()) || "[]") as SignedEnvelope[];
const saveLog = () => localStorage.setItem(storageKey(), JSON.stringify(envelopes.slice(-1000)));

const pickTeam = (): Team => {
  const red = Object.values(state.players).filter((p) => p.team === "red").length;
  const blue = Object.values(state.players).filter((p) => p.team === "blue").length;
  return red <= blue ? "red" : "blue";
};

const compactId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
const formatTime = (time: number) => new Date(time).toLocaleString("zh-CN", { hour12: false });
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

void boot();
