import "./style.css";
import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";
import type VditorType from "vditor";
import "vditor/dist/index.css";
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
  KeyRound,
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
  privateChatViolation,
  requiredVoters,
  scoreOf,
  sortProblemsByDifficulty,
  teamName,
  visibleChats,
  winThreshold
} from "./domain";
import { createIdentity, loadIdentity, renameIdentity, signEvent, verifyEnvelope, type LocalIdentity } from "./identity";
import { cachedProblemCount, defaultRatios, difficultyMeta, parseCustomProblems, pickProblems, pickReplacementProblem, platformLabel, type DifficultyLevel, type PlatformRatios, type ProblemPlatform } from "./problemPicker";
import { loadVJudgeSession, logoutVJudgeSession, verifyVJudgeLogin, type VJudgeSession } from "./oauth";
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
let reconnectNoticeTimer: number | undefined;
let directoryReconnectNoticeTimer: number | undefined;
let roomReconnectAttempts = 0;
let directoryReconnectAttempts = 0;
let roomSocketGeneration = 0;
let directorySocketGeneration = 0;
let directoryLiveSnapshotReceived = false;
let lastDirectoryLiveAt = 0;
let lastUsersLiveAt = 0;
let lastProfileFallbackSync = 0;
let finishReturnTimer: number | undefined;
let clockTimer: number | undefined;
let syncTimer: number | undefined;
let heartbeatTimer: number | undefined;
let initialFallbackTimer: number | undefined;
let syncInFlight = false;
let roomLastPongAt = 0;
let directoryLastPongAt = 0;
let lastRoomLiveStateAt = 0;
let statusText = "booting...";
let statusTone: "info" | "error" = "info";
let authErrorText = "";
let announcementTitle = "VJudge Duel 公告";
let announcementContent = "正在读取公告…";
let vjudgeUsername = "";
let creatingRoom = false;
let loginSubmitting = false;
const adminBusy = new Set<string>();
const judgingProblems = new Set<string>();
const replacingProblems = new Set<string>();
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
const userCacheTtl = 24 * 60 * 60 * 1000;
const themeModeKey = "luogu-duel.theme-mode.v1";
const avatarCache: Record<string, string> = readAvatarCache();
const userCache: Record<string, { user: UserRecord; cachedAt: number }> = readUserCache();
const avatarLoading = new Set<string>();
const avatarMissing = new Set<string>();
let profileVditor: VditorType | null = null;
let chatVditor: VditorType | null = null;
let chatVditorTarget: HTMLDivElement | null = null;
let chatVditorGeneration = 0;
let vditorModulePromise: Promise<typeof import("vditor")> | null = null;
const vditorPreviewSources = new WeakMap<HTMLElement, string>();
let themeMode = readThemeMode();
const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");

const draft = {
  userMenuOpen: false,
  themeMenuOpen: false,
  roomTab: "duel" as "duel" | "ranking",
  profileTab: "home" as "home" | "matches" | "achievements",
  profileEditing: false,
  profileDraft: "",
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
  adminSearch: "",
  adminReason: "",
  adminRatings: {} as Record<string, string>,
  teamsOpen: false,
  spectatorsOpen: false
};

type ToastMessage = {
  id: string;
  title: string;
  text: string;
  tone: "info" | "success" | "warning";
};

const dataVersion = "v4";
const roomSeatKey = () => `luogu-duel.${dataVersion}.seat.${roomId}`;
const activeRoomKey = `luogu-duel.active-room.${dataVersion}`;
const historyKey = `luogu-duel.history.${dataVersion}`;
const directoryCacheKey = "vjudge-duel.directory-cache.v2";
const eventCacheKey = (id: string) => `vjudge-duel.events.${dataVersion}.${id}`;
const announcementCacheKey = "vjudge-duel.announcement.v1";
const judgeCooldownKey = () => `vjudge-duel.judge-cooldown.v1.${normalizeName(identity?.luoguName ?? "anonymous")}`;
const temporaryBanKey = "vjudge-duel.security.ban-until.v1";
const temporaryBanReasonKey = "vjudge-duel.security.ban-reason.v1";
const temporaryMuteKey = "vjudge-duel.security.mute-until.v1";
let temporaryBanUntil = readStoredNumber(temporaryBanKey);
let temporaryBanReason = readStoredText(temporaryBanReasonKey) || "操作过于频繁";
let temporaryMuteUntil = readStoredNumber(temporaryMuteKey);

