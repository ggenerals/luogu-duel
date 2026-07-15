import "./style.css";
import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";
import type { ComponentChildren, JSX } from "preact";
import { render } from "preact";
import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Crown,
  DoorClosed,
  Eye,
  Flame,
  Flag,
  Handshake,
  LogOut,
  Medal,
  MessageSquare,
  Monitor,
  Moon,
  Play,
  Radio,
  RefreshCw,
  Send,
  Shield,
  Sprout,
  Star,
  Sun,
  Swords,
  Terminal,
  Trash2,
  Trophy,
  UserMinus,
  Users,
  Volume2,
  VolumeX,
  X,
  Zap
} from "lucide-preact";
import {
  applyEvent,
  applyEvents,
  buildVote,
  canCloseRoom,
  canStart,
  createInitialState,
  isAdminName,
  isTeam,
  normalizeName,
  requiredVoters,
  scoreOf,
  sortProblemsByDifficulty,
  teamName,
  visibleChats,
  winThreshold
} from "./domain";
import { createIdentity, loadIdentity, renameIdentity, signEvent, verifyEnvelope, type LocalIdentity } from "./identity";
import { cachedProblemCount, defaultRatios, difficultyMeta, parseCustomProblems, pickProblems, platformLabel, type DifficultyLevel, type PlatformRatios, type ProblemPlatform } from "./problemPicker";
import { createVJudgeChallenge, loadVJudgeSession, logoutVJudgeSession, verifyVJudgeLogin, type VJudgeSession } from "./oauth";
import { allowServerRequest, directoryWebSocketUrl, fetchRooms, fetchSnapshot, fetchUserRecord, fetchUsers, publishEnvelope, roomWebSocketUrl, saveUserRecord, setServerRequestWarningHandler, updateUserRating, type RoomListing, type ServerMessage, type UserRecord } from "./realtimeStore";
import { fetchVJudgeRecords } from "./vjudge";
import type { ChatMessage, DuelEvent, DuelState, Player, Problem, Seat, SignedEnvelope, VoteKind } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

type BootPhase = "loading" | "auth-error" | "ready";
type ViewMode = "home" | "room" | "profile" | "admin";

function profileNameFromPath(): string {
  const match = decodeURIComponent(location.pathname).match(/^\/user\/([^/]+)\/?$/);
  return match?.[1]?.trim() ?? "";
}

const initialProfileUserName = profileNameFromPath();
let bootPhase: BootPhase = "loading";
let mode: ViewMode = initialProfileUserName ? "profile" : "home";
let identity: LocalIdentity;
let vjudgeSession: VJudgeSession | null = null;
let roomId = "global";
let roomSecret = "public-lobby";
let envelopes: SignedEnvelope[] = [];
let state: DuelState = createInitialState(roomId);
let globalModeration: DuelState = createInitialState("global");
let rooms: RoomListing[] = [];
let users: UserRecord[] = [];
let usersLoaded = false;
let profileUserName = initialProfileUserName;
let bootScreenVisible = true;
let bootScreenLeaving = false;
let socket: WebSocket | null = null;
let directorySocket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let directoryReconnectTimer: number | undefined;
let lastDirectoryHttpSync = 0;
let directoryLiveSnapshotReceived = false;
let finishReturnTimer: number | undefined;
let clockTimer: number | undefined;
let syncTimer: number | undefined;
let statusText = "booting...";
let statusTone: "info" | "error" = "info";
let authErrorText = "";
let vjudgeUsername = "";
let vjudgeChallenge = createVJudgeChallenge();
let creatingRoom = false;
let loginSubmitting = false;
const adminBusy = new Set<string>();
const judgingProblems = new Set<string>();
let downloadProgress: Record<ProblemPlatform, { percent: number; status: string }> = {
  luogu: { percent: 0, status: "等待下载" }, codeforces: { percent: 0, status: "等待下载" }, atcoder: { percent: 0, status: "等待下载" }
};
let toasts: ToastMessage[] = [];
const notifiedKeys = new Set<string>();
const joinDeniedRooms = new Set<string>();
const systemLogoUrl = "https://cdn.luogu.com.cn/upload/image_hosting/tq5l4861.png";
const darkBrandLogoUrl = "https://cdn.luogu.com.cn/upload/image_hosting/giufbahf.png";
const lightBrandLogoUrl = "https://cdn.luogu.com.cn/upload/image_hosting/tq5l4861.png";
const avatarCacheKey = "luogu-duel.avatar-cache.v1";
const userCacheKey = "luogu-duel.user-cache.v1";
const registrationCacheKey = "luogu-duel.registration-cache.v1";
const bannedAvatarUrl = "https://cdn.luogu.com.cn/images/banned.png";
const userCacheTtl = 24 * 60 * 60 * 1000;
const themeModeKey = "luogu-duel.theme-mode.v1";
const avatarCache: Record<string, string> = readAvatarCache();
const userCache: Record<string, { user: UserRecord; cachedAt: number }> = readUserCache();
const avatarLoading = new Set<string>();
const avatarMissing = new Set<string>();
let themeMode = readThemeMode();
const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");

const draft = {
  userMenuOpen: false,
  themeMenuOpen: false,
  roomTab: "duel" as "duel" | "ranking",
  profileEditing: false,
  chat: "",
  roomCount: 9,
  customProblems: "",
  difficultyLow: 1 as DifficultyLevel,
  difficultyHigh: 3 as DifficultyLevel,
  ratios: { ...defaultRatios } as PlatformRatios,
  unrated: false,
  pickerStatus: "",
  closeReason: "房主关闭房间",
  adminTarget: "",
  adminReason: "",
  adminRatings: {} as Record<string, string>,
  teamsOpen: false
};

type ToastMessage = {
  id: string;
  title: string;
  text: string;
  tone: "info" | "success" | "warning";
};

const dataVersion = "v3";
const roomSeatKey = () => `luogu-duel.${dataVersion}.seat.${roomId}`;
const activeRoomKey = `luogu-duel.active-room.${dataVersion}`;
const historyKey = `luogu-duel.history.${dataVersion}`;
const directoryCacheKey = "vjudge-duel.directory-cache.v1";
const eventCacheKey = (id: string) => `vjudge-duel.events.${dataVersion}.${id}`;

const notify = (forceStickChat = false) => {
  const stickChat = forceStickChat || shouldStickChats();
  render(<App />, app);
  if (stickChat) queueMicrotask(scrollChatsToBottom);
};
const applyTheme = () => {
  const effective = themeMode === "system" ? (themeQuery.matches ? "dark" : "light") : themeMode;
  document.documentElement.dataset.theme = effective;
};
const setStatus = (text: string, tone: "info" | "error" = "info") => {
  statusText = text;
  statusTone = tone;
  notify();
};

const finishBootScreen = () => {
  if (!bootScreenVisible || bootScreenLeaving) return;
  bootScreenLeaving = true;
  notify();
  window.setTimeout(() => {
    bootScreenVisible = false;
    notify();
  }, 260);
};

const boot = async () => {
  identity = await loadIdentity();
  applyTheme();
  themeQuery.addEventListener("change", () => {
    if (themeMode === "system") applyTheme();
    notify();
  });
  clockTimer ??= window.setInterval(() => notify(), 20_000);
  syncTimer ??= window.setInterval(() => void periodicSync(), 20_000);
  window.addEventListener("hashchange", () => void enterFromHash());
  window.addEventListener("online", () => {
    connectRoom();
    connectDirectory();
  });

  vjudgeSession = loadVJudgeSession();
  if (!vjudgeSession) {
    authErrorText = "请使用 VJudge 登录。";
    statusText = "等待 VJudge 身份验证";
    bootPhase = "auth-error";
    finishBootScreen();
    notify();
    return;
  }

  identity = await renameIdentity(identity, vjudgeSession.username);
  bootPhase = "ready";
  await registerCurrentUser();
  await refreshGlobalModeration();
  await enterFromHash();
  finishBootScreen();
};

const enterFromHash = async () => {
  const profileName = profileNameFromPath();
  if (profileName) {
    mode = "profile";
    roomId = "global";
    roomSecret = "public-lobby";
    profileUserName = profileName;
    closeSocket();
    connectDirectory();
    await Promise.all([loadDirectory(), loadUsers()]);
    await ensureUserLoaded(profileName);
    notify();
    return;
  }
  const params = new URLSearchParams(location.hash.slice(1));
  const adminRequested = params.get("admin") === "1";
  roomId = params.get("room") || "global";
  roomSecret = params.get("secret") || (roomId === "global" ? "public-lobby" : "public-room");
  mode = adminRequested && isAdmin() ? "admin" : roomId === "global" ? "home" : "room";
  closeSocket();
  clearFinishTimer();
  draft.chat = "";
  draft.closeReason = isAdmin() ? "管理员强制关闭房间" : "房主关闭房间";

  if (mode === "home" || mode === "admin") {
    connectDirectory();
    directoryLiveSnapshotReceived = false;
    const cachedEvents = readEventCache("global");
    envelopes = [];
    state = createInitialState("global");
    await mergeEnvelopes(cachedEvents);
    globalModeration = state;
    rooms = readDirectoryCache();
    users = Object.values(userCache).map((entry) => entry.user);
    statusTone = "info";
    statusText = "正在连接大厅";
    notify();
    await Promise.all([loadDirectory(), loadUsers()]);
    notify();
    return;
  }

  state = createInitialState(roomId);
  closeDirectory();
  const cachedEvents = readEventCache(roomId);
  envelopes = [];
  await mergeEnvelopes(cachedEvents);
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
    const remoteRooms = await fetchRooms();
    if (!directoryLiveSnapshotReceived) {
      rooms = remoteRooms;
      writeDirectoryCache(rooms);
    }
    statusTone = "info";
    statusText = "大厅在线";
  } catch (error) {
    if (!rooms.length) rooms = readDirectoryCache();
    statusTone = "error";
    statusText = friendlyError(error, "房间目录暂时不可用");
  }
};

