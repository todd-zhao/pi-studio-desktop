import { useCallback, useRef, useState } from "react";
import {
  archiveProject as archiveProjectApi,
  archiveSession as archiveSessionApi,
  assignSessionToProject,
  deleteArchivedSession as deleteArchivedSessionApi,
  deleteSession as deleteSessionApi,
  listArchivedSessions,
  listProjects,
  listSessions,
  removeProject,
  removeSessionFromProject,
  restoreProject as restoreProjectApi,
  restoreSession as restoreSessionApi,
} from "../api";
import type { ArchivedSession, ClientWsMessage, ProjectSummary, SessionMeta, WorkspaceInfo } from "../types";
import type { Toast } from "../types-app";

export interface UseSessionsOptions {
  /** Raw socket send helper (from useLiveSocket). */
  send: (msg: ClientWsMessage) => void;
  toast: (level: Toast["level"], message: string) => void;
  /** Active session file, used to decide whether CRUD results require a switch. */
  activeSessionFile: string | undefined;
  /** Closes the right panel when switching session/workspace. */
  closePanel: () => void;
}

/**
 * Owns sessions / projects / workspaces / archived-sessions data plus the
 * open-tab list and all session-level CRUD operations.
 */
export function useSessions(options: UseSessionsOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSession[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [openTabFiles, setOpenTabFiles] = useState<string[]>([]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      /* ignore */
    }
  }, []);

  const refreshArchived = useCallback(async () => {
    try {
      setArchivedSessions(await listArchivedSessions());
    } catch {
      /* ignore */
    }
  }, []);

  const handleDeleteSession = useCallback(async (file: string) => {
    const { toast } = optionsRef.current;
    try {
      const result = await deleteSessionApi(file);
      setOpenTabFiles((prev) => prev.filter((f) => f !== file));
      await refreshSessions();
      setProjects(await listProjects());
      if (result.activeFile && result.activeFile !== optionsRef.current.activeSessionFile) {
        optionsRef.current.send({ type: "switch_session", file: result.activeFile });
      }
      toast("ok", "对话已删除");
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }, [refreshSessions]);

  const handleArchiveSession = useCallback(async (file: string) => {
    const { toast } = optionsRef.current;
    try {
      const result = await archiveSessionApi(file);
      setOpenTabFiles((prev) => prev.filter((f) => f !== file));
      await refreshSessions();
      await refreshArchived();
      setProjects(await listProjects());
      if (result.activeFile && result.activeFile !== optionsRef.current.activeSessionFile) {
        optionsRef.current.send({ type: "switch_session", file: result.activeFile });
      }
      toast("ok", "对话已归档");
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }, [refreshArchived, refreshSessions]);

  const handleRestoreArchived = useCallback(async (file: string) => {
    const { toast } = optionsRef.current;
    try {
      await restoreSessionApi(file);
      await refreshArchived();
      await refreshSessions();
      setProjects(await listProjects());
      toast("ok", "对话已还原");
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }, [refreshArchived, refreshSessions]);

  const handleDeleteArchived = useCallback(async (file: string) => {
    const { toast } = optionsRef.current;
    try {
      const result = await deleteArchivedSessionApi(file);
      await refreshArchived();
      await refreshSessions();
      setProjects(await listProjects());
      if (result.activeFile && result.activeFile !== optionsRef.current.activeSessionFile) {
        optionsRef.current.send({ type: "switch_session", file: result.activeFile });
      }
      toast("ok", "已删除归档对话");
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }, [refreshArchived, refreshSessions]);

  const assignSession = useCallback(async (file: string, projectId: string | null) => {
    const { toast } = optionsRef.current;
    try {
      if (projectId) await assignSessionToProject(projectId, file);
      else {
        const current = sessions.find((session) => session.file === file);
        if (current?.projectId) await removeSessionFromProject(current.projectId, file);
      }
      setSessions(await listSessions());
      setProjects(await listProjects());
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }, [sessions]);

  const newProjectSession = useCallback((projectId: string) => {
    optionsRef.current.send({ type: "new_session", projectId });
  }, []);

  const deleteProject = useCallback(async (projectId: string) => {
    const { toast } = optionsRef.current;
    try {
      await removeProject(projectId);
      setProjects(await listProjects());
      await refreshSessions();
      toast("ok", "项目已删除");
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }, [refreshSessions]);

  const archiveProject = useCallback(async (projectId: string) => {
    const { toast } = optionsRef.current;
    try {
      await archiveProjectApi(projectId);
      setProjects(await listProjects());
      await refreshSessions();
      toast("ok", "项目已归档");
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }, [refreshSessions]);

  const restoreProject = useCallback(async (projectId: string) => {
    const { toast } = optionsRef.current;
    try {
      await restoreProjectApi(projectId);
      setProjects(await listProjects());
      await refreshSessions();
      toast("ok", "项目已还原");
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }, [refreshSessions]);

  const switchSession = useCallback((file: string) => {
    optionsRef.current.send({ type: "switch_session", file });
    setOpenTabFiles((prev) => (prev.includes(file) ? prev : [...prev, file]));
    optionsRef.current.closePanel();
  }, []);

  const newSession = useCallback(() => {
    optionsRef.current.send({ type: "new_session" });
  }, []);

  const closeTab = useCallback(
    (file: string) => {
      const next = openTabFiles.filter((f) => f !== file);
      setOpenTabFiles(next);
      if (optionsRef.current.activeSessionFile !== file) return;
      const fallback = next[0] ?? sessions.find((s) => s.file !== file)?.file;
      if (fallback) switchSession(fallback);
      else newSession();
    },
    [openTabFiles, sessions, switchSession, newSession],
  );

  const switchWorkspace = useCallback((path: string) => {
    optionsRef.current.send({ type: "switch_workspace", path });
    optionsRef.current.closePanel();
  }, []);

  const addWorkspace = useCallback((path: string) => {
    optionsRef.current.send({ type: "add_workspace", path });
  }, []);

  return {
    sessions,
    setSessions,
    archivedSessions,
    setArchivedSessions,
    projects,
    setProjects,
    workspaces,
    setWorkspaces,
    openTabFiles,
    setOpenTabFiles,
    refreshSessions,
    refreshArchived,
    handleDeleteSession,
    handleArchiveSession,
    handleRestoreArchived,
    handleDeleteArchived,
    assignSession,
    newProjectSession,
    deleteProject,
    archiveProject,
    restoreProject,
    switchSession,
    newSession,
    closeTab,
    switchWorkspace,
    addWorkspace,
  };
}
