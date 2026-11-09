import assert from "node:assert/strict";
import test from "node:test";
import { SafeError } from "../src/errors.js";
import { fileReferences, normalizeStudentFilePath } from "../src/files.js";

const ORIGIN = "https://artemis.test";
const PDF = "/api/core/files/courses/585/conversations/32119/FoP-SES01-Time-Allocation.pdf";

test("file paths normalize from a URL, an absolute path, and a relative path", () => {
  const absolute = normalizeStudentFilePath(PDF, ORIGIN);
  const url = normalizeStudentFilePath(`${ORIGIN}${PDF}?version=3#page=2`, ORIGIN);
  const relative = normalizeStudentFilePath("courses/585/conversations/32119/FoP-SES01-Time-Allocation.pdf", ORIGIN);
  const prefixed = normalizeStudentFilePath("api/core/files/courses/585/conversations/32119/FoP-SES01-Time-Allocation.pdf", ORIGIN);
  assert.equal(absolute.path, PDF);
  assert.equal(url.path, PDF);
  assert.equal(relative.path, PDF);
  assert.equal(prefixed.path, PDF);
  assert.equal(absolute.filename, "FoP-SES01-Time-Allocation.pdf");
});

test("student file prefixes are allowed and other paths are refused", () => {
  const allowed = [
    "attachments/lectures/4/syllabus.pdf",
    "attachments/attachment-video-units/12/student/slides.pdf",
    "attachments/attachment-video-units/12/slide/3",
    "slides/7",
    "courses/7/icons/icon.png",
    "markdown/diagram.png",
    "drag-and-drop/questions/5/backgrounds/board.png",
    "drag-and-drop/questions/5/drag-items/2/pic.png",
    "file-upload-exercises/123/submissions/456/answer.pdf",
  ];
  for (const reference of allowed) {
    assert.equal(normalizeStudentFilePath(reference, ORIGIN).path, `/api/core/files/${reference}`);
  }
  const refused = [
    "https://other.test/api/core/files/markdown/a.png",
    "https://user:secret@artemis.test/api/core/files/markdown/a.png",
    "/api/core/public/account",
    "/api/core/files/attachments/attachment-video-units/12/slides.pdf",
    "/api/core/files/../secret.pdf",
    "/api/core/files/%2e%2e/secret.pdf",
    "/api/core/files/%252e%252e/secret.pdf",
    "courses/585/conversations/32119/../../secret.pdf",
    "users/1/profile-pictures/avatar.png",
    "exam-users/4/signatures/sign.png",
  ];
  for (const reference of refused) {
    assert.throws(
      () => normalizeStudentFilePath(reference, ORIGIN),
      (error) => error instanceof SafeError && error.code === "invalid_arguments",
      reference,
    );
  }
});

test("message markdown keeps only student file links", () => {
  const content = [
    "See [Time allocation](/api/core/files/courses/585/conversations/32119/FoP-SES01-Time-Allocation.pdf)",
    "and [slides](attachments/attachment-video-units/12/student/slides.pdf).",
    "Skip [elsewhere](https://other.test/api/core/files/markdown/a.png)",
    "and [tutor](/api/core/files/attachments/attachment-video-units/12/slides.pdf).",
  ].join(" ");
  assert.deepEqual(fileReferences(content, ORIGIN), [
    { name: "Time allocation", path: PDF },
    { name: "slides", path: "/api/core/files/attachments/attachment-video-units/12/student/slides.pdf" },
  ]);
});
