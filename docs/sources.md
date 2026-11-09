# Endpoint mapping

Pinned to the Artemis commit deployed on https://artemis.tum.de when the public info endpoint was read on 2026-11-09.

| | |
| --- | --- |
| Commit | `43b26a1d892d7bb3d03c40af9d2829516894bc50` |
| Branch reported by the server | `develop` |
| Commit time | `2026-11-05T22:20:18Z` |
| Build | Artemis 10.6 |
| Commit subject | Development: Render more documentation screenshots from the demo course (#14503) |

Source links below use that commit. The public info body itself is not archived; it contains operational fields that this plugin does not need. The auth-related fields that were read are listed here.

## Public TUM configuration

`GET https://artemis.tum.de/management/info` returned HTTP 200, `content-type: application/vnd.spring-boot.actuator.v3+json`, `content-version: 10.6`.

Observed fields:

- `useExternal`: true
- `registrationEnabled`: false
- `accountName`: `TUM`
- `universityName`: Technical University of Munich
- `oidc.buttonLabel`: `TUM Login`
- `activeProfiles`: `prod`, `core`, `localvc`, `localci`, `scheduling`
- `activeModuleFeatures` includes `ldap` and `passkey`. No SAML2 feature was present.
- `externalPasswordResetLinkMap` points at the public TUMonline password-reset pages.
- No login was attempted. No password, cookie, or session was sent.

Other unauthenticated probes, with redirects not followed:

| Request | Result |
| --- | --- |
| `GET /api/core/public/authenticate` | 200, empty body. This is the "is anyone logged in" check, not password login. |
| `GET /api/core/public/account` | 204, which the source returns for an anonymous caller. |
| `GET /api/account/public/authenticate` | 404 |
| `GET /api/course/courses/for-dashboard` | 401, empty body. The security layer answers before an anonymous caller can tell a missing route from a protected one. The route is established from source, not from this status. |
| `GET /oauth2/authorization/oidc` | 302 to `https://login.tum.de/idp/profile/oidc/authorize` |

The OIDC redirect used `response_type=code`, client id `TUS1322-ARTEMIS-P`, scope `openid profile email imMatrikelNr`, `code_challenge_method=S256`, and `redirect_uri=https://artemis.tum.de/login/oauth2/code/oidc`. The one-time `state`, `nonce`, and `code_challenge` are not recorded.

## Password login

`POST /api/core/public/authenticate`

- Controller: `PublicUserJwtResource` in `src/main/java/de/tum/cit/aet/artemis/core/web/open/PublicUserJwtResource.java` (mapping at line 63, method at line 101).
- Body: `LoginVM` (`username`, `password`, optional `rememberMe`) in `src/main/java/de/tum/cit/aet/artemis/core/dto/vm/LoginVM.java`.
- `User-Agent` is required. Length limits in `Constants.java`: username 4–50, password 8–100 characters and at most 72 UTF-8 bytes. Login pattern: `^[_'.@A-Za-z0-9-]*$`.
- Success is HTTP 200 and `{ "access_token": "<jwt>" }`, and a `jwt` cookie. This plugin stores only the access token and sends it as `Authorization: Bearer`. It does not send the `tool` query parameter.
- HTTP 401 is an empty refusal. The source deliberately uses the same status for a wrong password and for an unknown account.
- The browser client posts here from `auth-jwt.service.ts` (`login`).

`GET /api/core/public/login-options?usernameOrEmail=`

- `PublicAccountResource` line 287, implemented by `LoginOptionsService`.
- `PASSWORD` is returned for an internal account, for a blank identifier, and when neither OIDC nor SAML2 is enabled.
- `OIDC` or `SAML2` is returned for an external account and for an identifier that is not in the local database, when that provider is enabled. Those two cases are intentionally indistinguishable.
- The service does not query LDAP.

`POST /api/core/public/logout` clears the JWT cookie. The JWT itself is stateless (`https://github.com/ls1intum/Artemis/security` describes the TUM lifetimes: about 3 days, or 10 days with remember-me).

`JWTFilter` accepts either the `jwt` cookie or an `Authorization: Bearer` header, but not both. A bearer value with prefix `art_pat_` is a personal access token (`Constants.java`).

## Reference server

<https://glama.ai/mcp/servers/mxmichels17/tum-mcp> describes <https://github.com/mxmichels17/tum-mcp> at `fba48fed625756fda1f056c13103b4d71681267a` (2026-10-24). Artemis login is `src/platforms/artemis.ts` lines 1–46.

What that file actually does:

- It posts `{ username, password, rememberMe: true }` to `https://artemis.tum.de/api/core/public/authenticate`.
- It stores the returned `access_token` and sends `Authorization: Bearer`.
- It does not complete OIDC, does not impersonate the VS Code or iOS redirect, and does not ask the user to paste a browser cookie.
- The comment says a 2026-10-17 read of `/management/info` showed the `ldap` module and no SAML2/OIDC, so password login worked. The repository's own test notes say a live Artemis login was reported by the owner, and this checkout had no separate automated proof against TUM.

That OIDC claim is stale relative to the 2026-11-09 TUM info read, which shows an OIDC button and a live redirect to `login.tum.de`, and still lists `ldap` in `activeModuleFeatures`. A public X search for Grok Bot or `@bot` with Artemis or TUM login returned no posts. General Grok Bot MCP writeups describe connector OAuth, not this student API.

## Directory password and browser single sign-on are separate

`SecurityConfiguration.authenticationManager` (lines 178–210) registers `LdapAuthenticationProvider` first when the `ldap` feature is on, then the internal password provider. `LdapAuthenticationProvider.authenticateUser` (lines 75–100) skips internal accounts and binds the submitted password as an LDAP `uid`. `OIDCEnabled` does not remove that provider.

`LoginOptionsService` still tells the browser to show OIDC for a non-internal account. That is the web form's choice. It is not a switch that disables `POST /api/core/public/authenticate`.

This plugin therefore:

- uses `PASSWORD` from login-options as normal password login on any Artemis deployment
- uses the same authenticate endpoint when login-options says `OIDC` or `SAML2` and public info lists `ldap` (directory password)
- stops when single sign-on is requested and `ldap` is absent

Browser completion for a third-party client is still not available. The registered redirect remains `https://artemis.tum.de/login/oauth2/code/oidc`. Exchange codes stay limited to `redirect=vscode` and `redirect=ios`. Those clients are not impersonated. A new redirect needs an upstream registration.

No live TUM password or directory login has been run by this plugin.

OIDC itself is a browser authorization-code flow:

- Documentation: `documentation/docs/admin/oidc-login-registration.mdx` (`redirect-uri: "{baseUrl}/login/oauth2/code/{registrationId}"`, TUM authorization URI `https://login.tum.de/idp/profile/oidc/authorize`).
- `OIDCConfiguration` copies the query parameters `rememberMe`, `redirect`, and `code_challenge` onto the authorization request.
- `OIDCAuthenticationSuccessHandler` mints an exchange code only for `redirect=vscode` and `redirect=ios`.
- Those callbacks are `vscode://aet-tum.iris-thaumantias/auth-callback` and `de.tum.cit.ase.artemis://oauth2callback` (`OIDCConstants.java`).
- The SPA then posts the code and PKCE verifier to `POST /api/core/public/exchange-code`.

No third redirect target is accepted. A localhost MCP callback is not part of this protocol, so it is not implemented.

## Student exercises and lectures

Pinned to the same commit. All of these are GET. None of them start a participation or mark a lecture unit complete.

| Read | Method and path | Role |
| --- | --- | --- |
| Exercise list | `GET /api/course/courses/{courseId}/exercises-for-overview` | `@EnforceAtLeastStudent`, then student role in the course (`CourseOverviewResource` lines 209–217) |
| Exercise statement | `GET /api/exercise/exercises/{exerciseId}` | `@EnforceAtLeastStudentInExercise`. Course exercises only. Not visible to students returns 403 (`ExerciseResource` lines 197–207). Exam exercises are rejected in `loadExerciseForKind`. |
| Lecture list | `GET /api/lecture/courses/{courseId}/lectures-for-overview` | `@EnforceAtLeastStudentInCourse` (`LectureResource` lines 363–368). Titles and dates only. |
| Lecture materials | `GET /api/lecture/lectures/{lectureId}/details` | `@EnforceAtLeastStudentInLecture` (`LectureResource` lines 560–565). `LectureService.getForDetails` filters units the user should not see. |

`ExerciseOverviewDTO` dates (`releaseDate`, `startDate`, `dueDate`) are nullable `ZonedDateTime` values. Jackson omits nulls. A null release date means a course exercise is visible (`BaseExercise.isVisibleToStudents`). A future release date is not. The overview service can include unreleased exercises for a teaching assistant (`includeUnreleased`), so this plugin drops rows whose release date is still in the future.

`ExerciseResponseDTO.problemStatement` is a nullable string. The same record can carry example solutions, grading instructions, and repository URIs. This plugin copies only the statement and the three dates. `GET .../example-solution` is not called. `GET .../details` is not called, because that route also loads participations and results.

`LectureForOverviewDTO` has `id`, `title`, nullable `startDate` and `endDate`, and `isTutorialLecture`. `LectureDetailsDTO` units are `attachment`, `online`, `text`, or `exercise`. A unit is kept only when `visibleToStudents` is true. Attachment links that stay on the Artemis origin are returned as paths. Other `https` links are returned as URLs and are not fetched. `POST .../completion` is not called.

## Later student reads

Still pinned to `43b26a1d892d7bb3d03c40af9d2829516894bc50`. Domain calls are GET.

- Announcements: `GET /api/communication/courses/{courseId}/channels/overview`, then `GET /api/communication/courses/{courseId}/messages` for the channel with `isAnnouncementChannel`. `POST .../announcements` is not called.
- Results: `studentParticipations` on `GET /api/course/courses/{courseId}/exercises-for-overview`, only results with `completionDate`. Feedback: `GET /api/assessment/participations/{participationId}/results/{resultId}/details`.
- Calendar: `GET /api/calendar/courses/{courseId}/calendar-events`. The subscription-token route is not called. Exam dates: `GET /api/exam/courses/{courseId}/exams-for-overview`. That DTO has no seat. Released grade: `GET /api/exam/courses/{courseId}/exams/{examId}/student-exams/{studentExamId}/grade-summary`. `own-student-exam` is not called.
- Conversations: `GET /api/communication/courses/{courseId}/conversations` and the messages GET above. Unread, reaction, and post routes are not called.
- Attachment bytes: `GET /api/core/files/attachments/lectures/{lectureId}/{name}` only when the path matches that lecture.
- Tutorial groups: `GET /api/tutorialgroup/courses/{courseId}/tutorial-groups`. Competencies: `GET /api/atlas/courses/{courseId}/competencies`. Learning path: `GET /api/atlas/courses/{courseId}/learning-path/me`. FAQs: `GET /api/communication/courses/{courseId}/faqs`, keeping `ACCEPTED` only. Notifications: `GET /api/notification/courses/{courseId}`. The seen-status update route is not called.

## Student writes

Still pinned to `43b26a1d892d7bb3d03c40af9d2829516894bc50`. Each write is sent once, only after a local confirmation token matches the payload. A redirect is not followed.

- Notifications: `PUT /api/notification/courses/{courseId}/status` with `{ notificationIds, statusType: "SEEN" }`. `PUT .../seen` is the client's automatic display hook and is not called. `PUT .../archive-all` is not called.
- Conversation read: `PATCH /api/communication/courses/{courseId}/conversations/{conversationId}/mark-as-read`, only after the conversation appears in the student's conversation list.
- Post: `POST /api/communication/courses/{courseId}/messages` with `CreatePostDTO` `{ content, hasForwardedMessages: false, conversation: { id } }`. Content is at most 5000 characters. Reactions, edits, and deletes are not called.
- Reply: `POST /api/communication/courses/{courseId}/answer-messages` with `CreateAnswerPostDTO` `{ content, post: { id } }`, and only when that post is on the requested message page.
- Text: `POST` or `PUT /api/text/exercises/{exerciseId}/text-submissions` with `TextSubmissionRequestDTO` `{ id?, text, language?, submitted: true }`. Text is at most 30000 characters. Language is `ENGLISH` or `GERMAN`.
- File upload: `POST /api/fileupload/exercises/{exerciseId}/file-upload-submissions` as multipart parts `submission` (`FileUploadSubmissionInputDTO`) and `file`. The server limit is 8 MB.
- Quiz live: `POST /api/quiz/exercises/{exerciseId}/submissions/live?submit=true` with `QuizSubmissionFromLiveClientDTO` when `GET /api/quiz/quiz-exercises/{id}/for-student` returns `quizQuestionsType` `live-quiz`.
- Quiz practice: `POST /api/quiz/exercises/{exerciseId}/submissions/practice` with `QuizSubmissionFromStudentDTO` when that read returns `after-quiz-end`. `before-quiz-start` is refused. `PUT .../submissions/exam` is not called.

Programming submissions stay on Git. Modeling submissions are a diagram model (`POST /api/modeling/exercises/{exerciseId}/modeling-submissions`) and are not sent. Exam exercises are refused because their submission path is exam conduction.

A missing optional route is HTTP 404 and is returned as `not_enabled` for tutorial groups, competencies, FAQs, notifications, the calendar, and exams. Messaging that the course has turned off is HTTP 403, the same status Artemis uses when the caller is not in the course, so this plugin returns `forbidden` and does not read the response body to tell those apart. Learning paths that are switched off are HTTP 400 and are returned as `not_enabled`. A student with no generated learning path is HTTP 404 and is returned as `not_found`. This plugin does not call the POST that generates a path or the PATCH that starts one.

`GET /api/communication/courses/{courseId}/messages` does not mark posts read at this commit. `GET /api/notification/courses/{courseId}` does not mark notifications seen. The seen routes are `PUT /api/notification/courses/{courseId}/status`, `PUT .../seen`, and `PUT .../archive-all`, and they are not called. `GET .../unread-messages`, `PATCH .../mark-as-read`, and `GET .../own-student-exam` are not called. Some of the GET routes above carry Artemis `@FeatureUsage` telemetry; the plugin still only sends GET.

## Student course list

`GET /api/course/courses/for-dashboard`

- `CourseOverviewResource` is mapped at `api/course/` and the method is `courses/for-dashboard` (lines 90 and 276).
- Annotation: `@EnforceAtLeastStudent`. It is not annotated `@AllowedScopes`, so an instructor personal access token is not a way to call it.
- Response: `CoursesForDashboardDTO`, a set of `CourseForDashboardDTO` plus active exams. Each dashboard entry nests a `CourseDashboardDTO` under `course`.
- The plugin reads only `course.id`, `course.title`, `course.shortName`, `course.startDate`, and `course.endDate`, then drops scores, exercises, lectures, exams, and every other field.

`GET /api/course/courses/for-dropdown` (line 254) is also `@EnforceAtLeastStudent`, and it is the agent-scoped `courses:read` operation, but `CourseDropdownDTO` is only id, title, and icon. It cannot fill the agreed summary.

## CourseSummary nullability

Agreed output, always with all five keys:

```json
{ "id": 1, "title": "...", "shortName": "...", "startDate": null, "endDate": null }
```

From `Course.java` at the pinned commit:

| Field | Column | Constraint in the entity |
| --- | --- | --- |
| `id` | primary key on `DomainObject` | Present for a stored course. The dashboard DTO types it as primitive `long`. |
| `title` | `title` | No `nullable = false` on the column. |
| `shortName` | `short_name`, unique | No `nullable = false` on the column. |
| `startDate` | `start_date` | `@Column(nullable = false)` |
| `endDate` | `end_date` | `@Column(nullable = false)` |

From `CourseDashboardDTO`, which is the JSON the dashboard endpoint actually builds:

| Field | Jackson / Java nullability |
| --- | --- |
| `id` | primitive `long` |
| `title` | `String`, not `@Nullable` |
| `shortName` | `String`, not `@Nullable` |
| `startDate` | `@Nullable ZonedDateTime` |
| `endDate` | `@Nullable ZonedDateTime` |

The record and the entity both use `@JsonInclude(NON_EMPTY)`, so a null date is omitted rather than sent as `null`. The plugin treats a missing or JSON `null` date as `null`. It rejects a missing id, title, or short name, a non-integer id, or a date that is not ISO-8601. It does not invent a date when the column annotation says non-null but the DTO omits the value.

Dates are copied as the server sent them. They are not reformatted.

## Instructor MCP, not used

[Agent access](https://docs.artemis.tum.de/admin/agent-access/) documents `POST /api/core/agent/mcp` and personal access tokens. The same commit's `AgentMcpResource` accepts only a `PersonalAccessTokenAuthentication`. The documentation says only instructors and editors can create tokens, and a token cannot turn a student into an editor. This plugin does not call that endpoint and does not send `art_pat_` tokens to the student course API.

## Plugin format

- Manifest schema: `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
- MCP schema: `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`
- Specification: `https://agent-plugins.org/specification` (1.0.0). `mcp.json` is stdio. `cwd` is omitted, which the specification defines as the plugin root. The command is the plugin-relative `./bin/artemis-student-mcp`. `${CURSOR_PLUGIN_ROOT}` is not a placeholder in that schema.
- Copies of those schemas are vendored for offline tests. The tests do not download them again.
