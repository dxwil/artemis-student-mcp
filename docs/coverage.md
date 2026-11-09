# Student client coverage

Grep of `*.service.ts` under `src/main/webapp/app` in Artemis 10.6 (`43b26a1d892d7bb3d03c40af9d2829516894bc50`), skipping `manage/` and `admin/`. This is the HTTP calls those services name. It is not a reading of every component. Websocket traffic is out of scope even when a service also opens a socket.

| Student-facing feature | Status |
| --- | --- |
| `GET /api/core/public/account` | Covered by `get_account` |
| `GET /api/course/courses/for-dashboard` | Covered by `list_courses` |
| Exercises for overview, exercise details, problem statement | Covered by `list_exercises` and `get_exercise` |
| Lectures for overview and lecture details | Covered by `list_lectures` and `get_lecture` |
| Student files under `api/core/files/` (lectures, conversations, markdown, drag-and-drop, own file-upload submissions, slides, course icons) | Covered by `download_file` and `GET /files/<token>`. `download_attachment` remains the lecture-id alias |
| Announcement channel and conversation messages | Covered by `list_announcements`, `list_conversations`, and `list_messages`. Markdown file links are returned as `files` |
| Create a post and an answer | Covered by `create_post` and `reply_to_post` |
| Mark a conversation read | Covered by `mark_conversation_read` |
| Course notifications and mark seen | Covered by `list_notifications` and `mark_notifications_read` |
| Released results and feedback details | Covered by `list_results` and `get_feedback` |
| Text, file-upload, and quiz submission | Covered by `submit_text`, `submit_file`, and `submit_quiz` |
| Calendar and exam overview | Covered by `list_calendar` and `list_exams` |
| Released exam grade summary | Covered by `get_exam_result` |
| Tutorial group list | Covered by `list_tutorial_groups` |
| Competencies and the student's learning path | Covered by `list_competencies` and `get_learning_path` |
| Accepted FAQs | Covered by `list_faqs` |
| Own programming repository (list, read, commit, build logs) | Gap. Most useful next read: the student's own repository files and the latest build log |
| Example solution after the due date (`GET .../exercises/{id}/example-solution`) | Gap. Useful once the deadline has passed |
| Complaint on the student's own released result | Gap. The student client posts a complaint and reads its status |
| Iris course chat (`api/iris/courses/...`) | Gap when the course enables Iris. Useful as a read of the student's own chat |
| Tutorial-group registration and the student's registered sessions | Gap. The list exists; joining a group and reading the personal schedule do not |
| Saved posts, reactions, forwarded messages, unread counts | Gap. Smaller than the five above |
| Modeling submission | Gap. Intentionally left with programming and exam submission |
| Course statistics and peer comparison | Gap. Low priority; it is aggregate, not the student's own work |
| Rating a result | Gap. A write, and not required to read the result |
| Account language change, VCS tokens, tool tokens | Intentionally out of scope. Tokens are secrets |
| Profile pictures and exam-user images | Intentionally out of scope for `download_file` |
| Exam start, live events, and exam submission | Intentionally out of scope. The plugin does not start or submit an exam |
| Instructor, editor, tutor, and admin routes, including assessment dashboards | Intentionally out of scope |
| Websocket topics | Intentionally out of scope |

The five gaps ranked most useful for a student are the programming repository, the example solution, complaints, Iris chat, and tutorial-group registration.
