import "mocha";
import { assert } from "chai";
import * as sinon from "sinon";

import { OTPType } from "../../models/otp";
import { UserSettings } from "../../models/settings";
import { reorderEntries, updateCodes } from "../../store/Accounts";

mocha.setup("bdd");

describe("Accounts.updateCodes", () => {
  function createEntry(type = OTPType.totp) {
    return ({
      type,
      period: 30,
      secret: "test-secret",
      generate: sinon.fake(),
    } as unknown) as OTPEntryInterface;
  }

  function createState(entry: OTPEntryInterface) {
    return {
      entries: [entry],
      sectorStart: false,
      sectorOffset: 0,
      second: 0,
    } as AccountsState;
  }

  beforeEach(() => {
    UserSettings.items.offset = 0;
  });

  it("generates a TOTP only once within the same time step", () => {
    const clock = sinon.useFakeTimers(
      new Date("2024-01-01T00:00:01.000Z").getTime()
    );
    const entry = createEntry();
    const state = createState(entry);

    updateCodes(state);
    clock.tick(20_000);
    updateCodes(state);

    assert.equal((entry.generate as sinon.SinonSpy).callCount, 1);
  });

  it("generates a new TOTP when the time step changes", () => {
    const clock = sinon.useFakeTimers(
      new Date("2024-01-01T00:00:01.000Z").getTime()
    );
    const entry = createEntry();
    const state = createState(entry);

    updateCodes(state);
    clock.tick(30_000);
    updateCodes(state);

    assert.equal((entry.generate as sinon.SinonSpy).callCount, 2);
  });

  it("does not automatically generate counter-based codes", () => {
    sinon.useFakeTimers(new Date("2024-01-01T00:00:01.000Z").getTime());
    const entry = createEntry(OTPType.hotp);

    updateCodes(createState(entry));

    assert.equal((entry.generate as sinon.SinonSpy).callCount, 0);
  });
});

describe("Accounts.reorderEntries", () => {
  const createEntry = (hash: string, index: number) =>
    ({ hash, index } as OTPEntryInterface);

  it("reorders entries by hash and updates their indexes", () => {
    const first = createEntry("first", 0);
    const second = createEntry("second", 1);
    const third = createEntry("third", 2);

    const result = reorderEntries(
      [first, second, third],
      ["third", "first", "second"]
    );

    assert.deepEqual(result, [third, first, second]);
    assert.deepEqual(
      result?.map((entry) => entry.index),
      [0, 1, 2]
    );
  });

  it("rejects incomplete, duplicate, or unknown hashes", () => {
    const entries = [createEntry("first", 0), createEntry("second", 1)];

    assert.isNull(reorderEntries(entries, ["first"]));
    assert.isNull(reorderEntries(entries, ["first", "first"]));
    assert.isNull(reorderEntries(entries, ["first", "unknown"]));
  });
});
