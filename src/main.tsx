import "./style.css";
import { render } from "preact";
import {
  applyEvent,
  applyEvents,
  buildVote,
  canStart,
  createInitialState,
  createReplacementProblem,
  encodeSystemChatCommand,
  makeProblemSet,
  scoreOf,
  visibleChats,
  winThreshold,
  type SystemChatCommand
} from "./domain";
import {
  deleteCloudSnapshot,
  loadCloudSnapshot,
  loadRoomDirectory,
  saveCloudSnapshot,
  saveRoomDirectory,
  type RoomListing
} from "./cloudStore";
import { createIdentity, loadIdentity, renameIdentity, signEvent, verifyEnvelope, type LocalIdentity } from "./identity";
import { fetchLuoguRecords } from "./luogu";
import { cachedProblemCount, difficultyMeta, pickLuoguProblems, type DifficultyLevel } from "./problemPicker";
import { completeCpOAuthLogin, loadCpSession, logoutCpSession, startCpOAuthLogin, type CpSession } from "./oauth";
import type { ChatMessage, DuelEvent, DuelState, Player, Problem, Seat, SignedEnvelope, Team, VoteKind } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

type BootPhase = "loading" | "auth-error" | "ready";

let bootPhase: BootPhase = "loading";
let identity: LocalIdentity;
let roomId = "global";
let roomSecret = "public-lobby";
let envelopes: SignedEnvelope[] = [];
let state: DuelState = createInitialState(roomId);
let globalModeration: DuelState = createInitialState("global");
let apiPollTimer: number | undefined;
let apiSaveTimer: number | undefined;
let apiBusy = false;
let apiFailureCount = 0;
let apiSaveFailureCount = 0;
let dirtyEventIds = new Set<string>();
let statusText = "正在初始化";
let cpSession: CpSession | null = null;
let authErrorText = "";
let cleanupTimer: number | undefined;
let cleanupKey = "";
let finishReturnTimer: number | undefined;
let waitingRooms: RoomListing[] = [];

const draft = {
  userMenuOpen: false,
  chat: "",
  roomCount: 9,
  manualProblems: "",
  difficultyLow: 1 as DifficultyLevel,
  difficultyHigh: 3 as DifficultyLevel,
  pickerStatus: "",
  adminReasons: {} as Record<string, string>
};

const dataVersion = "v2";
const storageKey = () => `luogu-duel.${dataVersion}.log.${roomId}`;
const roomSeatKey = () => `luogu-duel.${dataVersion}.seat.${roomId}`;
const activeRoomKey = `luogu-duel.active-room.${dataVersion}`;
const historyKey = `luogu-duel.history.${dataVersion}`;
const adminNames = new Set(["General826", "Gcend", "GCSG01"]);

const notify = () => render(<App />, app);
const setStatus = (text: string) => {
  statusText = text;
  notify();
};

const boot = async () => {
  identity = await loadIdentity();
  window.addEventListener("hashchange", () => void enterFromHash());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pullApiSnapshot("页面恢复");
  });

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
    logoutCpSession();
  }

  cpSession = loadCpSession();
  if (oauthFailed) {
    bootPhase = "auth-error";
    notify();
    return;
  }
  if (!cpSession && location.pathname !== "/callback") {
    await startCpOAuthLogin();
    return;
  }
  if (!cpSession) {
    authErrorText = "CP OAuth 未能完成登录";
    bootPhase = "auth-error";
    notify();
    return;
  }

  identity = await renameIdentity(identity, cpSession.luoguName);
  bootPhase = "ready";
  await enterFromHash();
  if (oauthLuoguName && !state.players[identity.id] && !isBannedName(identity.luoguName)) {
    const seat = preferredSeat();
    await emitCommand({ kind: "player.joined", luoguName: oauthLuoguName, team: seat });
    rememberSeat(seat);
  }
  notify();
};

const enterFromHash = async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  roomId = params.get("room") || "global";
  roomSecret = params.get("secret") || (roomId === "global" ? "public-lobby" : "public-room");

  stopApiSync();
  if (cleanupTimer) window.clearTimeout(cleanupTimer);
  if (finishReturnTimer) window.clearTimeout(finishReturnTimer);
  cleanupTimer = undefined;
  finishReturnTimer = undefined;
  cleanupKey = "";
  apiFailureCount = 0;
  apiSaveFailureCount = 0;
  draft.chat = "";

  envelopes = loadLog();
  state = applyEvents(roomId, envelopes.map((item) => item.event));
  if (roomId === "global") globalModeration = state;
  dirtyEventIds = new Set();
  scheduleCleanupIfFinished();
  notify();

  await pullApiSnapshot("进入房间");
  if (await closeStaleSoloRoom()) return;
  await ensureJoined();
  rememberActiveRoomIfNeeded();
  startApiSync();
  statusText = roomId === "global" ? "公共大厅已连接，云端同步运行中" : "房间已连接，云端同步运行中";
  notify();
};

const ensureJoined = async () => {
  if (state.players[identity.id]) {
    rememberSeat(state.players[identity.id].team);
    return;
  }
  if (isBannedName(identity.luoguName)) {
    statusText = "当前账号已被该房间封禁，不能重新加入";
    return;
  }
  const alreadyJoined = envelopes.some(
    (item) =>
      item.event.actorId === identity.id &&
      (item.event.type === "player.joined" ||
        (item.event.type === "chat.sent" && item.event.text.includes('"kind":"player.joined"')))
  );
  if (alreadyJoined) return;
  const seat = preferredSeat();
  await emitCommand({ kind: "player.joined", luoguName: identity.luoguName, team: seat });
  rememberSeat(seat);
};

const emit = async (event: DuelEvent) => {
  const envelope = await signEvent(identity, event);
  await receiveEnvelope(envelope);
  dirtyEventIds.add(event.id);
  scheduleApiSave(350);
};

