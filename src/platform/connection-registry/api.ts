import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type {
  Connection,
  ConnectionGroup,
  ConnectionGroupInput,
  ConnectionGroupUpdate,
  ConnectionInput,
  ConnectionMove,
  ConnectionUpdate,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const connectionsApi = {
  list: () => call<Connection[]>("connections_list"),
  create: (input: ConnectionInput) => call<Connection>("connections_create", { input }),
  update: (id: string, update: ConnectionUpdate) =>
    call<Connection>("connections_update", { id, update }),
  move: (id: string, move: ConnectionMove) =>
    call<Connection>("connections_move", { id, move }),
  delete: (id: string) => call<void>("connections_delete", { id }),
  getSecret: (id: string) => call<string | null>("connections_get_secret", { id }),
};

export const connectionGroupsApi = {
  list: () => call<ConnectionGroup[]>("connection_groups_list"),
  create: (input: ConnectionGroupInput) =>
    call<ConnectionGroup>("connection_groups_create", { input }),
  update: (id: string, update: ConnectionGroupUpdate) =>
    call<ConnectionGroup>("connection_groups_update", { id, update }),
  delete: (id: string) => call<void>("connection_groups_delete", { id }),
};
