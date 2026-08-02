export interface ConnectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SavedBackendConnection {
  version: 1;
  baseUrl: string;
  token: string;
  connectionId: string;
  requestId: string | null;
  verificationCode: string | null;
  deviceName: string | null;
}

interface PersistedConnections {
  version: 1;
  activeUrl: string | null;
  connections: Record<string, SavedBackendConnection>;
}

const STORAGE_KEY = "nnm.training.connections";

export function normalizeBackendUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Inserisci l'URL del backend");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("L'URL del backend deve essere assoluto");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Il backend deve usare HTTP o HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("L'URL del backend non può contenere credenziali, query o frammenti");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

export function loadBackendConnection(storage: ConnectionStorage = browserStorage()): SavedBackendConnection | null {
  const state = readState(storage);
  if (!state.activeUrl) return null;
  return state.connections[state.activeUrl] ?? null;
}

/**
 * Return the saved backend connection whose origin matches ``origin``,
 * regardless of which connection is currently active.
 *
 * The Training Sidebar stores every paired backend keyed by its base URL, so
 * the project workspace can reuse the established companion pairing without
 * creating a second token store. Callers must never fall back to the active
 * (possibly remote) connection when no connection matches: sending a remote
 * training bearer token to the local companion would leak credentials.
 */
export function loadBackendConnectionByOrigin(
  origin: string,
  storage: ConnectionStorage = browserStorage(),
): SavedBackendConnection | null {
  const state = readState(storage);
  const expected = normalizeOriginForComparison(origin);
  for (const connection of Object.values(state.connections)) {
    try {
      if (normalizeOriginForComparison(connection.baseUrl) === expected) {
        return connection;
      }
    } catch {
      // Malformed baseUrl entries are skipped; the storage parser already
      // requires a string, but an unparseable URL must not abort the lookup.
      continue;
    }
  }
  return null;
}

/**
 * Normalize an origin for comparison: lowercase, trailing slashes stripped,
 * and loopback host aliases (``localhost``, ``127.0.0.1``, ``[::1]``) mapped
 * to ``127.0.0.1`` so a local companion is recognized regardless of how the
 * user typed its URL in the Training Sidebar.
 */
export function normalizeOriginForComparison(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]") {
      url.hostname = "127.0.0.1";
    }
    return `${url.protocol}//${url.host}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return origin.replace(/\/+$/, "").toLowerCase();
  }
}

export function saveBackendConnection(
  connection: SavedBackendConnection,
  storage: ConnectionStorage = browserStorage(),
): void {
  const state = readState(storage);
  state.connections[connection.baseUrl] = connection;
  state.activeUrl = connection.baseUrl;
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function forgetBackendConnection(
  baseUrl: string,
  storage: ConnectionStorage = browserStorage(),
): void {
  const state = readState(storage);
  delete state.connections[baseUrl];
  if (state.activeUrl === baseUrl) {
    state.activeUrl = Object.keys(state.connections).at(-1) ?? null;
  }
  if (Object.keys(state.connections).length === 0) {
    storage.removeItem(STORAGE_KEY);
  } else {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

function readState(storage: ConnectionStorage): PersistedConnections {
  const empty: PersistedConnections = { version: 1, activeUrl: null, connections: {} };
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedConnections>;
    if (parsed.version !== 1 || typeof parsed.connections !== "object" || parsed.connections === null) {
      return empty;
    }
    const connections = Object.fromEntries(
      Object.entries(parsed.connections).filter((entry): entry is [string, SavedBackendConnection] => {
        const value = entry[1] as Partial<SavedBackendConnection>;
        return value.version === 1 && typeof value.baseUrl === "string" && typeof value.token === "string";
      }),
    );
    return {
      version: 1,
      activeUrl: typeof parsed.activeUrl === "string" ? parsed.activeUrl : null,
      connections,
    };
  } catch {
    return empty;
  }
}

function browserStorage(): ConnectionStorage {
  if (!("localStorage" in globalThis)) {
    throw new Error("localStorage non è disponibile");
  }
  return globalThis.localStorage;
}