const emitChat = async (text: string, visibility: "all" | "team") => {
  await emit({ ...baseEvent("chat.sent"), text, visibility });
};

const emitCommand = async (command: SystemChatCommand) => {
  await emitChat(encodeSystemChatCommand(command), "all");
};

const receiveEnvelope = async (envelope: SignedEnvelope) => {
  if (envelopes.some((item) => item.event.id === envelope.event.id)) return;
  if (!(await verifyEnvelope(envelope))) return;
  envelopes.push(envelope);
  saveLog();
  state = applyEvents(roomId, envelopes.map((item) => item.event));
  if (roomId === "global") globalModeration = state;
  saveHistory();
  scheduleCleanupIfFinished();
  notify();
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
  if (
    envelopes.some(
      (item) => item.event.type === "game.started" || (item.event.type === "chat.sent" && item.event.text.includes('"kind":"game.started"'))
    )
  ) {
    return;
  }
  await emitCommand({ kind: "game.started" });
  await publishActiveRoom();
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
    if (roomId === "global") {
      try {
        waitingRooms = await loadRoomDirectory();
      } catch {
        waitingRooms = [];
      }
    }
    const remote = await loadCloudSnapshot(cloudKey());
    const remoteIds = new Set(remote.map((item) => item.event.id));
    const added = await mergeRemoteEnvelopes(remote);
    if (roomId === "global") {
      globalModeration = state;
    } else {
      await refreshGlobalModeration();
    }
    dirtyEventIds = new Set([
      ...[...dirtyEventIds].filter((id) => !remoteIds.has(id)),
      ...envelopes.filter((item) => item.event.roomId === roomId && !remoteIds.has(item.event.id)).map((item) => item.event.id)
    ]);
    if (dirtyEventIds.size > 0) scheduleApiSave(900);
    apiFailureCount = 0;
    statusText = added > 0 ? `${reason}：合并 ${added} 条事件` : `${reason}：已是最新`;
  } catch (error) {
    apiFailureCount += 1;
    statusText = friendlyCloudError(error);
  } finally {
    apiBusy = false;
    notify();
  }
};

const publishWaitingRoom = async (listing: RoomListing) => {
  try {
    const rooms = await loadRoomDirectory();
    waitingRooms = rooms.filter((room) => room.roomId !== listing.roomId).concat(listing);
    await saveRoomDirectory(waitingRooms);
  } catch (error) {
    statusText = friendlyCloudError(error, "房间列表写入失败");
  }
};

const publishActiveRoom = async () => {
  if (roomId === "global") return;
  try {
    const rooms = await loadRoomDirectory();
    const current = rooms.find((room) => room.roomId === roomId);
    const listing: RoomListing = {
      roomId,
      secret: roomSecret,
      host: current?.host ?? Object.values(state.players)[0]?.luoguName ?? identity.luoguName,
      createdAt: current?.createdAt ?? Date.now(),
      problemCount: state.problems.length,
      status: "arena",
      startedAt: state.startedAt ?? Date.now()
    };
    waitingRooms = rooms.filter((room) => room.roomId !== roomId).concat(listing);
    await saveRoomDirectory(waitingRooms);
  } catch {
    statusText = "对局仍在本地进行，房间目录稍后自动重试";
  }
};

const unpublishWaitingRoom = async (targetRoomId: string) => {
  try {
    const rooms = await loadRoomDirectory();
    const next = rooms.filter((room) => room.roomId !== targetRoomId);
    if (next.length === rooms.length) return;
    await saveRoomDirectory(next);
    if (roomId === "global") waitingRooms = next;
  } catch {
    statusText = "房间目录暂时不可用，不影响当前对局";
  }
};

const closeStaleSoloRoom = async (): Promise<boolean> => {
  if (roomId === "global" || state.phase !== "lobby") return false;
  const firstEventAt = envelopes.filter((item) => item.event.roomId === roomId).sort((a, b) => a.event.issuedAt - b.event.issuedAt)[0]?.event.issuedAt;
  if (!firstEventAt || Date.now() - firstEventAt < 300_000) return false;
  if (Object.keys(state.players).length > 1) return false;
  await deleteCloudSnapshot(cloudKey());
  await unpublishWaitingRoom(roomId);
  localStorage.removeItem(storageKey());
  statusText = "房间 300 秒内无人加入，已自动关闭";
  location.hash = "";
  return true;
};

const mergeRemoteEnvelopes = async (remote: SignedEnvelope[]): Promise<number> => {
  const known = new Set(envelopes.map((item) => item.event.id));
  const accepted: SignedEnvelope[] = [];

  for (const envelope of remote) {
    if (known.has(envelope.event.id) || envelope.event.roomId !== roomId) continue;
    if (!(await verifyEnvelope(envelope))) continue;
    known.add(envelope.event.id);
    accepted.push(envelope);
  }

  if (accepted.length === 0) return 0;
  accepted.sort(compareEnvelopes);
  envelopes.push(...accepted);
  envelopes.sort(compareEnvelopes);
  saveLog();
  state = accepted.reduce((next, envelope) => applyEvent(next, envelope.event), state);
  if (roomId === "global") globalModeration = state;
  saveHistory();
  scheduleCleanupIfFinished();
  void maybeAutoStart();
  return accepted.length;
};

const refreshGlobalModeration = async () => {
  try {
    const globalRemote = await loadCloudSnapshot("global");
    globalModeration = applyEvents("global", globalRemote.map((item) => item.event));
  } catch {
    // Room sync should keep working even when the global moderation snapshot is temporarily unavailable.
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
    statusText = `云端已写入 ${dirtyEventIds.size} 条待确认事件`;
    dirtyEventIds.clear();
    apiSaveFailureCount = 0;
  } catch (error) {
    apiSaveFailureCount += 1;
    statusText = friendlyCloudError(error, "云端写入失败，已保留本地事件");
    scheduleApiSave(Math.min(30_000, 2500 * 2 ** Math.min(apiSaveFailureCount, 4)));
  }
  notify();
};

