import { api, post } from "./client";
import type { Task } from "./setup";

export type VehicleCatalogEntry = {
  id: string;
  name: string;
  actor?: string;
  templates: string[];
};

export type ItemCatalogEntry = {
  id: string;
  itemId: string;
  name: string;
  category: string;
  source: string;
  image?: string;
};

export type CharacterTransferSettings = {
  ShouldDeleteOriginCharactersDuringTransfers: boolean;
  AcceptOutgoingCharacterTransfers: boolean;
  IncomingCharacterTransfers: number;
  ExportCharacterTimeout: number;
  ImportCharacterTimeout: number;
  FreeToTransferCharactersFrom: boolean;
  FreeToTransferCharactersTo: boolean;
  ValidateBeforeImportCharacterTimeout: number;
  ForceIsWorldClosed: boolean;
  ForceIsWorldClosingSoon: boolean;
};

export type IncomingCharacterTransferPolicy = {
  value: number;
  label: string;
};

export type MessageOfTheDaySettings = {
  enabled: boolean;
  title: string;
  message: string;
  deliveryMode: "login" | "daily" | "map";
};

export type MessageOfTheDayStatus = {
  lastAttemptAt: string;
  lastSent: number;
  lastFailed: number;
  lastError: string;
  lastScanAt: string;
  lastScanError: string;
};

export type PlayerAnnouncementSettings = {
  joinEnabled: boolean;
  joinMessage: string;
  leaveEnabled: boolean;
  leaveMessage: string;
};

export type ScheduledMapMessage = {
  id: string;
  name: string;
  enabled: boolean;
  mapName: string;
  dimension: number;
  message: string;
  frequency: "daily" | "weekly";
  daysOfWeek: number[];
  time: string;
  timezone: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt: string;
  lastDeliveredAt: string;
  lastStatus: "never" | "running" | "sent" | "skipped" | "failed" | "missed";
  lastError: string;
  lastRecipients: number;
};

export type ScheduledMapMessageDraft = Pick<ScheduledMapMessage, "name" | "enabled" | "mapName" | "dimension" | "message" | "frequency" | "daysOfWeek" | "time" | "timezone"> & { id?: string };

export type LandsraadTerm = {
  term_id: number | string;
  start_time?: string;
  end_time?: string;
  test_term?: boolean;
  reigning_faction?: string;
  active_decree?: string;
  elected_decree?: string;
  winning_faction?: string;
};

export type LandsraadTask = {
  task_id: string;
  board_index: number;
  house_name: string;
  display_name: string;
  goal_amount: number;
  faction_progress: number;
  completed: boolean;
  winning_faction?: string;
  sysselraad?: boolean;
};

export type LandsraadReward = {
  row_locator: string;
  task_id: string;
  threshold: number;
  template_id: string;
  amount: number;
};

export type LandsraadOverview = {
  capabilities: Record<string, boolean>;
  term: LandsraadTerm | null;
  decrees: Record<string, unknown>[];
  tasks: LandsraadTask[];
  rewards: LandsraadReward[];
};

export type LandsraadMilestonePreset = {
  enabled: boolean;
  goalAmount: number;
  thresholds: number[];
  lastAppliedTermId: string | null;
  lastAppliedAt: string;
  lastResult: string;
};

