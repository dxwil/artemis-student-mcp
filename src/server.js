import { pathToFileURL } from "node:url";
import { listCourses } from "./auth.js";
import { createMcpHandler, parseRpcLine } from "./mcp.js";
import { listAnnouncements } from "./announcements.js";
import { getFeedback, listResults } from "./results.js";
import { listConversations, listMessages } from "./conversations.js";
import { getLearningPath, listCompetencies, listFaqs, listNotifications, listTutorialGroups } from "./course-info.js";
import { downloadAttachment } from "./downloads.js";
import { getExamResult, listCalendar, listExams } from "./schedule.js";
import { markConversationRead, markNotificationsRead } from "./mark-read.js";
import { createPost, replyToPost } from "./posting.js";
import { submitFile, submitQuiz, submitText } from "./submissions.js";
import { getExercise, getLecture, listExercises, listLectures } from "./student-reads.js";

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const handle = createMcpHandler({
    listCourses: () => listCourses(env, fetchImpl),
    listExercises: (courseId) => listExercises(env, courseId, fetchImpl),
    getExercise: (exerciseId, courseId) => getExercise(env, exerciseId, courseId, fetchImpl),
    listLectures: (courseId) => listLectures(env, courseId, fetchImpl),
    getLecture: (lectureId, courseId) => getLecture(env, lectureId, courseId, fetchImpl),
    listAnnouncements: (courseId, page) => listAnnouncements(env, courseId, page, fetchImpl),
    listResults: (courseId) => listResults(env, courseId, fetchImpl),
    getFeedback: (participationId, resultId) => getFeedback(env, participationId, resultId, fetchImpl),
    listCalendar: (courseId, month, timeZone) => listCalendar(env, courseId, month, timeZone, fetchImpl),
    listExams: (courseId) => listExams(env, courseId, fetchImpl),
    getExamResult: (courseId, examId, studentExamId) => getExamResult(env, courseId, examId, studentExamId, fetchImpl),
    listConversations: (courseId) => listConversations(env, courseId, fetchImpl),
    listMessages: (courseId, conversationId, page) => listMessages(env, courseId, conversationId, page, fetchImpl),
    downloadAttachment: (lectureId, filePath) => downloadAttachment(env, lectureId, filePath, fetchImpl),
    listTutorialGroups: (courseId) => listTutorialGroups(env, courseId, fetchImpl),
    listCompetencies: (courseId) => listCompetencies(env, courseId, fetchImpl),
    getLearningPath: (courseId) => getLearningPath(env, courseId, fetchImpl),
    listFaqs: (courseId) => listFaqs(env, courseId, fetchImpl),
    listNotifications: (courseId, page) => listNotifications(env, courseId, page, fetchImpl),
    markNotificationsRead: (courseId, notificationIds, confirmationToken) =>
      markNotificationsRead(env, courseId, notificationIds, confirmationToken, fetchImpl),
    markConversationRead: (courseId, conversationId, confirmationToken) =>
      markConversationRead(env, courseId, conversationId, confirmationToken, fetchImpl),
    createPost: (courseId, conversationId, content, confirmationToken) =>
      createPost(env, courseId, conversationId, content, confirmationToken, fetchImpl),
    replyToPost: (courseId, conversationId, postId, content, page, confirmationToken) =>
      replyToPost(env, courseId, conversationId, postId, content, page, confirmationToken, fetchImpl),
    submitText: (exerciseId, text, language, confirmationToken) => submitText(env, exerciseId, text, language, confirmationToken, fetchImpl),
    submitFile: (exerciseId, filePath, confirmationToken) => submitFile(env, exerciseId, filePath, confirmationToken, fetchImpl),
    submitQuiz: (exerciseId, answers, confirmationToken) => submitQuiz(env, exerciseId, answers, confirmationToken, fetchImpl),
  });
  let buffer = "";
  let chain = Promise.resolve();

  const onLine = (line) => {
    chain = chain.then(async () => {
      const message = parseRpcLine(line);
      const response = message.invalid
        ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
        : await handle(message);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    });
    return chain;
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") {
        onLine(line);
      }
      index = buffer.indexOf("\n");
    }
  });

  await new Promise((resolve) => {
    process.stdin.on("end", () => {
      chain.then(resolve, resolve);
    });
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(() => {
    process.stderr.write("artemis-student-mcp failed\n");
    process.exitCode = 1;
  });
}