const scheduleCleanupIfFinished = () => {
  if (roomId === "global" || state.phase !== "finished") return;
  localStorage.removeItem(activeRoomKey);
  void unpublishWaitingRoom(roomId);
  const key = cloudKey();
  if (cleanupTimer && cleanupKey === key) return;
  if (cleanupTimer) window.clearTimeout(cleanupTimer);
  if (finishReturnTimer) window.clearTimeout(finishReturnTimer);
  cleanupKey = key;
  finishReturnTimer = window.setTimeout(() => {
    location.hash = "";
  }, 10_000);
  cleanupTimer = window.setTimeout(async () => {
    try {
      await deleteCloudSnapshot(key);
      statusText = "对局已结束，云端房间快照已删除";
    } catch (error) {
      statusText = friendlyCloudError(error, "云端房间删除失败");
    }
    notify();
  }, 10_000);
};

const currentPollInterval = (): number => {
  const base = 20_000;
  if (document.hidden) return 45_000;
  return Math.min(60_000, base + apiFailureCount * 5_000);
};

const submitCreateRoom = async (event: Event) => {
  event.preventDefault();
  if (hasBlockingActiveRoom()) {
    setStatus("你已经在一场比赛中，不能创建新房间");
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
      draft.pickerStatus = "正在下载/读取洛谷题库缓存";
      notify();
      problems = await pickLuoguProblems(count, nextRoom, draft.difficultyLow, draft.difficultyHigh);
      draft.pickerStatus = `已从 ${difficultyName(draft.difficultyLow)} → ${difficultyName(draft.difficultyHigh)} 抽取 ${problems.length} 题`;
    }
  } catch (error) {
    draft.pickerStatus = "";
    setStatus(error instanceof Error ? error.message : "题库抽取失败");
    return;
  }

  history.pushState(null, "", `#room=${nextRoom}&secret=${nextSecret}`);
  await enterFromHash();
  await emitCommand({ kind: "room.configured", problems });
  await publishWaitingRoom({
    roomId: nextRoom,
    secret: nextSecret,
    host: identity.luoguName,
    createdAt: Date.now(),
    problemCount: problems.length,
    status: "lobby"
  });
  notify();
};

const submitChat = async (event: Event) => {
  event.preventDefault();
  const raw = draft.chat.trim();
  if (!raw) return;
  if (isMuted(identity.id)) {
    setStatus("你已被禁言，暂时不能发送消息");
    return;
  }
  if (isRestricted(identity.id)) {
    setStatus("你已被移出或封禁，不能发送消息");
    return;
  }
  if (await handleAdminChatCommand(raw)) {
    draft.chat = "";
    notify();
    return;
  }
  const teamMessage = roomId !== "global" && raw.startsWith("/");
  await emitChat(teamMessage ? raw.slice(1).trim() : raw, teamMessage ? "team" : "all");
  draft.chat = "";
  notify();
};

const handleAdminChatCommand = async (raw: string): Promise<boolean> => {
  const muteMatch = raw.match(/^\/(ban|unban)\s+(\S+)$/i);
  const kickMatch = raw.match(/^\/kick\s+(\S+)(?:\s+(.+))?$/i);
  const unkickMatch = raw.match(/^\/unkick\s+(\S+)$/i);
  if (!muteMatch && !kickMatch && !unkickMatch) return false;
  if (roomId !== "global") {
    statusText = "管理命令请回到主页执行；房间内 / 开头仍作为队内消息";
    return true;
  }
  if (!isAdmin(identity.luoguName)) {
    statusText = "只有管理员可以使用管理命令";
    return true;
  }

  if (unkickMatch) {
    await emitCommand({ kind: "player.unkicked", targetName: unkickMatch[1] });
    return true;
  }

  const targetName = (muteMatch?.[2] || kickMatch?.[1] || "").trim();
  const target = findPlayerByName(targetName);
  if (!target) {
    statusText = `没有找到用户 ${targetName}`;
    return true;
  }
  if (isAdmin(target.luoguName)) {
    statusText = "管理员不能被禁言、踢出或封禁";
    return true;
  }

  if (muteMatch) {
    await emitCommand({ kind: muteMatch[1].toLowerCase() === "ban" ? "player.muted" : "player.unmuted", targetId: target.id });
    return true;
  }

  await emitCommand({ kind: "player.kicked", targetId: target.id, reason: kickMatch?.[2]?.trim() || "管理员移出房间" });
  return true;
};

const setTeam = async (seat: Seat) => {
  if (isRestricted(identity.id)) {
    setStatus("你已被移出或封禁，不能切换队伍");
    return;
  }
  rememberSeat(seat);
  await emitCommand({ kind: "player.teamChanged", team: seat });
  rememberActiveRoomIfNeeded();
};

const toggleReady = async () => {
  const player = state.players[identity.id];
  if (!isParticipant(player?.team) || isRestricted(identity.id)) return;
  await emitCommand({ kind: "player.readyChanged", ready: !(player?.ready ?? false) });
};

const openVote = async (kind: VoteKind, targetPid?: string, replacement?: Problem) => {
  const player = state.players[identity.id];
  if (!player || !isParticipant(player.team) || isRestricted(identity.id)) return;
  await emitCommand({ kind: "vote.opened", vote: buildVote(kind, player, targetPid, replacement) });
};

const judgeProblem = async (pid: string) => {
  const users = Object.values(state.players)
    .filter((player) => isParticipant(player.team) && !isRestricted(player.id))
    .map((p) => p.luoguName);
  if (!state.startedAt) {
    setStatus("对局尚未正式开赛，不能判题");
    return;
  }
  try {
    statusText = `正在抓取 ${pid} 的洛谷提交`;
    notify();
    const records = await fetchLuoguRecords(pid, users, state.startedAt);
    for (const record of records) {
      await emitCommand({ kind: "judge.recordSeen", record });
    }
    statusText = records.length ? `已同步 ${pid} 的 ${records.length} 条提交` : `${pid} 暂无开赛后的有效提交`;
  } catch (error) {
    statusText = error instanceof Error ? error.message : "提交抓取失败";
  }
  notify();
};