recordBurst("refresh", 4_000, 3, () => applyTemporaryBan(20_000, "4 秒内刷新次数过多"));

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
  void loadAnnouncement();
  themeQuery.addEventListener("change", () => {
    if (themeMode === "system") applyTheme();
    notify();
  });
  clockTimer ??= window.setInterval(() => {
    if ((mode === "room" && state.phase === "arena") || temporaryBanUntil > Date.now() || temporaryMuteUntil > Date.now()) notify();
  }, 1_000);
  syncTimer ??= window.setInterval(() => void periodicSync(), 60_000);
  heartbeatTimer ??= window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (socket?.readyState === WebSocket.OPEN) {
      if (roomLastPongAt && now - roomLastPongAt > 120_000) socket.close();
      else socket.send("ping");
    }
    if (directorySocket?.readyState === WebSocket.OPEN) {
      if (directoryLastPongAt && now - directoryLastPongAt > 120_000) directorySocket.close();
      else directorySocket.send("ping");
    }
  }, 45_000);
  window.addEventListener("hashchange", () => void enterFromHash());
  window.addEventListener("online", () => {
    connectRoom();
    connectDirectory();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (socket?.readyState === WebSocket.OPEN) {
      roomLastPongAt = now;
      socket.send("ping");
    }
    if (directorySocket?.readyState === WebSocket.OPEN) {
      directoryLastPongAt = now;
      directorySocket.send("ping");
    }
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
  if (initialFallbackTimer) window.clearTimeout(initialFallbackTimer);
  initialFallbackTimer = undefined;
  lastRoomLiveStateAt = 0;
  clearFinishTimer();
  draft.chat = "";
  chatVditor?.setValue("", true);
  draft.spectatorsOpen = false;
  draft.closeReason = isAdmin() ? "管理员强制关闭房间" : "房主关闭房间";

  if (mode === "home" || mode === "admin") {
    directoryLiveSnapshotReceived = false;
    envelopes = [];
    state = createInitialState("global");
    globalModeration = state;
    rooms = [];
    users = [];
    connectDirectory();
    connectRoom();
    statusTone = "info";
    statusText = "正在连接大厅";
    notify();
    initialFallbackTimer = window.setTimeout(() => {
      if (mode !== "home" && mode !== "admin") return;
      void (async () => {
        if (!directoryLiveSnapshotReceived) await Promise.all([loadDirectory(), loadUsers()]);
        else if (!lastRoomLiveStateAt) await refreshGlobalModeration();
        notify();
      })();
    }, 2_000);
    return;
  }

  state = createInitialState(roomId);
  closeDirectory();
  const cachedEvents = readEventCache(roomId);
  envelopes = [];
  notify();
  connectRoom();
  const expectedRoomId = roomId;
  initialFallbackTimer = window.setTimeout(() => {
    if (mode !== "room" || roomId !== expectedRoomId || lastRoomLiveStateAt) return;
    void (async () => {
      const loaded = await loadSnapshot();
      if (!loaded && !envelopes.length) await mergeEnvelopes(cachedEvents);
      await ensureJoined();
      notify();
    })();
  }, 2_000);
  rememberActiveRoomIfNeeded();
  notify();
};

const loadDirectory = async () => {
  try {
    await refreshGlobalModeration();
    if (mode === "home") state = globalModeration;
    const remoteRooms = await fetchRooms();
    if (!directoryLiveSnapshotReceived || Date.now() - lastDirectoryLiveAt >= 20_000) {
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
    const remoteUsers = await fetchUsers();
    if (!lastUsersLiveAt || Date.now() - lastUsersLiveAt >= 60_000) users = remoteUsers;
    for (const user of remoteUsers) userCache[normalizeName(user.name)] = { user, cachedAt: Date.now() };
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
  setVditorTheme(profileVditor);
  setVditorTheme(chatVditor);
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

const loadSnapshot = async (): Promise<boolean> => {
  try {
    await refreshGlobalModeration();
    const requestedAt = Date.now();
    const remote = await fetchSnapshot(roomId, roomSecret);
    if (lastRoomLiveStateAt > requestedAt) return true;
    await applyAuthoritativeSnapshot(remote);
    statusTone = "info";
    statusText = "快照已同步";
    return true;
  } catch (error) {
    statusTone = "error";
    statusText = friendlyError(error, "房间快照同步失败");
    return false;
  }
};

const periodicSync = async () => {
  if (bootPhase !== "ready" || syncInFlight) return;
  syncInFlight = true;
  try {
    if (mode === "home" || mode === "admin") {
      const directoryOpen = directorySocket?.readyState === WebSocket.OPEN;
      const roomOpen = socket?.readyState === WebSocket.OPEN;
      connectDirectory();
      connectRoom();
      if (!directoryOpen) await Promise.all([loadDirectory(), loadUsers()]);
      else if (!roomOpen) await refreshGlobalModeration();
    } else if (mode === "room") {
      const roomOpen = socket?.readyState === WebSocket.OPEN;
      if (!roomOpen) {
        connectRoom();
        await loadSnapshot();
      }
    } else if (Date.now() - lastProfileFallbackSync >= 5 * 60_000) {
      lastProfileFallbackSync = Date.now();
      await Promise.all([loadDirectory(), loadUsers()]);
    }
  } finally {
    syncInFlight = false;
    notify();
  }
};

const shouldConnectRoomSocket = (): boolean => mode === "room" || ((mode === "home" || mode === "admin") && roomId === "global");

const connectRoom = () => {
  if (!shouldConnectRoomSocket()) return;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  if (!allowServerRequest()) return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  closeSocket(false);
  const generation = ++roomSocketGeneration;
  const nextSocket = new WebSocket(roomWebSocketUrl(roomId, roomSecret));
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    if (generation !== roomSocketGeneration) return;
    roomReconnectAttempts = 0;
    roomLastPongAt = Date.now();
    if (reconnectNoticeTimer) window.clearTimeout(reconnectNoticeTimer);
    reconnectNoticeTimer = undefined;
    statusTone = "info";
    statusText = roomId === "global" ? "大厅在线" : "房间实时在线";
    notify();
  });
  nextSocket.addEventListener("message", (event) => {
    if (generation !== roomSocketGeneration) return;
    roomLastPongAt = Date.now();
    if (event.data === "pong") return;
    void handleServerMessage(event.data);
  });
  nextSocket.addEventListener("close", () => {
    if (generation !== roomSocketGeneration) return;
    if (socket === nextSocket) socket = null;
    if (shouldConnectRoomSocket()) {
      const delay = Math.min(30_000, 500 * 2 ** Math.min(roomReconnectAttempts, 6));
      roomReconnectAttempts += 1;
      reconnectTimer = window.setTimeout(connectRoom, delay);
      if (!reconnectNoticeTimer) {
        reconnectNoticeTimer = window.setTimeout(() => {
          reconnectNoticeTimer = undefined;
          if (generation !== roomSocketGeneration || socket?.readyState === WebSocket.OPEN) return;
          statusTone = "info";
          statusText = "连接中断，正在恢复";
          notify();
        }, 4_000);
      }
    }
  });
  nextSocket.addEventListener("error", () => {
    if (generation !== roomSocketGeneration) return;
    // close 事件统一负责重连，避免 error + close 连续刷新状态。
  });
};
const notifyDraft = () => render(<App />, app);

const closeSocket = (clearTimer = true) => {
  roomSocketGeneration += 1;
  if (clearTimer && reconnectTimer) window.clearTimeout(reconnectTimer);
  if (reconnectNoticeTimer) window.clearTimeout(reconnectNoticeTimer);
  reconnectTimer = undefined;
  reconnectNoticeTimer = undefined;
  if (socket) socket.close();
  socket = null;
};

const connectDirectory = () => {
  if (mode !== "home" && mode !== "admin") return;
  if (directorySocket?.readyState === WebSocket.OPEN || directorySocket?.readyState === WebSocket.CONNECTING) return;
  if (!allowServerRequest()) return;
  if (directoryReconnectTimer) window.clearTimeout(directoryReconnectTimer);
  directoryReconnectTimer = undefined;
  closeDirectory(false);
  const generation = ++directorySocketGeneration;
  const nextSocket = new WebSocket(directoryWebSocketUrl());
  directorySocket = nextSocket;
  nextSocket.addEventListener("open", () => {
    if (generation !== directorySocketGeneration) return;
    directoryReconnectAttempts = 0;
    directoryLastPongAt = Date.now();
    if (directoryReconnectNoticeTimer) window.clearTimeout(directoryReconnectNoticeTimer);
    directoryReconnectNoticeTimer = undefined;
    statusTone = "info";
    statusText = "大厅实时连接已建立";
    notify();
  });
  nextSocket.addEventListener("message", (event) => {
    if (generation !== directorySocketGeneration) return;
    directoryLastPongAt = Date.now();
    if (event.data === "pong") return;
    void handleDirectoryMessage(event.data);
  });
  nextSocket.addEventListener("close", () => {
    if (generation !== directorySocketGeneration) return;
    if (directorySocket === nextSocket) directorySocket = null;
    if (mode === "home" || mode === "admin") {
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(directoryReconnectAttempts, 6));
      directoryReconnectAttempts += 1;
      directoryReconnectTimer = window.setTimeout(connectDirectory, delay);
      if (!directoryReconnectNoticeTimer) {
        directoryReconnectNoticeTimer = window.setTimeout(() => {
          directoryReconnectNoticeTimer = undefined;
          if (generation !== directorySocketGeneration || directorySocket?.readyState === WebSocket.OPEN) return;
          statusTone = "info";
          statusText = "大厅连接中断，正在恢复";
          notify();
        }, 5_000);
      }
    }
  });
  nextSocket.addEventListener("error", () => {
    if (generation !== directorySocketGeneration) return;
    // close 事件统一负责重连，避免重复提示。
  });
};

const closeDirectory = (clearTimer = true) => {
  directorySocketGeneration += 1;
  if (clearTimer && directoryReconnectTimer) window.clearTimeout(directoryReconnectTimer);
  if (directoryReconnectNoticeTimer) window.clearTimeout(directoryReconnectNoticeTimer);
  directoryReconnectTimer = undefined;
  directoryReconnectNoticeTimer = undefined;
  if (directorySocket) directorySocket.close();
  directorySocket = null;
};

const handleDirectoryMessage = async (raw: string) => {
  const message = JSON.parse(raw) as ServerMessage;
  if (message.type === "pong") {
    directoryLastPongAt = Date.now();
    return;
  }
  if (message.type === "directory") {
    rooms = message.rooms;
    writeDirectoryCache(rooms);
    directoryLiveSnapshotReceived = true;
    lastDirectoryLiveAt = Date.now();
    statusTone = "info";
    statusText = "大厅在线";
  }
  if (message.type === "users") {
    users = message.users;
    lastUsersLiveAt = Date.now();
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
  if (message.type === "pong") {
    roomLastPongAt = Date.now();
    return;
  }
  if (message.type === "hello" || message.type === "sync") {
    await applyAuthoritativeSnapshot(message.envelopes);
    lastRoomLiveStateAt = Date.now();
    await ensureJoined();
  }
  if (message.type === "event") {
    await receiveEnvelope(message.envelope);
    lastRoomLiveStateAt = Date.now();
  }
  if (message.type === "error") {
    statusTone = "error";
    statusText = message.message;
    if (message.message.includes("另一场未结束比赛")) joinDeniedRooms.add(roomId);
    await replaceRoomSnapshot().catch(() => undefined);
    if (message.message.includes("每天最多创建 1 场")) {
      localStorage.removeItem(eventCacheKey(roomId));
      location.hash = "";
      return;
    }
  }
  notify();
};

const mergeEnvelopes = async (incoming: SignedEnvelope[]) => {
  for (const envelope of incoming) await receiveEnvelope(envelope, false);
};

const applyAuthoritativeSnapshot = async (incoming: SignedEnvelope[]) => {
  const verified: SignedEnvelope[] = [];
  for (const envelope of incoming) {
    if (envelope.event.roomId === roomId && await verifyEnvelope(envelope)) verified.push(envelope);
  }
  const unique = new Map(verified.map((envelope) => [envelope.event.id, envelope]));
  envelopes = [...unique.values()].sort(compareEnvelopes);
  state = applyEvents(roomId, envelopes.map((item) => item.event));
  writeEventCache(roomId, envelopes);
  if (roomId === "global") globalModeration = state;
  saveHistory();
  scheduleFinishReturn();
  maybeAutoStart();
  rememberActiveRoomIfNeeded();
};

const replaceRoomSnapshot = async () => {
  const remote = await fetchSnapshot(roomId, roomSecret, false);
  await applyAuthoritativeSnapshot(remote);
  if (state.closed) localStorage.removeItem(eventCacheKey(roomId));
  else writeEventCache(roomId, envelopes);
  saveHistory();
};

const ensureJoined = async () => {
  if (mode !== "room" || state.phase === "finished" || state.players[identity.id] || bannedRecord() || joinDeniedRooms.has(roomId)) return;
  if (state.phase === "arena") {
    await emit({ ...baseEvent("player.joined"), luoguName: identity.luoguName, team: "spectator" });
    rememberSeat("spectator");
    return;
  }
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
    const message = friendlyError(error, "发送失败，正在恢复服务器状态");
    if (!sentBySocket) setStatus(message, "error");
    if (message.includes("另一场未结束比赛")) joinDeniedRooms.add(roomId);
    await replaceRoomSnapshot().catch(() => undefined);
  }
};

const pushToastsForEvent = (event: DuelEvent, previousPhase: DuelState["phase"], previousSystemCount: number) => {
  if (mode !== "room" && event.roomId !== "global") return;
  if (event.type === "game.started") {
    const elapsed = Date.now() - (state.startedAt ?? event.issuedAt);
    if (elapsed >= 0 && elapsed < 5_000) {
      notifyImportant(`start:${roomId}:${state.startedAt ?? event.issuedAt}:${matchTitle()}`, "比赛开始", matchTitle(), "success");
    }
  }
  if (previousPhase !== "finished" && state.phase === "finished") {
    const text = state.closed?.reason ?? (state.winner === "draw" ? "双方平局" : `${teamName(state.winner)} 获胜`);
    notifyImportant(`end:${roomId}:${state.closed?.at ?? event.issuedAt}:${text}`, "比赛结束", text, "warning");
  }
  if (event.type === "chat.sent" && event.visibility === "team" && state.phase === "arena") {
    const chat = state.chats.find((item) => item.id === event.id);
    if (chat && visibleChats(state, identity.id).some((item) => item.id === chat.id) && !mentionsUser(chat.text, identity.luoguName)) {
      notifyImportant(`${event.id}:team`, `队内消息 / ${chat.luoguName}`, chat.text, "info");
    }
  }
  if (event.type === "chat.sent" && event.actorId !== identity.id) {
    const chat = state.chats.find((item) => item.id === event.id);
    if (chat && visibleChats(state, identity.id).some((item) => item.id === chat.id) && mentionsUser(chat.text, identity.luoguName)) {
      void notifyImportant(`${event.id}:mention`, `${chat.luoguName} @了你`, chat.text, "info");
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
  if (mode === "room" && !state.players[identity.id]) await ensureJoined();
  const player = state.players[identity.id];
  if (mode === "room" && !player) {
    setStatus("尚未加入房间，请稍后重试", "error");
    return;
  }
  await emit({ ...baseEvent("chat.sent"), text, visibility: player?.team === "spectator" ? "all" : visibility });
};

const mentionsUser = (text: string, name: string): boolean => {
  const target = normalizeName(name);
  return [...text.matchAll(/@([A-Za-z0-9_.-]{1,40})/g)].some((match) => normalizeName(match[1]) === target);
};

const insertMention = (name: string) => {
  if (!name.trim() || isOwnName(name)) return;
  const current = (chatVditor?.getValue() ?? draft.chat).trimEnd();
  const next = `${current}${current ? " " : ""}@${name.trim()} `;
  draft.chat = next;
  chatVditor?.setValue(next, true);
  chatVditorTarget?.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
};

const emitDirect = async (event: Extract<DuelEvent, { type: "room.closed" | "player.kicked" | "player.unkicked" | "player.muted" | "player.unmuted" }>) => {
  await emit(event);
};

const refreshGlobalModeration = async () => {
  try {
    const requestedAt = Date.now();
    const remote = await fetchSnapshot("global", "public-lobby");
    if (mode === "home" && roomId === "global") {
      if (lastRoomLiveStateAt > requestedAt) return;
      await mergeHomeGlobalSnapshot(remote);
      return;
    }
    globalModeration = applyEvents("global", remote.map((item) => item.event));
  } catch {
    if (mode === "home" && roomId === "global") globalModeration = state;
  }
};

const mergeHomeGlobalSnapshot = async (incoming: SignedEnvelope[]) => {
  await applyAuthoritativeSnapshot(incoming);
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

type RoomDialogValues = {
  count: number;
  difficultyLow: DifficultyLevel;
  difficultyHigh: DifficultyLevel;
  ratios: PlatformRatios;
  customProblems: string;
  unrated: boolean;
};

const openCreateRoomDialog = async () => {
  if (creatingRoom) return;
  const difficultyOptions = difficultyMeta.map((item) => `<option value="${item.value}" style="color:${item.color}">${item.label}</option>`).join("");
  const result = await Swal.fire<RoomDialogValues>({
    title: "生成房间",
    html: `
      <div class="room-builder-dialog">
        <label><span>题目数量</span><input id="room-builder-count" type="number" min="1" max="21"></label>
        <div class="room-builder-difficulties">
          <label><span>最低难度</span><select id="room-builder-low">${difficultyOptions}</select></label>
          <label><span>最高难度</span><select id="room-builder-high">${difficultyOptions}</select></label>
        </div>
        <div class="room-builder-oj">
          <strong>题目来源 <small>默认 2 : 1 : 1</small></strong>
          ${(["luogu", "codeforces", "atcoder"] as ProblemPlatform[]).map((platform) => `
            <div class="room-builder-oj-row">
              <input id="room-builder-${platform}-enabled" type="checkbox">
              <label for="room-builder-${platform}-enabled">${platformLabel(platform)}</label>
              <input id="room-builder-${platform}-weight" type="number" min="1" max="20" aria-label="${platformLabel(platform)} 权重">
            </div>
          `).join("")}
        </div>
        <label><span>自定义题目 <small>填写后强制 UNR</small></span><textarea id="room-builder-custom" rows="4" placeholder="每行一个题目；留空则随机抽题"></textarea></label>
        <label class="room-builder-unrated"><input id="room-builder-unrated" type="checkbox"><span>UNR 休闲模式</span></label>
        <small class="room-builder-cache">本地题库缓存 ${cachedProblemCount()} 条</small>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: "开始生成",
    cancelButtonText: "取消",
    focusConfirm: false,
    customClass: { popup: "duel-swal room-builder-swal", confirmButton: "duel-swal-confirm", cancelButton: "duel-swal-cancel" },
    didOpen: (popup) => {
      const count = popup.querySelector<HTMLInputElement>("#room-builder-count")!;
      const low = popup.querySelector("#room-builder-low");
      const high = popup.querySelector("#room-builder-high");
      const custom = popup.querySelector<HTMLTextAreaElement>("#room-builder-custom")!;
      const unrated = popup.querySelector<HTMLInputElement>("#room-builder-unrated")!;
      if (!(low instanceof HTMLSelectElement) || !(high instanceof HTMLSelectElement)) return;
      count.value = String(draft.roomCount);
      low.value = String(draft.difficultyLow);
      high.value = String(draft.difficultyHigh);
      custom.value = draft.customProblems;
      unrated.checked = draft.unrated;
      const ratioInputs = (["luogu", "codeforces", "atcoder"] as ProblemPlatform[]).map((platform) => {
        const enabled = popup.querySelector<HTMLInputElement>(`#room-builder-${platform}-enabled`)!;
        const weight = popup.querySelector<HTMLInputElement>(`#room-builder-${platform}-weight`)!;
        enabled.checked = draft.ratios[platform] > 0;
        weight.value = String(draft.ratios[platform] || defaultRatios[platform]);
        enabled.addEventListener("input", () => { weight.disabled = !enabled.checked || Boolean(custom.value.trim()); });
        return { enabled, weight };
      });
      const paintDifficulty = (select: HTMLSelectElement) => {
        select.style.color = difficultyMeta.find((item) => item.value === Number(select.value))?.color ?? "var(--text)";
      };
      const syncCustom = () => {
        const usingCustom = Boolean(custom.value.trim());
        const customCount = parseCustomProblems(custom.value).length;
        if (customCount) count.value = String(customCount);
        count.disabled = usingCustom;
        low.disabled = usingCustom;
        high.disabled = usingCustom;
        ratioInputs.forEach(({ enabled, weight }) => {
          enabled.disabled = usingCustom;
          weight.disabled = usingCustom || !enabled.checked;
        });
        unrated.checked = usingCustom || draft.unrated;
        unrated.disabled = usingCustom;
      };
      low.addEventListener("input", () => paintDifficulty(low));
      high.addEventListener("input", () => paintDifficulty(high));
      custom.addEventListener("input", syncCustom);
      paintDifficulty(low);
      paintDifficulty(high);
      syncCustom();
    },
    preConfirm: () => {
      const popup = Swal.getPopup()!;
      const customProblems = popup.querySelector<HTMLTextAreaElement>("#room-builder-custom")!.value;
      const custom = parseCustomProblems(customProblems);
      if (customProblems.trim() && !custom.length) {
        Swal.showValidationMessage("没有识别到有效的自定义题目");
        return false;
      }
      const low = popup.querySelector("#room-builder-low");
      const high = popup.querySelector("#room-builder-high");
      if (!(low instanceof HTMLSelectElement) || !(high instanceof HTMLSelectElement)) return false;
      const difficultyLow = Number(low.value) as DifficultyLevel;
      const difficultyHigh = Number(high.value) as DifficultyLevel;
      if (!custom.length && difficultyLow > difficultyHigh) {
        Swal.showValidationMessage("最低难度不能高于最高难度");
        return false;
      }
      const ratios = Object.fromEntries((["luogu", "codeforces", "atcoder"] as ProblemPlatform[]).map((platform) => {
        const enabled = popup.querySelector<HTMLInputElement>(`#room-builder-${platform}-enabled`)!.checked;
        const weight = Number(popup.querySelector<HTMLInputElement>(`#room-builder-${platform}-weight`)!.value);
        return [platform, enabled ? clamp(weight, 1, 20) : 0];
      })) as PlatformRatios;
      if (!custom.length && Object.values(ratios).every((value) => value === 0)) {
        Swal.showValidationMessage("至少选择一个题目来源");
        return false;
      }
      return {
        count: custom.length || clamp(Number(popup.querySelector<HTMLInputElement>("#room-builder-count")!.value), 1, 21),
        difficultyLow,
        difficultyHigh,
        ratios,
        customProblems,
        unrated: custom.length > 0 || popup.querySelector<HTMLInputElement>("#room-builder-unrated")!.checked
      };
    }
  });
  if (!result.isConfirmed || !result.value) return;
  draft.roomCount = result.value.count;
  draft.difficultyLow = result.value.difficultyLow;
  draft.difficultyHigh = result.value.difficultyHigh;
  draft.ratios = result.value.ratios;
  draft.customProblems = result.value.customProblems;
  draft.unrated = result.value.unrated;
  await submitCreateRoom();
};

const submitCreateRoom = async (event?: Event) => {
  event?.preventDefault();
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
  await emit({
    ...baseEvent("room.configured"),
    problems,
    rated: customProblems.length ? false : !draft.unrated,
    hostName: identity.luoguName,
    minimumDifficulty: customProblems.length ? undefined : draft.difficultyLow
  });
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

const submitChat = async (event?: Event) => {
  event?.preventDefault();
  const raw = draft.chat.trim();
  if (!raw || blockedByBan()) return;
  if (isMutedCurrent()) {
    setStatus("你已被禁言", "error");
    return;
  }
  const teamMessage = raw.startsWith("/") && mode === "room";
  const text = teamMessage ? raw.slice(1).trim() : raw;
  if (!text) return;
  const privateViolation = teamMessage ? null : privateChatViolation(text);
  console.log(privateViolation);
  if (privateViolation) {
    setStatus(privateViolation, "error");
    applyTemporaryMute(20_000);
    notify();
    return;
  }
  if (recordBurst("chat", 5_000, 3, () => applyTemporaryMute(20_000))) {
    setStatus("发送过于频繁，已临时禁言 20 秒", "error");
    notify();
    return;
  }
  await emitChat(text, teamMessage ? "team" : "all");
  draft.chat = "";
  chatVditor?.setValue("", true);
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
  if (currentSeat() === seat) return;
  if (state.hostId === identity.id && seat === "spectator") {
    setStatus("房主不能进入观战席", "error");
    return;
  }
  if (recordBurst("team", 3_000, 3, () => applyTemporaryBan(10_000, "3 秒内切换队伍次数过多"))) return;
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
  const current = state.problems.find((problem) => problem.pid === targetPid);
  if (!current || replacingProblems.has(targetPid) || state.phase !== "arena") return;
  replacingProblems.add(targetPid);
  notify();
  try {
    setStatus(`正在为 ${targetPid} 查找低一级题目`);
    const replacement = await pickReplacementProblem(current, state.problems, `${roomId}:${state.lamport}:${identity.id}`);
    await openVote("replace-problem", targetPid, replacement);
    setStatus(`${targetPid} → ${replacement.pid}，等待投票`);
  } catch (error) {
    setStatus(friendlyError(error, "换题失败"), "error");
  } finally {
    replacingProblems.delete(targetPid);
    notify();
  }
};

const judgeProblem = async (problem: Problem) => {
  const key = `${problem.platform ?? "luogu"}:${problem.pid}`;
  if (judgingProblems.has(key) || judgeCooldownRemaining() > 0 || state.phase !== "arena" || !state.startedAt) return;
  judgingProblems.add(key);
  notify();
  try {
    const players = Object.values(state.players).filter((player) => isTeam(player.team) && !moderationRecordForPlayer(player));
    startJudgeCooldown();
    const records = await fetchVJudgeRecords(problem, players.map((player) => player.luoguName), state.startedAt, identity.luoguName);
    for (const record of records) {
      const existing = state.feed.find((item) => item.recordId === record.recordId && item.pid === record.pid);
      if (!existing || existing.status !== record.status || existing.at !== record.at) {
        await emit({ ...baseEvent("judge.recordSeen"), record });
      }
    }
    setStatus(records.length ? `${problem.pid} 已同步 ${records.length} 条提交` : `${problem.pid} 暂无开赛后的提交`);
  } catch (error) {
    if(error instanceof Error && error.message === "403") {
      setStatus("请刷新通过人机验证再尝试点击判题", "error");
    }
    setStatus(friendlyError(error, "VJudge 判题同步失败"), "error");
  } finally {
    judgingProblems.delete(key);
    notify();
  }
};

const App = () => {
  if (temporaryBanUntil > Date.now()) return <TemporaryBlockOverlay />;
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
        else if (mode === "room" && currentSeat() === "spectator") void leaveRoom();
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
          <p>与朋友创建一场友好的对决。</p>
        </div>
      </div>
      <div class="home-announcement">
        <h3>{announcementTitle}</h3>
        <RichText text={announcementContent} className="announcement-content" />
        <div class="announcement-actions">
          <button type="button" class="sponsor-trigger" onClick={() => void showSponsorCode()}>赞助</button>
          <button type="button" class="rules-ticket" onClick={() => window.open('https://www.luogu.me/article/fgiidurs', '_blank')}>
            规则与工单
          </button>
        </div>
        <BanAnnouncement />
      </div>
      <button class={`primary open-room-builder ${creatingRoom ? "is-loading" : ""}`} disabled={creatingRoom} onClick={() => void openCreateRoomDialog()}>
        {creatingRoom ? <RefreshCw class="spin" size={18} /> : <Play size={18} />}
        {creatingRoom ? "正在生成房间…" : "生成房间"}
      </button>
    </section>

    <section class="panel home-room-panel">
      <div class="section-head">
        <Users size={18} />
        <div>
          <h2>公开房间</h2>
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
              <button key={seat} class={currentSeat() === seat ? "active" : ""} disabled={blockedByBan() || (seat === "spectator" && state.hostId === identity.id)} onClick={() => void setSeat(seat)}>
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
      <i class="win-marker red-marker" style={{ left: `${thresholdPct}%` }} aria-label={`红方胜利线 ${winThreshold(state)}`} />
      <i class="win-marker blue-marker" style={{ left: `${100 - thresholdPct}%` }} aria-label={`蓝方胜利线 ${winThreshold(state)}`} />
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
    for (const name of [room.host, ...(room.redPlayers ?? []), ...(room.bluePlayers ?? [])]) {
      if (name && normalizeName(name) !== "unknown" && name !== "待同步") ensure(name);
    }
  }
  return [...map.values()].sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name));
};

