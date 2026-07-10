import "./style.css";
import type { ComponentChildren, JSX } from "preact";
import { render } from "preact";
import {
  Ban,
  Bot,
  Check,
  CircleDot,
  Crown,
  DoorClosed,
  Eye,
  Flame,
  Flag,
  Gauge,
  Handshake,
  LogOut,
  MessageSquare,
  Play,
  Radio,
  RefreshCw,
  Send,
  Shield,
  Swords,
  Terminal,
  Trash2,
  Users,
  Volume2,
  VolumeX,
  X
} from "lucide-preact";
import {
  applyEvent,
  applyEvents,
  buildVote,
  canCloseRoom,
  canStart,
  createInitialState,
  createReplacementProblem,
  isAdminName,
  isTeam,
  makeProblemSet,
  normalizeName,
  scoreOf,
  sortProblemsByDifficulty,
  teamName,
  visibleChats,
  winThreshold
} from "./domain";
import { createIdentity, loadIdentity, renameIdentity, signEvent, verifyEnvelope, type LocalIdentity } from "./identity";
import { fetchLuoguRecords } from "./luogu";
import { cachedProblemCount, difficultyMeta, pickLuoguProblems, type DifficultyLevel } from "./problemPicker";
import { completeCpOAuthLogin, consumeCpOAuthError, loadCpSession, logoutCpSession, startCpOAuthLogin, type CpSession } from "./oauth";
import { fetchRooms, fetchSnapshot, publishEnvelope, roomWebSocketUrl, type RoomListing, type ServerMessage } from "./realtimeStore";
import type { ChatMessage, DuelEvent, DuelState, Player, Problem, Seat, SignedEnvelope, VoteKind } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

type BootPhase = "loading" | "auth-error" | "ready";
type ViewMode = "home" | "room";

let bootPhase: BootPhase = "loading";
let mode: ViewMode = "home";
let identity: LocalIdentity;
let cpSession: CpSession | null = null;
let roomId = "global";
let roomSecret = "public-lobby";
let envelopes: SignedEnvelope[] = [];
let state: DuelState = createInitialState(roomId);
let globalModeration: DuelState = createInitialState("global");
let rooms: RoomListing[] = [];
let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let finishReturnTimer: number | undefined;
let clockTimer: number | undefined;
let syncTimer: number | undefined;
let statusText = "booting...";
let statusTone: "info" | "error" = "info";
let authErrorText = "";

const draft = {
  userMenuOpen: false,
  chat: "",
  roomCount: 9,
  manualProblems: "",
  difficultyLow: 1 as DifficultyLevel,
  difficultyHigh: 3 as DifficultyLevel,
  pickerStatus: "",
  closeReason: "房主关闭房间",
  adminTarget: "",
  adminReason: ""
};

const dataVersion = "v3";
const roomSeatKey = () => `luogu-duel.${dataVersion}.seat.${roomId}`;
const activeRoomKey = `luogu-duel.active-room.${dataVersion}`;
const historyKey = `luogu-duel.history.${dataVersion}`;

const notify = () => render(<App />, app);
const setStatus = (text: string, tone: "info" | "error" = "info") => {
  statusText = text;
  statusTone = tone;
  notify();
};

const boot = async () => {
  identity = await loadIdentity();
  clockTimer ??= window.setInterval(() => notify(), 1000);
  syncTimer ??= window.setInterval(() => void periodicSync(), 20_000);
  window.addEventListener("hashchange", () => void enterFromHash());
  window.addEventListener("online", () => void connectRoom());

  try {
    await completeCpOAuthLogin();
  } catch (error) {
    authErrorText = error instanceof Error ? error.message : "CP OAuth 登录失败";
    logoutCpSession();
  }

  cpSession = loadCpSession();
  if (!cpSession) {
    const oauthError = consumeCpOAuthError();
    if (oauthError) {
      authErrorText = oauthError;
      bootPhase = "auth-error";
      notify();
      return;
    }
    const callbackReturnedAt = Number(sessionStorage.getItem("luogu-duel.oauth.callback-returned") || "0");
    if (Date.now() - callbackReturnedAt < 5 * 60_000) {
      sessionStorage.removeItem("luogu-duel.oauth.callback-returned");
      authErrorText = "CP OAuth 回调已返回，但未能建立登录会话。请重新登录；如果仍失败，请看 /api/auth/exchange 的响应。";
      bootPhase = "auth-error";
      notify();
      return;
    }
    authErrorText = "请先通过 CP OAuth 登录。";
    bootPhase = "auth-error";
    notify();
    return;
  }

  identity = await renameIdentity(identity, cpSession.luoguName);
  bootPhase = authErrorText ? "auth-error" : "ready";
  await refreshGlobalModeration();
  await enterFromHash();
};

const enterFromHash = async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  roomId = params.get("room") || "global";
  roomSecret = params.get("secret") || (roomId === "global" ? "public-lobby" : "public-room");
  mode = roomId === "global" ? "home" : "room";
  closeSocket();
  clearFinishTimer();
  draft.chat = "";
  draft.closeReason = isAdmin() ? "管理员强制关闭房间" : "房主关闭房间";

  if (mode === "home") {
    state = createInitialState("global");
    envelopes = [];
    await loadDirectory();
    notify();
    return;
  }

  state = createInitialState(roomId);
  envelopes = [];
  notify();
  await loadSnapshot();
  await ensureJoined();
  connectRoom();
  rememberActiveRoomIfNeeded();
  notify();
};