const adminMute = async (player: Player, muted: boolean) => {
  if (!isAdmin(identity.luoguName) || isAdmin(player.luoguName)) return;
  const sameNamePlayers = playersByNormalizedName(player.luoguName);
  for (const target of sameNamePlayers) {
    await emitCommand({ kind: muted ? "player.unmuted" : "player.muted", targetId: target.id });
  }
};

const adminKick = async (player: Player) => {
  if (!isAdmin(identity.luoguName) || isAdmin(player.luoguName)) return;
  await emitCommand({ kind: "player.kicked", targetId: player.id, reason: draft.adminReasons[player.id]?.trim() || "管理员移出房间" });
};

const adminUnkick = async (player: Player) => {
  if (!isAdmin(identity.luoguName)) return;
  await emitCommand({ kind: "player.unkicked", targetName: player.luoguName });
};

const closeCurrentRoom = async (force: boolean) => {
  if (roomId === "global") return;
  if (!force && state.phase !== "lobby") {
    setStatus("比赛已经正式开始，普通关闭不可用");
    return;
  }
  if (force && !isAdmin(identity.luoguName)) return;
  await emitCommand({ kind: "room.closed", reason: force ? "管理员强制关闭房间" : "玩家关闭未开赛房间" });
  await unpublishWaitingRoom(roomId);
};

const forceCloseListing = async (listing: RoomListing) => {
  if (!isAdmin(identity.luoguName)) return;
  try {
    const targetKey = `${listing.roomId}:${listing.secret}`;
    const remote = await loadCloudSnapshot(targetKey);
    const lamport = Math.max(0, ...remote.map((item) => item.event.lamport)) + 1;
    const event: DuelEvent = {
      type: "chat.sent",
      roomId: listing.roomId,
      actorId: identity.id,
      id: crypto.randomUUID(),
      lamport,
      issuedAt: Date.now(),
      text: encodeSystemChatCommand({ kind: "room.closed", reason: "管理员强制关闭房间", actorName: identity.luoguName }),
      visibility: "all"
    };
    const envelope = await signEvent(identity, event);
    await saveCloudSnapshot(targetKey, remote.concat(envelope).slice(-1000));
    await unpublishWaitingRoom(listing.roomId);
    statusText = `已向房间 ${listing.roomId} 发送强制关闭`;
  } catch (error) {
    statusText = friendlyCloudError(error, "强制关闭房间失败");
  }
  notify();
};

const App = () => {
  if (bootPhase === "loading") {
    return (
      <main class="auth-gate">
        <section class="panel auth-card lift-in">
          <p class="eyebrow">LUOGU DUEL</p>
          <h1>正在进入对局</h1>
          <p class="lead">{statusText}</p>
        </section>
      </main>
    );
  }

  if (bootPhase === "auth-error") return <AuthGate />;

  return (
    <>
      <Topbar />
      {roomId === "global" ? <Home /> : state.phase === "arena" || state.phase === "finished" ? <Arena /> : <Lobby />}
      <EndOverlay />
    </>
  );
};

const AuthGate = () => (
  <main class="auth-gate">
    <section class="panel auth-card lift-in">
      <p class="eyebrow">CP OAUTH</p>
      <h1>登录没有完成</h1>
      <p class="lead">{authErrorText || "需要通过 CP OAuth 绑定洛谷用户名后继续。"}</p>
      <div class="actions">
        <button class="primary" onClick={() => void startCpOAuthLogin()}>
          重新登录
        </button>
      </div>
    </section>
  </main>
);

const Topbar = () => (
  <header class="topbar">
    <div class="brand-row">
      <button class="brand" onClick={() => (location.hash = "")}>
        Luogu Duel
      </button>
      <span class={`status-pill ${apiFailureCount ? "warning" : ""}`}>{statusText}</span>
      <span class="muted">待确认 {dirtyEventIds.size}</span>
    </div>
    <div class="user-area">
      <button class="user-button" onClick={() => ((draft.userMenuOpen = !draft.userMenuOpen), notify())}>
        {cpSession?.luoguName ?? identity.luoguName}
      </button>
      {draft.userMenuOpen ? (
        <div class="user-menu lift-in">
          <button onClick={() => void pullApiSnapshot("手动同步")}>立即同步</button>
          <button
            onClick={async () => {
              identity = await createIdentity(identity.luoguName);
              location.reload();
            }}
          >
            重置本机密钥
          </button>
          <button
            onClick={async () => {
              logoutCpSession();
              draft.userMenuOpen = false;
              await startCpOAuthLogin();
            }}
          >
            登出
          </button>
        </div>
      ) : null}
    </div>
  </header>
);

const Home = () => (
  <main class="home-grid">
    <section class="panel chat-panel lift-in">
      <PanelTitle title="公共聊天室" subtitle="公共大厅消息" />
      <Chat />
      <AdminTools />
    </section>
    <section class="stack">
      <section class="panel hero-panel lift-in">
        <div>
          <p class="eyebrow">LOCKOUT MATCH</p>
          <h1>创建一场洛谷抢分对决</h1>
          <p class="lead">选择难度端点，自动缓存公开题库并抽题。正式开赛前题目封存，判题只统计开赛后的提交。</p>
        </div>
        <form class="create-form" autocomplete="off" onSubmit={(event) => void submitCreateRoom(event)}>
          <label>
            题目数量
            <input
              type="number"
              min="1"
              max="21"
              value={draft.roomCount}
              autoComplete="off"
              onInput={(event) => {
                draft.roomCount = clamp(Number(event.currentTarget.value || 9), 1, 21);
                notify();
              }}
            />
          </label>
          <DifficultyRangeSlider />
          <label>
            手动题号
            <textarea
              value={draft.manualProblems}
              placeholder="留空则从题库抽取，例如 P1000 P1001"
              autoComplete="off"
              onInput={(event) => {
                draft.manualProblems = event.currentTarget.value;
                const manualCount = parseManualProblemCount(draft.manualProblems);
                if (manualCount > 0) draft.roomCount = clamp(manualCount, 1, 21);
                notify();
              }}
            />
          </label>
          <div class="picker-note">
            <span>本地缓存 {cachedProblemCount()} 题</span>
            <span>{draft.pickerStatus || "首次抽题会下载并缓存洛谷公开题库"}</span>
          </div>
          <button class="primary">创建房间</button>
        </form>
      </section>
      <section class="home-bottom">
        <section class="panel lift-in">
          <PanelTitle title="实时对局" subtitle="等待或进行中" />
          <WaitingRooms />
        </section>
        <section class="panel lift-in">
          <PanelTitle title="历史对局" subtitle="本地记录" />
          <History />
        </section>
      </section>
    </section>
  </main>
);

