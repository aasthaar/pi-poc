import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const SEARCH_PARAMS = Type.Object({
    query: Type.String({ description: "The search query. Keep it concise and specific." }),
    max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return. Defaults to 5." })),
});

export default function webSearchExtension(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        pi.registerTool({
            name: "web_search",
            label: "Web Search",
            description: "Search the web using Tavily API. Use for current events, recent info, or anything requiring up-to-date web knowledge.",
            promptSnippet: "Search the web for up-to-date information using Tavily",
            promptGuidelines: [
                "Use web_search when the user asks about current events or recent information.",
                "Use web_search when local files don't contain the needed information.",
                "Keep queries short and specific, 3-6 words works best.",
            ],
            parameters: SEARCH_PARAMS,
            async execute(_toolCallId, params) {
                const apiKey = process.env.TAVILY_API_KEY;
                if (!apiKey) {
                    return {
                        content: [{ type: "text", text: "Error: TAVILY_API_KEY is not set." }],
                        details: { error: "Missing API key" },
                    };
                }
                try {
                    const response = await fetch("https://api.tavily.com/search", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            api_key: apiKey,
                            query: params.query,
                            max_results: params.max_results ?? 5,
                            search_depth: "basic",
                            include_answer: true,
                        }),
                    });
                    if (!response.ok) {
                        return {
                            content: [{ type: "text", text: `Tavily API error: ${response.status} ${response.statusText}` }],
                            details: { error: response.statusText },
                        };
                    }
                    const data = await response.json();
                    const results = (data.results ?? [])
                        .map((r: any) => `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.content?.slice(0, 300)}`)
                        .join("\n\n");
                    const text = data.answer
                        ? `Answer: ${data.answer}\n\nSources:\n${results}`
                        : `Sources:\n${results}`;
                    return {
                        content: [{ type: "text", text }],
                        details: { query: params.query, resultCount: data.results?.length ?? 0 },
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Request failed: ${err.message}` }],
                        details: { error: err.message },
                    };
                }
            },
        });
        ctx.ui.notify("Registered tool: web_search", "info");
    });
}