const loadDirectory = async () => {
  try {
    await refreshGlobalModeration();
    if (mode === "home") state = globalModeration;
    await ensureHomeJoined();
    rooms = await fetchRooms();
    statusTone = "info";
    statusText = `大厅在线，${rooms.length} 个房间可见`;
  } catch (error) {
    rooms = [];
    statusTone = "error";
    statusText = friendlyError(error, "房间目录暂时不可用");
  }
};

const loadSnapshot = async () => {
  try {
    await refreshGlobalModeration();
    const remote = await fetchSnapshot(roomId, roomSecret);
    await mergeEnvelopes(remote);
    statusTone = "info";
    statusText = "快照已同步";
  } catch (error) {
    statusTone = "error";
    statusText = friendlyError(error, "房间快照同步失败");
  }
};

const periodicSync = async () => {
  if (bootPhase !== "ready") return;
  if (mode === "home") {
    await loadDirectory();
  } else {
    await loadSnapshot();
  }
  notify();
};

const connectRoom = () => {
  if (mode !== "room") return;
  closeSocket(false);
  socket = new WebSocket(roomWebSocketUrl(roomId, roomSecret));
  socket.addEventListener("open", () => {
    statusTone = "info";
    statusText = "WebSocket 已连接";
    notify();
  });
  socket.addEventListener("message", (event) => void handleServerMessage(event.data));
  socket.addEventListener("close", () => {
    socket = null;
    if (mode === "room") {
      statusTone = "error";
      statusText = "连接休眠或断开，正在重连";
      reconnectTimer = window.setTimeout(connectRoom, 1200);
      notify();
    }
  });
  socket.addEventListener("error", () => {
    statusTone = "error";
    statusText = "WebSocket 错误，HTTP 兜底仍可用";
    notify();
  });
};

const closeSocket = (clearTimer = true) => {
  if (clearTimer && reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (socket) socket.close();
  socket = null;
};

const handleServerMessage = async (raw: string) => {
  const message = JSON.parse(raw) as ServerMessage;
  if (message.type === "hello" || message.type === "sync") {
    await mergeEnvelopes(message.envelopes);
    await ensureJoined();
  }
  if (message.type === "event") await receiveEnvelope(message.envelope);
  if (message.type === "error") {
    statusTone = "error";
    statusText = message.message;
  }
  notify();
};

const mergeEnvelopes = async (incoming: SignedEnvelope[]) => {
  for (const envelope of incoming) await receiveEnvelope(envelope, false);
};

const ensureJoined = async () => {
  if (mode !== "room" || state.players[identity.id] || bannedRecord()) return;
  const seat = preferredSeat();
  await emit({ ...baseEvent("player.joined"), luoguName: identity.luoguName, team: seat });
  rememberSeat(seat);
};

const ensureHomeJoined = async () => {
  if (mode !== "home" || state.players[identity.id] || bannedRecord()) return;
  await emit({ ...baseEvent("player.joined"), luoguName: identity.luoguName, team: "spectator" });
};

const receiveEnvelope = async (envelope: SignedEnvelope, renderNow = true) => {
  if (envelopes.some((item) => item.event.id === envelope.event.id)) return;
  if (!(await verifyEnvelope(envelope))) return;
  envelopes.push(envelope);
  envelopes.sort(compareEnvelopes);
  state = applyEvent(state, envelope.event);
  if (roomId === "global") globalModeration = state;
  saveHistory();
  scheduleFinishReturn();
  maybeAutoStart();
  rememberActiveRoomIfNeeded();
  if (renderNow) notify();
};

const emit = async (event: DuelEvent) => {
  if (blockedByBan()) return;
  const envelope = await signEvent(identity, event);
  await receiveEnvelope(envelope);
  let sentBySocket = false;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "event", envelope }));
    sentBySocket = true;
  }
  try {
    await publishEnvelope(roomId, roomSecret, envelope);
  } catch (error) {
    if (!sentBySocket) setStatus(friendlyError(error, "事件已保存在本地，发送失败"), "error");
  }
};

const emitChat = async (text: string, visibility: "all" | "team") => {
  await emit({ ...baseEvent("chat.sent"), text, visibility });
};

const emitDirect = async (event: Extract<DuelEvent, { type: "room.closed" | "player.kicked" | "player.unkicked" | "player.muted" | "player.unmuted" }>) => {
  await emit(event);
};

const refreshGlobalModeration = async () => {
  try {
    const remote = await fetchSnapshot("global", "public-lobby");
    globalModeration = applyEvents("global", remote.map((item) => item.event));
  } catch {
    globalModeration = createInitialState("global");
  }
};

const ensureGlobalAdminJoined = async () => {
  if (globalModeration.players[identity.id]) return;
  const joinEvent: DuelEvent = {
    type: "player.joined",
    roomId: "global",
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: globalModeration.lamport + 1,
    issuedAt: Date.now(),
    luoguName: identity.luoguName,
    team: "spectator"
  };
  const envelope = await signEvent(identity, joinEvent);
  await publishEnvelope("global", "public-lobby", envelope);
  globalModeration = applyEvent(globalModeration, envelope.event);
};