const Lobby = () => (
  <main class="lobby">
    <section class="panel lift-in">
      <PanelTitle
        title="准备室"
        subtitle="红蓝双方都准备后自动开赛"
        action={
          <div class="title-actions">
            <button onClick={() => void navigator.clipboard.writeText(location.href)}>复制邀请链接</button>
            <button class="danger" onClick={() => void closeCurrentRoom(false)}>
              关闭房间
            </button>
          </div>
        }
      />
      <RestrictionBanner />
      <Roster />
      <div class="actions">
        <button disabled={isRestricted(identity.id)} onClick={() => void setTeam("red")}>
          加入红方
        </button>
        <button disabled={isRestricted(identity.id)} onClick={() => void setTeam("blue")}>
          加入蓝方
        </button>
        <button disabled={isRestricted(identity.id)} onClick={() => void setTeam("spectator")}>
          观赛席
        </button>
        {isParticipant(currentSeat()) ? (
          <button class="primary" disabled={isRestricted(identity.id)} onClick={() => void toggleReady()}>
            {state.players[identity.id]?.ready ? "取消准备" : "准备就绪"}
          </button>
        ) : null}
      </div>
      <p class="muted">观赛席不参与准备、投票和计分。未正式开始前，普通玩家也可以关闭房间。</p>
    </section>
    <section class="panel lift-in">
      <PanelTitle title="题目池" subtitle="开赛后公开" />
      <div class="table-scroll masked-problems">
        <Problems withActions={false} />
      </div>
    </section>
  </main>
);

const Arena = () => (
  <main class="arena">
    <section class="panel lift-in">
      <SeatBadge />
      <div class="scoreboard">
        <strong class="red">红 {scoreOf(state, "red")}</strong>
        <span>胜利线 {winThreshold(state)}</span>
        <strong class="blue">蓝 {scoreOf(state, "blue")}</strong>
      </div>
      {state.winner ? <div class="result">{state.winner === "draw" ? "平局" : `${teamName(state.winner)} 获胜`}</div> : null}
      <div class="table-scroll problem-scroll">
        <Problems withActions={true} />
      </div>
      <div class="actions">
        {isParticipant(currentSeat()) && !isRestricted(identity.id) ? (
          <>
            <button onClick={() => void openVote("surrender")}>投降</button>
            <button onClick={() => void openVote("draw")}>平局</button>
          </>
        ) : null}
      </div>
      <Votes />
    </section>
    <section class="panel chat-panel lift-in">
      <PanelTitle title="房间通讯" subtitle="/ 开头为队内消息" />
      <Roster compact />
      <Chat />
      <SystemFlow />
    </section>
    <section class="panel lift-in">
      <PanelTitle title="实时提交实况" subtitle={`${state.feed.length} 条`} />
      <div class="table-scroll feed-scroll">
        <Feed />
      </div>
    </section>
  </main>
);

const PanelTitle = ({ title, subtitle, action }: { title: string; subtitle?: string; action?: preact.ComponentChildren }) => (
  <div class="panel-title">
    <div>
      <span>{title}</span>
      {subtitle ? <small>{subtitle}</small> : null}
    </div>
    {action}
  </div>
);

const DifficultyRangeSlider = () => {
  const low = Math.min(draft.difficultyLow, draft.difficultyHigh) as DifficultyLevel;
  const high = Math.max(draft.difficultyLow, draft.difficultyHigh) as DifficultyLevel;
  const setLow = (value: DifficultyLevel) => {
    draft.difficultyLow = value;
    if (draft.difficultyLow > draft.difficultyHigh) draft.difficultyHigh = draft.difficultyLow;
    notify();
  };
  const setHigh = (value: DifficultyLevel) => {
    draft.difficultyHigh = value;
    if (draft.difficultyHigh < draft.difficultyLow) draft.difficultyLow = draft.difficultyHigh;
    notify();
  };
  return (
    <div class="difficulty-range">
      <div class="difficulty-range-head">
        <span>
          低难度 <strong>{difficultyName(low)}</strong>
        </span>
        <span>
          高难度 <strong>{difficultyName(high)}</strong>
        </span>
      </div>
      <div class="difficulty-track-wrap">
        <div class="difficulty-track" />
        <input
          class="difficulty-range-input low"
          type="range"
          min="1"
          max="8"
          step="1"
          value={draft.difficultyLow}
          aria-label="低难度端点"
          onInput={(event) => setLow(Number(event.currentTarget.value) as DifficultyLevel)}
        />
        <input
          class="difficulty-range-input high"
          type="range"
          min="1"
          max="8"
          step="1"
          value={draft.difficultyHigh}
          aria-label="高难度端点"
          onInput={(event) => setHigh(Number(event.currentTarget.value) as DifficultyLevel)}
        />
      </div>
      <div class="difficulty-scale">
        {difficultyMeta.map((item) => (
          <span key={item.value}>{item.short}</span>
        ))}
      </div>
    </div>
  );
};

