# Live test: student writes

These commands were not run against a live Artemis server in this environment. There are no credentials here. Use a course you are enrolled in, and stop if the preview names the wrong course, conversation, or exercise.

Artemis 10.6 has channels, group chats, and one-to-one chats. It does not have a note-to-self conversation in the student API. For a message, prefer a one-to-one chat or a channel that has no other people in it. For a submission, prefer a practice quiz that has already ended, or a text or file-upload exercise whose due date is still open. Do not use a graded exercise you still need.

```bash
git clone https://github.com/dxwil/artemis-student-mcp.git
cd artemis-student-mcp
chmod +x ./bin/artemis-student-mcp ./bin/artemis-student-auth
export PLUGIN_DATA="$HOME/.local/share/artemis-student"
mkdir -p "$PLUGIN_DATA"
chmod 700 "$PLUGIN_DATA"
unset ARTEMIS_USERNAME ARTEMIS_PASSWORD
./bin/artemis-student-auth login
./bin/artemis-student-auth conversations COURSE_ID
./bin/artemis-student-auth post COURSE_ID CONVERSATION_ID "live-test note"
./bin/artemis-student-auth mark-conversation COURSE_ID CONVERSATION_ID
./bin/artemis-student-auth notifications COURSE_ID
./bin/artemis-student-auth mark-notifications COURSE_ID NOTIFICATION_ID
./bin/artemis-student-auth submit-text EXERCISE_ID "practice answer"
./bin/artemis-student-auth submit-file EXERCISE_ID ./notes.pdf
./bin/artemis-student-auth submit-quiz EXERCISE_ID ./answers.json
./bin/artemis-student-auth logout
```

Each write prints a JSON preview and then asks `Send this write? [y/N]`. Press enter to cancel. The confirmation token and the session file are not printed.

An answers file is a JSON array. A multiple-choice answer looks like `{"type":"multiple-choice","questionId":1,"selectedOptionIds":[2]}`. A short answer looks like `{"type":"short-answer","questionId":8,"texts":[{"text":"loop","spotId":9}]}`. A drag-and-drop answer looks like `{"type":"drag-and-drop","questionId":3,"mappings":[{"dragItemId":4,"dropLocationId":5}]}`.

Safe lines to report are `post: N`, `reply: N`, `marked: N`, `marked-read: N`, `submitted: N`, `cancelled`, or one stderr line such as a closed quiz or a passed due date. Do not send the preview when it contains your answer text, a password, a token, or the session file.

Programming and modeling exercises are refused on purpose. Exam exercises are refused on purpose.