const moderateGlobal = async (action: "ban" | "unban" | "mute" | "unmute") => {
  const targetName = draft.adminTarget.trim();
  if (!isAdmin() || !targetName) return;
  if (isAdminName(targetName)) {
    setStatus("不能操作管理员账号", "error");
    return;
  }

  await ensureGlobalAdminJoined();
  const targetId = `name:${normalizeName(targetName)}`;
  const base = {
    roomId: "global",
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: globalModeration.lamport + 1,
    issuedAt: Date.now()
  };
  const event: DuelEvent =
    action === "ban"
      ? { ...base, type: "player.kicked", targetId, targetName, reason: draft.adminReason.trim() || "管理员封禁" }
      : action === "unban"
        ? { ...base, type: "player.unkicked", targetName }
        : action === "mute"
          ? { ...base, type: "player.muted", targetId, targetName }
          : { ...base, type: "player.unmuted", targetId, targetName };
  const envelope = await signEvent(identity, event);
  await publishEnvelope("global", "public-lobby", envelope);
  globalModeration = applyEvent(globalModeration, envelope.event);
  if (mode === "home") state = globalModeration;
  setStatus(`已${actionLabel(action)} ${targetName}`);
};

const actionLabel = (action: "ban" | "unban" | "mute" | "unmute"): string =>
  action === "ban" ? "封禁" : action === "unban" ? "解封" : action === "mute" ? "禁言" : "解禁言";

const baseEvent = <T extends DuelEvent["type"]>(type: T) => ({
  type,
  roomId,
  actorId: identity.id,
  id: crypto.randomUUID(),
  lamport: state.lamport + 1,
  issuedAt: Date.now()
});

const submitCreateRoom = async (event: Event) => {
  event.preventDefault();
  if (hasBlockingActiveRoom()) {
    setStatus("你已经在一场比赛中，先结束或观赛再创建新房间", "error");
    return;
  }

  const nextRoom = compactId();
  const nextSecret = compactId() + compactId();
  const count = clamp(draft.roomCount, 1, 21);
  const manual = draft.manualProblems.trim();

  let problems: Problem[];
  try {
    if (manual) {
      problems = makeProblemSet(count, nextRoom, manual);
    } else {
      draft.pickerStatus = "读取洛谷题库缓存";
      notify();
      problems = await pickLuoguProblems(count, nextRoom, draft.difficultyLow, draft.difficultyHigh);
      draft.pickerStatus = `已抽取 ${problems.length} 题`;
    }
    problems = sortProblemsByDifficulty(problems);
  } catch (error) {
    draft.pickerStatus = "";
    setStatus(error instanceof Error ? error.message : "题库抽取失败", "error");
    return;
  }

  history.pushState(null, "", `#room=${nextRoom}&secret=${nextSecret}`);
  await enterFromHash();
  await emit({ ...baseEvent("room.configured"), problems });
};

const submitChat = async (event: Event) => {
  event.preventDefault();
  const raw = draft.chat.trim();
  if (!raw || blockedByBan()) return;
  if (isMutedCurrent()) {
    setStatus("你已被禁言", "error");
    return;
  }
  const teamMessage = raw.startsWith("/") && mode === "room";
  const text = teamMessage ? raw.slice(1).trim() : raw;
  if (!text) return;
  await emitChat(text, teamMessage ? "team" : "all");
  draft.chat = "";
  notify();
};

const closeRoom = async () => {
  if (!canCloseRoom(state, identity.id, identity.luoguName)) return;
  await emitDirect({ ...baseEvent("room.closed"), reason: draft.closeReason, actorName: identity.luoguName });
};

const setSeat = async (seat: Seat) => {
  if (blockedByBan() || state.phase !== "lobby") return;
  rememberSeat(seat);
  await emit({ ...baseEvent("player.teamChanged"), team: seat });
};

const toggleReady = async () => {
  const player = state.players[identity.id];
  if (!player || !isTeam(player.team) || blockedByBan()) return;
  await emit({ ...baseEvent("player.readyChanged"), ready: !player.ready });
};

const maybeAutoStart = () => {
  if (!canStart(state)) return;
  if (envelopes.some((item) => item.event.type === "game.started")) return;
  void emit({ ...baseEvent("game.started") });
};

const openVote = async (kind: VoteKind, targetPid?: string, replacement?: Problem) => {
  const player = state.players[identity.id];
  if (!player || !isTeam(player.team) || blockedByBan()) return;
  await emit({ ...baseEvent("vote.opened"), vote: buildVote(kind, player, targetPid, replacement) });
};

const judgeProblem = async (pid: string) => {
  const users = Object.values(state.players)
    .filter((player) => isTeam(player.team) && !moderationRecordForPlayer(player))
    .map((p) => p.luoguName);
  if (!state.startedAt) {
    setStatus("对局尚未开始", "error");
    return;
  }
  try {
    statusTone = "info";
    statusText = `抓取 ${pid} 提交记录`;
    notify();
    const records = await fetchLuoguRecords(pid, users, state.startedAt);
    for (const record of records) await emit({ ...baseEvent("judge.recordSeen"), record });
    statusTone = "info";
    statusText = records.length ? `已同步 ${records.length} 条提交` : `${pid} 暂无开赛后的有效提交`;
  } catch (error) {
    statusTone = "error";
    statusText = friendlyError(error, "提交抓取失败");
  }
  notify();
};

