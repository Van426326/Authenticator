import "mocha";
import { assert } from "chai";

import {
  POPUP_WIDTHS,
  isPopupWidth,
  resolvePopupWidth,
} from "../../models/display";

mocha.setup("bdd");

describe("popup width presets", () => {
  it("accepts only supported widths", () => {
    assert.isTrue(isPopupWidth(POPUP_WIDTHS.narrow));
    assert.isTrue(isPopupWidth(POPUP_WIDTHS.default));
    assert.isTrue(isPopupWidth(POPUP_WIDTHS.wide));
    assert.isFalse(isPopupWidth(320));
  });

  it("migrates legacy zoom values to the nearest preset category", () => {
    assert.equal(resolvePopupWidth(undefined, 80), POPUP_WIDTHS.narrow);
    assert.equal(resolvePopupWidth(undefined, 100), POPUP_WIDTHS.default);
    assert.equal(resolvePopupWidth(undefined, 125), POPUP_WIDTHS.wide);
  });

  it("prefers a valid saved width over legacy zoom", () => {
    assert.equal(
      resolvePopupWidth(POPUP_WIDTHS.wide, 50),
      POPUP_WIDTHS.wide
    );
  });
});
