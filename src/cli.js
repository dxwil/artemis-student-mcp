import fs from "node:fs";
import { stdin as input, stderr as output } from "node:process";
import { pathToFileURL } from "node:url";
import { loginWithPassword, logout, resolveConfig } from "./auth.js";
import { SafeError } from "./errors.js";
import { callToolOverMcp, listCoursesOverMcp } from "./mcp-call.js";
import { isExpired, isInstructorToken, loadSession, readExpiry } from "./session.js";

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch) {
  const command = argv[0];
  try {
    if (command === "login") {
      rejectExtra(argv.slice(1), "Usage: artemis-student-auth login");
      await loginCommand(env, fetchImpl);
      return 0;
    }
    if (command === "courses") {
      const show = parseShow(argv.slice(1));
      await coursesCommand(env, show);
      return 0;
    }
    if (command === "calendar") {
      const parsed = parseIdAndText(argv.slice(1), "calendar <courseId> <YYYY-MM>");
      requireSession(env);
      const body = await callToolOverMcp(env, "list_calendar", { courseId: parsed.id, month: parsed.text });
      process.stdout.write(`events: ${body.events.length}\n`);
      if (parsed.show) {
        process.stdout.write(`${JSON.stringify(body.events)}\n`);
      }
      return 0;
    }
    if (command === "exams") {
      const parsed = parseIdCommand(argv.slice(1), command);
      await countCommand(env, "list_exams", { courseId: parsed.id }, parsed.show, "exams");
      return 0;
    }
    if (command === "results") {
      const parsed = parseIdCommand(argv.slice(1), command);
      await countCommand(env, "list_results", { courseId: parsed.id }, parsed.show, "results");
      return 0;
    }
    if (command === "feedback") {
      const parsed = parseTwoIds(argv.slice(1), "feedback <participationId> <resultId>");
      requireSession(env);
      const body = await callToolOverMcp(env, "get_feedback", { participationId: parsed.first, resultId: parsed.second });
      process.stdout.write(`feedback: ${body.feedback.length}\n`);
      if (parsed.show) {
        process.stdout.write(`${JSON.stringify(body.feedback)}\n`);
      }
      return 0;
    }
    if (command === "announcements") {
      const parsed = parseIdCommand(argv.slice(1), command);
      await countCommand(env, "list_announcements", { courseId: parsed.id, page: 0 }, parsed.show, "announcements");
      return 0;
    }
    if (command === "conversations") {
      const parsed = parseIdCommand(argv.slice(1), command);
      await countCommand(env, "list_conversations", { courseId: parsed.id }, parsed.show, "conversations");
      return 0;
    }
    if (command === "messages") {
      const parsed = parseTwoIds(argv.slice(1), "messages <courseId> <conversationId>");
      requireSession(env);
      const body = await callToolOverMcp(env, "list_messages", { courseId: parsed.first, conversationId: parsed.second, page: 0 });
      process.stdout.write(`messages: ${body.messages.length}\n`);
      if (parsed.show) {
        process.stdout.write(`${JSON.stringify(body.messages)}\n`);
      }
      return 0;
    }
    if (command === "tutorials" || command === "competencies" || command === "faqs" || command === "notifications") {
      const parsed = parseIdCommand(argv.slice(1), command);
      const tool = { tutorials: "list_tutorial_groups", competencies: "list_competencies", faqs: "list_faqs", notifications: "list_notifications" }[command];
      const label = { tutorials: "tutorialGroups", competencies: "competencies", faqs: "faqs", notifications: "notifications" }[command];
      const args = command === "notifications" ? { courseId: parsed.id, page: 0 } : { courseId: parsed.id };
      await countCommand(env, tool, args, parsed.show, label);
      return 0;
    }
    if (command === "learning-path") {
      const parsed = parseIdCommand(argv.slice(1), command);
      requireSession(env);
      const body = await callToolOverMcp(env, "get_learning_path", { courseId: parsed.id });
      process.stdout.write(`progress: ${body.learningPath.progress}\n`);
      if (parsed.show) {
        process.stdout.write(`${JSON.stringify(body.learningPath)}\n`);
      }
      return 0;
    }
    if (command === "download") {
      const parsed = parseIdAndText(argv.slice(1), "download <lectureId> <path>");
      requireSession(env);
      const body = await callToolOverMcp(env, "download_attachment", { lectureId: parsed.id, path: parsed.text });
      process.stdout.write(`downloaded: ${body.download.bytes}\n`);
      if (parsed.show) {
        process.stdout.write(`${JSON.stringify(body.download)}\n`);
      }
      return 0;
    }
    if (command === "mark-notifications") {
      const courseId = requireCliId(argv[1], "mark-notifications <courseId> <notificationId>...");
      const notificationIds = argv.slice(2).map((value) => requireCliId(value, "mark-notifications <courseId> <notificationId>..."));
      const sent = await approvedWrite(env, "mark_notifications_read", { courseId, notificationIds });
      if (sent) {
        process.stdout.write(`marked: ${sent.marked}\n`);
      }
      return 0;
    }
    if (command === "mark-conversation") {
      const courseId = requireCliId(argv[1], "mark-conversation <courseId> <conversationId>");
      const conversationId = requireCliId(argv[2], "mark-conversation <courseId> <conversationId>");
      rejectExtra(argv.slice(3), "Usage: artemis-student-auth mark-conversation <courseId> <conversationId>");
      const sent = await approvedWrite(env, "mark_conversation_read", { courseId, conversationId });
      if (sent) {
        process.stdout.write(`marked-read: ${sent.conversationId}\n`);
      }
      return 0;
    }
    if (command === "post") {
      const parsed = parseTwoIdsAndText(argv.slice(1), "post <courseId> <conversationId> <text>");
      const sent = await approvedWrite(env, "create_post", { courseId: parsed.first, conversationId: parsed.second, content: parsed.text });
      if (sent) {
        process.stdout.write(`post: ${sent.postId}\n`);
      }
      return 0;
    }
    if (command === "reply") {
      const parsed = parseThreeIdsAndText(argv.slice(1), "reply <courseId> <conversationId> <postId> <text>");
      const sent = await approvedWrite(env, "reply_to_post", {
        courseId: parsed.first,
        conversationId: parsed.second,
        postId: parsed.third,
        content: parsed.text,
      });
      if (sent) {
        process.stdout.write(`reply: ${sent.answerId}\n`);
      }
      return 0;
    }
    if (command === "submit-text") {
      const exerciseId = requireCliId(argv[1], "submit-text <exerciseId> (--file <path>|text)");
      const text = argv[2] === "--file" ? fs.readFileSync(argv[3], "utf8") : argv.slice(2).join(" ");
      if (argv[2] === "--file") {
        rejectExtra(argv.slice(4), "Usage: artemis-student-auth submit-text <exerciseId> --file <path>");
      }
      const sent = await approvedWrite(env, "submit_text", { exerciseId, text });
      if (sent) {
        process.stdout.write(`submitted: ${sent.submissionId}\n`);
      }
      return 0;
    }
    if (command === "submit-file") {
      const exerciseId = requireCliId(argv[1], "submit-file <exerciseId> <path>");
      if (typeof argv[2] !== "string" || argv.length !== 3) {
        throw new SafeError("usage", "Usage: artemis-student-auth submit-file <exerciseId> <path>");
      }
      const sent = await approvedWrite(env, "submit_file", { exerciseId, filePath: argv[2] });
      if (sent) {
        process.stdout.write(`submitted: ${sent.submissionId}\n`);
      }
      return 0;
    }
    if (command === "submit-quiz") {
      const exerciseId = requireCliId(argv[1], "submit-quiz <exerciseId> <answers.json>");
      if (typeof argv[2] !== "string" || argv.length !== 3) {
        throw new SafeError("usage", "Usage: artemis-student-auth submit-quiz <exerciseId> <answers.json>");
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(argv[2], "utf8"));
      } catch {
        throw new SafeError("invalid_arguments", "The quiz answers file is not valid JSON.");
      }
      const answers = Array.isArray(parsed) ? parsed : parsed?.answers;
      const sent = await approvedWrite(env, "submit_quiz", { exerciseId, answers });
      if (sent) {
        process.stdout.write(`submitted: ${sent.submissionId}\n`);
      }
      return 0;
    }
    if (command === "exercises" || command === "lectures") {
      const parsed = parseIdCommand(argv.slice(1), command);
      await countCommand(env, command === "exercises" ? "list_exercises" : "list_lectures", { courseId: parsed.id }, parsed.show, command);
      return 0;
    }
    if (command === "exercise" || command === "lecture") {
      const parsed = parseIdCommand(argv.slice(1), command);
      await detailCommand(env, command, parsed.id, parsed.show);
      return 0;
    }
    if (command === "logout") {
      rejectExtra(argv.slice(1), "Usage: artemis-student-auth logout");
      const config = resolveConfig(env);
      await logout(env, fetchImpl);
      process.stdout.write("Cleared the local session.\n");
      if (config.tokenFile) {
        process.stdout.write(`session file: ${config.tokenFile}\n`);
      }
      return 0;
    }
    if (command === "status") {
      rejectExtra(argv.slice(1), "Usage: artemis-student-auth status");
      writeStatus(env);
      return 0;
    }
    process.stderr.write("Usage: artemis-student-auth <login|courses|exercises|exercise|lectures|lecture|announcements|results|feedback|calendar|exams|conversations|messages|download|tutorials|competencies|learning-path|faqs|notifications|mark-notifications|mark-conversation|post|reply|submit-text|submit-file|submit-quiz|logout|status>\n");
    return 1;
  } catch (error) {
    const safe = error instanceof SafeError ? error : new SafeError("internal", "The command could not be completed.");
    process.stderr.write(`${safe.message}\n`);
    return safe.code === "sso_required" ? 2 : 1;
  }
}

