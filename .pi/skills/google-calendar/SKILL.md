---
name: google-calendar
description: Manage Google Calendar events. Use when user wants to add, edit, remove, or list meetings/events on their Google Calendar.
---

# Google Calendar Skill

## Setup
Run once before first use to authenticate:
```bash
node .pi/extensions/google-auth.js
```

## Usage
This skill gives you access to these tools:
- `add_meeting` — create a new calendar event
- `list_meetings` — list upcoming events
- `remove_meeting` — delete an event

## Example Tasks
- "add a meeting tomorrow at 3pm called POC Demo"
- "list my meetings for this week"
- "remove my 5pm meeting on Friday"

## Rules
- Always confirm with user before removing an event
- Always show event details after adding/editing
- Use ISO 8601 format for dates internally
- Default meeting duration is 1 hour unless specified