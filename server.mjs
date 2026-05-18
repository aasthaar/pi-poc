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

wss.on("connection", async (ws) => {
  console.log("[server] Browser connected — initializing...");

  let session;
  let extensionsResult;
  let unsubscribe;
  let isReady = false;
  const messageQueue = [];

  // Command handler
  async function handleCommand(cmd) {
    console.log(`[server] Received command: ${cmd.type}`);
    
    if (cmd.type === "prompt") {
      if (!session) return;
      await session.prompt(cmd.message);
    } else if (cmd.type === "new_session" || cmd.type === "newSession") {
      console.log("[server] Creating new AgentSession...");
      if (session) {
        if (unsubscribe) unsubscribe();
        session.dispose();
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
        
        const result = await createAgentSession({
          resourceLoader: services.resourceLoader,
          model:        MODEL,
          authStorage,
          modelRegistry,
          sessionManager: SessionManager.inMemory()
        });
        session = result.session;
        await session.bindExtensions({});
        extensionsResult = result.extensionsResult;

        setupSession(session, extensionsResult);
        
        ws.send(JSON.stringify({ 
          type: "_bridge", 
          event: "session_ready",
          sessionId: session.id,
          model: MODEL.id,
          provider: MODEL.provider
        }));
      } catch (err) {
        console.error("[server] Failed to create session:", err);
        ws.send(JSON.stringify({ type: "_bridge", event: "error", message: err.message }));
      }
    } else if (cmd.type === "abort") {
      console.log("[server] Aborting session...");
      if (session && session.abort) {
        await session.abort();
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

  function setupSession(sess, extRes) {
    // Pipe all agent events to the browser
    unsubscribe = sess.subscribe((eventData) => {
      console.log(`[server] Agent event: ${eventData.type} ${eventData.type === 'auto_retry_start' || eventData.type === 'message_end' ? JSON.stringify(eventData) : ''}`);
      ws.send(JSON.stringify(eventData));
    });
  }

  // Initial boot
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
    
    const extensionsRes = services.resourceLoader.getExtensions();
    const skillsResult = services.resourceLoader.getSkills();

    console.log(`[server] Found ${extensionsRes.extensions.length} extensions and ${skillsResult.skills.length} skills`);

    const result = await createAgentSession({
      resourceLoader: services.resourceLoader,
      model:        MODEL,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory()
    });
    session = result.session;
    await session.bindExtensions({});
    extensionsResult = result.extensionsResult;
    console.log(`[server] Active agent tools: ${session.agent.state.tools.map(t => t.name).join(", ")}`);

    setupSession(session, extensionsResult);
    
    isReady = true;
    console.log(`[server] Agent ready. Processing ${messageQueue.length} queued commands.`);

    ws.send(JSON.stringify({ 
      type: "_bridge", 
      event: "session_ready",
      sessionId: session.id,
      model: MODEL.id,
      provider: MODEL.provider
    }));

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
    if (session) session.dispose();
  });
});