const App = () => {
  if (bootPhase === "loading") return <Shell title="Luogu Duel" subtitle="initializing"><Loading /></Shell>;
  if (bootPhase === "auth-error") return <AuthError />;
  return (
    <>
      <Shell title="Luogu Duel" subtitle={mode === "home" ? "control room" : `${roomId} / ${state.phase}`}>
        {mode === "home" ? <Home /> : <Room />}
      </Shell>
      <BanOverlay />
      <EndOverlay />
    </>
  );
};

const Shell = ({ title, subtitle, children }: { title: string; subtitle: string; children: ComponentChildren }) => (
  <div class="app-shell">
    <header class="topbar">
      <button class="brand" onClick={() => (location.hash = "")}>
        <Swords size={20} />
        <span>{title}</span>
        <em>{subtitle}</em>
      </button>
      <div class={`status-pill ${statusTone}`}>
        <Radio size={15} />
        <span>{statusText}</span>
      </div>
      <div class="session">
        <button class="session-user" onClick={() => {
          draft.userMenuOpen = !draft.userMenuOpen;
          notify();
        }}>
          <span class="chat-avatar">{avatarText(identity?.luoguName ?? "?")}</span>
          {identity?.luoguName ?? "..."}
        </button>
        {draft.userMenuOpen ? (
          <div class="session-menu">
            <button onClick={logout}>
              <LogOut size={15} />
              退出登录
            </button>
          </div>
        ) : null}
      </div>
    </header>
    {children}
  </div>
);

const Home = () => (
  <main class="home-grid">
    <section class="command-panel">
      <div class="section-head">
        <Terminal size={18} />
        <div>
          <h1>创建 Luogu Duel</h1>
          <p>极简房间、实时状态、房间级 Durable Object。</p>
        </div>
      </div>
      <form class="create-form" onSubmit={(event) => void submitCreateRoom(event)}>
        <label>
          <span>题目数量</span>
          <input type="number" min={1} max={21} value={draft.roomCount} onInput={(event) => (draft.roomCount = Number(event.currentTarget.value))} />
        </label>
        <label class="wide">
          <span>手动题号</span>
          <input value={draft.manualProblems} placeholder="P1001 P1002，留空则自动抽题" onInput={(event) => (draft.manualProblems = event.currentTarget.value)} />
        </label>
        <DifficultyControl label="最低难度" value={draft.difficultyLow} set={(value) => (draft.difficultyLow = value)} />
        <DifficultyControl label="最高难度" value={draft.difficultyHigh} set={(value) => (draft.difficultyHigh = value)} />
        <button class="primary wide">
          <Play size={17} />
          生成房间
        </button>
      </form>
      <p class="muted">题库缓存：{cachedProblemCount()} 条 {draft.pickerStatus ? ` / ${draft.pickerStatus}` : ""}</p>
      <AdminPanel />
    </section>

    <section class="panel">
      <div class="section-head">
        <Users size={18} />
        <div>
          <h2>公开房间</h2>
          <p>进行中的房间默认观赛加入。</p>
        </div>
        <button class="ghost icon-only" onClick={() => void loadDirectory()}>
          <RefreshCw size={16} />
        </button>
      </div>
      <RoomList />
    </section>

    <section class="panel home-chat-panel">
      <Chat />
    </section>

    <section class="panel">
      <div class="section-head">
        <Gauge size={18} />
        <div>
          <h2>历史</h2>
          <p>本机最近对局。</p>
        </div>
      </div>
      <History />
    </section>
  </main>
);

const Room = () => (
  <main class="room-grid">
    <section class="arena-head">
      <div class="match-meta">
        <p class="eyebrow">{state.phase === "arena" ? "LIVE MATCH" : "READY ROOM"}</p>
        <h1>{matchTitle()}</h1>
        <p>{state.problems.length} 题 / 胜利线 {winThreshold(state)} / 你是 {teamName(currentSeat())}</p>
      </div>
      <div class="timer-block">
        <strong>{formatMatchClock()}</strong>
        <ScoreBar />
      </div>
    </section>

    <section class="panel roster-panel">
      <PanelTitle icon={<Users size={16} />} title="TEAMS" detail="roster / rating" />
      <Roster />
    </section>

    <section class="panel comms-panel">
      <Chat />
      <Votes />
      <RoomControls />
    </section>

    <section class="panel submissions-panel">
      <PanelTitle icon={<Flame size={16} />} title="SUBMISSIONS" detail="history" />
      <FeedTable />
    </section>

    <section class="panel problems-panel">
      <PanelTitle icon={<Terminal size={16} />} title="PROBLEMS" detail="easy -> hard" />
      <Problems />
    </section>
  </main>
);