async function loginCommand(env, fetchImpl) {
  const username = await resolveUsername(env);
  const password = await resolvePassword(env);
  const config = resolveConfig({ ...env, ARTEMIS_USERNAME: username, ARTEMIS_PASSWORD: password });
  if (!config.tokenFile) {
    throw new SafeError(
      "no_token_store",
      "Set PLUGIN_DATA or ARTEMIS_TOKEN_FILE to a private directory outside the plugin before logging in.",
    );
  }
  await loginWithPassword(config, fetchImpl);
  await writeCourseCount(env, false);
}

async function coursesCommand(env, show) {
  const config = resolveConfig(env);
  if (!config.tokenFile) {
    throw new SafeError(
      "no_token_store",
      "Set PLUGIN_DATA or ARTEMIS_TOKEN_FILE to a private directory outside the plugin before listing courses.",
    );
  }
  await writeCourseCount(env, show);
}

async function writeCourseCount(env, show) {
  const summary = await listCoursesOverMcp(env, { show });
  process.stdout.write(`courses: ${summary.count}\n`);
  if (show) {
    process.stdout.write(`${JSON.stringify(summary.courses)}\n`);
  }
}

async function countCommand(env, tool, args, show, label) {
  requireSession(env);
  const body = await callToolOverMcp(env, tool, args);
  const items = body[label] ?? body[tool === "list_exercises" ? "exercises" : "lectures"];
  process.stdout.write(`${label}: ${items.length}\n`);
  if (show) {
    process.stdout.write(`${JSON.stringify(items)}\n`);
  }
}

