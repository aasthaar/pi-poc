import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const REMINDER_PARAMS = Type.Object({
    message: Type.String({ description: "The reminder message to show" }),
    minutes: Type.Optional(Type.Number({ description: "Minutes from now to send the reminder" })),
    time: Type.Optional(Type.String({ description: "Specific time to send reminder in HH:MM format e.g. 15:30" })),
});

export default function reminderExtension(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        pi.registerTool({
            name: "set_reminder",
            label: "Set Reminder",
            description: "Set a reminder that will show a Windows notification at a specified time or after a delay. Use when user says 'remind me', 'alert me', 'notify me'.",
            promptSnippet: "Set a timed reminder notification",
            promptGuidelines: [
                "Use set_reminder when user asks to be reminded about something",
                "Use minutes for relative reminders like 'in 30 mins'",
                "Use time for absolute reminders like 'at 3pm'",
            ],
            parameters: REMINDER_PARAMS,
            async execute(_toolCallId, params) {
                try {
                    let delayMinutes: number;
                    if (params.minutes) {
                        delayMinutes = params.minutes;
                    } else if (params.time) {
                        const [hours, mins] = params.time.split(":").map(Number);
                        const now = new Date();
                        const target = new Date();
                        target.setHours(hours, mins, 0, 0);
                        if (target <= now) target.setDate(target.getDate() + 1);
                        delayMinutes = Math.round((target.getTime() - now.getTime()) / 60000);
                    } else {
                        return {
                            content: [{ type: "text", text: "Please specify either minutes or time for the reminder." }],
                            details: { error: "No time specified" },
                        };
                    }
                    const delaySeconds = delayMinutes * 60;
                    const safeMessage = params.message.replace(/'/g, "");
                    const scriptPath = `/tmp/reminder_${Date.now()}.sh`;
                    const fs2 = await import("fs");
                    fs2.writeFileSync(scriptPath, `#!/bin/bash\nsleep ${delaySeconds}\npowershell.exe -Command "msg * '${safeMessage}'"\n`);
                    const { execSync } = await import("child_process");
                    execSync(`chmod +x ${scriptPath}`);
                    execSync(`bash -c "nohup ${scriptPath} > /dev/null 2>&1 &"`);
                    const timeStr = params.minutes
                        ? `in ${params.minutes} minute${params.minutes === 1 ? "" : "s"}`
                        : `at ${params.time}`;
                    return {
                        content: [{ type: "text", text: `Reminder set! You'll get a notification ${timeStr}: "${params.message}"` }],
                        details: { message: params.message, delayMinutes },
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Failed to set reminder: ${err.message}` }],
                        details: { error: err.message },
                    };
                }
            },
        });
        ctx.ui.notify("Reminder tool loaded!", "info");
    });
}
