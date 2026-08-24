const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(value: Uint8Array) {
  let result = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index];
    const second = value[index + 1];
    const third = value[index + 2];
    const chunk =
      (first << 16) |
      ((second === undefined ? 0 : second) << 8) |
      (third === undefined ? 0 : third);
    result += ALPHABET[(chunk >>> 18) & 63];
    result += ALPHABET[(chunk >>> 12) & 63];
    result += second === undefined ? "=" : ALPHABET[(chunk >>> 6) & 63];
    result += third === undefined ? "=" : ALPHABET[chunk & 63];
  }
  return result;
}

export function decodeBase64(value: string, name = "Value") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error(`${name} is not valid base64`);
  }

  let padding = 0;
  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }
  const result = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = ALPHABET.indexOf(value[index]);
    const second = ALPHABET.indexOf(value[index + 1]);
    const third =
      value[index + 2] === "=" ? 0 : ALPHABET.indexOf(value[index + 2]);
    const fourth =
      value[index + 3] === "=" ? 0 : ALPHABET.indexOf(value[index + 3]);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      throw new Error(`${name} is not valid base64`);
    }
    const chunk = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < result.length) {
      result[outputIndex] = (chunk >>> 16) & 255;
      outputIndex += 1;
    }
    if (outputIndex < result.length) {
      result[outputIndex] = (chunk >>> 8) & 255;
      outputIndex += 1;
    }
    if (outputIndex < result.length) {
      result[outputIndex] = chunk & 255;
      outputIndex += 1;
    }
  }

  if (encodeBase64(result) !== value) {
    throw new Error(`${name} is not canonical base64`);
  }
  return result;
}