async function detailCommand(env, command, id, show) {
  requireSession(env);
  if (command === "exercise") {
    const body = await callToolOverMcp(env, "get_exercise", { exerciseId: id });
    const exercise = body.exercise;
    const deadlines = ["releaseDate", "startDate", "dueDate"].filter((key) => exercise[key]);
    process.stdout.write(`exercise: ${exercise.id}\n`);
    process.stdout.write(`statement: ${exercise.problemStatement ? "yes" : "no"}\n`);
    process.stdout.write(`deadlines: ${deadlines.join(",")}\n`);
    if (show) {
      process.stdout.write(`${JSON.stringify(exercise)}\n`);
    }
    return;
  }
  const body = await callToolOverMcp(env, "get_lecture", { lectureId: id });
  process.stdout.write(`lecture: ${body.lecture.id}\n`);
  process.stdout.write(`materials: ${body.lecture.materials.length}\n`);
  if (show) {
    process.stdout.write(`${JSON.stringify(body.lecture)}\n`);
  }
}

function requireSession(env) {
  const config = resolveConfig(env);
  if (!config.tokenFile) {
    throw new SafeError(
      "no_token_store",
      "Set PLUGIN_DATA or ARTEMIS_TOKEN_FILE to a private directory outside the plugin before reading.",
    );
  }
}

function parseIdAndText(args, usage) {
  const show = args.includes("--show");
  const rest = args.filter((arg) => arg !== "--show");
  if (rest.length !== 2 || !/^[1-9][0-9]*$/.test(rest[0])) {
    throw new SafeError("usage", `Usage: artemis-student-auth ${usage} [--show]`);
  }
  return { id: Number(rest[0]), text: rest[1], show };
}

function parseTwoIds(args, usage) {
  const show = args.includes("--show");
  const rest = args.filter((arg) => arg !== "--show");
  if (rest.length !== 2 || rest.some((arg) => !/^[1-9][0-9]*$/.test(arg))) {
    throw new SafeError("usage", `Usage: artemis-student-auth ${usage} [--show]`);
  }
  return { first: Number(rest[0]), second: Number(rest[1]), show };
}

function parseIdCommand(args, command) {
  const show = args.includes("--show");
  const rest = args.filter((arg) => arg !== "--show");
  if (rest.length !== 1 || !/^[1-9][0-9]*$/.test(rest[0])) {
    throw new SafeError("usage", `Usage: artemis-student-auth ${command} <id> [--show]`);
  }
  return { id: Number(rest[0]), show };
}