const RoomControls = () => {
  const player = state.players[identity.id];
  const canClose = canCloseRoom(state, identity.id, identity.luoguName);
  const canPlayAction = state.phase === "arena" && isTeam(player?.team) && !blockedByBan();
  return (
    <div class="room-controls">
      {state.phase === "lobby" ? (
        <>
          <div class="segmented">
            {(["red", "blue", "spectator"] as Seat[]).map((seat) => (
              <button key={seat} class={currentSeat() === seat ? "active" : ""} disabled={blockedByBan()} onClick={() => void setSeat(seat)}>
                {seat === "spectator" ? <Eye size={15} /> : <CircleDot size={15} />}
                {teamName(seat)}
              </button>
            ))}
          </div>
          <button class={player?.ready ? "success" : "primary"} disabled={!isTeam(player?.team) || blockedByBan()} onClick={() => void toggleReady()}>
            <Check size={16} />
            {player?.ready ? "已准备" : "准备"}
          </button>
        </>
      ) : null}
      {canPlayAction ? (
        <div class="match-actions">
          <button class="ghost" onClick={() => void openVote("draw")}>
            <Handshake size={16} />
            求和
          </button>
          <button class="danger" onClick={() => void openVote("surrender")}>
            <Flag size={16} />
            投降
          </button>
        </div>
      ) : null}
      {canClose ? (
        <div class="close-box">
          <input value={draft.closeReason} onInput={(event) => (draft.closeReason = event.currentTarget.value)} />
          <button class="danger" onClick={() => void closeRoom()}>
            <DoorClosed size={16} />
            {isAdmin() ? "强制关房" : "关闭房间"}
          </button>
        </div>
      ) : null}
    </div>
  );
};

const PanelTitle = ({ icon, title, detail }: { icon: ComponentChildren; title: string; detail: string }) => (
  <div class="panel-title">
    <span>{icon}</span>
    <strong>{title}</strong>
    <em>{detail}</em>
  </div>
);

const ScoreBar = () => {
  const red = scoreOf(state, "red");
  const blue = scoreOf(state, "blue");
  const total = Math.max(1, red + blue);
  const redPct = red + blue === 0 ? 50 : (red / total) * 100;
  const bluePct = 100 - redPct;
  return (
    <div class="duel-progress" aria-label="score progress">
      <div class="red-fill" style={{ width: `${redPct}%` }}>
        <span>{red}</span>
      </div>
      <div class="blue-fill" style={{ width: `${bluePct}%` }}>
        <span>{blue}</span>
      </div>
    </div>
  );
};

const RoomList = () => {
  const fresh = rooms.filter((room) => Date.now() - room.createdAt < 6 * 60 * 60 * 1000);
  if (!fresh.length) return <p class="muted">暂无公开房间。</p>;
  return (
    <div class="room-list">
      {fresh.map((room) => (
        <article class="room-card" key={room.roomId}>
          <div>
            <strong>{room.host}</strong>
            <span>{room.problemCount} 题 / {room.status === "arena" ? `开赛 ${timeAgo(room.startedAt ?? room.createdAt)}` : "准备中"}</span>
          </div>
          <em class={room.status === "arena" ? "live" : ""}>{room.status === "arena" ? "LIVE" : "LOBBY"}</em>
          <button onClick={() => joinRoom(room)}>{room.status === "arena" ? "观赛" : "加入"}</button>
        </article>
      ))}
    </div>
  );
};

const AdminPanel = () => {
  if (!isAdmin()) return null;
  return (
    <div class="admin-panel">
      <PanelTitle icon={<Shield size={16} />} title="ADMIN" detail="global moderation" />
      <p>当前管理员：{identity.luoguName}</p>
      <div class="admin-moderation">
        <input
          value={draft.adminTarget}
          placeholder="Luogu 用户名"
          onInput={(event) => (draft.adminTarget = event.currentTarget.value)}
        />
        <input
          value={draft.adminReason}
          placeholder="原因（封禁时使用）"
          onInput={(event) => (draft.adminReason = event.currentTarget.value)}
        />
        <button class="danger" onClick={() => void moderateGlobal("ban")}>
          <Ban size={14} />
          封禁
        </button>
        <button class="ghost" onClick={() => void moderateGlobal("unban")}>
          <X size={14} />
          解封
        </button>
        <button class="ghost" onClick={() => void moderateGlobal("mute")}>
          <VolumeX size={14} />
          禁言
        </button>
        <button class="ghost" onClick={() => void moderateGlobal("unmute")}>
          <Volume2 size={14} />
          解禁言
        </button>
      </div>
      <div class="admin-room-list">
        {rooms.length ? (
          rooms.map((room) => (
            <div class="admin-room" key={room.roomId}>
              <code>{room.roomId}</code>
              <span>{room.host} / {room.status}</span>
              <button class="danger" onClick={() => void forceCloseRoom(room)}>
                <Trash2 size={14} />
                删除房间
              </button>
            </div>
          ))
        ) : (
          <p class="muted">暂无可管理的公开房间。</p>
        )}
      </div>
    </div>
  );
};

const forceCloseRoom = async (room: RoomListing) => {
  const event: DuelEvent = {
    type: "room.closed",
    roomId: room.roomId,
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: 1,
    issuedAt: Date.now(),
    reason: "管理员删除房间",
    actorName: identity.luoguName
  };
  const envelope = await signEvent(identity, event);
  await publishEnvelope(room.roomId, room.secret, envelope);
  rooms = rooms.filter((item) => item.roomId !== room.roomId);
  setStatus(`已删除房间 ${room.roomId}`);
};