const WaitingRooms = () => {
  const freshRooms = waitingRooms
    .filter((room) => Date.now() - room.createdAt < (room.status === "arena" ? 6 : 2) * 60 * 60 * 1000)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 12);
  if (freshRooms.length === 0) return <p class="muted">暂无等待中的公开房间。</p>;
  return (
    <div class="room-list">
      {freshRooms.map((room) => (
        <div class="room-card" key={room.roomId}>
          <div>
            <strong>
              {room.host} <em class={room.status === "arena" ? "live" : ""}>{room.status === "arena" ? "进行中" : "准备中"}</em>
            </strong>
            <span>
              {room.problemCount} 题 · {room.status === "arena" && room.startedAt ? `开赛 ${timeAgo(room.startedAt)}` : timeAgo(room.createdAt)}
            </span>
          </div>
          <div class="room-actions">
            <button
              onClick={() => {
                if (hasBlockingActiveRoom(room.roomId)) {
                  setStatus("你已经在一场比赛中，不能加入其他房间");
                  return;
                }
                location.hash = `room=${room.roomId}&secret=${room.secret}`;
              }}
            >
              {room.status === "arena" ? "观赛" : "加入"}
            </button>
            {isAdmin(identity.luoguName) ? (
              <button class="danger" onClick={() => void forceCloseListing(room)}>
                强制关房
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
};

const History = () => {
  const history = readHistory();
  if (history.length === 0) return <p class="muted">暂无历史对局。</p>;
  return (
    <>
      {history
        .slice(-8)
        .reverse()
        .map((item) => (
          <div class="history" key={`${item.roomId}:${item.at}`}>
            <span>{item.roomId}</span>
            <span>{item.result}</span>
          </div>
        ))}
    </>
  );
};

const Roster = ({ compact = false }: { compact?: boolean }) => (
  <div class={compact ? "teams compact" : "teams"}>
    <TeamCard team="red" />
    <TeamCard team="blue" />
    <TeamCard team="spectator" />
  </div>
);

const TeamCard = ({ team }: { team: Seat }) => {
  const players = Object.values(state.players).filter((player) => player.team === team);
  return (
    <div class={`team ${team}`}>
      <h3>{teamName(team)}</h3>
      {players.length ? (
        players.map((player) => <PlayerRow player={player} team={team} key={player.id} />)
      ) : (
        <p class="muted">{team === "spectator" ? "暂无观赛者" : "等待玩家"}</p>
      )}
    </div>
  );
};

const PlayerRow = ({ player, team }: { player: Player; team: Seat }) => {
  const muted = isMuted(player.id);
  const kicked = moderationRecordForPlayer(player);
  return (
    <div class={`player ${kicked ? "restricted" : ""}`}>
      <span class="player-name">{player.luoguName}</span>
      <span class="badge-row">
        {isAdmin(player.luoguName) ? <em class="role admin">管理员</em> : null}
        {muted ? <em class="role muted">禁言</em> : null}
        {kicked ? <em class="role kicked">封禁</em> : null}
        <em class="role">{team === "spectator" ? "观赛" : player.ready ? "已准备" : "未准备"}</em>
      </span>
      {kicked ? <small class="moderation-reason">{kicked.reason}</small> : null}
    </div>
  );
};

const RestrictionBanner = () => {
  const record = moderationRecordForPlayer(state.players[identity.id]) || moderationRecordForName(identity.luoguName);
  if (!record && !isMuted(identity.id)) return null;
  return (
    <div class="restriction-banner">
      {record ? (
        <>
          <strong>你已被移出并封禁</strong>
          <span>
            {record.reason} · {record.by}
          </span>
        </>
      ) : (
        <>
          <strong>你已被禁言</strong>
          <span>仍可观赛，但暂时不能发送聊天消息。</span>
        </>
      )}
    </div>
  );
};

const AdminTools = ({ compact = false }: { compact?: boolean }) => {
  if (!isAdmin(identity.luoguName) || roomId !== "global") return null;
  const players = uniquePlayersByName();
  return (
    <div class={`admin-tools ${compact ? "compact" : ""}`}>
      <div class="admin-head">
        <span>全局管理员面板</span>
        <small>禁言影响全部房间发言，踢出会按用户名封禁。</small>
      </div>
      <div class="admin-list">
        {players.map((player) => {
          const sameNamePlayers = playersByNormalizedName(player.luoguName);
          const muted = sameNamePlayers.some((target) => isMuted(target.id));
          const kicked = Boolean(moderationRecordForPlayer(player));
          const protectedUser = isAdmin(player.luoguName);
          return (
            <div class="admin-row" key={normalizeName(player.luoguName)}>
              <div>
                <strong>{player.luoguName}</strong>
                <span>
                  {teamName(player.team)}
                  {muted ? " · 已禁言" : ""}
                  {kicked ? " · 已封禁" : ""}
                </span>
              </div>
              <input
                value={draft.adminReasons[player.id] || ""}
                placeholder="踢出理由"
                autoComplete="off"
                disabled={protectedUser || kicked}
                onInput={(event) => {
                  draft.adminReasons[player.id] = event.currentTarget.value;
                  notify();
                }}
              />
              <div class="admin-actions">
                <button disabled={protectedUser || kicked} onClick={() => void adminMute(player, muted)}>
                  {muted ? "解除禁言" : "禁言"}
                </button>
                {kicked ? (
                  <button onClick={() => void adminUnkick(player)}>取消封禁</button>
                ) : (
                  <button class="danger" disabled={protectedUser} onClick={() => void adminKick(player)}>
                    踢出并封禁
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const SeatBadge = () => (
  <div class={`seat-badge ${currentSeat()}`}>
    <span>我的身份</span>
    <strong>{teamName(currentSeat())}</strong>
  </div>
);

const Problems = ({ withActions }: { withActions: boolean }) => (
  <table>
    <thead>
      <tr>
        <th>题目</th>
        <th>难度</th>
        <th>分数</th>
        <th>解题选手</th>
        {withActions ? <th>操作</th> : null}
      </tr>
    </thead>
    <tbody>
      {state.problems.map((problem, index) =>
        withActions ? (
          <tr class={problem.solvedBy?.team ?? ""} key={problem.pid}>
            <td>
              <a href={`https://www.luogu.com.cn/problem/${problem.pid}`} target="_blank" rel="noreferrer">
                {problem.pid}
              </a>
              {problem.title ? <small class="problem-title">{problem.title}</small> : null}
            </td>
            <td>{problem.difficulty ? <DifficultyBadge level={problem.difficulty} /> : <span class="muted">随机</span>}</td>
            <td>{problem.score}</td>
            <td>{problem.solvedBy ? problem.solvedBy.luoguName : "未抢占"}</td>
            <td class="row-actions">
              {isParticipant(currentSeat()) && !isRestricted(identity.id) ? (
                <>
                  <button onClick={() => void judgeProblem(problem.pid)}>判题</button>
                  <button onClick={() => void openVote("replace-problem", problem.pid, createReplacementProblem(state, crypto.randomUUID(), problem.pid))}>
                    换题
                  </button>
                  <button onClick={() => void openVote("delete-problem", problem.pid)}>删除</button>
                </>
              ) : (
                <span class="muted">观赛中</span>
              )}
            </td>
          </tr>
        ) : (
          <tr key={`${problem.pid}:${index}`}>
            <td>
              <span class="blur-token">P{String(index + 1).padStart(4, "0")}</span>
            </td>
            <td>
              <span class="blur-token">{problem.difficulty ? difficultyName(problem.difficulty) : "未知"}</span>
            </td>
            <td>
              <span class="blur-token">{problem.score}</span>
            </td>
            <td>
              <span class="muted">开赛后公开</span>
            </td>
          </tr>
        )
      )}
    </tbody>
  </table>
);

const DifficultyBadge = ({ level }: { level: number }) => {
  const meta = difficultyMeta.find((item) => item.value === level);
  return (
    <span class="difficulty-badge" style={{ "--difficulty-color": meta?.color ?? "#6b7280" } as preact.JSX.CSSProperties}>
      {meta?.short ?? level}
    </span>
  );
};

const Chat = () => {
  const chats = roomId === "global" ? state.chats.filter((chat) => chat.visibility === "all") : visibleChats(state, identity.id);
  return (
    <>
      <div class="chat-log">
        {chats.slice(-80).reverse().map((chat) => (
          <ChatLine chat={chat} key={chat.id} />
        ))}
      </div>
      <form class="chat-form" autocomplete="off" onSubmit={(event) => void submitChat(event)}>
        <input
          name="duel-message"
          value={draft.chat}
          placeholder={roomId === "global" ? "输入公共消息" : "输入消息，/ 开头为队内私聊"}
          autoComplete="new-password"
          spellcheck={false}
          disabled={Boolean(isMuted(identity.id) || isRestricted(identity.id))}
          onInput={(event) => {
            draft.chat = event.currentTarget.value;
            notify();
          }}
        />
        <button disabled={Boolean(isMuted(identity.id) || isRestricted(identity.id))}>发送</button>
      </form>
    </>
  );
};

const ChatLine = ({ chat }: { chat: ChatMessage }) => (
  <p class={chat.visibility === "team" ? "private" : ""}>
    <span>
      {chat.visibility === "team" ? "队内" : "公屏"} · {chat.luoguName}
    </span>
    {chat.text}
  </p>
);

const Votes = () => {
  const openVotes = Object.values(state.votes).filter((vote) => vote.status === "open");
  if (openVotes.length === 0) return null;
  const canVote = isParticipant(currentSeat()) && !isRestricted(identity.id);
  return (
    <div class="votes">
      {openVotes.map((vote) => (
        <div class="vote" key={vote.id}>
          <span>
            {voteLabel(vote.kind)} {vote.targetPid ?? ""}
          </span>
          <span>
            {Object.keys(vote.approvals).length}/{participantCount()}
          </span>
          {canVote ? (
            <>
              <button onClick={() => void emitCommand({ kind: "vote.cast", voteId: vote.id, approve: true })}>同意</button>
              <button onClick={() => void emitCommand({ kind: "vote.cast", voteId: vote.id, approve: false })}>拒绝</button>
            </>
          ) : null}
          {canVote && vote.proposerId === identity.id ? (
            <button onClick={() => void emitCommand({ kind: "vote.cancelled", voteId: vote.id })}>取消</button>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const Feed = () => (
  <table>
    <thead>
      <tr>
        <th>用户</th>
        <th>题目</th>
        <th>时间</th>
        <th>状态</th>
      </tr>
    </thead>
    <tbody>
      {state.feed.map((item) => (
        <tr key={`${item.recordId}:${item.pid}`}>
          <td>{item.luoguName}</td>
          <td>{item.pid}</td>
          <td>{formatTime(item.at)}</td>
          <td>
            <strong>{item.status}</strong>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

const SystemFlow = () => (
  <div class="system-flow">
    {state.system.slice(-10).map((line, index) => (
      <p key={`${line}:${index}`}>{line}</p>
    ))}
  </div>
);

const EndOverlay = () => {
  if (state.phase !== "finished") return null;
  const mine = currentSeat();
  const title = state.closed
    ? "房间已关闭"
    : state.winner === "draw"
      ? "平局"
      : state.winner === mine
        ? "胜利"
        : isParticipant(mine)
          ? "失败"
          : `${teamName(state.winner ?? "spectator")} 获胜`;
  const detail = state.closed?.reason ?? "10 秒后返回主页";
  return (
    <div class="end-overlay">
      <div class={`end-card ${state.winner ?? "closed"}`}>
        <p class="eyebrow">MATCH END</p>
        <h1>{title}</h1>
        <p class="lead">{detail}</p>
        <button class="primary" onClick={() => (location.hash = "")}>
          返回主页
        </button>
      </div>
    </div>
  );
};

const loadLog = (): SignedEnvelope[] => JSON.parse(localStorage.getItem(storageKey()) || "[]") as SignedEnvelope[];
const saveLog = () => localStorage.setItem(storageKey(), JSON.stringify(envelopes.slice(-1000)));
const cloudKey = (): string => (roomId === "global" ? "global" : `${roomId}:${roomSecret}`);
const compareEnvelopes = (a: SignedEnvelope, b: SignedEnvelope): number =>
  a.event.lamport - b.event.lamport || a.event.issuedAt - b.event.issuedAt || a.event.id.localeCompare(b.event.id);

const preferredSeat = (): Seat => {
  if (state.phase !== "lobby") return "spectator";
  const remembered = localStorage.getItem(roomSeatKey()) as Seat | null;
  if (remembered === "red" || remembered === "blue" || remembered === "spectator") return remembered;
  return pickTeam();
};

const pickTeam = (): Team => {
  const red = Object.values(state.players).filter((p) => p.team === "red").length;
  const blue = Object.values(state.players).filter((p) => p.team === "blue").length;
  return red <= blue ? "red" : "blue";
};

const rememberSeat = (seat: Seat) => localStorage.setItem(roomSeatKey(), seat);
const currentSeat = (): Seat => state.players[identity.id]?.team ?? preferredSeat();
const isParticipant = (seat: Seat | undefined): seat is Team => seat === "red" || seat === "blue";
const participantCount = (): number => Object.values(state.players).filter((player) => isParticipant(player.team) && !isRestricted(player.id)).length;
const teamName = (seat: Seat): string => (seat === "red" ? "红方" : seat === "blue" ? "蓝方" : "观赛席");
const isAdmin = (name: string): boolean => adminNames.has(name);
const normalizeName = (name: string): string => name.trim().toLowerCase();
const moderationRecordForName = (name: string) => state.banned[normalizeName(name)] || globalModeration.banned[normalizeName(name)];
const moderationRecordForPlayer = (player: Player | undefined) =>
  player ? state.kicked[player.id] || globalModeration.kicked[player.id] || moderationRecordForName(player.luoguName) : undefined;
const isBannedName = (name: string): boolean => Boolean(moderationRecordForName(name));
const isMuted = (id: string): boolean => Boolean(state.muted[id] || globalModeration.muted[id]);
const isRestricted = (id: string): boolean => {
  const player = state.players[id];
  return Boolean(moderationRecordForPlayer(player));
};
const findPlayerByName = (name: string): Player | undefined =>
  Object.values(state.players).find((player) => normalizeName(player.luoguName) === normalizeName(name));
const playersByNormalizedName = (name: string): Player[] =>
  Object.values(state.players).filter((player) => normalizeName(player.luoguName) === normalizeName(name));
const uniquePlayersByName = (): Player[] => {
  const byName = new Map<string, Player>();
  for (const player of Object.values(state.players)) {
    const key = normalizeName(player.luoguName);
    const current = byName.get(key);
    if (!current || isAdmin(player.luoguName) || player.luoguName.localeCompare(current.luoguName) < 0) {
      byName.set(key, player);
    }
  }
  return [...byName.values()].sort((a, b) => a.luoguName.localeCompare(b.luoguName));
};

const rememberActiveRoomIfNeeded = () => {
  const seat = state.players[identity.id]?.team;
  if (roomId !== "global" && isParticipant(seat) && !isRestricted(identity.id) && state.phase !== "finished") {
    localStorage.setItem(activeRoomKey, JSON.stringify({ roomId, secret: roomSecret }));
  }
  if (state.phase === "finished" || isRestricted(identity.id)) localStorage.removeItem(activeRoomKey);
};

const hasBlockingActiveRoom = (allowedRoomId?: string): boolean => {
  const raw = localStorage.getItem(activeRoomKey);
  if (!raw) return false;
  try {
    const active = JSON.parse(raw) as { roomId?: string };
    return Boolean(active.roomId && active.roomId !== allowedRoomId);
  } catch {
    localStorage.removeItem(activeRoomKey);
    return false;
  }
};

const parseManualProblemCount = (value: string): number =>
  value
    .split(/[\s,，]+/)
    .map((pid) => pid.trim().toUpperCase())
    .filter((pid) => /^P\d{1,5}$/.test(pid)).length;

const readHistory = (): Array<{ roomId: string; result: string; at: number }> => {
  try {
    return JSON.parse(localStorage.getItem(historyKey) || "[]") as Array<{ roomId: string; result: string; at: number }>;
  } catch {
    return [];
  }
};

const saveHistory = () => {
  if (roomId === "global" || !state.winner) return;
  const history = readHistory();
  const result = state.winner === "draw" ? "平局" : `${teamName(state.winner)}胜`;
  const next = history.filter((item) => item.roomId !== roomId).concat({ roomId, result, at: Date.now() });
  localStorage.setItem(historyKey, JSON.stringify(next.slice(-30)));
};

const friendlyCloudError = (error: unknown, prefix = "云同步暂时不可用"): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Failed to fetch") || message.includes("NetworkError") || message.includes("Load failed")) {
    return `${prefix}，已切换本地缓存并自动退避重试`;
  }
  return `${prefix}：${message}`;
};

const difficultyName = (level: number): string => difficultyMeta.find((item) => item.value === level)?.label ?? `难度 ${level}`;
const voteLabel = (kind: VoteKind): string => {
  if (kind === "replace-problem") return "换题";
  if (kind === "delete-problem") return "删题";
  if (kind === "draw") return "平局";
  return "投降";
};
const compactId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
const formatTime = (time: number) => new Date(time).toLocaleString("zh-CN", { hour12: false });
const timeAgo = (time: number): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
};

notify();
void boot();