const loadUsers = async () => {
  try {
    users = await fetchUsers();
    for (const user of users) userCache[normalizeName(user.name)] = { user, cachedAt: Date.now() };
    writeUserCache();
  } catch {
    users = Object.values(userCache)
      .filter((entry) => Date.now() - entry.cachedAt < userCacheTtl)
      .map((entry) => entry.user);
  } finally {
    usersLoaded = true;
  }
};

const setThemeMode = (next: "system" | "light" | "dark") => {
  themeMode = next;
  try {
    localStorage.setItem(themeModeKey, next);
  } catch {
    // ignore
  }
  applyTheme();
  draft.themeMenuOpen = false;
  notify();
};

function readThemeMode(): "system" | "light" | "dark" {
  try {
    const stored = localStorage.getItem(themeModeKey);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // ignore
  }
  return "system";
}

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
  if (mode === "home" || mode === "profile") {
    connectDirectory();
    if (directorySocket?.readyState === WebSocket.OPEN) return;
    if (Date.now() - lastDirectoryHttpSync < 5 * 60_000) return;
    lastDirectoryHttpSync = Date.now();
    await Promise.all([loadDirectory(), loadUsers()]);
  } else {
    if (socket?.readyState === WebSocket.OPEN) return;
    await loadSnapshot();
  }
  notify();
};

const connectRoom = () => {
  if (mode !== "room") return;
  if (!allowServerRequest()) return;
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

const connectDirectory = () => {
  if (mode !== "home" && mode !== "profile" && mode !== "admin") return;
  if (directorySocket?.readyState === WebSocket.OPEN || directorySocket?.readyState === WebSocket.CONNECTING) return;
  if (!allowServerRequest()) return;
  closeDirectory(false);
  directorySocket = new WebSocket(directoryWebSocketUrl());
  directorySocket.addEventListener("open", () => {
    statusTone = "info";
    statusText = "大厅实时连接已建立";
    notify();
  });
  directorySocket.addEventListener("message", (event) => void handleDirectoryMessage(event.data));
  directorySocket.addEventListener("close", () => {
    directorySocket = null;
    if (mode === "home" || mode === "profile") {
      statusTone = "error";
      statusText = "大厅实时连接断开，使用低频 HTTP 兜底";
      directoryReconnectTimer = window.setTimeout(connectDirectory, 5000);
      notify();
    }
  });
  directorySocket.addEventListener("error", () => {
    statusTone = "error";
    statusText = "大厅实时连接错误，使用低频 HTTP 兜底";
    notify();
  });
};

const closeDirectory = (clearTimer = true) => {
  if (clearTimer && directoryReconnectTimer) window.clearTimeout(directoryReconnectTimer);
  directoryReconnectTimer = undefined;
  if (directorySocket) directorySocket.close();
  directorySocket = null;
};

const handleDirectoryMessage = async (raw: string) => {
  const message = JSON.parse(raw) as ServerMessage;
  if (message.type === "directory") {
    rooms = message.rooms;
    writeDirectoryCache(rooms);
    directoryLiveSnapshotReceived = true;
    statusTone = "info";
    statusText = "大厅在线";
  }
  if (message.type === "users") {
    users = message.users;
    for (const user of users) userCache[normalizeName(user.name)] = { user, cachedAt: Date.now() };
    writeUserCache();
    usersLoaded = true;
  }
  if (message.type === "error") {
    statusTone = "error";
    statusText = message.message;
  }
  notify();
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
    if (message.message.includes("另一场未结束比赛") || message.message.includes("操作过于频繁")) {
      if (message.message.includes("另一场未结束比赛")) joinDeniedRooms.add(roomId);
      await replaceRoomSnapshot();
    }
  }
  notify();
};

const mergeEnvelopes = async (incoming: SignedEnvelope[]) => {
  for (const envelope of incoming) await receiveEnvelope(envelope, false);
};

const replaceRoomSnapshot = async () => {
  const remote = await fetchSnapshot(roomId, roomSecret, false);
  envelopes = [];
  state = createInitialState(roomId);
  await mergeEnvelopes(remote);
  if (state.closed) localStorage.removeItem(eventCacheKey(roomId));
  else writeEventCache(roomId, envelopes);
  saveHistory();
};

const ensureJoined = async () => {
  if (mode !== "room" || state.phase !== "lobby" || state.players[identity.id] || bannedRecord() || joinDeniedRooms.has(roomId)) return;
  const active = readActiveRoom();
  if (active?.roomId && active.roomId !== roomId) {
    setStatus("你正在另一场未结束比赛中，本房以观赛方式打开", "error");
    return;
  }
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
  const previousPhase = state.phase;
  const previousSystemCount = state.system.length;
  envelopes.push(envelope);
  envelopes.sort(compareEnvelopes);
  state = applyEvents(roomId, envelopes.map((item) => item.event));
  writeEventCache(roomId, envelopes);
  if (roomId === "global") globalModeration = state;
  saveHistory();
  scheduleFinishReturn();
  maybeAutoStart();
  rememberActiveRoomIfNeeded();
  if (renderNow) pushToastsForEvent(envelope.event, previousPhase, previousSystemCount);
  if (renderNow) notify();
};

const emit = async (event: DuelEvent) => {
  if (blockedByBan()) return;
  if (mode === "room" && state.phase === "finished") return;
  if (!allowServerRequest()) return;
  const envelope = await signEvent(identity, event);
  await receiveEnvelope(envelope);
  let sentBySocket = false;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "event", envelope }));
    sentBySocket = true;
  }
  if (sentBySocket) return;
  try {
    await publishEnvelope(roomId, roomSecret, envelope);
  } catch (error) {
    const message = friendlyError(error, "事件已保存在本地，发送失败");
    if (!sentBySocket) setStatus(message, "error");
    if (message.includes("另一场未结束比赛") || message.includes("操作过于频繁")) {
      if (message.includes("另一场未结束比赛")) joinDeniedRooms.add(roomId);
      await replaceRoomSnapshot();
    }
  }
};

const pushToastsForEvent = (event: DuelEvent, previousPhase: DuelState["phase"], previousSystemCount: number) => {
  if (mode !== "room" && event.roomId !== "global") return;
  if (event.type === "game.started") {
    notifyImportant(`start:${roomId}:${state.startedAt ?? event.issuedAt}:${matchTitle()}`, "比赛开始", matchTitle(), "success");
  }
  if (previousPhase !== "finished" && state.phase === "finished") {
    const text = state.closed?.reason ?? (state.winner === "draw" ? "双方平局" : `${teamName(state.winner)} 获胜`);
    notifyImportant(`end:${roomId}:${state.closed?.at ?? event.issuedAt}:${text}`, "比赛结束", text, "warning");
  }
  if (event.type === "chat.sent" && event.visibility === "team" && state.phase === "arena") {
    const chat = state.chats.find((item) => item.id === event.id);
    if (chat && visibleChats(state, identity.id).some((item) => item.id === chat.id)) {
      notifyImportant(`${event.id}:team`, `队内消息 / ${chat.luoguName}`, chat.text, "info");
    }
  }
  if (event.type !== "game.started" && (state.phase === "arena" || event.type.startsWith("vote.") || event.type === "judge.recordSeen" || event.type === "room.closed")) {
    for (const message of state.system.slice(previousSystemCount)) {
      notifyImportant(`system:${roomId}:${message.at}:${message.text}`, "系统", message.text, event.type === "judge.recordSeen" ? "success" : "info");
    }
  }
};

const notifyImportant = async (key: string, title: string, text: string, tone: ToastMessage["tone"] = "info") => {
  const normalizedKey = `${key}:${title}:${text}`.replace(/\s+/g, " ").trim();
  if (notifiedKeys.has(normalizedKey)) return;
  notifiedKeys.add(normalizedKey);
  const gmNotify = (globalThis as unknown as { GM_notification?: (options: { title: string; text: string; timeout?: number }) => void }).GM_notification;
  if (gmNotify) {
    gmNotify({ title: `VJudge Duel · ${title}`, text, timeout: 4200 });
    return;
  }
  if ("Notification" in window) {
    let permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }
    if (permission === "granted") {
      new Notification(`VJudge Duel · ${title}`, {
        body: text,
        icon: systemLogoUrl
      });
      return;
    }
  }
  pushToast(title, text, tone);
};

setServerRequestWarningHandler(() => {
  void notifyImportant(
    `request-limit:${Math.floor(Date.now() / 60_000)}`,
    "请求过于频繁",
    "本分钟已发送 60 次请求，继续操作可能被视为攻击并导致管理员封号。",
    "warning"
  );
});

const pushToast = (title: string, text: string, tone: ToastMessage["tone"] = "info") => {
  if (toasts.some((item) => item.title === title && item.text === text)) return;
  const toast: ToastMessage = { id: crypto.randomUUID(), title, text, tone };
  toasts = [...toasts.slice(-3), toast];
  window.setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== toast.id);
    notify();
  }, 4200);
};