const Roster = () => (
  <div class="teams">
    {(["red", "blue", "spectator"] as Seat[]).map((seat) => (
      <div class={`team-card ${seat}`} key={seat}>
        <h3>{teamName(seat)}</h3>
        {Object.values(state.players).filter((player) => player.team === seat).length ? (
          Object.values(state.players)
            .filter((player) => player.team === seat)
            .map((player) => <PlayerRow player={player} key={player.id} />)
        ) : (
          <p class="muted">等待玩家</p>
        )}
      </div>
    ))}
  </div>
);

const PlayerRow = ({ player }: { player: Player }) => {
  const banned = moderationRecordForPlayer(player);
  const muted = isMutedPlayer(player);
  return (
    <div class={`player-row ${banned ? "banned" : ""}`}>
      <div class="avatar">{avatarText(player.luoguName)}</div>
      <div class="player-main">
        <span>{player.luoguName}</span>
        <small>{ratingFor(player.luoguName)}</small>
      </div>
      <div class="player-tags">
        {state.hostId === player.id ? <em><Crown size={12} />HOST</em> : null}
        {isAdminName(player.luoguName) ? <em><Shield size={12} />ADMIN</em> : null}
        {muted ? <em><Ban size={12} />MUTED</em> : null}
        {banned ? <em><Ban size={12} />BANNED</em> : <em>{player.ready ? "READY" : teamName(player.team).toUpperCase()}</em>}
      </div>
    </div>
  );
};

const Problems = () => (
  <div class="problem-grid">
    {state.problems.map((problem, index) => (
      <article class={`problem-card ${problem.solvedBy?.team ?? ""}`} key={problem.pid}>
        <div>
          <a href={`https://www.luogu.com.cn/problem/${problem.pid}`} target="_blank" rel="noreferrer">
            {state.phase === "lobby" ? `P${String(index + 1).padStart(4, "0")}` : problem.pid}
          </a>
          <span>{problem.score} pts</span>
        </div>
        {problem.difficulty ? <DifficultyBadge level={problem.difficulty} /> : <em>random</em>}
        <strong>{problem.solvedBy?.luoguName ?? (state.phase === "lobby" ? "hidden" : "unclaimed")}</strong>
        {state.phase === "arena" && isTeam(currentSeat()) && !blockedByBan() ? (
          <div class="problem-actions">
            <button onClick={() => void judgeProblem(problem.pid)}>判题</button>
            <button onClick={() => void openVote("replace-problem", problem.pid, createReplacementProblem(state, crypto.randomUUID(), problem.pid))}>换题</button>
            <button onClick={() => void openVote("delete-problem", problem.pid)}>删题</button>
          </div>
        ) : null}
      </article>
    ))}
  </div>
);

