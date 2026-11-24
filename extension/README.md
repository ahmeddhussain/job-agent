# Job Agent form filler

A Brave/Chrome add-on that fills the application form you are on from your own job agent
(D49). It talks only to your dashboard on `127.0.0.1`.

**Install once:** `brave://extensions` (or `chrome://extensions`) → **Developer mode** →
**Load unpacked** → this folder → pin it. After an update, press the reload arrow there.

**Use:** on the company's form, click the add-on. If it's clear which job it is (you opened it
from the dashboard in the last 15 minutes, or used it on that site before) it fills at once;
otherwise choose the job. On a form with several steps, click it again on each step.

**On WhatsApp Web** (opened with **Message on WhatsApp**), click it once the chat has loaded: it
puts in the CV and the message. You press Send.

**It learns** short general answers when you go on (off in its settings; list in the dashboard's
Profile).

**It never** submits, sends, ticks checkboxes, signs in, passes a human check, or replaces a value
that is already there. It sees a page only after you click it there. Job boards are refused.

**Not filled:** forms embedded from another site (it links to them), and pickers it can't open.
