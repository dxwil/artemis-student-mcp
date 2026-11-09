# Live list_courses check

This checks your own Artemis login. It does not print the course list, the session, or any secret. Automated tests in this tree do not log in.

Node.js 22 or newer. From an empty directory:

```bash
node --version
git clone https://github.com/dxwil/artemis-student-mcp.git
cd artemis-student-mcp
chmod +x ./bin/artemis-student-mcp ./bin/artemis-student-auth
export PLUGIN_DATA="$HOME/.local/share/artemis-student"
mkdir -p "$PLUGIN_DATA"
chmod 700 "$PLUGIN_DATA"
unset ARTEMIS_USERNAME ARTEMIS_PASSWORD
./bin/artemis-student-auth login
./bin/artemis-student-auth courses
./bin/artemis-student-auth exercises COURSE_ID
./bin/artemis-student-auth announcements COURSE_ID
./bin/artemis-student-auth results COURSE_ID
./bin/artemis-student-auth calendar COURSE_ID YYYY-MM
./bin/artemis-student-auth exams COURSE_ID
./bin/artemis-student-auth conversations COURSE_ID
./bin/artemis-student-auth tutorials COURSE_ID
./bin/artemis-student-auth faqs COURSE_ID
./bin/artemis-student-auth notifications COURSE_ID
./bin/artemis-student-auth download LECTURE_ID PATH
./bin/artemis-student-auth exercise EXERCISE_ID
./bin/artemis-student-auth lectures COURSE_ID
./bin/artemis-student-auth lecture LECTURE_ID
./bin/artemis-student-auth logout
```

Replace `COURSE_ID`, `EXERCISE_ID`, and `LECTURE_ID` with numbers from your own account. Default output is counts and whether a statement or deadlines exist. It does not print titles or statement text. Add `--show` only when you mean to print that text locally. Do not send `--show` output unless you intend to share it.

Safe lines look like `exercises: N`, `announcements: N`, `results: N`, `events: N`, `exams: N`, `conversations: N`, `messages: N`, `tutorialGroups: N`, `faqs: N`, and `notifications: N`. The local `file` and `download` commands report that a download link needs the HTTP server. A sanitized stderr line is also safe. Do not send a password, a token, or the session file. These later reads were not live-tested here.

`chmod` is there in case clone drops the executable bit. `node ./bin/artemis-student-auth login` is the same command without that bit.

`login` asks for the username and the password with echo off. Do not put either value after the command. It then speaks MCP to `bin/artemis-student-mcp` and calls `list_courses`. Success is only this stdout line:

```text
courses: N
```

A saved token without that line is not success. `courses` repeats the same read and does not prompt. `courses --show` also prints course summaries; leave that off unless you mean to share titles.

A successful check prints `courses: N`. Do not share the password, a token, the session file, or command output that contains them.

The session file is `$HOME/.local/share/artemis-student/session.json`. `logout` deletes it and prints that path. Exit code 2 means the server asked for browser single sign-on and did not advertise directory password login.

Offline check, with no login:

```bash
npm test
```
