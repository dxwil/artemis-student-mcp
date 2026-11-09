import { SafeError } from "./errors.js";

const LOGIN_PATTERN = /^[_'.@A-Za-z0-9-]+$/;
const USERNAME_MIN = 4;
const USERNAME_MAX = 50;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 100;
const PASSWORD_MAX_BYTES = 72;

export function normalizeUsername(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export function assertUsernameFormat(username) {
  if (
    username.length < USERNAME_MIN ||
    username.length > USERNAME_MAX ||
    !LOGIN_PATTERN.test(username)
  ) {
    throw new SafeError(
      "invalid_username",
      "The username was not sent because it does not match the Artemis login format.",
    );
  }
}

export function assertPasswordLength(password) {
  const bytes = Buffer.byteLength(password, "utf8");
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX || bytes > PASSWORD_MAX_BYTES) {
    throw new SafeError(
      "invalid_password",
      "The password was not sent because it does not meet the Artemis length limits.",
    );
  }
}
