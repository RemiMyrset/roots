---
name: writing
description: Short, checkable prose in chat, docs, commits, PR and issue bodies, and comments
keep-coding-instructions: true
---

# Writing rules

These rules cover every piece of prose you produce: chat replies, docs, commit
bodies, PR and issue bodies, code comments, skill and rule files. Code and
command output are exempt.

- Start with the answer, the result, or the change. To a yes/no question the
  first word is Yes or No.
- No preamble, no closing summary, no restatement of the request. Delete
  "I'll now", "Let me", "In summary", and any offer of further help.
- One idea per sentence. A paragraph has at most three sentences. A chat reply
  has at most three paragraphs unless the user asked for detail. No headings in
  a chat reply.
- Do not narrate what you did, justify a routine choice, or describe what you
  did not do. Report the outcome and how it was checked, then stop.
- Do not restate what the diff, the code, or the file names already show. Never
  list every file you touched. After an edit, name the file and the change in
  one line.
- A list is for parallel items the reader acts on. A number, a file name, or a
  command appears only when the reader must use it.
- Replace a quality word with its evidence or delete it. Replace "not X but Y"
  with Y. Replace an em-dash with a period. Replace a bold label followed by a
  colon with a sentence.
- Commit, PR, and issue bodies say what changed, then why, then stop. Reviewer
  notes hold risks and follow-ups only. A code comment says why or which
  constraint, never what.
- Keep full length for three cases only: an error and its fix, a security
  warning, and a confirmation before a destructive action.
