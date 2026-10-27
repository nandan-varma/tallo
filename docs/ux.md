# UX flows

Three jobs, three places. Each job has one way to do it; nothing is offered twice.

| Job      | Where               | The path                                                                                     |
| -------- | ------------------- | -------------------------------------------------------------------------------------------- |
| Find     | `/`                 | Describe the role in chat; results list beside it; a posting opens in a pane (`/?job=<id>`). |
| Apply    | `/resume/<posting>` | Posting → **Tailor resume** → check what changed → **Download PDF** → **Apply**.             |
| Maintain | `/resume`           | Your one resume. The menu in the toolbar switches to a tailored copy.                        |

Navigation is Jobs and Resume. Data status is a quiet link on the right. Old `/profile` and `/jobs/<id>` redirect.

## What each place holds

- **Jobs** (`/`): chat, results, tracker (the "Tracker" tab: every saved or applied role, filter by status, notes on the
  posting), saved searches on the empty chat with "N new" since you last ran them. A posting offers Save/status, Tailor
  resume, Apply, and a fit check against your resume; at the interviewing stage it also offers interview prep.
- **Resume** (`/resume`, `/resume/<posting>`): editor with checks, assistant, live PDF; a posting's copy also has the cover
  letter tab. Theme (light/dark) is the toggle in the header and follows the system until you choose.

## Rules we hold to

- **One home for each fact.** The resume is the only place the resume is edited; the assistant reads it directly (no
  generated profile). What a resume cannot say (target roles, pay, places, deal-breakers) is the "About you" sheet in the
  chat, where it is used.
- **Status has one control**: the status menu is the only way to change where a role stands; clicking Apply moves a saved or
  untracked role to applied, and never overrides a later status.
- **A posting has one view**, the reading pane, and one address. Sharing, reloading and linking from the resume all use it.
- **One way to ask the resume assistant**: tailor (for a posting's copy) or type an instruction. Every result is put in
  place with a "What changed" list and Undo, so there is no confirm step to forget.
- **One place for each setting.** Page limit, template, paper and accent live in the Design popover; the preview only reports
  and points there.
- **The toolbar finishes the job.** On a posting's copy: Back to the role, Design, Download, Apply.
- **Nothing is lost silently.** Autosave with a visible state and Retry; leaving with unsaved work warns; removing an entry
  or a copy needs a second press; AI changes are undoable.
- **Sections fold.** The editor opens on Contact and Experience; closed sections say what they hold ("3 roles").
- **First run explains itself.** No resume: the chat points at `/resume`; the resume page starts with one drop zone
  (PDF or pasted text) and a quiet "blank resume" link.
