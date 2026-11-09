import fs from "node:fs";
import { dashboardBody } from "./support.js";

export function installMock(scenario, env) {
  const trace = [];
  const flush = () => {
    if (env.ARTEMIS_MOCK_TRACE) {
      fs.writeFileSync(env.ARTEMIS_MOCK_TRACE, JSON.stringify(trace));
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    let hasPassword = false;
    if (init.body) {
      try {
        hasPassword = Object.prototype.hasOwnProperty.call(JSON.parse(init.body), "password");
      } catch {
        hasPassword = false;
      }
    }
    trace.push({
      method: init.method ?? "GET",
      origin: parsed.origin,
      path: parsed.pathname,
      hasAuthorization: Boolean(init.headers?.Authorization),
      hasPassword,
      hasUserAgent: Boolean(init.headers?.["User-Agent"]),
    });
    flush();
    return respond(scenario, parsed, init, env);
  };
  process.on("exit", flush);
}

function respond(scenario, url, init, env) {
  if (url.pathname === "/management/info") {
    const directory = scenario === "directory-password";
    return Response.json({
      activeModuleFeatures: directory ? ["ldap", "passkey"] : ["passkey"],
      oidc: { buttonLabel: "TUM Login" },
      accountName: directory ? "TUM" : "Example",
      internalNote: "INFO_SECRET_MARKER",
    });
  }
  if (url.pathname === "/api/core/public/login-options") {
    if (scenario === "directory-password" || scenario === "sso-oidc") {
      return Response.json({ loginMethod: "OIDC", idpName: "TUM Login" });
    }
    return Response.json({ loginMethod: "PASSWORD", idpName: null });
  }
  if (url.pathname === "/api/core/public/authenticate") {
    if (scenario === "wrong-password") {
      return new Response(null, { status: 401 });
    }
    return Response.json({ access_token: env.ARTEMIS_SESSION_TOKEN });
  }
  if (url.pathname === "/api/core/public/logout") {
    return new Response(null, { status: 200 });
  }
  if (scenario === "student-content" && url.pathname === "/api/exercise/exercises/3") {
    return Response.json({
      id: 3,
      type: "text",
      title: "Essay",
      visibleToStudents: true,
      releaseDate: "2020-01-01T00:00:00Z",
      dueDate: "2020-02-01T00:00:00Z",
      problemStatement: "Write an essay",
      exampleSolution: "SECRET_SOLUTION",
      course: { id: 7 },
    });
  }
  if (scenario === "student-content" && url.pathname === "/api/lecture/courses/7/lectures-for-overview") {
    return Response.json([{ id: 4, title: "Week 1", startDate: "2020-04-01T00:00:00Z", endDate: null, isTutorialLecture: false }]);
  }
  if (scenario === "student-content" && url.pathname === "/api/lecture/lectures/4/details") {
    return Response.json({
      id: 4,
      title: "Week 1",
      course: { id: 7 },
      lectureUnits: [
        {
          id: 1,
          type: "attachment",
          name: "Slides",
          visibleToStudents: true,
          releaseDate: "2020-04-01T00:00:00Z",
          attachment: {
            id: 21,
            name: "Slides",
            link: "attachments/attachment-video-units/1/slides.pdf",
            attachmentType: "FILE",
            version: 1,
            studentVersion: "attachments/attachment-video-units/1/student/slides.pdf",
          },
        },
        { id: 2, type: "attachment", name: "Draft", visibleToStudents: false, attachment: { id: 22, name: "Draft", link: "attachments/attachment-video-units/2/draft.pdf" } },
      ],
    });
  }
  if (scenario === "student-content" && url.pathname === "/api/course/courses/7/exercises-for-overview") {
    return Response.json({
      exercises: [
        {
          id: 3,
          type: "TEXT",
          title: "Essay",
          releaseDate: "2020-01-01T00:00:00Z",
          dueDate: "2020-02-01T00:00:00Z",
          exampleSolution: "SECRET_SOLUTION",
          studentParticipations: [
            {
              id: 11,
              repositoryUri: "https://git.example/secret",
              submissions: [
                { results: [{ id: 12, completionDate: "2020-03-01T00:00:00Z", score: 80, rated: true, successful: true }] },
                { results: [{ id: 13, completionDate: null, score: 0 }] },
              ],
            },
          ],
        },
      ],
      totalScores: { relativeScore: "GRADE_MARKER" },
    });
  }
  if (scenario === "student-content" && url.pathname === "/api/assessment/participations/11/results/12/details") {
    return Response.json([{ id: 1, text: "Looks good", visibility: "AFTER_DUE_DATE", gradingInstruction: "SECRET" }]);
  }
  if (scenario === "student-content" && url.pathname === "/api/communication/courses/7/channels/overview") {
    return Response.json([{ id: 9, isAnnouncementChannel: true, title: "Announcements" }]);
  }
  if (scenario === "student-content" && url.pathname === "/api/communication/courses/7/messages") {
    return Response.json([
      { id: 1, content: "Hello class", creationDate: "2020-01-02T00:00:00Z", author: { name: "Ada", login: "student1" }, visibleForStudents: true, answers: [] },
      { id: 2, content: "hidden-text", visibleForStudents: false, author: { name: "Ada", login: "student1" } },
    ]);
  }
  if (scenario === "student-content" && url.pathname === "/api/communication/courses/7/conversations") {
    return Response.json([{ id: 9, type: "channel", title: "General", members: [{ login: "student1", email: "ada@example.edu" }] }]);
  }
  if (scenario === "student-content" && url.pathname === "/api/calendar/courses/7/calendar-events") {
    return Response.json({ "2026-11-09": [{ type: "LECTURE", title: "Week", startDate: "2026-11-09T10:00:00Z", location: "Room 1" }] });
  }
  if (scenario === "student-content" && url.pathname === "/api/exam/courses/7/exams-for-overview") {
    return Response.json([{ id: 5, title: "Final", visibleDate: "2020-01-01T00:00:00Z", startDate: "2020-02-01T00:00:00Z", endDate: "2020-02-01T02:00:00Z", workingTime: 7200, examMaxPoints: 40, testExam: false }]);
  }
  if (scenario === "student-content" && url.pathname === "/api/exam/courses/7/exams/5/student-exams/6/grade-summary") {
    return Response.json({ grade: "2.0", studentResult: { score: 80, otherStudents: [{ email: "other@example.edu" }] } });
  }
  if (scenario === "student-content" && url.pathname === "/api/core/files/attachments/attachment-video-units/1/student/slides.pdf") {
    return new Response(Buffer.from("pdf-bytes"));
  }
  if (scenario === "student-content" && url.pathname === "/api/tutorialgroup/courses/7/tutorial-groups") {
    return Response.json([{ id: 8, title: "Group A", campus: "Garching", language: "EN", isOnline: false, isUserRegistered: true, teachingAssistantName: "Tutor", teachingAssistantId: 99 }]);
  }
  if (scenario === "student-content" && url.pathname === "/api/atlas/courses/7/competencies") {
    return Response.json([{ id: 2, title: "Loops", description: "Repeat", taxonomy: "APPLY", masteryThreshold: 70, optional: false, userProgress: [{ progress: 40, confidence: 0.5 }] }]);
  }
  if (scenario === "student-content" && url.pathname === "/api/atlas/courses/7/learning-path/me") {
    return Response.json({ id: 15, startedByStudent: true, progress: 40 });
  }
  if (scenario === "student-content" && url.pathname === "/api/communication/courses/7/faqs") {
    return Response.json([
      { id: 1, questionTitle: "When?", questionAnswer: "Monday", faqState: "ACCEPTED" },
      { id: 2, questionTitle: "Draft", questionAnswer: "secret-faq", faqState: "PROPOSED" },
    ]);
  }
  if (scenario === "student-content" && url.pathname === "/api/notification/courses/7") {
    return Response.json({ content: [{ notificationId: 5, notificationType: "NEW_ANNOUNCEMENT", category: "GENERAL", creationDate: "2026-01-01T00:00:00Z", status: "UNSEEN" }] });
  }
  if (url.pathname === "/api/course/courses/for-dashboard") {
    if (scenario === "forbidden") {
      return new Response(null, { status: 403 });
    }
    if (scenario === "malformed") {
      return Response.json({ courses: [{ course: { id: 4, title: "Incomplete" } }] });
    }
    if (scenario === "redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://off-origin.test/collect?code=LEAKMARKER" },
      });
    }
    return Response.json(dashboardBody());
  }
  return new Response(null, { status: 404 });
}
