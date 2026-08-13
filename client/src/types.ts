// Shared protocol types (single source of truth): @pi-studio/shared.
// Client-only types below.
export type * from "@pi-studio/shared";
import type { AttachmentInfo } from "@pi-studio/shared";

export interface ArchivedSession {
  file: string;
  name?: string;
  createdAt?: number;
  messageCount: number;
  firstMessage?: string;
  projectId?: string;
  projectName?: string;
  archivedAt: number;
}
export interface ScheduledTask { id: string; name: string; prompt: string; agentId: string; kind: "once"|"interval"|"daily"|"weekly"; at?: string; intervalMinutes?: number; time?: string; weekday?: number; enabled: boolean; nextRunAt?: number; lastRunAt?: number; lastStatus?: "success"|"error"|"queued"; lastResult?: string; }
export interface UploadResult {
  files: AttachmentInfo[];
}
export interface SkillSummary {
  name: string;
  description: string;
  filePath: string;
  directory: string;
  disableModelInvocation: boolean;
}
export interface XlsxSheet {
  name: string;
  rows: string[][];
}
export interface ParsedDoc {
  kind: "docx" | "xlsx" | "pptx";
  html?: string;
  sheets?: XlsxSheet[];
}
