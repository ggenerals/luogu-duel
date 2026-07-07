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
import { createIdentity, loadIdentity, renameIdentity, signEvent, verifyEnvelope, type LocalIdentity } from "./identity";
import { fetchLuoguRecords } from "./luogu";
import { createRoomSync, type RoomSync } from "./sync";
import type { DuelEvent, DuelState, Problem, SignedEnvelope, Team, VoteKind } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

let identity: LocalIdentity;
let roomId = "global";
let roomSecret = "public-lobby";
let envelopes: SignedEnvelope[] = [];
let state: DuelState = createInitialState(roomId);
let sync: RoomSync | null = null;
let connectedPeers: string[] = [];
let judgeTimer: number | undefined;
let judgeCursor = 0;
let statusText = "正在初始化";

const storageKey = () => `luogu-duel.log.${roomId}`;
const historyKey = "luogu-duel.history.v1";

const boot = async () => {
  identity = await loadIdentity();
  await enterFromHash();
  window.addEventListener("hashchange", enterFromHash);
  app.addEventListener("click", handleClick);
  app.addEventListener("submit", handleSubmit);
  render();
};

const enterFromHash = async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const nextRoom = params.get("room") || "global";
  const nextSecret = params.get("secret") || (nextRoom === "global" ? "public-lobby" : "");
  roomId = nextRoom;
  roomSecret = nextSecret || "public-room";
  envelopes = loadLog();
  state = applyEvents(roomId, envelopes.map((item) => item.event));
  await sync?.leave();
  sync = createRoomSync(roomId, roomSecret, () => envelopes, receiveEnvelope, (peers) => {
    connectedPeers = peers;
    render();
  });
  await ensureJoined();
  startJudgeLoop();
  statusText = roomId === "global" ? "公共大厅已连接" : "房间已连接";
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
  await sync?.broadcast(envelope);
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

const handleSubmit = async (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const action = form.dataset.action;
  const data = new FormData(form);

  if (action === "identity") {
    identity = await renameIdentity(identity, String(data.get("luoguName") || ""));
    await emit({ ...baseEvent("player.joined"), luoguName: identity.luoguName, team: state.players[identity.id]?.team ?? "red" });
  }

  if (action === "create-room") {
    const count = clamp(Number(data.get("count") || 9), 3, 21);
    const manual = String(data.get("manual") || "");
    const nextRoom = compactId();
    const nextSecret = compactId() + compactId();
    history.pushState(null, "", `#room=${nextRoom}&secret=${nextSecret}`);
    await enterFromHash();
    const problems = makeProblemSet(count, nextRoom, manual);
    await emit({ ...baseEvent("room.configured"), problems });
  }

  if (action === "chat") {
    const raw = String(data.get("message") || "").trim();
    if (!raw) return;
    form.reset();
    await emit({
      ...baseEvent("chat.sent"),
      text: raw.startsWith("/") ? raw.slice(1).trim() : raw,
      visibility: raw.startsWith("/") ? "team" : "all"
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
  if (roomId === "global") {
    app.innerHTML = shell(renderHome());
    return;
  }
  app.innerHTML = shell(state.phase === "arena" || state.phase === "finished" ? renderArena() : renderLobby());
};

const shell = (content: string) => `
  <header class="topbar">
    <div>
      <button class="ghost" data-action="home">Luogu Duel</button>
      <span class="muted">${escapeHtml(statusText)} · ${connectedPeers.length} peer(s)</span>
    </div>
    <form class="identity" data-action="identity">
      <input name="luoguName" value="${escapeHtml(identity.luoguName)}" aria-label="洛谷用户名" />
      <button>绑定</button>
      <button type="button" class="ghost" data-action="reset-id">重置密钥</button>
    </form>
  </header>
  ${content}
`;

const renderHome = () => `
  <main class="home-grid">
    <section class="panel">
      <h2>公共聊天室</h2>
      ${renderChat()}
    </section>
    <section class="stack">
      <div class="panel">
        <h2>创建房间</h2>
        <form class="create-form" data-action="create-room">
          <label>题目数量 <input type="number" name="count" min="3" max="21" value="9" /></label>
          <label>手动题号 <textarea name="manual" placeholder="留空则随机，如 P1000 P1001"></textarea></label>
          <button>创建 Lockout 房间</button>
        </form>
      </div>
      <div class="panel">
        <h2>历史对局</h2>
        ${renderHistory()}
      </div>
    </section>
  </main>
`;

const renderLobby = () => `
  <main class="lobby">
    <section class="panel">
      <div class="section-head">
        <h2>准备室</h2>
        <button data-action="copy-link">复制邀请链接</button>
      </div>
      <div class="teams">
        ${renderTeam("red")}
        ${renderTeam("blue")}
      </div>
      <div class="actions">
        <button data-action="team" data-team="red">加入红方</button>
        <button data-action="team" data-team="blue">加入蓝方</button>
        <button data-action="ready">${state.players[identity.id]?.ready ? "取消准备" : "准备就绪"}</button>
      </div>
      <p class="muted">所有人准备，且红蓝双方都有人后，会自动进入对决页。</p>
    </section>
    <section class="panel">
      <h2>题目池</h2>
      ${renderProblems(false)}
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
      ${renderProblems(true)}
      <div class="actions">
        <button data-action="vote-surrender">投降</button>
        <button data-action="vote-draw">平局</button>
      </div>
      ${renderVotes()}
    </section>
    <section class="panel">
      <h2>房间通讯</h2>
      ${renderChat()}
      <div class="system-flow">${state.system.slice(-10).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
    </section>
    <section class="panel">
      <h2>实时提交实况</h2>
      ${renderFeed()}
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
  <div class="chat-log">
    ${visibleChats(state, identity.id)
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
    <input name="message" placeholder="输入消息，/ 开头为队内私聊" />
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
