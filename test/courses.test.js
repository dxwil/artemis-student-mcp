import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDashboard } from "../src/courses.js";
import { SafeError } from "../src/errors.js";
import { dashboardBody } from "./support.js";

test("normalizes the student dashboard and drops grades, exams, and descriptions", () => {
  const courses = normalizeDashboard(dashboardBody());
  assert.deepEqual(courses, [
    {
      id: 3,
      title: "Discrete Structures",
      shortName: "ds",
      startDate: null,
      endDate: "2027-02-01T00:00:00Z",
    },
    {
      id: 7,
      title: "Introduction to Informatics",
      shortName: "info1",
      startDate: "2026-10-01T00:00:00+02:00",
      endDate: null,
    },
  ]);
  const encoded = JSON.stringify(courses);
  assert.equal(encoded.includes("GRADE_MARKER_125"), false);
  assert.equal(encoded.includes("EXERCISE_MARKER"), false);
  assert.equal(encoded.includes("EXAM_MARKER"), false);
  assert.equal(encoded.includes("DESCRIPTION_MARKER"), false);
});

test("treats an omitted date as null and rejects a malformed date or missing short name", () => {
  const courses = normalizeDashboard({
    courses: [{ course: { id: 1, title: "Algorithms", shortName: "algo" } }],
  });
  assert.equal(courses[0].startDate, null);
  assert.equal(courses[0].endDate, null);
  assert.throws(
    () => normalizeDashboard({ courses: [{ course: { id: 1, title: "Algorithms", shortName: "algo", endDate: "tomorrow" } }] }),
    (error) => error instanceof SafeError && error.code === "malformed",
  );
  assert.throws(
    () => normalizeDashboard({ courses: [{ course: { id: 1, title: "Algorithms" } }] }),
    (error) => error instanceof SafeError && error.code === "malformed",
  );
});