const AdminPage = () => {
  if (!isAdmin()) return <main class="center-screen"><Shield size={42} /><h1>无管理员权限</h1></main>;
  const rows = ratingRows();
  const search = normalizeName(draft.adminSearch);
  const visibleRows = search ? rows.filter((row) => normalizeName(row.name).includes(search)) : rows;
  const managedRooms = rooms.filter((room) => (room.status === "lobby" || room.status === "arena") && !isClosedListing(room));
  return (
    <main class="admin-page">
      <header class="admin-page-head">
        <div><Shield size={22} /><span><h1>管理中心</h1><p>当前管理员：{identity.luoguName}</p></span></div>
        <div class="admin-stats"><strong>{rows.length}</strong><span>玩家</span><strong>{managedRooms.length}</strong><span>活跃房间</span></div>
        <button class="ghost" onClick={() => void Promise.all([loadDirectory(), loadUsers()])}><RefreshCw size={15} />刷新</button>
      </header>

      <section class="panel admin-section">
        <div class="admin-section-head">
          <div><h2>玩家管理</h2><p>{visibleRows.length} / {rows.length} 名玩家</p></div>
          <div class="admin-player-filters">
            <input type="search" value={draft.adminSearch} placeholder="搜索用户名" onInput={(event) => { draft.adminSearch = event.currentTarget.value; notifyDraft(); }} />
            <input value={draft.adminReason} placeholder="封禁原因（可选）" onInput={(event) => (draft.adminReason = event.currentTarget.value)} />
          </div>
        </div>
        <div class="admin-player-list">
          {visibleRows.map((row) => {
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
          {!visibleRows.length ? <p class="muted admin-empty">没有匹配的玩家。</p> : null}
        </div>
      </section>

      <section class="panel admin-section">
        <div class="admin-section-head"><div><h2>房间管理</h2></div></div>
        <div class="admin-room-list">
          {managedRooms.length ? managedRooms.map((room) => {
            const busy = adminBusy.has(`room:${room.roomId}`);
            return (
              <article class="admin-room" key={room.roomId}>
                <code>{room.roomId}</code>
                <span><strong>{room.host}</strong><small>{roomStatusLabel(room)} · {playerCount(room)} 人 · {room.problemCount} 题</small></span>
                <button class="danger" disabled={busy} onClick={() => void runForceCloseRoom(room)}>{busy ? <RefreshCw class="spin" size={14} /> : <Trash2 size={14} />}强制关闭</button>
              </article>
            );
          }) : <p class="muted">暂无准备中或进行中的房间。</p>}
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

const Roster = () => {
  const spectators = Object.values(state.players).filter((player) => player.team === "spectator");
  return (
    <div class="teams">
      {(["red", "blue"] as const).map((seat) => (
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
      <div class="team-card spectator-card">
        <button class="spectator-toggle" onClick={() => { draft.spectatorsOpen = !draft.spectatorsOpen; notify(); }}>
          <Eye size={14} />
          <strong>观赛席</strong>
          <span>{spectators.length}</span>
          {draft.spectatorsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {draft.spectatorsOpen ? (
          <div class="spectator-list">
            {spectators.length ? spectators.map((player) => <PlayerRow player={player} key={player.id} />) : <p class="muted">暂无观赛人员</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
};

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
        {!isOwnName(player.luoguName) ? <button type="button" class="mention-player" title={`@${player.luoguName}`} onClick={() => insertMention(player.luoguName)}>@</button> : null}
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
        {problem.difficulty ? <DifficultyBadge level={problem.difficulty} /> : <em>自定义</em>}
        <strong>{problem.solvedBy?.luoguName ?? (state.phase === "lobby" ? "hidden" : "unclaimed")}</strong>
        {state.phase === "arena" && isTeam(currentSeat()) && !blockedByBan() ? (
          <div class="problem-actions">
            <button disabled={judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`) || judgeCooldownRemaining() > 0} onClick={() => void judgeProblem(problem)}>
              {judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`) ? <RefreshCw class="spin" size={13} /> : null}
              {judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`) ? "同步中" : judgeCooldownRemaining() > 0 ? `${judgeCooldownRemaining()}s` : "判题"}
            </button>
            <button disabled={replacingProblems.has(problem.pid)} onClick={() => void replaceProblem(problem.pid)}>{replacingProblems.has(problem.pid) ? <RefreshCw class="spin" size={13} /> : null}{replacingProblems.has(problem.pid) ? "查找中" : "换题"}</button>
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
  queueMicrotask(syncChatVditorState);
  return (
    <div class="chat">
      <PanelTitle icon={<MessageSquare size={16} />} title="CHAT" detail={mode === "room" ? "/ prefix = team" : "global"} />
      <div class="chat-log">
        {items.map((item) => <ChatLine item={item} key={item.id} />)}
      </div>
      <form class="chat-form" onSubmit={(event) => void submitChat(event)}>
        <div class="chat-vditor" ref={chatVditorRef} />
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
        <RichText text={item.text} className="chat-text" />
      </p>
    );
  }
  if (item.type === "judge") {
    const record = item.record;
    return (
      <p class={record.status === "OK" ? "chat-line judge ok" : "chat-line judge fail"}>
        <span class="chat-avatar">{record.status === "OK" ? "✓" : "!"}</span>
        <span>{formatClock(record.at)} / {record.pid}</span>
        <RichText text={`${record.luoguName} ${record.status}`} className="chat-text" />
      </p>
    );
  }
  const chat = item.chat;
  const mine = chat.actorId === identity.id || isOwnName(chat.luoguName);
  return (
    <p class={`chat-line bubble ${mine ? "mine" : "theirs"} ${chat.visibility === "team" ? "private" : ""}`}>
      <UserAvatar name={chat.luoguName} className="chat-avatar" />
      <button type="button" class="chat-name" title={`点击 @${chat.luoguName}`} style={{ color: nameColor(chat.luoguName) }} onClick={() => insertMention(chat.luoguName)}>{chat.visibility === "team" ? "TEAM / " : ""}{chat.luoguName}</button>
      <RichText text={chat.text} className="chat-text" />
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
  const openEditor = () => {
    draft.profileDraft = source;
    draft.profileEditing = true;
    notify();
    queueMicrotask(() => void mountProfileVditor());
  };
  return (
    <main class="profile-page">
      <div class="profile-card">
        <header class="profile-hero">
          <UserAvatar name={name} className="profile-avatar" />
          <div class="profile-identity">
            <p class="eyebrow">PLAYER PROFILE</p>
            <h1 style={{ color: nameColor(name) }}>{name}</h1>
            <p>{row.games} 场对决 · {row.wins} 胜 · {row.losses} 负</p>
          </div>
          <div class="profile-rating-summary">
            <span>RATING</span>
            <strong>{Math.round(row.rating)}</strong>
          </div>
        </header>

        <nav class="profile-tabs" aria-label="个人主页栏目">
          {(["home", "matches", "achievements"] as const).map((tab) => (
            <button class={draft.profileTab === tab ? "active" : ""} key={tab} onClick={() => { destroyProfileVditor(); draft.profileTab = tab; draft.profileEditing = false; notify(); }}>
              {tab === "home" ? "主页" : tab === "matches" ? "对局" : "成就"}
            </button>
          ))}
        </nav>

        {draft.profileTab === "home" ? (
          <div class="profile-home-layout">
            <section class="profile-home-main">
              <div class="profile-content-head">
                <div><h2>个人主页</h2></div>
                {mine ? (
                  <div class="profile-actions">
                    {draft.profileEditing ? (
                      <>
                        <button class="primary" onClick={() => void persistUserProfile(name, profileVditor?.getValue() ?? draft.profileDraft)}>保存</button>
                        <button class="ghost" onClick={() => { destroyProfileVditor(); draft.profileEditing = false; draft.profileDraft = ""; notify(); }}>取消</button>
                      </>
                    ) : <button class="primary" onClick={openEditor}>编辑主页</button>}
                  </div>
                ) : null}
              </div>
              {draft.profileEditing && mine ? (
                <div id="profile-vditor" class="profile-vditor" />
              ) : (
                <div class="profile-html">
                  <RichText text={source || "这个用户还没有填写个人主页。"} className="profile-rich-text" />
                </div>
              )}
            </section>
            <aside class="profile-sidebar">
              <RatingCurve name={name} />
              <div class="profile-stats">
                <span>比赛数据</span>
                <strong>{row.wins}/{row.games}</strong>
                <small>{row.games ? Math.round(row.wins / row.games * 100) : 0}% 胜率</small>
              </div>
            </aside>
          </div>
        ) : null}

        {draft.profileTab === "matches" ? (
          <section class="profile-section profile-tab-panel">
            <h2>最近 20 场</h2>
            {completedPlayerRooms(name).length
              ? completedPlayerRooms(name).slice(0, 20).map((room) => <p key={room.roomId}><code>{shortRoomId(room.roomId)}</code><span>{roomLine(room)}</span><em>{roomStatusLabel(room)}</em></p>)
              : <p class="muted">暂无已结束的对局。</p>}
          </section>
        ) : null}

        {draft.profileTab === "achievements" ? (
          <div class="achievement-grid profile-tab-panel">
            {achievementsFor(name, row).map((achievement) => (
              <article class={`achievement ${achievement.progress >= 100 ? "complete" : ""}`} key={achievement.title}>
                <achievement.Icon size={26} />
                <div><h3>{achievement.title}</h3><p>{achievement.text}</p><span>进度 {achievement.progress}%</span></div>
              </article>
            ))}
          </div>
        ) : null}
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

const RatingCurve = ({ name }: { name: string }) => {
  const user = userRecordFor(name);
  const raw = user?.ratingHistory?.length ? user.ratingHistory.slice(-24) : [{ at: Date.now(), rating: user?.rating ?? 1300 }];
  const history = raw.length === 1 ? [raw[0], { ...raw[0], at: raw[0].at + 1 }] : raw;
  const ratings = history.map((point) => point.rating);
  const minimum = Math.min(...ratings);
  const maximum = Math.max(...ratings);
  const range = Math.max(80, maximum - minimum);
  const floor = minimum - Math.max(30, (range - (maximum - minimum)) / 2);
  const ceiling = floor + range;
  const points = history.map((point, index) => {
    const x = history.length <= 1 ? 0 : index / (history.length - 1) * 360;
    const y = 92 - (point.rating - floor) / (ceiling - floor) * 76;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const first = history[0].rating;
  const current = history.at(-1)?.rating ?? first;
  return (
    <section class="rating-curve-card" aria-label="Rating 曲线">
      <div><span>RATING</span><strong>{Math.round(current)}</strong><em class={current >= first ? "up" : "down"}>{current >= first ? "+" : ""}{Math.round(current - first)}</em></div>
      <svg viewBox="0 0 360 108" preserveAspectRatio="none" role="img">
        <defs><linearGradient id="rating-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--green)" stop-opacity=".38"/><stop offset="1" stop-color="var(--green)" stop-opacity="0"/></linearGradient></defs>
        <polygon points={`0,108 ${points} 360,108`} fill="url(#rating-area)" />
        <polyline points={points} fill="none" stroke="var(--green)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </section>
  );
};

const loadAnnouncement = async () => {
  try {
    const cached = JSON.parse(localStorage.getItem(announcementCacheKey) || "null") as { title?: string; content?: string; cachedAt?: number } | null;
    if (cached?.title && cached.content) {
      announcementTitle = cached.title;
      announcementContent = cached.content;
      notify();
      if (cached.cachedAt && Date.now() - cached.cachedAt < 24 * 60 * 60_000) return;
    }
  } catch {
    // Continue with the network source.
  }
  try {
    const response = await fetch("https://api.luogu.me/article/query/utz3c7b2", {
      cache: "default",
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`announcement returned ${response.status}`);
    const payload = (await response.json()) as { code?: number; data?: { title?: string; content?: string } };
    if (payload.code !== 200 || !payload.data?.content) throw new Error("invalid announcement payload");
    announcementTitle = payload.data.title?.trim() || "VJudge Duel 公告";
    announcementContent = payload.data.content;
    try {
      localStorage.setItem(announcementCacheKey, JSON.stringify({ title: announcementTitle, content: announcementContent, cachedAt: Date.now() }));
    } catch {
      // Rendering does not depend on storage.
    }
    notify();
  } catch {
    if (announcementContent === "正在读取公告…") announcementContent = "公告暂时不可用。";
  }
};

const TemporaryBlockOverlay = () => (
  <div class="temporary-block-overlay">
    <div>
      <Shield size={48} />
      <h1>临时封禁</h1>
      <p>{temporaryBanReason}</p>
      <strong>{Math.max(1, Math.ceil((temporaryBanUntil - Date.now()) / 1000))}s</strong>
    </div>
  </div>
);

const vditorCdn = "https://cdn.jsdelivr.net/npm/vditor@3.11.2";

const loadVditor = () => {
  vditorModulePromise ??= import("vditor");
  return vditorModulePromise;
};

const currentVditorTheme = (): "dark" | "light" => document.documentElement.dataset.theme === "dark" ? "dark" : "light";

const vditorPreviewOptions = () => {
  const theme = currentVditorTheme();
  return {
    theme: { current: theme, path: `${vditorCdn}/dist/css/content-theme` },
    hljs: { style: theme === "dark" ? "github-dark" : "github" },
    markdown: { sanitize: true, codeBlockPreview: true, mathBlockPreview: true },
    math: { engine: "KaTeX" as const }
  };
};

const setVditorTheme = (editor: VditorType | null) => {
  if (!editor) return;
  const theme = currentVditorTheme();
  editor.setTheme(theme === "dark" ? "dark" : "classic", theme, theme === "dark" ? "github-dark" : "github", `${vditorCdn}/dist/css/content-theme`);
};

const chatEditorBlocked = () => blockedByBan() || isMutedCurrent() || (mode === "room" && state.phase === "finished");

const syncChatVditorState = () => {
  if (!chatVditor) return;
  if (chatEditorBlocked()) chatVditor.disabled();
  else chatVditor.enable();
};

const destroyChatVditor = () => {
  chatVditorGeneration += 1;
  chatVditor?.destroy();
  chatVditor = null;
  chatVditorTarget = null;
};

const mountChatVditor = async (target: HTMLDivElement) => {
  if (chatVditor && chatVditorTarget === target) {
    syncChatVditorState();
    return;
  }
  destroyChatVditor();
  chatVditorTarget = target;
  const generation = chatVditorGeneration;
  const { default: Vditor } = await loadVditor();
  if (generation !== chatVditorGeneration || !target.isConnected) return;
  const editor = new Vditor(target, {
    mode: "wysiwyg",
    value: draft.chat,
    lang: "zh_CN",
    cdn: vditorCdn,
    theme: currentVditorTheme() === "dark" ? "dark" : "classic",
    minHeight: 82,
    cache: { enable: false },
    counter: { enable: true, max: 500, type: "markdown" },
    toolbar: ["bold", "italic", "strike", "inline-code", "link", "emoji"],
    toolbarConfig: { pin: false },
    preview: vditorPreviewOptions(),
    input: (value) => { draft.chat = value; },
    ctrlEnter: (value) => {
      draft.chat = value;
      void submitChat();
    },
    after: () => syncChatVditorState()
  });
  chatVditor = editor;
};

const chatVditorRef = (element: HTMLDivElement | null) => {
  if (element) {
    void mountChatVditor(element);
    return;
  }
  queueMicrotask(() => {
    if (chatVditorTarget && !chatVditorTarget.isConnected) destroyChatVditor();
  });
};

const destroyProfileVditor = () => {
  profileVditor?.destroy();
  profileVditor = null;
};

const mountProfileVditor = async () => {
  const target = document.querySelector<HTMLDivElement>("#profile-vditor");
  if (!target || !draft.profileEditing) return;
  destroyProfileVditor();
  const { default: Vditor } = await loadVditor();
  if (!target.isConnected || !draft.profileEditing) return;
  const editor = new Vditor(target, {
    mode: "wysiwyg",
    value: draft.profileDraft,
    lang: "zh_CN",
    cdn: vditorCdn,
    theme: currentVditorTheme() === "dark" ? "dark" : "classic",
    minHeight: 380,
    cache: { enable: false },
    counter: { enable: true, max: 20_000, type: "markdown" },
    toolbar: ["headings", "bold", "italic", "strike", "|", "quote", "list", "ordered-list", "check", "|", "link", "table", "code", "inline-code", "|", "undo", "redo", "fullscreen"],
    preview: vditorPreviewOptions(),
    input: (value) => { draft.profileDraft = value; },
    ctrlEnter: (value) => void persistUserProfile(profileUserName || identity.luoguName, value)
  });
  profileVditor = editor;
};

const mountVditorPreview = (element: HTMLDivElement | null, source: string) => {
  const renderKey = `${currentVditorTheme()}\u0000${source}`;
  if (!element || vditorPreviewSources.get(element) === renderKey) return;
  vditorPreviewSources.set(element, renderKey);
  element.textContent = source;
  void loadVditor().then(({ default: Vditor }) => Vditor.preview(element, source, {
    mode: currentVditorTheme(),
    lang: "zh_CN",
    cdn: vditorCdn,
    anchor: 0,
    ...vditorPreviewOptions(),
    after: () => {
      element.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      });
    }
  })).catch(() => {
    element.textContent = source;
  });
};

const RichText = ({ text, className = "" }: { text: string; className?: string }) => (
  <div class={`rich-text vditor-reset ${currentVditorTheme() === "dark" ? "vditor-reset--dark" : ""} ${className}`} ref={(element) => mountVditorPreview(element, text)} />
);

const AuthError = () => (
  <Shell title="VJudge Duel" subtitle="login">
    <main class="center-screen auth-page">
      <section class="auth-card">
        <div class="auth-intro">
          <KeyRound class="login-mark" size={38} strokeWidth={1.8} />
          <p class="eyebrow">VJUDGE IDENTITY</p>
          <h1>使用 VJudge 登录</h1>
          <p>{authErrorText}</p>
        </div>
        <form class="paste-login" onSubmit={(event) => void submitVJudgeLogin(event)}>
          <strong class="login-title">验证账号</strong>
          <ol class="login-guide">
            <li>输入你的 VJudge 用户名</li>
            <li>确保当前浏览器已经登录 VJudge</li>
            <li>点击验证后会短暂打开 VJudge，并自动完成在线确认</li>
          </ol>
          <input disabled={loginSubmitting} value={vjudgeUsername} placeholder="VJudge 用户名" autoComplete="username" onInput={(event) => (vjudgeUsername = event.currentTarget.value)} />
          <div class="login-actions">
            <span>检测最近 3 秒的在线状态</span>
            <button class={`primary ${loginSubmitting ? "is-loading" : ""}`} disabled={loginSubmitting} type="submit">
              {loginSubmitting ? <RefreshCw class="spin" size={16} /> : <KeyRound size={16} />}{loginSubmitting ? "正在打开 VJudge…" : "打开 VJudge 并验证"}
            </button>
          </div>
        </form>
      </section>
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

const openVJudgeForLogin = async (): Promise<void> => {
  const popup = window.open("about:blank", "_blank", "popup,width=1080,height=760");
  if (!popup) throw new Error("浏览器阻止了 VJudge 窗口，请允许本站弹出窗口后重试");
  const url = "https://vjudge.net/";
  await fetch(url, { method: "HEAD", cache: "no-store", mode: "no-cors", credentials: "include" }).catch(() => undefined);
  const startedAt = performance.now();
  await fetch(url, { method: "HEAD", cache: "default", mode: "no-cors", credentials: "include" }).catch(() => undefined);
  const closeDelay = (performance.now() - startedAt) * 1.5 + 1000;
  try {
    popup.location.replace(`${url}`);
    console.log(closeDelay);
    await new Promise((resolve) => window.setTimeout(resolve, closeDelay));
  } finally {
    if (!popup.closed) popup.close();
  }
};

const submitVJudgeLogin = async (event: Event) => {
  event.preventDefault();
  if (loginSubmitting) return;
  const username = vjudgeUsername.trim();
  if (!username) {
    authErrorText = "请输入 VJudge 用户名";
    notify();
    return;
  }
  loginSubmitting = true;
  notify();
  try {
    await openVJudgeForLogin();
    vjudgeSession = await verifyVJudgeLogin(username);
    identity = await renameIdentity(identity, vjudgeSession.username);
    authErrorText = "";
    bootPhase = "ready";
    await registerCurrentUser();
    await refreshGlobalModeration();
    await enterFromHash();
  } catch (error) {
    authErrorText = error instanceof Error ? error.message : "VJudge 登录失败";
  } finally {
    loginSubmitting = false;
  }
  notify();
};

const Loading = () => (
  <main class="center-screen">
    <Bot size={42} />
    <h1>Connecting</h1>
    <p>正在连接。</p>
  </main>
);

const BootScreen = ({ leaving }: { leaving: boolean }) => (
  <main class={`boot-screen${leaving ? " leaving" : ""}`}>
    <div class="boot-loading">Loading...</div>
  </main>
);

const ProfileLoading = () => (
  <main class="profile-page">
    <div class="profile-loading-overlay" aria-label="loading user profile" />
  </main>
);

const DifficultyBadge = ({ level }: { level: number }) => {
  const meta = difficultyMeta.find((item) => item.value === level);
  return <span class="difficulty-badge" data-difficulty={level} style={{ "--difficulty-color": meta?.color ?? "#6b7280" } as JSX.CSSProperties}>{meta?.short ?? level}</span>;
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

const showSponsorCode = async () => {
  await Swal.fire({
    title: "赞助",
    imageUrl: "https://cdn.luogu.com.cn/upload/image_hosting/7uzglkak.png",
    imageAlt: "赞助码",
    imageWidth: 280,
    confirmButtonText: "关闭",
    customClass: { popup: "duel-swal", confirmButton: "duel-swal-confirm" }
  });
};

const judgeCooldownRemaining = (): number => {
  try {
    const until = Number(localStorage.getItem(judgeCooldownKey()) || 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  } catch {
    return 0;
  }
};

const startJudgeCooldown = () => {
  try {
    localStorage.setItem(judgeCooldownKey(), String(Date.now() + 30_000));
  } catch {
    // Server-side rate limiting remains authoritative.
  }
};

const vjudgeProblemUrl = (problem: Problem): string => {
  const source = problem.platform === "codeforces" ? "Codeforces" : problem.platform === "atcoder" ? "AtCoder" : "洛谷";
  return `https://vjudge.net/problem/${encodeURIComponent(source)}-${encodeURIComponent(problem.pid)}`;
};

const logout = () => {
  logoutVJudgeSession();
  location.hash = "";
  location.reload();
};

const blockedByBan = (): boolean => temporaryBanUntil > Date.now() || Boolean(bannedRecord());
const bannedRecord = () =>
  moderationRecordForPlayer(state.players[identity?.id]) ||
  moderationRecordForName(identity?.luoguName ?? "");
const moderationRecordForName = (name: string) =>
  state.banned[normalizeName(name)] || globalModeration.banned[normalizeName(name)];
const moderationRecordForPlayer = (player: Player | undefined) => (player ? state.kicked[player.id] || moderationRecordForName(player.luoguName) : undefined);
const isMutedCurrent = (): boolean => temporaryMuteUntil > Date.now() || isMutedByIdentity(identity?.id ?? "", identity?.luoguName ?? "");
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
      if (typeof value === "string" && value) return [[key, value]];
      if (typeof value === "object" && typeof value?.url === "string" && value.url) return [[key, value.url]];
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
      value.user && typeof value.cachedAt === "number"
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
    ratingHistory: existing?.ratingHistory,
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
    destroyProfileVditor();
    draft.profileEditing = false;
    draft.profileDraft = "";
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
  return `红 ${count("red")} / 蓝 ${count("blue")}`;
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

function readStoredNumber(key: string): number {
  try {
    const value = Number(localStorage.getItem(key) || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function readStoredText(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function recordBurst(kind: string, windowMs: number, threshold: number, punish: () => void): boolean {
  const key = `vjudge-duel.security.actions.${kind}.v1`;
  const now = Date.now();
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "[]") as number[];
    const recent = stored.filter((time) => Number.isFinite(time) && now - time < windowMs).concat(now);
    if (recent.length >= threshold) {
      localStorage.removeItem(key);
      punish();
      return true;
    }
    localStorage.setItem(key, JSON.stringify(recent));
  } catch {
    // The in-memory operation is still allowed when browser storage is unavailable.
  }
  return false;
}

function applyTemporaryBan(durationMs: number, reason: string): void {
  temporaryBanUntil = Date.now() + durationMs;
  temporaryBanReason = reason;
  try {
    localStorage.setItem(temporaryBanKey, String(temporaryBanUntil));
    localStorage.setItem(temporaryBanReasonKey, reason);
  } catch {
    // In-memory enforcement remains active.
  }
}

function applyTemporaryMute(durationMs: number): void {
  temporaryMuteUntil = Date.now() + durationMs;
  try {
    localStorage.setItem(temporaryMuteKey, String(temporaryMuteUntil));
  } catch {
    // In-memory enforcement remains active.
  }
}

notify();
void boot();
