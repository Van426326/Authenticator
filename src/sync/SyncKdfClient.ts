import { decodeBase64 } from "./Base64";
import { Argon2idKdfConfig, validateKdfConfig } from "./SyncCrypto";

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_PASSWORD_LENGTH = 1024;

export interface SandboxMessageHost {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
}

export interface SandboxMessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface DeriveResponse {
  requestId: string;
  ok: boolean;
  key?: string;
}

function isDeriveResponse(value: unknown): value is DeriveResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const response = value as Record<string, unknown>;
  return (
    typeof response.requestId === "string" &&
    typeof response.ok === "boolean" &&
    (response.key === undefined || typeof response.key === "string")
  );
}

export class SyncKdfClient {
  constructor(
    private readonly host: SandboxMessageHost,
    private readonly sandbox: SandboxMessageTarget,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Argon2 sandbox timeout is invalid");
    }
  }

  deriveKey(password: string, kdf: Argon2idKdfConfig) {
    if (
      typeof password !== "string" ||
      password.length === 0 ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      return Promise.reject(new Error("Sync password is invalid"));
    }
    try {
      validateKdfConfig(kdf);
    } catch (error) {
      return Promise.reject(error);
    }

    const requestId = crypto.randomUUID();
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.host.removeEventListener("message", listener);
        clearTimeout(timeout);
      };
      const finish = (operation: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        operation();
      };
      const listener = (event: MessageEvent) => {
        if (
          event.source !== ((this.sandbox as unknown) as MessageEventSource) ||
          !isDeriveResponse(event.data) ||
          event.data.requestId !== requestId
        ) {
          return;
        }
        if (!event.data.ok || !event.data.key) {
          finish(() => reject(new Error("Argon2 key derivation failed")));
          return;
        }
        try {
          const key = decodeBase64(event.data.key, "Derived Argon2 key");
          if (key.byteLength !== 32) {
            throw new Error("Derived Argon2 key must contain 32 bytes");
          }
          finish(() => resolve(key));
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const timeout = setTimeout(
        () => finish(() => reject(new Error("Argon2 sandbox timed out"))),
        this.timeoutMs
      );
      this.host.addEventListener("message", listener);
      try {
        this.sandbox.postMessage(
          {
            action: "derive-sync-key",
            requestId,
            password,
            kdf,
          },
          "*"
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }
}

export function createSyncKdfClient() {
  const iframe = document.querySelector("#argon-sandbox");
  if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow) {
    throw new Error("Argon2 sandbox is unavailable");
  }
  return new SyncKdfClient(window, iframe.contentWindow);
}
