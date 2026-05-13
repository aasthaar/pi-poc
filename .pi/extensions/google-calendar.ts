import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";

const CREDENTIALS_PATH = path.join(process.cwd(), ".pi/credentials.json");
const TOKEN_PATH = path.join(process.cwd(), ".pi/token.json");
const SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.readonly",
];

async function getAuthClient() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
        oAuth2Client.setCredentials(token);
    } else {
        throw new Error("Not authenticated. Please run the auth flow first by using /auth-calendar command.");
    }
    return oAuth2Client;
}

const ADD_MEETING_PARAMS = Type.Object({
    title: Type.String({ description: "Title of the meeting" }),
    date: Type.String({ description: "Date of the meeting e.g. 2025-05-10" }),
    start_time: Type.String({ description: "Start time in HH:MM format e.g. 14:00" }),
    end_time: Type.String({ description: "End time in HH:MM format e.g. 15:00" }),
    description: Type.Optional(Type.String({ description: "Optional description of the meeting" })),
});

const LIST_MEETINGS_PARAMS = Type.Object({
    days_ahead: Type.Optional(Type.Number({ description: "How many days ahead to list. Defaults to 7." })),
});

const REMOVE_MEETING_PARAMS = Type.Object({
    event_id: Type.String({ description: "The event ID to remove. Get this from list_meetings." }),
});

export default function googleCalendarExtension(pi: ExtensionAPI) {
    // Auth command to trigger OAuth flow
    pi.registerCommand("auth-calendar", {
        description: "Authenticate with Google Calendar",
        handler: async (_args, ctx) => {
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
            const { client_secret, client_id, redirect_uris } = credentials.installed;
            const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

            const authUrl = oAuth2Client.generateAuthUrl({
                access_type: "offline",
                scope: SCOPES,
            });

            // Write URL to file so it's easily accessible
            fs.writeFileSync(path.join(process.cwd(), ".pi/auth-url.txt"), authUrl);
            ctx.ui.notify(`Auth URL written to .pi/auth-url.txt - open that file and visit the URL`, "info");
            ctx.ui.notify("After authenticating, copy the code and run: /auth-code YOUR_CODE", "info");
        },
    });

    pi.registerCommand("auth-code", {
        description: "Complete Google Calendar auth with the code from browser",
        handler: async (args, ctx) => {
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
            const { client_secret, client_id, redirect_uris } = credentials.installed;
            const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

            try {
                const { tokens } = await oAuth2Client.getToken(args.trim());
                oAuth2Client.setCredentials(tokens);
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
                ctx.ui.notify("Successfully authenticated with Google Calendar!", "info");
            } catch (err: any) {
                ctx.ui.notify(`Auth failed: ${err.message}`, "warning");
            }
        },
    });

    pi.on("session_start", (_event, ctx) => {
        // Add Meeting Tool
        pi.registerTool({
            name: "add_meeting",
            label: "Add Meeting",
            description: "Add a new event to Google Calendar",
            promptSnippet: "Create a new Google Calendar event",
            promptGuidelines: ["Use add_meeting when user wants to schedule or add a meeting or event"],
            parameters: ADD_MEETING_PARAMS,
            async execute(_toolCallId, params) {
                try {
                    const auth = await getAuthClient();
                    const calendar = google.calendar({ version: "v3", auth });
                    const event = await calendar.events.insert({
                        calendarId: "primary",
                        requestBody: {
                            summary: params.title,
                            description: params.description ?? "",
                            start: {
                                dateTime: `${params.date}T${params.start_time}:00`,
                                timeZone: "Asia/Kolkata",
                            },
                            end: {
                                dateTime: `${params.date}T${params.end_time}:00`,
                                timeZone: "Asia/Kolkata",
                            },
                        },
                    });
                    return {
                        content: [{ type: "text", text: `Meeting added! Event ID: ${event.data.id}\nTitle: ${params.title}\nDate: ${params.date} ${params.start_time}-${params.end_time}` }],
                        details: { eventId: event.data.id },
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Failed to add meeting: ${err.message}` }],
                        details: { error: err.message },
                    };
                }
            },
        });

        // List Meetings Tool
        pi.registerTool({
            name: "list_meetings",
            label: "List Meetings",
            description: "List upcoming Google Calendar events",
            promptSnippet: "List upcoming Google Calendar events",
            promptGuidelines: ["Use list_meetings when user wants to see their upcoming meetings or schedule"],
            parameters: LIST_MEETINGS_PARAMS,
            async execute(_toolCallId, params) {
                try {
                    const auth = await getAuthClient();
                    const calendar = google.calendar({ version: "v3", auth });
                    const now = new Date();
                    const future = new Date();
                    future.setDate(now.getDate() + (params.days_ahead ?? 7));
                    const response = await calendar.events.list({
                        calendarId: "primary",
                        timeMin: now.toISOString(),
                        timeMax: future.toISOString(),
                        singleEvents: true,
                        orderBy: "startTime",
                    });
                    const events = response.data.items ?? [];
                    if (events.length === 0) {
                        return {
                            content: [{ type: "text", text: "No upcoming meetings found." }],
                            details: { count: 0 },
                        };
                    }
                    const text = events.map(e =>
                        `ID: ${e.id}\nTitle: ${e.summary}\nStart: ${e.start?.dateTime ?? e.start?.date}`
                    ).join("\n\n");
                    return {
                        content: [{ type: "text", text }],
                        details: { count: events.length },
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Failed to list meetings: ${err.message}` }],
                        details: { error: err.message },
                    };
                }
            },
        });

        // Remove Meeting Tool
        pi.registerTool({
            name: "remove_meeting",
            label: "Remove Meeting",
            description: "Remove an event from Google Calendar by event ID",
            promptSnippet: "Delete a Google Calendar event",
            promptGuidelines: ["Use remove_meeting when user wants to delete or cancel a meeting. Always list meetings first to get the event ID."],
            parameters: REMOVE_MEETING_PARAMS,
            async execute(_toolCallId, params) {
                try {
                    const auth = await getAuthClient();
                    const calendar = google.calendar({ version: "v3", auth });
                    await calendar.events.delete({
                        calendarId: "primary",
                        eventId: params.event_id,
                    });
                    return {
                        content: [{ type: "text", text: `Meeting removed successfully! Event ID: ${params.event_id}` }],
                        details: { eventId: params.event_id },
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Failed to remove meeting: ${err.message}` }],
                        details: { error: err.message },
                    };
                }
            },
        });

        ctx.ui.notify("Google Calendar tools loaded!", "info");
    });
}
