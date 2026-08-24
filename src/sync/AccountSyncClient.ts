import { SyncMutationCommand } from "./SyncMutationFactory";

interface MutationResponse {
  handled: boolean;
}

function isMutationResponse(value: unknown): value is MutationResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      "handled" in value &&
      typeof value.handled === "boolean"
  );
}

export interface AccountMutationSender {
  send(message: unknown): Promise<unknown>;
}

const chromeMutationSender: AccountMutationSender = {
  send: (message) => chrome.runtime.sendMessage(message),
};

export async function persistAccountMutation(
  command: SyncMutationCommand,
  persistWithoutSync: () => Promise<void>,
  sender: AccountMutationSender = chromeMutationSender
) {
  const response: unknown = await sender.send({
    action: "githubAccountMutation",
    command,
  });
  if (!isMutationResponse(response)) {
    throw new Error("Background returned an invalid account mutation response");
  }
  if (response.handled) {
    return;
  }
  await persistWithoutSync();
}