const Chat = () => {
  const items = chatStreamItems();
  const muted = isMutedCurrent();
  return (
    <div class="chat">
      <PanelTitle icon={<MessageSquare size={16} />} title="CHAT" detail={mode === "room" ? "/ prefix = team" : "global"} />
      <div class="chat-log">
        {items.map((item) => <ChatLine item={item} key={item.id} />)}
      </div>
      <form class="chat-form" onSubmit={(event) => void submitChat(event)}>
        <textarea
          value={draft.chat}
          rows={1}
          disabled={blockedByBan() || muted}
          placeholder={muted ? "你已被禁言" : mode === "room" ? "消息，/开头发队内" : "大厅自由聊天"}
          onInput={(event) => (draft.chat = event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button disabled={blockedByBan() || muted}>
          <Send size={15} />
          {muted ? "禁言" : "发送"}
        </button>
      </form>
    </div>
  );
};

type ChatStreamItem =
  | { type: "chat"; id: string; at: number; chat: ChatMessage }
  | { type: "system"; id: string; at: number; text: string }
  | { type: "judge"; id: string; at: number; record: DuelState["feed"][number] };

const chatStreamItems = (): ChatStreamItem[] => {
  const chats = visibleChats(state, identity.id).slice(-80).map((chat) => ({ type: "chat" as const, id: chat.id, at: chat.at, chat }));
  const judges = state.feed.slice(0, 40).map((record) => ({
    type: "judge" as const,
    id: `judge:${record.recordId}:${record.pid}`,
    at: record.at,
    record
  }));
  const systems = state.system.slice(-40).map((message) => ({
    type: "system" as const,
    id: `system:${message.id}`,
    at: message.at,
    text: message.text
  }));
  return [...chats, ...judges, ...systems].sort((a, b) => b.at - a.at).slice(0, 120);
};

const ChatLine = ({ item }: { item: ChatStreamItem }) => {
  if (item.type === "system") {
    return (
      <p class="system">
        <span class="chat-avatar">#</span>
        <span>SYS</span>
        <span class="chat-text">{item.text}</span>
      </p>
    );
  }
  if (item.type === "judge") {
    const record = item.record;
    return (
      <p class={record.status === "OK" ? "judge ok" : "judge fail"}>
        <span class="chat-avatar">{record.status === "OK" ? "✓" : "!"}</span>
        <span>{formatClock(record.at)} / {record.pid}</span>
        <span class="chat-text">{record.luoguName} {record.status}</span>
      </p>
    );
  }
  const chat = item.chat;
  return (
    <p class={chat.visibility === "team" ? "private" : ""}>
      <span class="chat-avatar">{avatarText(chat.luoguName)}</span>
      <span>{chat.visibility === "team" ? "TEAM" : "ALL"} / {chat.luoguName}</span>
      <span class="chat-text">{chat.text}</span>
    </p>
  );
};

const FeedTable = () => (
  <table class="feed-table">
    <thead>
      <tr>
        <th>TIME</th>
        <th>PROB</th>
        <th>USER</th>
        <th>VERDICT</th>
      </tr>
    </thead>
    <tbody>
      {state.feed.slice(0, 16).map((item) => (
        <tr class={item.status === "OK" ? "ok" : "fail"} key={`${item.recordId}:${item.pid}`}>
          <td>{formatClock(item.at)}</td>
          <td><code>{problemCode(item.pid)}</code></td>
          <td>{item.luoguName}</td>
          <td>{item.status}</td>
        </tr>
      ))}
      {state.feed.length === 0 ? (
        <tr>
          <td colSpan={4}>No submissions.</td>
        </tr>
      ) : null}
    </tbody>
  </table>
);

const Votes = () => {
  const openVotes = Object.values(state.votes).filter((vote) => vote.status === "open");
  if (!openVotes.length) return null;
  const canVote = isTeam(currentSeat()) && !blockedByBan();
  return (
    <div class="votes">
      {openVotes.map((vote) => (
        <div class="vote" key={vote.id}>
          <span>{voteLabel(vote.kind)} {vote.targetPid ?? ""}</span>
          <strong>{Object.keys(vote.approvals).length}/{participantCount()}</strong>
          {canVote ? (
            <>
              <button onClick={() => void emit({ ...baseEvent("vote.cast"), voteId: vote.id, approve: true })}>同意</button>
              <button onClick={() => void emit({ ...baseEvent("vote.cast"), voteId: vote.id, approve: false })}>拒绝</button>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const BanOverlay = () => {
  const record = bannedRecord();
  if (!record) return null;
  return (
    <div class="ban-overlay">
      <div>
        <Ban size={46} />
        <h1>你已被封禁</h1>
        <p>{record.reason}</p>
        <small>操作人：{record.by}</small>
      </div>
    </div>
  );
};

const EndOverlay = () => {
  if (state.phase !== "finished") return null;
  const mine = currentSeat();
  const title = state.closed ? "房间已关闭" : state.winner === "draw" ? "平局" : state.winner === mine ? "胜利" : isTeam(mine) ? "失败" : `${teamName(state.winner)} 获胜`;
  return (
    <div class="end-overlay">
      <div class={`end-card ${state.winner ?? "closed"}`}>
        <p class="eyebrow">MATCH END</p>
        <h1>{title}</h1>
        <p>{state.closed?.reason ?? "10 秒后返回主页"}</p>
        <button class="primary" onClick={() => (location.hash = "")}>返回大厅</button>
      </div>
    </div>
  );
};

const AuthError = () => (
  <Shell title="Luogu Duel" subtitle="auth error">
    <main class="center-screen">
      <Bot size={42} />
      <h1>登录失败</h1>
      <p>{authErrorText}</p>
      <button class="primary" onClick={() => void startCpOAuthLogin(true)}>重新登录</button>
    </main>
  </Shell>
);

const Loading = () => (
  <main class="center-screen">
    <Bot size={42} />
    <h1>Connecting</h1>
    <p>正在装载身份与房间网络。</p>
  </main>
);

const DifficultyControl = ({ label, value, set }: { label: string; value: DifficultyLevel; set: (value: DifficultyLevel) => void }) => (
  <label>
    <span>{label}</span>
    <select value={value} onChange={(event) => set(Number(event.currentTarget.value) as DifficultyLevel)}>
      {difficultyMeta.map((item) => (
        <option value={item.value} key={item.value}>{item.label}</option>
      ))}
    </select>
  </label>
);

const DifficultyBadge = ({ level }: { level: number }) => {
  const meta = difficultyMeta.find((item) => item.value === level);
  return <span class="difficulty-badge" style={{ "--difficulty-color": meta?.color ?? "#6b7280" } as JSX.CSSProperties}>{meta?.short ?? level}</span>;
};

const History = () => {
  const history = readHistory();
  if (!history.length) return <p class="muted">暂无历史对局。</p>;
  return (
    <div class="history-list">
      {history.slice(-8).reverse().map((item) => (
        <p key={`${item.roomId}:${item.at}`}><span>{item.roomId}</span><strong>{item.result}</strong></p>
      ))}
    </div>
  );
};

const joinRoom = (room: RoomListing) => {
  if (hasBlockingActiveRoom(room.roomId)) {
    setStatus("你已经在一场比赛中，不能加入其他房间", "error");
    return;
  }
  location.hash = `room=${room.roomId}&secret=${room.secret}`;
};

const logout = () => {
  logoutCpSession();
  location.hash = "";
  location.reload();
};

const blockedByBan = (): boolean => Boolean(bannedRecord());
const bannedRecord = () =>
  moderationRecordForPlayer(state.players[identity?.id]) ||
  moderationRecordForName(identity?.luoguName ?? "");
const moderationRecordForName = (name: string) =>
  state.banned[normalizeName(name)] || globalModeration.banned[normalizeName(name)];
const moderationRecordForPlayer = (player: Player | undefined) => (player ? state.kicked[player.id] || moderationRecordForName(player.luoguName) : undefined);
const isMutedCurrent = (): boolean => isMutedByIdentity(identity?.id ?? "", identity?.luoguName ?? "");
const isMutedPlayer = (player: Player): boolean => isMutedByIdentity(player.id, player.luoguName);
const isMutedByIdentity = (id: string, name: string): boolean => {
  const nameKey = `name:${normalizeName(name)}`;
  return Boolean(state.muted[id] || state.muted[nameKey] || globalModeration.muted[id] || globalModeration.muted[nameKey]);
};
const currentSeat = (): Seat => state.players[identity.id]?.team ?? preferredSeat();
const preferredSeat = (): Seat => {
  if (state.phase !== "lobby") return "spectator";
  const remembered = localStorage.getItem(roomSeatKey()) as Seat | null;
  if (remembered === "red" || remembered === "blue" || remembered === "spectator") return remembered;
  const red = Object.values(state.players).filter((p) => p.team === "red").length;
  const blue = Object.values(state.players).filter((p) => p.team === "blue").length;
  return red <= blue ? "red" : "blue";
};
const rememberSeat = (seat: Seat) => localStorage.setItem(roomSeatKey(), seat);
const isAdmin = () => isAdminName(identity?.luoguName ?? "");
const participantCount = (): number => Object.values(state.players).filter((player) => isTeam(player.team) && !moderationRecordForPlayer(player)).length;
const matchTitle = (): string => {
  const red = Object.values(state.players).filter((p) => p.team === "red").map((p) => p.luoguName).join(" / ");
  const blue = Object.values(state.players).filter((p) => p.team === "blue").map((p) => p.luoguName).join(" / ");
  return `${red || "红方"} vs ${blue || "蓝方"}`;
};

const rememberActiveRoomIfNeeded = () => {
  const seat = state.players[identity.id]?.team;
  if (mode === "room" && isTeam(seat) && !blockedByBan() && state.phase !== "finished") {
    localStorage.setItem(activeRoomKey, JSON.stringify({ roomId, secret: roomSecret }));
    return;
  }
  if (mode === "room" || state.phase === "finished" || blockedByBan()) localStorage.removeItem(activeRoomKey);
};

const hasBlockingActiveRoom = (allowedRoomId?: string): boolean => {
  const raw = localStorage.getItem(activeRoomKey);
  if (!raw) return false;
  try {
    const active = JSON.parse(raw) as { roomId?: string };
    if (active.roomId && !rooms.some((room) => room.roomId === active.roomId)) {
      localStorage.removeItem(activeRoomKey);
      return false;
    }
    return Boolean(active.roomId && active.roomId !== allowedRoomId);
  } catch {
    localStorage.removeItem(activeRoomKey);
    return false;
  }
};

const scheduleFinishReturn = () => {
  if (state.phase !== "finished") return;
  clearFinishTimer();
  localStorage.removeItem(activeRoomKey);
  finishReturnTimer = window.setTimeout(() => {
    location.hash = "";
  }, 10_000);
};

const clearFinishTimer = () => {
  if (finishReturnTimer) window.clearTimeout(finishReturnTimer);
  finishReturnTimer = undefined;
};

const readHistory = (): Array<{ roomId: string; result: string; at: number }> => {
  try {
    return JSON.parse(localStorage.getItem(historyKey) || "[]") as Array<{ roomId: string; result: string; at: number }>;
  } catch {
    return [];
  }
};

const saveHistory = () => {
  if (mode !== "room" || state.phase !== "finished" || (!state.winner && !state.closed)) return;
  const result = state.closed ? "关闭" : state.winner === "draw" ? "平局" : `${teamName(state.winner)}胜`;
  const next = readHistory().filter((item) => item.roomId !== roomId).concat({ roomId, result, at: Date.now() });
  localStorage.setItem(historyKey, JSON.stringify(next.slice(-30)));
};

const compareEnvelopes = (a: SignedEnvelope, b: SignedEnvelope): number =>
  a.event.lamport - b.event.lamport || a.event.issuedAt - b.event.issuedAt || a.event.id.localeCompare(b.event.id);

const voteLabel = (kind: VoteKind): string => {
  if (kind === "replace-problem") return "换题";
  if (kind === "delete-problem") return "删题";
  if (kind === "draw") return "平局";
  return "投降";
};

const formatMatchClock = (): string => {
  const base = state.startedAt ?? Date.now();
  const seconds = state.phase === "arena" && state.startedAt ? Math.max(0, Math.floor((Date.now() - base) / 1000)) : 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
};

const formatClock = (time: number): string =>
  new Date(time).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

const avatarText = (name: string): string => (name.trim()[0] || "?").toUpperCase();
const ratingFor = (name: string): number => 1200 + [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 1900;
const problemCode = (pid: string): string => pid.replace(/^P/i, "") || pid;

const friendlyError = (error: unknown, prefix: string): string => `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
const compactId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
const timeAgo = (time: number): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
};

notify();
void boot();
