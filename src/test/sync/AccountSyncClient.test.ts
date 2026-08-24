import { assert } from "chai";
import {
  AccountMutationSender,
  persistAccountMutation,
} from "../../sync/AccountSyncClient";

mocha.setup("bdd");

const command = {
  entityType: "otp" as const,
  entityId: "account-1",
  kind: "delete" as const,
  logicalPayload: null,
};

describe("persistAccountMutation", () => {
  it("does not perform a second local write when background handled the mutation", async () => {
    let fallbackCalls = 0;
    const sender: AccountMutationSender = {
      async send() {
        return { handled: true };
      },
    };

    await persistAccountMutation(
      command,
      async () => {
        fallbackCalls += 1;
      },
      sender,
    );

    assert.equal(fallbackCalls, 0);
  });

  it("uses ordinary persistence only when synchronization is unconfigured", async () => {
    let fallbackCalls = 0;
    const sender: AccountMutationSender = {
      async send() {
        return { handled: false };
      },
    };

    await persistAccountMutation(
      command,
      async () => {
        fallbackCalls += 1;
      },
      sender,
    );

    assert.equal(fallbackCalls, 1);
  });

  it("fails closed instead of bypassing a malformed background response", async () => {
    let fallbackCalls = 0;
    const sender: AccountMutationSender = {
      async send() {
        return undefined;
      },
    };

    let error: unknown;
    try {
      await persistAccountMutation(
        command,
        async () => {
          fallbackCalls += 1;
        },
        sender,
      );
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, Error);
    assert.equal(fallbackCalls, 0);
  });
});
