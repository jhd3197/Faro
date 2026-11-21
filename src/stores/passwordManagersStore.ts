import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import type { AgentInfo, PasswordManagerId, PmStatus } from "@/lib/types";

// 1Password / Bitwarden state and the SSH agents found on this machine
// (Plan 33). Shared by Settings › Password managers, the profile editor and
// the vault picker, so an unlock in one shows up in the others.
interface PasswordManagersState {
  status: PmStatus[];
  agents: AgentInfo[];
  loaded: boolean;
  refresh: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  /** Rejects with the backend's plain message. */
  unlock: (provider: PasswordManagerId, password: string) => Promise<void>;
  /** 1Password without the app: add the account to the CLI and sign in. */
  addOpAccount: (address: string, email: string, secretKey: string, password: string) => Promise<void>;
  lock: (provider: PasswordManagerId) => Promise<void>;
}

export const usePasswordManagers = create<PasswordManagersState>((set, get) => ({
  status: [],
  agents: [],
  loaded: false,

  refresh: async () => {
    try {
      set({ status: await ipc.passwordManagersStatus(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  refreshAgents: async () => {
    try {
      set({ agents: await ipc.sshAgents() });
    } catch {
      /* no agent info: the select just shows no found/not running */
    }
  },

  addOpAccount: async (address, email, secretKey, password) => {
    try {
      await ipc.passwordManagerOpAddAccount(address, email, secretKey, password);
    } finally {
      await get().refresh();
    }
  },

  unlock: async (provider, password) => {
    try {
      await ipc.passwordManagerUnlock(provider, password);
    } finally {
      await get().refresh();
    }
  },

  lock: async (provider) => {
    try {
      await ipc.passwordManagerLock(provider);
    } finally {
      await get().refresh();
    }
  },
}));

export const PM_NAMES: Record<PasswordManagerId, string> = {
  "1password": "1Password",
  bitwarden: "Bitwarden",
};

export function isPasswordManager(id: string): id is PasswordManagerId {
  return id === "1password" || id === "bitwarden";
}
