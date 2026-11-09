import { studentGet } from "./auth.js";
import { normalizeDate } from "./courses.js";
import { SafeError } from "./errors.js";
import { requireId } from "./student-reads.js";

const MALFORMED = "Artemis returned a response that does not match the student read shape.";

export async function listResults(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/course/courses/${id}/exercises-for-overview`, fetchImpl, nowMs);
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.exercises)) {
    throw new SafeError("malformed", MALFORMED);
  }
  const results = [];
  for (const exercise of payload.exercises) {
    if (!exercise || typeof exercise.id !== "number") {
      continue;
    }
    for (const participation of exercise.studentParticipations ?? []) {
      if (!participation || typeof participation.id !== "number") {
        continue;
      }
      for (const submission of participation.submissions ?? []) {
        for (const result of submission?.results ?? []) {
          if (!result || result.completionDate == null) {
            continue;
          }
          results.push({
            exerciseId: exercise.id,
            participationId: participation.id,
            resultId: requirePayloadId(result.id),
            completionDate: normalizeDate(result.completionDate),
            score: typeof result.score === "number" ? result.score : null,
            rated: result.rated === true,
            successful: result.successful === true,
          });
        }
      }
    }
  }
  return results;
}

export async function getFeedback(env, participationId, resultId, fetchImpl, nowMs = Date.now()) {
  const participation = requireId(participationId);
  const result = requireId(resultId);
  const payload = await studentGet(
    env,
    `/api/assessment/participations/${participation}/results/${result}/details`,
    fetchImpl,
    nowMs,
  );
  if (!Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return payload
    .filter((item) => item && item.visibility !== "NEVER")
    .slice(0, 100)
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : null,
      text: bound(item.text),
      detailText: bound(item.detailText),
      credits: typeof item.credits === "number" ? item.credits : null,
      positive: item.positive === true,
    }));
}

function requirePayloadId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SafeError("malformed", MALFORMED);
  }
  return value;
}

function bound(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.slice(0, 8_000);
}
