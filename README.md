# Scaler Class Scheduler — Chrome Extension

Schedules classes on **scaler.com/scm/classes/schedule-classes** from a CSV, **one batch at a time**.

For each batch it:

1. Selects the batch, then the library.
2. Ticks **Schedule as offline classes** and unticks any **Same for all** box.
3. For each class in the CSV, ticks the class (exact name match) and sets its **Primary Instructor** (found by email) and **Classroom**.
4. Picks a schedule pattern and start date. These only exist to open the preview.
5. Clicks **Confirm Schedule**, then sets each class's **date and time to the CSV values** in the preview.
6. Checks every row (class, date, time, instructor, classroom) and clicks **Confirm & Schedule**.
7. Reloads the Schedule Classes page and starts the next batch.

Platform, audio/video access, secondary instructor and other hosts are left untouched.

## Install

1. Unzip this folder.
2. Open `chrome://extensions`, then turn on **Developer mode**.
3. Click **Load unpacked** and pick the `scaler-scheduler` folder.
4. Make sure you are logged in to scaler.com.

## CSV format

| Batch Name | Library Name | Class Name | Date | Time | Instructor Email | Classroom |
|---|---|---|---|---|---|---|
| SST IPS 2030 Batch A | SST Introduction to Problem Solving | Class One | 15/11/26 | 5:00 PM | noor.nigar@scaler.com | 1F, Classroom B |
|  |  | Class Two | 17/11/26 | 5:00 PM | noor.nigar@scaler.com | 1F, Classroom B |
| SST IPS 2030 Batch B | SST Introduction to Problem Solving | Class One | 16/11/26 | 10:00 AM | … | 1F, Classroom A |

- A row with a **Batch Name** starts a new batch. Rows below it with an empty Batch Name belong to that batch. Blank rows are ignored.
- **Class Name** must match the class in the library table exactly, including capital letters: `Movie Screening` ≠ `Movie screening`.
- **Date** is `DD/MM/YY` or `DD/MM/YYYY`.
- **Time** is `5:00 PM` (24-hour `17:00` also works). It must be on a 5-minute step.
- **Classroom** must match the dropdown text, e.g. `1F, Classroom B`. Spreadsheets add quotes around it automatically because of the comma.
- The popup's **Download template** link gives you a ready file.

The whole CSV is checked when you upload it: missing columns, bad dates or times, past dates, bad emails, empty classrooms, and duplicate classes in a batch. **Start** stays disabled until every problem is fixed.

## Running

1. Open the extension and upload the CSV.
2. **First time:** tick **Dry run** and click **Start**. It fills the first batch completely, including the preview, but does **not** click Confirm & Schedule. Check the page by eye.
3. Untick Dry run and click **Start**. Keep the tab open; you can watch the log in the popup.
4. **Stop** halts before the next step. A batch is never half-submitted by Stop.

## Working in other tabs while it runs

You can switch tabs, use another window, or use another Chrome profile while a run is going. It keeps working in the background:

- **Waits:** the extension's own waits are timed by its background worker. Chrome slows timers in hidden tabs, but not this worker's.
- **Page code:** a small script inside the Scaler page makes it see itself as visible. It also keeps its dropdown and calendar animations running.
- **Dropdowns:** they open even when the Scaler window isn't the focused window.
- **Memory Saver:** the Scaler tab is protected from being unloaded during a run. That protection is removed when the run ends.

Don't close the Scaler tab, and don't navigate it to another page. Closing the laptop lid or letting the computer sleep will pause the run.

## When something goes wrong

The run **stops at the first problem**, says why in the log, and does not submit that batch. Examples:

- A class is not in the table. Either the name is not an exact match, or the class is already scheduled for that batch. The log lists the class names that are in the table.
- Batch, library, instructor or classroom not found. The log shows which options were offered.
- Scaler shows an error after Confirm & Schedule, e.g. "already scheduled" or a clash.

Fix the CSV, re-upload it, choose **Start from** the failed batch, and start again. Batches that already succeeded don't need to run again.

**Report CSV** gives a per-batch status (success / failed / skipped). The **History** tab keeps the last 20 runs, with logs.

## If Scaler changes the page

The extension finds fields by their visible text: placeholders like "Select Batch/es", "Primary Instructor", "Classroom", "Select a schedule" and "Select a date", and buttons "Confirm Schedule" and "Confirm & Schedule". If Scaler renames these, a step will fail with a clear message.

To get it fixed, open the page in the state where it failed and click **Save page HTML (for debugging)** in the popup. Send that file along with the log.

## Files

```
scaler-scheduler/
├── manifest.json
├── lib/csv.js          # CSV parsing + validation
├── content/content.js  # page automation (one batch per page load)
├── popup/popup.html    # UI
├── popup/popup.js
└── icons/
```