const emitChat = async (text: string, visibility: "all" | "team") => {
  if (mode === "home") await ensureHomeJoined();
  await emit({ ...baseEvent("chat.sent"), text, visibility });
};

const emitDirect = async (event: Extract<DuelEvent, { type: "room.closed" | "player.kicked" | "player.unkicked" | "player.muted" | "player.unmuted" }>) => {
  await emit(event);
};

const refreshGlobalModeration = async () => {
  try {
    const remote = await fetchSnapshot("global", "public-lobby");
    if (mode === "home" && roomId === "global") {
      await mergeHomeGlobalSnapshot(remote);
      return;
    }
    globalModeration = applyEvents("global", remote.map((item) => item.event));
  } catch {
    globalModeration = mode === "home" && roomId === "global" ? state : createInitialState("global");
  }
};

const mergeHomeGlobalSnapshot = async (incoming: SignedEnvelope[]) => {
  for (const envelope of incoming) {
    if (envelope.event.roomId !== "global") continue;
    if (envelopes.some((item) => item.event.id === envelope.event.id)) continue;
    if (await verifyEnvelope(envelope)) envelopes.push(envelope);
  }
  envelopes = envelopes.filter((item) => item.event.roomId === "global");
  envelopes.sort(compareEnvelopes);
  state = applyEvents("global", envelopes.map((item) => item.event));
  globalModeration = state;
  saveHistory();
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
  if (mode === "home" || mode === "admin") state = globalModeration;
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
  if (creatingRoom) return;
  creatingRoom = true;
  notify();
  try {
  if (!(await leaveOrCloseCurrentMatchForNewRoom())) return;

  const nextRoom = compactId();
  const nextSecret = compactId() + compactId();
  const customProblems = parseCustomProblems(draft.customProblems);
  if (draft.customProblems.trim() && !customProblems.length) {
    setStatus("没有识别到有效的自定义题目", "error");
    return;
  }
  const count = customProblems.length || clamp(draft.roomCount, 1, 21);
  if (customProblems.length) {
    draft.roomCount = customProblems.length;
    draft.unrated = true;
  }
  let problems: Problem[];
  try {
    if (customProblems.length) {
      problems = customProblems;
      draft.pickerStatus = `已使用 ${customProblems.length} 道自定义题目`;
    } else {
      draft.pickerStatus = "正在读取题库";
      downloadProgress = { luogu: { percent: 0, status: "等待下载" }, codeforces: { percent: 0, status: "等待下载" }, atcoder: { percent: 0, status: "等待下载" } };
      void Swal.fire({
        title: "正在准备题库",
        html: problemBankProgressHtml(),
        allowEscapeKey: false,
        allowOutsideClick: false,
        showConfirmButton: false,
        customClass: { popup: "duel-swal bank-loading-swal" }
      });
      problems = await pickProblems(count, nextRoom, draft.difficultyLow, draft.difficultyHigh, draft.ratios, (platform, percent, status) => {
        downloadProgress[platform] = { percent, status };
        Swal.update({ html: problemBankProgressHtml() });
      });
    }
    problems = sortProblemsByDifficulty(problems);
    draft.pickerStatus = `已抽取 ${problems.length} 题`;
    Swal.close();
  } catch (error) {
    Swal.close();
    draft.pickerStatus = "";
    setStatus(error instanceof Error ? error.message : "题库抽取失败", "error");
    return;
  }

  history.pushState(null, "", `#room=${nextRoom}&secret=${nextSecret}`);
  await enterFromHash();
  await emit({ ...baseEvent("room.configured"), problems, rated: customProblems.length ? false : !draft.unrated });
  } finally {
    creatingRoom = false;
    notify();
  }
};

const problemBankProgressHtml = (): string => (["luogu", "codeforces", "atcoder"] as ProblemPlatform[])
  .map((platform) => {
    const progress = downloadProgress[platform];
    return `<div class="swal-bank-progress"><div><strong>${platformLabel(platform)}</strong><span>${progress.status}</span><b>${progress.percent}%</b></div><progress max="100" value="${progress.percent}"></progress></div>`;
  })
  .join("");

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
  notify(true);
};

const closeRoom = async () => {
  if (!canCloseRoom(state, identity.id, identity.luoguName)) return;
  await emitDirect({ ...baseEvent("room.closed"), reason: draft.closeReason, actorName: identity.luoguName });
};

const leaveRoom = async () => {
  const seat = state.players[identity.id]?.team ?? preferredSeat();
  if (mode !== "room") return;
  if (state.phase === "finished") {
    localStorage.removeItem(roomSeatKey());
    localStorage.removeItem(activeRoomKey);
    location.hash = "";
    return;
  }
  if (state.hostId === identity.id) {
    setStatus("房主不能退出，只能关闭房间", "error");
    return;
  }
  await emit({ ...baseEvent("player.left") });
  localStorage.removeItem(roomSeatKey());
  localStorage.removeItem(activeRoomKey);
  location.hash = "";
};

const kickLobbyPlayer = async (player: Player) => {
  if (state.phase !== "lobby" || state.hostId === player.id) return;
  const allowed = state.hostId === identity.id || isAdmin();
  if (!allowed) return;
  await emitDirect({
    ...baseEvent("player.kicked"),
    targetId: player.id,
    targetName: player.luoguName,
    reason: "移出准备房"
  });
};

const leaveOrCloseCurrentMatchForNewRoom = async (): Promise<boolean> => {
  let activeState = state;
  let activeId = roomId;
  let activeSecret = roomSecret;
  if (mode !== "room" || state.phase === "finished" || !isTeam(state.players[identity.id]?.team)) {
    const active = readActiveRoom();
    if (!active?.roomId || !active.secret) return true;
    const remote = await fetchSnapshot(active.roomId, active.secret);
    activeState = applyEvents(active.roomId, remote.map((item) => item.event));
    activeId = active.roomId;
    activeSecret = active.secret;
  }
  const player = activeState.players[identity.id];
  if (activeState.phase === "finished" || !isTeam(player?.team)) {
    localStorage.removeItem(activeRoomKey);
    return true;
  }
  const host = activeState.hostId === identity.id;
  const message = host
    ? "你正在主持一场未结束的比赛。创建新房间会关闭当前房间，是否继续？"
    : "你正在参加一场未结束的比赛。创建新房间会退出当前房间，是否继续？";
  const confirmation = await Swal.fire({
    title: host ? "关闭当前房间？" : "退出当前比赛？",
    text: message,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "继续创建",
    cancelButtonText: "取消",
    background: "var(--panel)",
    color: "var(--text)",
    customClass: {
      popup: "duel-swal",
      confirmButton: "duel-swal-confirm",
      cancelButton: "duel-swal-cancel"
    }
  });
  if (!confirmation.isConfirmed) return false;
  if (!allowServerRequest()) return false;
  const base = {
    roomId: activeId,
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: activeState.lamport + 1,
    issuedAt: Date.now()
  };
  const event: DuelEvent = host
    ? { ...base, type: "room.closed", reason: "房主创建新房间", actorName: identity.luoguName }
    : { ...base, type: "player.left" };
  const envelope = await signEvent(identity, event);
  await publishEnvelope(activeId, activeSecret, envelope);
  localStorage.removeItem(`luogu-duel.${dataVersion}.seat.${activeId}`);
  localStorage.removeItem(activeRoomKey);
  return true;
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
  if (state.hostId !== identity.id) return;
  if (envelopes.some((item) => item.event.type === "game.started")) return;
  void emit({ ...baseEvent("game.started") });
};

const openVote = async (kind: VoteKind, targetPid?: string, replacement?: Problem) => {
  const player = state.players[identity.id];
  if (state.phase !== "arena" || !player || !isTeam(player.team) || blockedByBan()) return;
  if (kind === "surrender") {
    const existing = Object.values(state.votes).find((vote) => vote.kind === "surrender" && vote.team === player.team && vote.status === "open");
    if (existing) {
      if (!existing.approvals[identity.id]) await emit({ ...baseEvent("vote.cast"), voteId: existing.id, approve: true });
      return;
    }
  }
  await emit({ ...baseEvent("vote.opened"), vote: buildVote(kind, player, targetPid, replacement) });
};

const replaceProblem = async (targetPid: string) => {
  void targetPid;
  setStatus("换题功能将在判题系统完成后开放", "error");
};

const judgeProblem = async (problem: Problem) => {
  const key = `${problem.platform ?? "luogu"}:${problem.pid}`;
  if (judgingProblems.has(key) || state.phase !== "arena" || !state.startedAt) return;
  judgingProblems.add(key);
  notify();
  try {
    const players = Object.values(state.players).filter((player) => isTeam(player.team) && !moderationRecordForPlayer(player));
    const records = await fetchVJudgeRecords(problem, players.map((player) => player.luoguName), state.startedAt);
    for (const record of records) {
      if (!state.feed.some((item) => item.recordId === record.recordId && item.pid === record.pid)) {
        await emit({ ...baseEvent("judge.recordSeen"), record });
      }
    }
    setStatus(records.length ? `${problem.pid} 已同步 ${records.length} 条提交` : `${problem.pid} 暂无开赛后的提交`);
  } catch (error) {
    setStatus(friendlyError(error, "VJudge 判题同步失败"), "error");
  } finally {
    judgingProblems.delete(key);
    notify();
  }
};

