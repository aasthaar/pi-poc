import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";

const CREDENTIALS_PATH = path.join(process.cwd(), ".pi/credentials.json");
const TOKEN_PATH = path.join(process.cwd(), ".pi/token.json");

async function getAuthClient() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
        oAuth2Client.setCredentials(token);
    } else {
        throw new Error("Not authenticated. Run /auth-calendar first.");
    }
    return oAuth2Client;
}

function decodeBase64(data: string): string {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function getEmailBody(payload: any): string {
    if (!payload) return "No content";
    if (payload.body?.data) return decodeBase64(payload.body.data);
    if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === "text/plain" && part.body?.data) {
                return decodeBase64(part.body.data);
            }
        }
        for (const part of payload.parts) {
            if (part.mimeType === "text/html" && part.body?.data) {
                return decodeBase64(part.body.data).replace(/<[^>]*>/g, "");
            }
        }
    }
    return "No readable content found";
}

const LIST_EMAILS_PARAMS = Type.Object({
    max_results: Type.Optional(Type.Number({ description: "Number of emails to return. Defaults to 10." })),
    unread_only: Type.Optional(Type.Boolean({ description: "If true, only return unread emails." })),
});

const READ_EMAIL_PARAMS = Type.Object({
    email_id: Type.String({ description: "The email ID to read. Get this from list_emails." }),
});

const SEARCH_EMAILS_PARAMS = Type.Object({
    query: Type.String({ description: "Search query e.g. 'from:manager@company.com' or 'subject:POC' or 'is:unread'" }),
    max_results: Type.Optional(Type.Number({ description: "Number of results to return. Defaults to 10." })),
});

export default function gmailReaderExtension(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {

        // List Emails Tool
        pi.registerTool({
            name: "list_emails",
            label: "List Emails",
            description: "List recent or unread emails from Gmail",
            promptSnippet: "List Gmail emails",
            promptGuidelines: [
                "Use list_emails when user wants to see their recent or unread emails",
                "Use unread_only: true when user says 'unread' or 'new' emails",
            ],
            parameters: LIST_EMAILS_PARAMS,
            async execute(_toolCallId, params) {
                try {
                    const auth = await getAuthClient();
                    const gmail = google.gmail({ version: "v1", auth });

                    const query = params.unread_only ? "is:unread" : "";
                    const response = await gmail.users.messages.list({
                        userId: "me",
                        maxResults: params.max_results ?? 10,
                        q: query,
                    });

                    const messages = response.data.messages ?? [];
                    if (messages.length === 0) {
                        return {
                            content: [{ type: "text", text: "No emails found." }],
                            details: { count: 0 },
                        };
                    }

                    // Fetch details for each message
                    const details = await Promise.all(
                        messages.map(async (msg) => {
                            const detail = await gmail.users.messages.get({
                                userId: "me",
                                id: msg.id!,
                                format: "metadata",
                                metadataHeaders: ["From", "Subject", "Date"],
                            });
                            const headers = detail.data.payload?.headers ?? [];
                            const get = (name: string) => headers.find(h => h.name === name)?.value ?? "Unknown";
                            return `ID: ${msg.id}\nFrom: ${get("From")}\nSubject: ${get("Subject")}\nDate: ${get("Date")}`;
                        })
                    );

                    return {
                        content: [{ type: "text", text: details.join("\n\n") }],
                        details: { count: messages.length },
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Failed to list emails: ${err.message}` }],
                        details: { error: err.message },
                    };
                }
            },
        });

        // Read Email Tool
        pi.registerTool({
            name: "read_email",
            label: "Read Email",
            description: "Read the full content of a specific email by ID",
            promptSnippet: "Read a specific Gmail email",
            promptGuidelines: [
                "Use read_email when user wants to read a specific email",
                "Always use list_emails first to get the email ID",
            ],
            parameters: READ_EMAIL_PARAMS,
            async execute(_toolCallId, params) {
                try {
                    const auth = await getAuthClient();
                    const gmail = google.gmail({ version: "v1", auth });

                    const detail = await gmail.users.messages.get({
                        userId: "me",
                        id: params.email_id,
                        format: "full",
                    });

                    const headers = detail.data.payload?.headers ?? [];
                    const get = (name: string) => headers.find(h => h.name === name)?.value ?? "Unknown";
                    const body = getEmailBody(detail.data.payload);

                    const text = `From: ${get("From")}\nSubject: ${get("Subject")}\nDate: ${get("Date")}\n\n${body.slice(0, 2000)}`;

                    return {
                        content: [{ type: "text", text }],
                        details: { emailId: params.email_id },
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Failed to read email: ${err.message}` }],
                        details: { error: err.message },
                    };
                }
            },
        });

        // Search Emails Tool
        pi.registerTool({
            name: "search_emails",
            label: "Search Emails",
            description: "Search Gmail emails by sender, subject, or keyword",
            promptSnippet: "Search Gmail emails",
            promptGuidelines: [
                "Use search_emails when user wants to find specific emails",
                "Supports Gmail search syntax like 'from:email', 'subject:text', 'is:unread'",
            ],
            parameters: SEARCH_EMAILS_PARAMS,
            async execute(_toolCallId, params) {
                try {
                    const auth = await getAuthClient();
                    const gmail = google.gmail({ version: "v1", auth });

                    const response = await gmail.users.messages.list({
                        userId: "me",
                        maxResults: params.max_results ?? 10,
                        q: params.query,
                    });

                    const messages = response.data.messages ?? [];
                    if (messages.length === 0) {
                        return {
                            content: [{ type: "text", text: `No emails found for query: "${params.query}"` }],
                            details: { count: 0 },
                        };
                    }

                    const details = await Promise.all(
                        messages.map(async (msg) => {
                            const detail = await gmail.users.messages.get({
                                userId: "me",
                                id: msg.id!,
                                format: "metadata",
                                metadataHeaders: ["From", "Subject", "Date"],
                            });
                            const headers = detail.data.payload?.headers ?? [];
                            const get = (name: string) => headers.find(h => h.name === name)?.value ?? "Unknown";
                            return `ID: ${msg.id}\nFrom: ${get("From")}\nSubject: ${get("Subject")}\nDate: ${get("Date")}`;
                        })
                    );

                    return {
                        content: [{ type: "text", text: details.join("\n\n") }],
                        details: { count: messages.length },
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Failed to search emails: ${err.message}` }],
                        details: { error: err.message },
                    };
                }
            },
        });

        ctx.ui.notify("Gmail tools loaded!", "info");
    });
}