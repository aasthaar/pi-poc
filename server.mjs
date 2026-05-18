/**
 * pi Chat Bridge — SDK Edition
 *
 * Uses @earendil-works/pi-coding-agent SDK directly (no subprocess).
 * Each WebSocket connection gets its own isolated AgentSession.
 * Runs as an ES module (.mjs) to work inside pi-mono's "type":"module" package.
 *
 * Usage:
 *   export OPENROUTER_API_KEY=sk-or-...
 *   node server.mjs
 */

import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const PORT = 8765;
const CWD = process.cwd();

// Setup global auth and model registry
const authStorage = new AuthStorage();
const modelRegistry = new ModelRegistry(authStorage);

// Inject runtime API keys from environment
if (process.env.OPENROUTER_API_KEY) {
  authStorage.setRuntimeApiKey("openrouter", process.env.OPENROUTER_API_KEY);
}

// Resolve the model — strictly use openrouter/free
const MODEL = modelRegistry.find("openrouter", "openrouter/free");

if (!MODEL) {
  console.error("[server] No models available. Check API keys.");
  process.exit(1);
}

// ── HTTP & WebSocket server ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(CWD, "index.html")));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });
server.listen(PORT, () => {
  console.log(`[server] Server listening at http://localhost:${PORT}`);
  console.log(`[server] You can now open http://localhost:${PORT} in your browser.\n`);
});

const activeSessions = new Map(); // sessionId -> { id, title, msgCount, created, filePath, manager, session: null, extensionsResult: null }

// Helper to lazily boot the AgentSession when needed
async function ensureSessionBooted(sessionData) {
  if (sessionData.session) return sessionData.session;
  
  console.log(`[server] Lazily booting AgentSession for ID: ${sessionData.id}`);
  const skillPaths = [path.join(__dirname, ".pi", "skills")];
  const extensionPaths = [path.join(__dirname, ".pi", "extensions")];
  const services = await createAgentSessionServices({ 
    cwd: CWD,
    resourceLoaderOptions: {
      additionalSkillPaths: skillPaths,
      additionalExtensionPaths: extensionPaths
    }
  });
  await services.resourceLoader.reload();
  
  const result = await createAgentSession({
    resourceLoader: services.resourceLoader,
    model:        MODEL,
    authStorage,
    modelRegistry,
    sessionManager: sessionData.manager
  });
  
  sessionData.session = result.session;
  sessionData.extensionsResult = result.extensionsResult;
  
  await result.session.bindExtensions({});
  return result.session;
}