export const adminApi = {
  itemCatalog: (q = "", limit = 10000) => api<{ rows: ItemCatalogEntry[] }>(`/api/admin/items/catalog?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`),
  itemSearch: (q: string) => api<{ stdout: string }>(`/api/admin/items/search?q=${encodeURIComponent(q)}`),
  itemList: (category = "") => api<{ stdout: string }>(`/api/admin/items${category ? `?category=${encodeURIComponent(category)}` : ""}`),
  vehicles: (q = "") => api<{ stdout: string }>(`/api/admin/vehicles${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  structuredVehicles: () => api<{ vehicles: VehicleCatalogEntry[]; stdout?: string; stderr?: string }>("/api/admin/vehicles/structured"),
  skillModules: (q = "") => api<{ stdout: string }>(`/api/admin/skill-modules${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  history: () => api<{ stdout: string }>("/api/admin/history"),
  clearHistory: (scope: "all" | "admin-tools" = "all") => post<{ ok: boolean }>("/api/admin/history/clear", { scope }),
  characterTransferSettings: () => api<{ settings: CharacterTransferSettings; defaults: CharacterTransferSettings; policies: IncomingCharacterTransferPolicy[]; customized: boolean; path: string }>("/api/admin/character-transfer-settings"),
  saveCharacterTransferSettings: (settings: CharacterTransferSettings) => post<{ ok: boolean; settings: CharacterTransferSettings; task: Task }>("/api/admin/character-transfer-settings", { settings }),
  restoreCharacterTransferSettings: () => post<{ ok: boolean; settings: CharacterTransferSettings; task: Task }>("/api/admin/character-transfer-settings", { restoreDefaults: true }),
  messageOfTheDay: () => api<{ settings: MessageOfTheDaySettings; defaults: MessageOfTheDaySettings; status: MessageOfTheDayStatus }>("/api/admin/message-of-the-day"),
  saveMessageOfTheDay: (settings: MessageOfTheDaySettings) => post<{ ok: boolean; settings: MessageOfTheDaySettings; defaults: MessageOfTheDaySettings; status: MessageOfTheDayStatus; delivery: { primedOnlinePlayers: number; note: string } }>("/api/admin/message-of-the-day", { settings }),
  restoreMessageOfTheDay: () => post<{ ok: boolean; settings: MessageOfTheDaySettings; defaults: MessageOfTheDaySettings; status: MessageOfTheDayStatus; delivery: { primedOnlinePlayers: number; note: string } }>("/api/admin/message-of-the-day", { restoreDefaults: true }),
  playerAnnouncements: () => api<{ settings: PlayerAnnouncementSettings; defaults: PlayerAnnouncementSettings }>("/api/admin/player-announcements"),
  savePlayerAnnouncements: (settings: PlayerAnnouncementSettings) => post<{ ok: boolean; settings: PlayerAnnouncementSettings; defaults: PlayerAnnouncementSettings }>("/api/admin/player-announcements", { settings }),
  restorePlayerAnnouncements: () => post<{ ok: boolean; settings: PlayerAnnouncementSettings; defaults: PlayerAnnouncementSettings }>("/api/admin/player-announcements", { restoreDefaults: true }),
  landsraad: () => api<LandsraadOverview>("/api/admin/landsraad"),
  landsraadMilestonePreset: () => api<{ preset: LandsraadMilestonePreset }>("/api/admin/landsraad/milestone-preset"),
  saveLandsraadMilestonePreset: (body: { enabled: boolean; goalAmount: number; thresholds: number[] }) => post<{ preset: LandsraadMilestonePreset; result: { applied: boolean; reason?: string; termId?: string } }>("/api/admin/landsraad/milestone-preset", body),
  setLandsraadTaskGoal: (taskId: string | number, goalAmount: number) => post<{ ok: boolean }>("/api/admin/landsraad/task-goal", { taskId, goalAmount }),
  setLandsraadTermTaskGoals: (termId: string | number, goalAmount: number) => post<{ ok: boolean; updatedRows: number }>("/api/admin/landsraad/term-task-goals", { termId, goalAmount }),
  setLandsraadRewardTier: (body: { rowLocator: string; taskId: string | number; threshold: number; newThreshold: number; templateId: string; amount: number }) => post<{ ok: boolean }>("/api/admin/landsraad/reward-tier", body),
  setLandsraadPlayerContribution: (body: { playerId: string | number; taskId: string | number; amount: number }) => post<{ ok: boolean; message?: string }>("/api/admin/landsraad/player-contribution", body),
  kickAllOnline: (confirmation: string) => post<{ task: Task }>("/api/players/kick-all-online", { confirmation }),
  broadcast: (title: string, body: string, durationSec: number) => post<{ supported: boolean; reason?: string; ok?: boolean; stdout?: string; stderr?: string; note?: string }>("/api/admin/broadcast", { title, body, durationSec }),
  mapChat: (mapName: string, dimension: number, body: string) => post<{ supported: boolean; reason?: string; ok?: boolean; stdout?: string; stderr?: string; note?: string }>("/api/admin/map-chat", { mapName, dimension, body }),
  mapChatSchedules: () => api<{ version: number; schedules: ScheduledMapMessage[] }>("/api/admin/map-chat-schedules"),
  saveMapChatSchedule: (schedule: ScheduledMapMessageDraft) => post<{ ok: boolean; schedule: ScheduledMapMessage; schedules: ScheduledMapMessage[] }>("/api/admin/map-chat-schedules", { action: "save", schedule }),
  deleteMapChatSchedule: (id: string) => post<{ ok: boolean; removed: string; schedules: ScheduledMapMessage[] }>("/api/admin/map-chat-schedules", { action: "delete", id }),
  runMapChatSchedule: (id: string) => post<{ ok: boolean; schedules: ScheduledMapMessage[]; result: { recipients?: number } }>("/api/admin/map-chat-schedules", { action: "run", id })
};