function parseShow(args) {
  if (args.length === 0) {
    return false;
  }
  if (args.length === 1 && args[0] === "--show") {
    return true;
  }
  throw new SafeError("usage", "Usage: artemis-student-auth courses [--show]");
}

function parseTwoIdsAndText(args, usage) {
  if (args.length < 3 || args.some((arg) => arg === "--show")) {
    throw new SafeError("usage", `Usage: artemis-student-auth ${usage}`);
  }
  return { first: requireCliId(args[0], usage), second: requireCliId(args[1], usage), text: args.slice(2).join(" ") };
}

function parseThreeIdsAndText(args, usage) {
  if (args.length < 4) {
    throw new SafeError("usage", `Usage: artemis-student-auth ${usage}`);
  }
  return {
    first: requireCliId(args[0], usage),
    second: requireCliId(args[1], usage),
    third: requireCliId(args[2], usage),
    text: args.slice(3).join(" "),
  };
}

function requireCliId(value, usage) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new SafeError("usage", `Usage: artemis-student-auth ${usage}`);
  }
  return Number(value);
}

async function approvedWrite(env, name, args) {
  requireSession(env);
  const preview = await callToolOverMcp(env, name, args);
  if (!preview || !preview.preview || typeof preview.confirmationToken !== "string") {
    throw new SafeError("malformed", "The write preview was missing.");
  }
  process.stdout.write(`${JSON.stringify(preview.preview)}\n`);
  if (!input.isTTY) {
    process.stdout.write("cancelled\n");
    return null;
  }
  output.write("Send this write? [y/N] ");
  const answer = await new Promise((resolve) => {
    input.setEncoding("utf8");
    input.once("data", (chunk) => resolve(String(chunk).trim()));
  });
  if (answer !== "y" && answer !== "Y") {
    process.stdout.write("cancelled\n");
    return null;
  }
  return callToolOverMcp(env, name, { ...args, confirmationToken: preview.confirmationToken });
}

function rejectExtra(args, usage) {
  if (args.length > 0) {
    throw new SafeError("usage", usage);
  }
}

function writeStatus(env) {
  const config = resolveConfig(env);
  process.stdout.write(`origin: ${config.origin}\n`);
  if (config.tokenFile) {
    process.stdout.write(`session file: ${config.tokenFile}\n`);
  }
  if (!config.tokenFile) {
    process.stdout.write("session: absent\n");
    return;
  }
  const session = loadSession(config.tokenFile, config.origin);
  if (!session) {
    process.stdout.write("session: absent\n");
    return;
  }
  if (isInstructorToken(session.accessToken)) {
    process.stdout.write("session: refused\n");
    return;
  }
  const exp = readExpiry(session.accessToken);
  const expired = isExpired(session.accessToken, Date.now());
  process.stdout.write(`session: ${expired ? "expired" : "present"}\n`);
  if (session.strategy) {
    process.stdout.write(`auth: ${session.strategy}\n`);
  }
  process.stdout.write(`expires: ${exp == null ? "unknown" : new Date(exp * 1000).toISOString()}\n`);
}

async function resolveUsername(env) {
  if (typeof env.ARTEMIS_USERNAME === "string" && env.ARTEMIS_USERNAME.trim() !== "") {
    return env.ARTEMIS_USERNAME.trim();
  }
  if (!input.isTTY) {
    throw new SafeError(
      "not_a_tty",
      "Run the login command in a terminal. The username is not read from a pipe or a command argument.",
    );
  }
  const answer = await readHidden("Artemis username: ");
  return answer.trim();
}

async function resolvePassword(env) {
  if (typeof env.ARTEMIS_PASSWORD === "string" && env.ARTEMIS_PASSWORD !== "") {
    return env.ARTEMIS_PASSWORD;
  }
  if (!input.isTTY) {
    throw new SafeError(
      "not_a_tty",
      "Set ARTEMIS_PASSWORD or run the login command in a terminal. The password is not read from a pipe or a tool argument.",
    );
  }
  return readHidden("Artemis password: ");
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    let value = "";
    const onData = (buffer) => {
      const text = buffer.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        reject(new SafeError("cancelled", "Login cancelled."));
        return;
      }
      if (text === "\r" || text === "\n" || text === "\u0004") {
        cleanup();
        output.write("\n");
        resolve(value);
        return;
      }
      if (text === "\u007f" || text === "\b") {
        value = value.slice(0, -1);
        return;
      }
      if (text < " " && text !== "\t") {
        return;
      }
      value += text;
    };
    const cleanup = () => {
      input.off("data", onData);
      if (!wasRaw) {
        input.setRawMode(false);
      }
    };
    input.on("data", onData);
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const code = await main();
  process.exitCode = code;
}
