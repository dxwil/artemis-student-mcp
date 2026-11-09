import { studentGet } from "./auth.js";
import { SafeError } from "./errors.js";

const MALFORMED = "Artemis returned a response that does not match the student account shape.";

export async function getAccount(env, fetchImpl, nowMs = Date.now()) {
  const payload = await studentGet(env, "/api/core/public/account", fetchImpl, nowMs);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  const firstName = optionalText(payload.firstName);
  const lastName = optionalText(payload.lastName);
  const givenName = optionalText(payload.name);
  return {
    login: requiredText(payload.login),
    firstName,
    lastName,
    name: givenName ?? joinName(firstName, lastName),
    email: optionalText(payload.email),
    registrationNumber: optionalText(payload.visibleRegistrationNumber) ?? optionalText(payload.registrationNumber),
    language: optionalText(payload.langKey),
    groups: stringList(payload.groups),
    courseRoles: courseRoles(payload.courseRoles),
  };
}

function requiredText(value) {
  const text = optionalText(value);
  if (text == null) {
    throw new SafeError("malformed", MALFORMED);
  }
  return text;
}

function optionalText(value) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SafeError("malformed", MALFORMED);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 200);
}

function joinName(firstName, lastName) {
  const name = [firstName, lastName].filter((part) => part != null).join(" ");
  return name === "" ? null : name;
}

function stringList(value) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return value
    .filter((entry) => typeof entry === "string" && entry.trim() !== "")
    .slice(0, 50)
    .map((entry) => entry.trim().slice(0, 100));
}

function courseRoles(value) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return value.slice(0, 50).map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.courseId !== "number" || !Number.isSafeInteger(entry.courseId)) {
      throw new SafeError("malformed", MALFORMED);
    }
    return { courseId: entry.courseId, roles: stringList(entry.roles ?? []) };
  });
}
