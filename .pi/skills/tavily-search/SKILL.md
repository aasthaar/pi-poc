---
name: tavily-search
description: Search the web using Tavily API. Use when the user asks about current events, recent information, facts, documentation, or anything that requires up-to-date web knowledge not available in local files.
---

# Tavily Web Search Skill

## Setup
Make sure TAVILY_API_KEY is set in your environment:
```bash
export TAVILY_API_KEY=your_key_here
```

## Usage
This skill gives you access to the `web_search` tool.

Use it when:
- User asks about something you don't know or that may have changed recently
- User explicitly asks to "search the web" or "look up" something
- Local files don't contain the needed information

## Steps
1. Call the `web_search` tool with a clear, concise query
2. Read the results carefully
3. Summarize the most relevant findings for the user
4. Always mention the sources you found

## Notes
- Keep queries short and specific (3-6 words works best)
- If first search is insufficient, refine and search again
- Always cite where information came from