// Initial directory scan to load persisted session headers
try {
  const agentDir = getAgentDir();
  const safePath = `--${CWD.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = path.join(agentDir, "sessions", safePath);
  
  if (fs.existsSync(sessionDir)) {
    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => path.join(sessionDir, f));
      
    console.log(`[server] Found ${files.length} existing sessions on disk.`);
    
    for (const filePath of files) {
      try {
        const mgr = SessionManager.open(filePath);
        const header = mgr.getHeader();
        if (!header) continue;
        
        const id = header.id;
        const created = new Date(header.timestamp).getTime();
        const entries = mgr.getEntries();
        
        let firstMsg = "";
        let msgCount = 0;
        for (const entry of entries) {
          if (entry.type === "message") {
            msgCount++;
            if (!firstMsg && entry.message.role === "user") {
              const content = entry.message.content;
              if (typeof content === "string") {
                firstMsg = content;
              } else if (Array.isArray(content)) {
                firstMsg = content.filter(c => c.type === "text").map(c => c.text).join("");
              }
            }
          }
        }
        
        const title = mgr.getSessionName() || firstMsg || "New session";
        
        activeSessions.set(id, {
          id,
          title,
          msgCount,
          created,
          filePath,
          manager: mgr,
          session: null,
          extensionsResult: null
        });
      } catch (err) {
        console.error(`[server] Failed to load session file ${filePath}:`, err);
      }
    }
  }
} catch (err) {
  console.error("[server] Failed to scan session directory:", err);
}

function getHistory(session) {
  if (!session || !session.sessionManager) return [];
  const context = session.sessionManager.buildSessionContext();
  if (!context || !context.messages) return [];
  
  return context.messages
    .filter(msg => msg.role === "user" || msg.role === "assistant")
    .map(msg => {
      const historyMsg = {
        role: msg.role,
        timestamp: msg.timestamp || Date.now()
      };
      
      if (msg.role === "user") {
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content.filter(c => c.type === "text").map(c => c.text).join("");
        }
        historyMsg.content = text;
      } else if (msg.role === "assistant") {
        historyMsg.content = "";
        historyMsg.thinking = "";
        historyMsg.toolCalls = [];
        
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") {
              historyMsg.content += block.text;
            } else if (block.type === "thinking") {
              historyMsg.thinking += block.thinking;
            } else if (block.type === "toolCall") {
              historyMsg.toolCalls.push({
                id: block.id,
                name: block.name,
                arguments: block.arguments
              });
            }
          }
        }
        if (typeof msg.content === "string") {
          historyMsg.content = msg.content;
        }
      }
      
      return historyMsg;
    });
}

wss.on("connection", async (ws) => {
  console.log("[server] Browser connected — initializing...");

  let currentSessionId = null;
  let unsubscribe = null;
  let isReady = false;
  const messageQueue = [];

  function broadcastSessionList() {
    const list = Array.from(activeSessions.values()).map(s => ({
      id: s.id,
      title: s.title,
      msgCount: s.msgCount,
      created: s.created
    }));
    list.sort((a, b) => b.created - a.created);
    ws.send(JSON.stringify({
      type: "_bridge",
      event: "session_list",
      sessions: list,
      activeSessionId: currentSessionId
    }));
  }

  function setupSession(sess) {
    if (unsubscribe) {
      unsubscribe();
    }
    unsubscribe = sess.subscribe((eventData) => {
      console.log(`[server] Agent event: ${eventData.type} - ${JSON.stringify(eventData).slice(0, 300)}`);
      ws.send(JSON.stringify(eventData));
    });
  }

  async function createNewSession() {
    console.log("[server] Creating new AgentSession...");
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }

    try {
      const skillPaths = [path.join(__dirname, ".pi", "skills")];
      const extensionPaths = [path.join(__dirname, ".pi", "extensions")];
      const services = await createAgentSessionServices({ 
        cwd: CWD,
        resourceLoaderOptions: {
          additionalSkillPaths: skillPaths,
          additionalExtensionPaths: extensionPaths
        }
      });
      await services.resourceLoader.reload();
      
      // Use SessionManager.create to ensure persistent files!
      const mgr = SessionManager.create(CWD);
      
      const result = await createAgentSession({
        resourceLoader: services.resourceLoader,
        model:        MODEL,
        authStorage,
        modelRegistry,
        sessionManager: mgr
      });
      
      const newSession = result.session;
      await newSession.bindExtensions({});
      
      const id = newSession.id;
      const sessionData = {
        id,
        session: newSession,
        extensionsResult: result.extensionsResult,
        manager: mgr,
        title: "New session",
        msgCount: 0,
        created: Date.now(),
        filePath: mgr.getSessionFile()
      };
      
      activeSessions.set(id, sessionData);
      currentSessionId = id;
      
      setupSession(newSession);
      
      ws.send(JSON.stringify({ 
        type: "_bridge", 
        event: "session_ready",
        sessionId: id,
        model: MODEL.id,
        provider: MODEL.provider
      }));
      
      broadcastSessionList();
    } catch (err) {
      console.error("[server] Failed to create session:", err);
      ws.send(JSON.stringify({ type: "_bridge", event: "error", message: err.message }));
    }
  }

  // Command handler
  async function handleCommand(cmd) {
    console.log(`[server] Received command: ${cmd.type}`);
    
    if (cmd.type === "prompt") {
      const sessionData = activeSessions.get(currentSessionId);
      if (!sessionData) return;
      
      // Ensure booted lazily
      const bootedSession = await ensureSessionBooted(sessionData);
      
      if (sessionData.title === "New session" && typeof cmd.message === "string") {
        const newTitle = cmd.message.slice(0, 36) + (cmd.message.length > 36 ? "…" : "");
        sessionData.title = newTitle;
        if (sessionData.manager) {
          sessionData.manager.appendSessionInfo(newTitle);
        }
      }
      sessionData.msgCount += 2;
      broadcastSessionList();

      const images = cmd.images ? cmd.images.map(img => ({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64
        }
      })) : undefined;

      await bootedSession.prompt(cmd.message, { images });
    } else if (cmd.type === "new_session" || cmd.type === "newSession") {
      await createNewSession();
    } else if (cmd.type === "switchSession") {
      const sessionData = activeSessions.get(cmd.sessionId);
      if (sessionData) {
        currentSessionId = cmd.sessionId;
        
        // Ensure booted lazily
        const bootedSession = await ensureSessionBooted(sessionData);
        setupSession(bootedSession);
        
        ws.send(JSON.stringify({ 
          type: "_bridge", 
          event: "session_ready",
          sessionId: currentSessionId,
          model: MODEL.id,
          provider: MODEL.provider,
          history: getHistory(bootedSession)
        }));
        broadcastSessionList();
      }
    } else if (cmd.type === "deleteSession") {
      const targetId = cmd.sessionId;
      const sessionData = activeSessions.get(targetId);
      if (sessionData) {
        if (sessionData.session) {
          sessionData.session.dispose();
        }
        // Delete the file from disk if it exists
        if (sessionData.filePath && fs.existsSync(sessionData.filePath)) {
          try {
            fs.unlinkSync(sessionData.filePath);
            console.log(`[server] Deleted session file: ${sessionData.filePath}`);
          } catch (err) {
            console.error(`[server] Failed to delete session file:`, err);
          }
        }
        activeSessions.delete(targetId);
      }
      
      if (currentSessionId === targetId) {
        const remaining = Array.from(activeSessions.values()).sort((a, b) => b.created - a.created);
        if (remaining.length > 0) {
          const latest = remaining[0];
          currentSessionId = latest.id;
          
          const bootedSession = await ensureSessionBooted(latest);
          setupSession(bootedSession);
          
          ws.send(JSON.stringify({ 
            type: "_bridge", 
            event: "session_ready",
            sessionId: currentSessionId,
            model: MODEL.id,
            provider: MODEL.provider,
            history: getHistory(bootedSession)
          }));
          broadcastSessionList();
        } else {
          await createNewSession();
        }
      } else {
        broadcastSessionList();
      }
    } else if (cmd.type === "abort") {
      console.log("[server] Aborting session...");
      const sessionData = activeSessions.get(currentSessionId);
      if (sessionData && sessionData.session && sessionData.session.abort) {
        await sessionData.session.abort();
      }
    }
  }

  // Handle messages immediately
  ws.on("message", async (data) => {
    try {
      const cmd = JSON.parse(data.toString());
      if (!isReady) {
        console.log(`[server] Queueing command: ${cmd.type}`);
        messageQueue.push(cmd);
        return;
      }
      await handleCommand(cmd);
    } catch (err) {
      console.error("[server] Message handling error:", err);
    }
  });

  // Initial boot
  try {
    if (activeSessions.size > 0) {
      const sorted = Array.from(activeSessions.values()).sort((a, b) => b.created - a.created);
      const latest = sorted[0];
      currentSessionId = latest.id;
      
      const bootedSession = await ensureSessionBooted(latest);
      setupSession(bootedSession);
      
      isReady = true;
      ws.send(JSON.stringify({ 
        type: "_bridge", 
        event: "session_ready",
        sessionId: currentSessionId,
        model: MODEL.id,
        provider: MODEL.provider,
        history: getHistory(bootedSession)
      }));
      broadcastSessionList();
    } else {
      await createNewSession();
      isReady = true;
    }

    // Drain queue
    while (messageQueue.length > 0) {
      const cmd = messageQueue.shift();
      await handleCommand(cmd);
    }
  } catch (err) {
    console.error("[server] Boot error:", err);
    ws.send(JSON.stringify({ type: "_bridge", event: "error", message: err.message }));
    ws.close();
  }

  ws.on("close", () => {
    console.log("[server] Browser disconnected");
    if (unsubscribe) unsubscribe();
  });
});