const App = () => {
  if (bootPhase === "loading") {
    return <BootScreen leaving={false} />;
  }
  const bootOverlay = bootScreenVisible ? <BootScreen leaving={bootScreenLeaving} /> : null;
  if (bootPhase === "auth-error") {
    return (
      <>
        <AuthError />
        {bootOverlay}
      </>
    );
  }
  return (
    <>
      <Shell title="VJudge Duel" subtitle={mode === "profile" ? "user" : mode === "admin" ? "admin" : mode === "home" ? "control room" : `${roomId} / ${state.phase}`}>
        {mode === "profile" ? <ProfilePage /> : mode === "admin" ? <AdminPage /> : mode === "home" ? <Home /> : <Room />}
      </Shell>
      <ToastStack />
      <BanOverlay />
      {bootOverlay}
    </>
  );
};

const ThemeModeIcon = () => {
  const Icon = themeMode === "system" ? Monitor : themeMode === "light" ? Sun : Moon;
  return <Icon size={16} />;
};

const Shell = ({ title, subtitle, children }: { title: string; subtitle: string; children: ComponentChildren }) => (
  <div class="app-shell">
    <header class="topbar">
      <button class="brand" onClick={() => {
        if (mode === "profile") location.href = "/";
        else location.hash = "";
      }}>
        {lightBrandLogoUrl || darkBrandLogoUrl ? <img src={document.documentElement.dataset.theme === "light" ? lightBrandLogoUrl : darkBrandLogoUrl} alt="" /> : null}
        <span>{title}</span>
        <em>{subtitle}</em>
      </button>
      <div class={`status-pill ${statusTone}`}>
        <Radio size={15} />
        <span>{statusText}</span>
      </div>
      <div class="session">
        <div class="theme-picker">
          <button class="ghost icon-only" onClick={() => {
            draft.themeMenuOpen = !draft.themeMenuOpen;
            notify();
          }}>
            <ThemeModeIcon />
          </button>
          {draft.themeMenuOpen ? (
            <div class="theme-menu">
              <button class={themeMode === "system" ? "active" : ""} onClick={() => setThemeMode("system")}><Monitor size={14} />跟随系统</button>
              <button class={themeMode === "light" ? "active" : ""} onClick={() => setThemeMode("light")}><Sun size={14} />浅色</button>
              <button class={themeMode === "dark" ? "active" : ""} onClick={() => setThemeMode("dark")}><Moon size={14} />深色</button>
            </div>
          ) : null}
        </div>
        {bootPhase === "ready" ? (
          <>
            {isAdmin() ? <button class="ghost" onClick={() => { location.hash = mode === "admin" ? "" : "admin=1"; }}><Shield size={15} />{mode === "admin" ? "主页" : "管理"}</button> : null}
            <button class="session-user" onClick={() => openProfile(identity?.luoguName ?? "")}>
              <UserAvatar name={identity?.luoguName ?? "?"} className="chat-avatar" />
              {identity?.luoguName ?? "..."}
            </button>
            <button class="ghost icon-only" onClick={logout}><LogOut size={15} /></button>
          </>
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
          <h1>创建 VJudge Duel</h1>
          <p>与你的朋友产生一场亲切的对决！</p>
        </div>
      </div>
      <div class="home-announcement">
        <h3>公告</h3>
        <p>我们创建了一个 QQ 群：1059528564，可以反馈修改建议或进行学术讨论<br/>并且由于此页面采用轻服务器设计<br/>所以许多功能快速访问有bug</p>
        <BanAnnouncement />
      </div>
      <form class="create-form" onSubmit={(event) => void submitCreateRoom(event)}>
        <label>
          <span>题目数量{hasCustomProblems() ? "（按自定义题目）" : ""}</span>
          <input disabled={creatingRoom || hasCustomProblems()} type="number" min={1} max={21} value={draft.roomCount} onInput={(event) => (draft.roomCount = Number(event.currentTarget.value))} />
        </label>
        <div class="difficulty-row wide">
          <DifficultyControl label="最低难度" value={draft.difficultyLow} set={(value) => (draft.difficultyLow = value)} />
          <DifficultyControl label="最高难度" value={draft.difficultyHigh} set={(value) => (draft.difficultyHigh = value)} />
        </div>
        <label class="wide custom-problems-field">
          <span>自定义题目 <small>洛谷：B/P/T/U 开头；AtCoder：AT_abc128_a；Codeforces：CF2061B。使用后自动 UNR</small></span>
          <textarea disabled={creatingRoom} value={draft.customProblems} placeholder="每行一个题目；留空则按题库随机抽取" onInput={(event) => {
            draft.customProblems = event.currentTarget.value;
            const count = parseCustomProblems(draft.customProblems).length;
            if (count) draft.roomCount = count;
            notify();
          }} />
        </label>
        <div class="oj-ratio-panel wide">
          <div class="oj-ratio-title"><strong>题目来源</strong><span>权重为 0 时不选择，默认 2 : 1 : 1</span></div>
          <div class="oj-ratio-list">
            {(["luogu", "codeforces", "atcoder"] as ProblemPlatform[]).map((platform) => (
              <div class={`oj-ratio-row ${draft.ratios[platform] > 0 ? "enabled" : ""}`} key={platform}>
                <button disabled={creatingRoom || hasCustomProblems()} type="button" class="oj-toggle" aria-pressed={draft.ratios[platform] > 0} onClick={() => {
                  draft.ratios[platform] = draft.ratios[platform] > 0 ? 0 : defaultRatios[platform];
                  notify();
                }}>
                  <span class="oj-check">{draft.ratios[platform] > 0 ? "✓" : ""}</span>
                  {platformLabel(platform)}
                </button>
                <span>权重</span>
                <input aria-label={`${platformLabel(platform)} 权重`} disabled={creatingRoom || hasCustomProblems() || draft.ratios[platform] === 0} type="number" min={0} max={20} value={draft.ratios[platform]} onInput={(event) => {
                  draft.ratios[platform] = clamp(Number(event.currentTarget.value), 1, 20);
                  notify();
                }} />
              </div>
            ))}
          </div>
        </div>
        <label class="mode-toggle wide">
          <input disabled={creatingRoom || hasCustomProblems()} type="checkbox" checked={draft.unrated || hasCustomProblems()} onInput={(event) => (draft.unrated = event.currentTarget.checked)} />
          <span>UNR 休闲模式（不参与评分）</span>
        </label>
        <button class={`primary wide ${creatingRoom ? "is-loading" : ""}`} disabled={creatingRoom}>
          {creatingRoom ? <RefreshCw class="spin" size={17} /> : <Play size={17} />}
          {creatingRoom ? "正在加载三个题库…" : "生成房间"}
        </button>
      </form>
      <p class="muted">题库缓存：{cachedProblemCount()} 条 {draft.pickerStatus ? ` / ${draft.pickerStatus}` : ""}</p>
    </section>

    <section class="panel home-room-panel">
      <div class="section-head">
        <Users size={18} />
        <div>
          <h2>公开房间</h2>
          <p>最新 20 场对决，准备中优先。</p>
        </div>
        <button class="ghost icon-only" onClick={() => void loadDirectory()}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div class="home-tabs">
        <button class={draft.roomTab === "duel" ? "active" : ""} onClick={() => {
          draft.roomTab = "duel";
          notify();
        }}>Duel</button>
        <button class={draft.roomTab === "ranking" ? "active" : ""} onClick={() => {
          draft.roomTab = "ranking";
          notify();
        }}>Ranking</button>
      </div>
      {draft.roomTab === "duel" ? <RoomList /> : <Ranking />}
    </section>

    <section class="panel home-chat-panel">
      <Chat />
    </section>
  </main>
);

const Room = () => (
  <main class="room-grid">
    <section class="arena-head">
      <div class="match-meta">
        <p class="eyebrow">{state.phase === "arena" ? "LIVE MATCH" : state.phase === "finished" ? "MATCH ARCHIVE" : "READY ROOM"}</p>
        <ArchiveStatus />
        <h1><MatchTitle /></h1>
        <p>{state.problems.length} 题 / 胜利线 {winThreshold(state)} / {state.rated ? "Rated" : "UNR"} / 你是 {teamName(currentSeat())}</p>
      </div>
      <div class="timer-block">
        <strong>{formatMatchClock()}</strong>
        <ScoreBar />
      </div>
    </section>

    <section class="panel roster-panel">
      <button class="roster-toggle" onClick={() => {
        draft.teamsOpen = !draft.teamsOpen;
        notify();
      }}>
        {draft.teamsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <strong>TEAMS</strong>
        <span>{teamSummary()}</span>
      </button>
      {draft.teamsOpen ? <Roster /> : null}
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

const ArchiveStatus = () => {
  if (state.phase !== "finished") return null;
  if (state.closed) {
    return <p class="archive-status closed"><strong>已关闭</strong><span>关闭原因：{state.closed.reason}</span></p>;
  }
  if (state.winner === "draw") return <p class="archive-status draw"><strong>比赛结束：平局</strong></p>;
  const winner = state.winner === "red" ? "红方" : "蓝方";
  return <p class={`archive-status ${state.winner ?? "draw"}`}><strong>{winner} 胜利</strong><span>比赛已封档，只读观赛</span></p>;
};

const MatchTitle = () => {
  const red = Object.values(state.players).filter((p) => p.team === "red");
  const blue = Object.values(state.players).filter((p) => p.team === "blue");
  const names = (players: Player[], fallback: string) =>
    players.length ? players.map((player, index) => (
      <span key={player.id}>
        {index > 0 ? " / " : ""}
        <button class="title-name" style={{ color: nameColor(player.luoguName) }} onClick={() => openProfile(player.luoguName)}>{player.luoguName}</button>
      </span>
    )) : fallback;
  return (
    <>
      <span class="red-title">{names(red, "红方")}</span>
      <span> vs </span>
      <span class="blue-title">{names(blue, "蓝方")}</span>
    </>
  );
};

const RoomControls = () => {
  const player = state.players[identity.id];
  const canClose = canCloseRoom(state, identity.id, identity.luoguName);
  const canPlayAction = state.phase === "arena" && isTeam(player?.team) && !blockedByBan();
  const canLeaveSpectator = mode === "room" && (player?.team === "spectator" || (!player && preferredSeat() === "spectator"));
  const showLobbyControls = state.phase === "lobby";
  if (state.phase === "finished") {
    return (
      <div class="room-controls">
        <button class="leave-seat" onClick={() => void leaveRoom()}>
          <DoorClosed size={15} />
          返回大厅
        </button>
      </div>
    );
  }
  return (
    <div class="room-controls">
      {showLobbyControls ? (
        <>
          <div class="segmented">
            <button class="leave-seat" disabled={state.hostId === identity.id || blockedByBan()} onClick={() => void leaveRoom()}>
              <DoorClosed size={15} />
              退出
            </button>
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
      {!showLobbyControls && canLeaveSpectator ? (
        <div class="segmented">
          <button class="leave-seat" disabled={blockedByBan()} onClick={() => void leaveRoom()}>
            <DoorClosed size={15} />
            退出观赛
          </button>
        </div>
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
  const total = Math.max(1, state.problems.reduce((sum, problem) => sum + problem.score, 0));
  const redPct = Math.min(100, (red / total) * 100);
  const bluePct = Math.min(100, (blue / total) * 100);
  const thresholdPct = Math.min(100, (winThreshold(state) / total) * 100);
  return (
    <div class="duel-progress" aria-label="score progress">
      <div class="red-fill" style={{ width: `${redPct}%` }}>
        <span>{red}</span>
      </div>
      <div class="blue-fill" style={{ width: `${bluePct}%` }}>
        <span>{blue}</span>
      </div>
      <i class="win-marker" style={{ left: `${thresholdPct}%` }} aria-label={`胜利线 ${winThreshold(state)}`} />
    </div>
  );
};

const RoomList = () => {
  const fresh = sortedRooms().filter((room) => !(room.status === "finished" && !room.winner && playerCount(room) <= 1)).slice(0, 20);
  if (!fresh.length) return <p class="muted">暂无公开房间。</p>;
  return (
    <div class="duel-table">
      <div class="duel-row duel-head">
        <span>ID</span>
        <span>选手</span>
        <span>状态</span>
      </div>
      {fresh.map((room) => (
        <button class="duel-row" key={room.roomId} onClick={() => joinRoom(room)}>
          <code>{shortRoomId(room.roomId)}</code>
          <RoomLineView room={room} />
          <em class={roomStatusClass(room)}>{roomStatusLabel(room)}</em>
        </button>
      ))}
    </div>
  );
};

const sortedRooms = (): RoomListing[] => {
  const rank = { lobby: 0, arena: 1, finished: 2 };
  return [...rooms].sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (b.endedAt ?? b.startedAt ?? b.createdAt) - (a.endedAt ?? a.startedAt ?? a.createdAt)
  );
};

const RoomLineView = ({ room }: { room: RoomListing }) => {
  const red = room.redPlayers?.length ? room.redPlayers : [room.host];
  const blue = room.bluePlayers ?? [];
  if (isClosedListing(room)) {
    return <span class="room-line"><PlayerNameList names={[room.host]} /> <em class="result-closed">已关闭：{room.closedReason || "房间已关闭"}</em></span>;
  }
  if (room.status === "lobby") {
    return <span class="room-line"><PlayerNameList names={[room.host]} /> <em>的未开始房间{room.rated === false ? " / UNR" : ""}</em></span>;
  }
  if (room.status === "finished" && room.winner && room.winner !== "draw") {
    const winner = room.winner === "red" ? red : blue.length ? blue : ["蓝方"];
    const loser = room.winner === "red" ? (blue.length ? blue : ["蓝方"]) : red;
    return <span class="room-line"><PlayerNameList names={winner} /> <em class="result-win">胜</em> <PlayerNameList names={loser} /></span>;
  }
  if (room.status === "finished" && room.winner === "draw") {
    return <span class="room-line"><PlayerNameList names={red} /> <em class="result-draw">平</em> <PlayerNameList names={blue.length ? blue : ["蓝方"]} /></span>;
  }
  return <span class="room-line"><PlayerNameList names={red} /> <em>vs</em> <PlayerNameList names={blue.length ? blue : ["等待蓝方"]} />{room.rated === false ? <em>UNR</em> : null}</span>;
};

const PlayerNameList = ({ names }: { names: string[] }) => (
  <>
    {names.map((name, index) => (
      <span class="room-player" style={{ color: nameColor(name) }} key={`${name}:${index}`}>
        {index > 0 ? " & " : ""}
        {name}
      </span>
    ))}
  </>
);

const roomLine = (room: RoomListing): string => {
  const red = (room.redPlayers?.length ? room.redPlayers : [room.host]).join(" & ");
  const blue = (room.bluePlayers ?? []).join(" & ");
  if (isClosedListing(room)) return `${room.host} 的房间已关闭${room.closedReason ? `：${room.closedReason}` : ""}`;
  if (room.status === "finished" && room.winner && room.winner !== "draw") {
    const winner = room.winner === "red" ? red : blue || "蓝方";
    const loser = room.winner === "red" ? blue || "蓝方" : red;
    return `${winner} 胜 ${loser}`;
  }
  if (room.status === "finished" && room.winner === "draw") return `${red} 平 ${blue || "蓝方"}`;
  if (room.status === "lobby") return `${room.host} 的未开始房间${room.rated === false ? " / UNR" : ""}`;
  return `${red} vs ${blue || "等待蓝方"}`;
};

const roomStatusLabel = (room: RoomListing): string =>
  isClosedListing(room) ? "已关闭" : room.status === "lobby" ? "准备" : room.status === "arena" ? "进行中" : room.winner ? "已结束" : "已关闭";

const roomStatusClass = (room: RoomListing): string =>
  isClosedListing(room) || (room.status === "finished" && !room.winner) ? "closed" : room.status;

const isClosedListing = (room: RoomListing): boolean =>
  Boolean(room.closedReason) || (room.status === "lobby" && Boolean(room.endedAt));

const shortRoomId = (id: string): string => id.replace(/\D/g, "").slice(-5) || id.slice(0, 5);

type RatingRow = {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  games: number;
};

const Ranking = () => {
  const rows = ratingRows();
  if (!rows.length) return <p class="muted">暂无注册用户。</p>;
  return (
    <div class="ranking-list">
      {rows.map((row, index) => (
        <button class="ranking-row" key={row.name} onClick={() => openProfile(row.name)}>
          <span>#{index + 1}</span>
          <UserAvatar name={row.name} className="chat-avatar" />
          <strong style={{ color: nameColor(row.name, row.rating) }}>{row.name}</strong>
          <code>{Math.round(row.rating)}</code>
          <em>{row.wins}-{row.losses}</em>
        </button>
      ))}
    </div>
  );
};

const ratingRows = (): RatingRow[] => {
  const map = new Map<string, RatingRow>();
  const ensure = (name: string): RatingRow => {
    const key = normalizeName(name);
    const existing = map.get(key);
    if (existing) return existing;
    const stored = userRecordFor(name);
    const row = {
      name: stored?.name ?? name,
      rating: stored?.rating ?? 1300,
      wins: stored?.wins ?? 0,
      losses: stored?.losses ?? 0,
      games: stored?.games ?? 0
    };
    map.set(key, row);
    return row;
  };
  for (const user of users) ensure(user.name);
  if (identity?.luoguName) ensure(identity.luoguName);
  for (const room of sortedRooms()) {
    for (const name of [room.host, ...(room.redPlayers ?? []), ...(room.bluePlayers ?? [])]) ensure(name);
  }
  return [...map.values()].sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name));
};

const AdminPage = () => {
  if (!isAdmin()) return <main class="center-screen"><Shield size={42} /><h1>无管理员权限</h1></main>;
  const rows = ratingRows();
  return (
    <main class="admin-page">
      <header class="admin-page-head">
        <div><Shield size={22} /><span><h1>管理中心</h1><p>当前管理员：{identity.luoguName}</p></span></div>
        <div class="admin-stats"><strong>{rows.length}</strong><span>玩家</span><strong>{rooms.length}</strong><span>房间</span></div>
        <button class="ghost" onClick={() => void Promise.all([loadDirectory(), loadUsers()])}><RefreshCw size={15} />刷新</button>
      </header>

      <section class="panel admin-section">
        <div class="admin-section-head">
          <div><h2>玩家管理</h2><p>封禁原因会应用到下方执行的封禁操作。</p></div>
          <input value={draft.adminReason} placeholder="封禁原因（可选）" onInput={(event) => (draft.adminReason = event.currentTarget.value)} />
        </div>
        <div class="admin-player-list">
          {rows.map((row) => {
            const key = normalizeName(row.name);
            const banned = Boolean(globalModeration.banned[key]);
            const muted = Boolean(globalModeration.muted[`name:${key}`]);
            const protectedAccount = isAdminName(row.name);
            const busy = adminBusy.has(`user:${key}`);
            return (
              <article class="admin-player" key={key}>
                <UserAvatar name={row.name} className="avatar" />
                <div class="admin-player-name"><button onClick={() => openProfile(row.name)} style={{ color: nameColor(row.name, row.rating) }}>{row.name}</button><span>{protectedAccount ? "ADMIN" : banned ? "BANNED" : muted ? "MUTED" : "ACTIVE"}</span></div>
                <label class="admin-rating"><span>Rating</span><input disabled={busy} type="number" min={0} max={10000} value={draft.adminRatings[key] ?? String(Math.round(row.rating))} onInput={(event) => { draft.adminRatings[key] = event.currentTarget.value; }} /></label>
                <button disabled={busy} onClick={() => void saveAdminRating(row.name)}>{busy ? <RefreshCw class="spin" size={14} /> : <Check size={14} />}保存</button>
                <div class="admin-player-actions">
                  <button class={banned ? "ghost" : "danger"} disabled={busy || protectedAccount} onClick={() => void runAdminUserAction(row.name, banned ? "unban" : "ban")}>{banned ? <X size={14} /> : <Ban size={14} />}{banned ? "解封" : "封禁"}</button>
                  <button class="ghost" disabled={busy || protectedAccount} onClick={() => void runAdminUserAction(row.name, muted ? "unmute" : "mute")}>{muted ? <Volume2 size={14} /> : <VolumeX size={14} />}{muted ? "解禁" : "禁言"}</button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section class="panel admin-section">
        <div class="admin-section-head"><div><h2>房间管理</h2><p>显示目录中的全部房间，可强制关闭未结束房间。</p></div></div>
        <div class="admin-room-list">
          {rooms.length ? rooms.map((room) => {
            const busy = adminBusy.has(`room:${room.roomId}`);
            const closed = isClosedListing(room) || room.status === "finished";
            return (
              <article class="admin-room" key={room.roomId}>
                <code>{room.roomId}</code>
                <span><strong>{room.host}</strong><small>{roomStatusLabel(room)} · {playerCount(room)} 人 · {room.problemCount} 题</small></span>
                <button class="danger" disabled={busy || closed} onClick={() => void runForceCloseRoom(room)}>{busy ? <RefreshCw class="spin" size={14} /> : <Trash2 size={14} />}{closed ? "已关闭" : "强制关闭"}</button>
              </article>
            );
          }) : <p class="muted">暂无房间。</p>}
        </div>
      </section>
    </main>
  );
};

const runAdminUserAction = async (name: string, action: "ban" | "unban" | "mute" | "unmute") => {
  const key = `user:${normalizeName(name)}`;
  if (adminBusy.has(key)) return;
  adminBusy.add(key);
  draft.adminTarget = name;
  notify();
  try {
    await moderateGlobal(action);
  } finally {
    adminBusy.delete(key);
    notify();
  }
};

const saveAdminRating = async (name: string) => {
  const nameKey = normalizeName(name);
  const key = `user:${nameKey}`;
  if (adminBusy.has(key)) return;
  const rating = Number(draft.adminRatings[nameKey] ?? ratingRowFor(name).rating);
  if (!Number.isFinite(rating) || rating < 0 || rating > 10_000) {
    setStatus("Rating 必须在 0 到 10000 之间", "error");
    return;
  }
  adminBusy.add(key);
  notify();
  try {
    const user = await updateUserRating(name, Math.round(rating), identity.luoguName);
    updateLocalUser(user.name, user, false);
    draft.adminRatings[nameKey] = String(user.rating);
    setStatus(`已将 ${user.name} 的 Rating 修改为 ${user.rating}`);
  } catch (error) {
    setStatus(friendlyError(error, "Rating 修改失败"), "error");
  } finally {
    adminBusy.delete(key);
    notify();
  }
};

const runForceCloseRoom = async (room: RoomListing) => {
  const key = `room:${room.roomId}`;
  if (adminBusy.has(key)) return;
  adminBusy.add(key);
  notify();
  try {
    await forceCloseRoom(room);
  } finally {
    adminBusy.delete(key);
    notify();
  }
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
  writeDirectoryCache(rooms);
  localStorage.removeItem(eventCacheKey(room.roomId));
  setStatus(`已删除房间 ${room.roomId}`);
};

const playerCount = (room: RoomListing): number => {
  const names = [room.host, ...(room.redPlayers ?? []), ...(room.bluePlayers ?? [])];
  return new Set(names.filter(Boolean).map((name) => normalizeName(name))).size;
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
  const row = ratingRowFor(player.luoguName);
  const canKick = state.phase === "lobby" && state.hostId !== player.id && (state.hostId === identity.id || isAdmin());
  return (
    <div class={`player-row ${banned ? "banned" : ""}`}>
      <UserAvatar name={player.luoguName} className="avatar" />
      <div class="player-main">
        <button class="name-button" style={{ color: nameColor(player.luoguName) }} onClick={() => openProfile(player.luoguName)}>{player.luoguName}</button>
        <small>{Math.round(row.rating)}</small>
      </div>
      <div class="player-tags">
        {state.hostId === player.id ? <em><Crown size={12} />HOST</em> : null}
        {isAdminName(player.luoguName) ? <em><Shield size={12} />ADMIN</em> : null}
        {muted ? <em><Ban size={12} />MUTED</em> : null}
        {banned ? <em><Ban size={12} />BANNED</em> : <em>{player.ready ? "READY" : teamName(player.team).toUpperCase()}</em>}
        {canKick ? <button class="kick-player" title="移出准备房" onClick={() => void kickLobbyPlayer(player)}><UserMinus size={13} /></button> : null}
      </div>
    </div>
  );
};

const Problems = () => (
  <div class="problem-grid">
    {state.problems.map((problem, index) => (
      <article class={`problem-card ${problem.solvedBy?.team ?? ""}`} key={`${problem.platform ?? "luogu"}:${problem.pid}`}>
        <div>
          {state.phase === "lobby" ? (
            <span class="problem-mask">P{String(index + 1).padStart(4, "0")}</span>
          ) : (
            <a href={vjudgeProblemUrl(problem)} target="_blank" rel="noreferrer" title={problem.title}>
              <small>{platformLabel(problem.platform ?? "luogu")}</small>{problem.pid}
            </a>
          )}
          <span>{problem.score} pts</span>
        </div>
        {problem.difficulty ? <DifficultyBadge level={problem.difficulty} /> : <em>random</em>}
        <strong>{problem.solvedBy?.luoguName ?? (state.phase === "lobby" ? "hidden" : "unclaimed")}</strong>
        {state.phase === "arena" && isTeam(currentSeat()) && !blockedByBan() ? (
          <div class="problem-actions">
            <button disabled={judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`)} onClick={() => void judgeProblem(problem)}>
              {judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`) ? <RefreshCw class="spin" size={13} /> : null}
              {judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`) ? "同步中" : "判题"}
            </button>
            <button onClick={() => void replaceProblem(problem.pid)}>换题</button>
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
  const readOnly = mode === "room" && state.phase === "finished";
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
          disabled={blockedByBan() || muted || readOnly}
          placeholder={readOnly ? "比赛已封档，只读" : muted ? "你已被禁言" : mode === "room" ? "消息，/开头发队内" : "大厅自由聊天"}
          onInput={(event) => (draft.chat = event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button disabled={blockedByBan() || muted || readOnly}>
          <Send size={15} />
          {readOnly ? "只读" : muted ? "禁言" : "发送"}
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
  const chats = visibleChats(state, identity.id).slice(-20).map((chat) => ({ type: "chat" as const, id: chat.id, at: chat.at, chat }));
  const judges = mode === "room" ? state.feed.slice(0, 20).map((record) => ({
    type: "judge" as const,
    id: `judge:${record.recordId}:${record.pid}`,
    at: record.at,
    record
  })) : [];
  const systems = mode === "room" ? state.system.slice(-20).map((message) => ({
    type: "system" as const,
    id: `system:${message.id}`,
    at: message.at,
    text: message.text
  })) : [];
  return [...chats, ...judges, ...systems].sort((a, b) => a.at - b.at).slice(-20);
};

const ChatLine = ({ item }: { item: ChatStreamItem }) => {
  if (item.type === "system") {
    return (
      <p class="chat-line system">
        <span class="chat-avatar">#</span>
        <span>SYS</span>
        <span class="chat-text">{item.text}</span>
      </p>
    );
  }
  if (item.type === "judge") {
    const record = item.record;
    return (
      <p class={record.status === "OK" ? "chat-line judge ok" : "chat-line judge fail"}>
        <span class="chat-avatar">{record.status === "OK" ? "✓" : "!"}</span>
        <span>{formatClock(record.at)} / {record.pid}</span>
        <span class="chat-text">{record.luoguName} {record.status}</span>
      </p>
    );
  }
  const chat = item.chat;
  const mine = chat.actorId === identity.id || isOwnName(chat.luoguName);
  return (
    <p class={`chat-line bubble ${mine ? "mine" : "theirs"} ${chat.visibility === "team" ? "private" : ""}`}>
      <UserAvatar name={chat.luoguName} className="chat-avatar" />
      <button class="chat-name" style={{ color: nameColor(chat.luoguName) }} onClick={() => openProfile(chat.luoguName)}>{chat.visibility === "team" ? "TEAM" : "ALL"} / {chat.luoguName}</button>
      <span class="chat-text">{chat.text}</span>
    </p>
  );
};

const UserAvatar = ({ name, className }: { name: string; className: string }) => {
  const url = avatarUrlFor(name);
  return url ? <img class={className} src={url} alt="" loading="lazy" /> : <span class={className}>{avatarText(name)}</span>;
};

const ToastStack = () => {
  if (!toasts.length) return null;
  return (
    <div class="toast-stack">
      {toasts.map((toast) => (
        <div class={`toast ${toast.tone}`} key={toast.id}>
          {systemLogoUrl ? <img src={systemLogoUrl} alt="" /> : null}
          <strong>{toast.title}</strong>
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  );
};

const ProfilePage = () => {
  const name = profileUserName || identity.luoguName;
  const user = userRecordFor(name);
  const row = ratingRowFor(name);
  const mine = normalizeName(name) === normalizeName(identity.luoguName);
  const source = user?.profileHtml || "";
  return (
    <main class="profile-page">
      <div class="profile-card">
        <div class="profile-head">
          <div>
            <UserAvatar name={name} className="profile-avatar" />
            <h1 style={{ color: nameColor(name) }}>{name}</h1>
          </div>
          <div class="profile-html">
            {draft.profileEditing && mine ? (
              <textarea
                class="profile-editor"
                value={source}
                placeholder="用纯文本内嵌 HTML 自定义主页"
                onInput={(event) => updateLocalUser(name, { profileHtml: event.currentTarget.value }, false)}
              />
            ) : (
              <pre class="profile-source" dangerouslySetInnerHTML={{ __html: sanitizeProfileHtml(source || "这个用户还没有写主页。") }} />
            )}
          </div>
        </div>
        {mine ? (
          <div class="profile-actions">
            {draft.profileEditing ? (
              <>
                <button class="primary" onClick={() => void persistUserProfile(name, userRecordFor(name)?.profileHtml ?? "")}>完成</button>
                <button class="ghost" onClick={() => {
                  draft.profileEditing = false;
                  notify();
                }}>取消</button>
              </>
            ) : (
              <button class="primary" onClick={() => {
                draft.profileEditing = true;
                notify();
              }}>编辑</button>
            )}
          </div>
        ) : null}
        <div class="profile-stats">
          <strong>Rating {Math.round(row.rating)}</strong>
          <span>{row.games} 场 / {row.wins} 胜 / {row.losses} 负</span>
        </div>
        <div class="profile-section">
          <h2>最近 20 场</h2>
          {completedPlayerRooms(name).slice(0, 20).map((room) => <p key={room.roomId}><code>{shortRoomId(room.roomId)}</code><span>{roomLine(room)}</span><em>{roomStatusLabel(room)}</em></p>)}
        </div>
        <div class="achievement-grid">
          {achievementsFor(name, row).map((achievement) => (
            <article class={`achievement ${achievement.progress >= 100 ? "complete" : ""}`} key={achievement.title}>
              <achievement.Icon size={26} />
              <div><h3>{achievement.title}</h3><p>{achievement.text}</p><span>进度 {achievement.progress}%</span></div>
            </article>
          ))}
        </div>
      </div>
    </main>
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
          <span>{vote.kind === "surrender" ? `${teamName(vote.team)}投降` : `${voteLabel(vote.kind)} ${vote.targetPid ?? ""}`}</span>
          <strong>{vote.kind === "surrender"
            ? `${requiredVoters(state, vote).filter((id) => vote.approvals[id]).length}/${requiredVoters(state, vote).length}`
            : `${Object.keys(vote.approvals).length}/${participantCount()}`}</strong>
          {vote.kind === "surrender" ? (
            currentSeat() === vote.team && !vote.approvals[identity.id] ? <button class="danger" onClick={() => void emit({ ...baseEvent("vote.cast"), voteId: vote.id, approve: true })}>确认投降</button> : null
          ) : canVote ? (
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
        <a class="ban-contact" href="https://www.luogu.com.cn/chat?uid=752953" target="_blank" rel="noreferrer">联系 sLMxf 申请解封</a>
        <small>操作人：{record.by}</small>
      </div>
    </div>
  );
};

const AuthError = () => (
  <Shell title="VJudge Duel" subtitle="login">
    <main class="center-screen">
      <Bot size={42} />
      <h1>请登录</h1>
      <p>{authErrorText}</p>
      <form class="paste-login" onSubmit={(event) => void submitVJudgeLogin(event)}>
        <strong>VJudge 登录</strong>
        <ol class="login-guide">
          <li>输入你的 VJudge 用户名。</li>
          <li>登录 VJudge 后，点击右上角自己的用户名，选择“更新资料”。</li>
          <li>在“学校”字段原有内容后加入下面的六位数字并保存。</li>
          <li>回到这里点击“验证登录”。</li>
        </ol>
        <input disabled={loginSubmitting} value={vjudgeUsername} placeholder="VJudge 用户名" onInput={(event) => (vjudgeUsername = event.currentTarget.value)} />
        <code>{vjudgeChallenge}</code>
        <a href={vjudgeUsername.trim() ? `https://vjudge.net/user/${encodeURIComponent(vjudgeUsername.trim())}` : "https://vjudge.net/user"} target="_blank" rel="noreferrer">打开 VJudge 个人主页</a>
        <button class={loginSubmitting ? "is-loading" : ""} disabled={loginSubmitting} type="submit">
          {loginSubmitting ? <RefreshCw class="spin" size={16} /> : null}{loginSubmitting ? "正在读取 VJudge 资料…" : "验证登录"}
        </button>
      </form>
    </main>
  </Shell>
);

const BanAnnouncement = () => {
  const entries = Object.entries(globalModeration.banned);
  if (!entries.length) return null;
  return (
    <div class="ban-announcement">
      <strong>封禁公告</strong>
      {entries.map(([name, record]) => <p key={name}><b>{name}</b><span>{record.reason}</span></p>)}
    </div>
  );
};

const submitVJudgeLogin = async (event: Event) => {
  event.preventDefault();
  if (loginSubmitting) return;
  loginSubmitting = true;
  notify();
  try {
    vjudgeSession = await verifyVJudgeLogin(vjudgeUsername, vjudgeChallenge);
    identity = await renameIdentity(identity, vjudgeSession.username);
    authErrorText = "";
    bootPhase = "ready";
    await registerCurrentUser();
    await refreshGlobalModeration();
    await enterFromHash();
  } catch (error) {
    authErrorText = error instanceof Error ? error.message : "VJudge 登录失败";
    vjudgeChallenge = createVJudgeChallenge();
  } finally {
    loginSubmitting = false;
  }
  notify();
};

const Loading = () => (
  <main class="center-screen">
    <Bot size={42} />
    <h1>Connecting</h1>
    <p>正在装载身份与房间网络。</p>
  </main>
);

const BootScreen = ({ leaving }: { leaving: boolean }) => (
  <main class={`boot-screen${leaving ? " leaving" : ""}`}>
    <div class="boot-loading">Loading</div>
  </main>
);

const ProfileLoading = () => (
  <main class="profile-page">
    <div class="profile-loading-overlay" aria-label="loading user profile" />
  </main>
);

const DifficultyControl = ({ label, value, set }: { label: string; value: DifficultyLevel; set: (value: DifficultyLevel) => void }) => (
  <label class="difficulty-control">
    <span>{label}</span>
    <DifficultyBadge level={value} />
    <select disabled={creatingRoom || hasCustomProblems()} value={value} onChange={(event) => set(Number(event.currentTarget.value) as DifficultyLevel)}>
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
  location.hash = `room=${room.roomId}&secret=${room.secret}`;
};

const hasCustomProblems = (): boolean => draft.customProblems.trim().length > 0;

const vjudgeProblemUrl = (problem: Problem): string => {
  const source = problem.platform === "codeforces" ? "Codeforces" : problem.platform === "atcoder" ? "AtCoder" : "洛谷";
  return `https://vjudge.net/problem/${encodeURIComponent(source)}-${encodeURIComponent(problem.pid)}`;
};

const logout = () => {
  logoutVJudgeSession();
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
const isOwnName = (name: string): boolean => normalizeName(name) === normalizeName(identity?.luoguName ?? "");
const avatarUrlFor = (name: string): string => {
  const key = normalizeName(name);
  if (!key) return "";
  return avatarCache[key] || userRecordFor(name)?.avatar || "";
};
function readAvatarCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(avatarCacheKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string | { url?: string }>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (typeof value === "string" && value && value !== bannedAvatarUrl) return [[key, value]];
      if (typeof value === "object" && typeof value?.url === "string" && value.url && value.url !== bannedAvatarUrl) return [[key, value.url]];
      return [];
    }));
  } catch {
    return {};
  }
}
const writeAvatarCache = () => {
  try {
    const entries = Object.entries(avatarCache)
      .filter(([, url]) => Boolean(url))
      .slice(-1000);
    localStorage.setItem(avatarCacheKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Avatar search is cosmetic; ignore quota/private-mode failures.
  }
};
function readUserCache(): Record<string, { user: UserRecord; cachedAt: number }> {
  try {
    const raw = localStorage.getItem(userCacheKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { user?: UserRecord; cachedAt?: number }>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) =>
      value.user && typeof value.cachedAt === "number" && value.user.avatar !== bannedAvatarUrl
        ? [[key, value as { user: UserRecord; cachedAt: number }]]
        : []
    ));
  } catch {
    return {};
  }
}
const writeUserCache = () => {
  try {
    localStorage.setItem(userCacheKey, JSON.stringify(userCache));
  } catch {
    // User cache is an optimization only.
  }
};
const writeCachedUser = (user: UserRecord) => {
  if (user.avatar === bannedAvatarUrl) {
    delete userCache[normalizeName(user.name)];
    writeUserCache();
    return;
  }
  userCache[normalizeName(user.name)] = { user, cachedAt: Date.now() };
  writeUserCache();
};
const registrationFresh = (nameKey: string): boolean => {
  try {
    const raw = localStorage.getItem(registrationCacheKey);
    const entries = raw ? JSON.parse(raw) as Record<string, number> : {};
    return Date.now() - (entries[nameKey] ?? 0) < userCacheTtl;
  } catch {
    return false;
  }
};
const rememberRegistered = (nameKey: string) => {
  try {
    const raw = localStorage.getItem(registrationCacheKey);
    const entries = raw ? JSON.parse(raw) as Record<string, number> : {};
    entries[nameKey] = Date.now();
    localStorage.setItem(registrationCacheKey, JSON.stringify(entries));
  } catch {
    // Registration cache only reduces duplicate writes.
  }
};
const userRecordFor = (name: string): UserRecord | null => {
  const key = normalizeName(name);
  const cached = userCache[key];
  return users.find((user) => normalizeName(user.name) === key) ?? (cached && Date.now() - cached.cachedAt < userCacheTtl ? cached.user : null);
};
const ensureUserLoaded = async (name: string): Promise<UserRecord | null> => {
  const key = normalizeName(name);
  const cached = userCache[key];
  if (cached && Date.now() - cached.cachedAt < userCacheTtl) return cached.user;
  try {
    const user = await fetchUserRecord(name);
    if (user) {
      updateLocalUser(user.name, user, false);
      writeCachedUser(user);
    }
    return user;
  } catch {
    return cached?.user ?? null;
  }
};
const updateLocalUser = (name: string, patch: Partial<UserRecord>, renderNow = true) => {
  const key = normalizeName(name);
  const existing = userRecordFor(name);
  const next: UserRecord = {
    name: existing?.name ?? name,
    rating: existing?.rating ?? 1300,
    wins: existing?.wins ?? 0,
    losses: existing?.losses ?? 0,
    games: existing?.games ?? 0,
    updatedAt: Date.now(),
    ...patch
  };
  users = users.filter((user) => normalizeName(user.name) !== key).concat(next);
  writeCachedUser(next);
  if (renderNow) notify();
};
const registerCurrentUser = async () => {
  if (!identity?.luoguName) return;
  const key = normalizeName(identity.luoguName);
  const cached = userCache[key];
  if (cached && Date.now() - cached.cachedAt < userCacheTtl && registrationFresh(key)) {
    updateLocalUser(cached.user.name, cached.user, false);
    return;
  }
  try {
    const user = await saveUserRecord({ name: identity.luoguName });
    updateLocalUser(user.name, user, false);
    rememberRegistered(key);
  } catch {
    updateLocalUser(identity.luoguName, {}, false);
  }
};
const persistUserProfile = async (name: string, profileHtml: string) => {
  updateLocalUser(name, { profileHtml });
  try {
    const user = await saveUserRecord({ name, profileHtml });
    draft.profileEditing = false;
    updateLocalUser(user.name, user);
  } catch (error) {
    setStatus(friendlyError(error, "主页保存失败"), "error");
  }
};
const openProfile = (name: string) => {
  if (!name.trim()) return;
  window.open(`/user/${encodeURIComponent(name.trim())}`, "_blank", "noopener,noreferrer");
};
const ratingRowFor = (name: string): RatingRow => {
  const key = normalizeName(name);
  const user = userRecordFor(name);
  return ratingRows().find((item) => normalizeName(item.name) === key) ?? {
    name: user?.name ?? name,
    rating: user?.rating ?? 1300,
    wins: user?.wins ?? 0,
    losses: user?.losses ?? 0,
    games: user?.games ?? 0
  };
};
const nameColor = (name: string, rating = ratingRowFor(name).rating): string => {
  if (isAdminName(name)) return "rgb(157, 61, 207)";
  if (rating < 1400) return "rgb(52, 152, 219)";
  if (rating < 1600) return "rgb(82, 196, 26)";
  if (rating < 1900) return "rgb(243, 156, 17)";
  return "rgb(254, 76, 97)";
};
const playerRooms = (name: string): RoomListing[] =>
  sortedRooms().filter((room) => [...(room.redPlayers ?? []), ...(room.bluePlayers ?? [])].some((player) => normalizeName(player) === normalizeName(name)));
const completedPlayerRooms = (name: string): RoomListing[] =>
  playerRooms(name).filter((room) => room.status === "finished" && Boolean(room.winner) && !room.closedReason);
const achievementsFor = (name: string, row: RatingRow) => {
  const rows = ratingRows();
  const rank = rows.findIndex((item) => normalizeName(item.name) === normalizeName(name)) + 1;
  const roomsForPlayer = playerRooms(name);
  const firstDone = row.games > 0;
  const fastWin = roomsForPlayer.some((room) => room.startedAt && room.endedAt && room.endedAt - room.startedAt <= 180000);
  const championDone = usersLoaded && row.games > 0 && rank === 1;
  return [
    { Icon: Star, title: "一等星", text: "进入排行榜前 20。", progress: rank > 0 && rank <= 20 ? 100 : 0 },
    { Icon: Swords, title: "决斗家", text: "获得 10 场胜利。", progress: Math.min(100, row.wins * 10) },
    { Icon: Sprout, title: "初出茅庐", text: "完成第一场决斗。", progress: firstDone ? 100 : 0 },
    { Icon: Zap, title: "闪电战", text: "在 3 分钟内结束一场对局。", progress: fastWin ? 100 : 0 },
    { Icon: Trophy, title: "冠军", text: "登上排行榜第一名。", progress: championDone ? 100 : 0 },
    { Icon: Medal, title: "常胜", text: "胜率达到 70%，且至少完成 5 场。", progress: row.games >= 5 ? Math.min(100, Math.round((row.wins / row.games / 0.7) * 100)) : Math.min(80, row.games * 16) }
  ];
};
const sanitizeProfileHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
const scrollChatsToBottom = () => {
  document.querySelectorAll<HTMLElement>(".chat-log").forEach((element) => {
    element.scrollTop = element.scrollHeight;
  });
};
const shouldStickChats = (): boolean =>
  [...document.querySelectorAll<HTMLElement>(".chat-log")].some((element) => element.scrollHeight - element.scrollTop - element.clientHeight < 80);
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
const teamSummary = (): string => {
  const count = (seat: Seat) => Object.values(state.players).filter((player) => player.team === seat).length;
  return `红 ${count("red")} / 蓝 ${count("blue")} / 观赛 ${count("spectator")}`;
};

const rememberActiveRoomIfNeeded = () => {
  const seat = state.players[identity.id]?.team;
  if (mode === "room" && isTeam(seat) && !blockedByBan() && state.phase !== "finished") {
    localStorage.setItem(activeRoomKey, JSON.stringify({ roomId, secret: roomSecret }));
    return;
  }
  if (mode === "room" || state.phase === "finished" || blockedByBan()) localStorage.removeItem(activeRoomKey);
};

const readActiveRoom = (): { roomId: string; secret?: string } | null => {
  const raw = localStorage.getItem(activeRoomKey);
  if (!raw) return null;
  try {
    const active = JSON.parse(raw) as { roomId?: string; secret?: string };
    const listed = rooms.find((room) => room.roomId === active.roomId);
    if (listed?.status === "finished") {
      localStorage.removeItem(activeRoomKey);
      return null;
    }
    return active.roomId ? { roomId: active.roomId, secret: active.secret } : null;
  } catch {
    localStorage.removeItem(activeRoomKey);
    return null;
  }
};

const scheduleFinishReturn = () => {
  if (state.phase !== "finished") return;
  clearFinishTimer();
  localStorage.removeItem(activeRoomKey);
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

const readDirectoryCache = (): RoomListing[] => {
  try {
    const cached = JSON.parse(localStorage.getItem(directoryCacheKey) || "[]") as RoomListing[];
    return Array.isArray(cached) ? cached : [];
  } catch {
    return [];
  }
};

const writeDirectoryCache = (snapshot: RoomListing[]) => {
  try {
    localStorage.setItem(directoryCacheKey, JSON.stringify(snapshot.slice(0, 500)));
  } catch {
    // Directory broadcasts remain authoritative when storage is unavailable.
  }
};

const readEventCache = (id: string): SignedEnvelope[] => {
  try {
    const cached = JSON.parse(localStorage.getItem(eventCacheKey(id)) || "[]") as SignedEnvelope[];
    return Array.isArray(cached) ? cached.filter((item) => item?.event?.roomId === id).slice(-1000) : [];
  } catch {
    return [];
  }
};

const writeEventCache = (id: string, snapshot: SignedEnvelope[]) => {
  try {
    localStorage.setItem(eventCacheKey(id), JSON.stringify(snapshot.slice(-1000)));
  } catch {
    // HTTP/WebSocket state still works if the browser quota is full.
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
  const end = state.phase === "finished" ? state.endedAt ?? state.closed?.at ?? base : Date.now();
  const seconds = (state.phase === "arena" || state.phase === "finished") && state.startedAt ? Math.max(0, Math.floor((end - base) / 1000)) : 0;
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
