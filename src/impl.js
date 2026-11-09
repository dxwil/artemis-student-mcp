import { getAccount } from "./account.js";
import { listCourses } from "./auth.js";
import { listAnnouncements } from "./announcements.js";
import { getLearningPath, listCompetencies, listFaqs, listNotifications, listTutorialGroups } from "./course-info.js";
import { listConversations, listMessages } from "./conversations.js";
import { downloadAttachment, downloadFile, readStudentFile } from "./downloads.js";
import { markConversationRead, markNotificationsRead } from "./mark-read.js";
import { createPost, replyToPost } from "./posting.js";
import { getExamResult, listCalendar, listExams } from "./schedule.js";
import { getFeedback, listResults } from "./results.js";
import { getExercise, getLecture, listExercises, listLectures } from "./student-reads.js";
import { submitFile, submitQuiz, submitText } from "./submissions.js";

export function createToolImpl(env, fetchImpl = globalThis.fetch) {
  return {
    getAccount: () => getAccount(env, fetchImpl),
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
    downloadFile: (reference) => downloadFile(env, reference, fetchImpl),
    downloadAttachment: (lectureId, unitId, attachmentId) => downloadAttachment(env, lectureId, { unitId, attachmentId }, fetchImpl),
    readFile: (uri) => readStudentFile(env, uri, fetchImpl),
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
    submitText: (exerciseId, text, language, confirmationToken) =>
      submitText(env, exerciseId, text, language, confirmationToken, fetchImpl),
    submitFile: (exerciseId, filePath, confirmationToken) => submitFile(env, exerciseId, filePath, confirmationToken, fetchImpl),
    submitQuiz: (exerciseId, answers, confirmationToken) => submitQuiz(env, exerciseId, answers, confirmationToken, fetchImpl),
  };
}
